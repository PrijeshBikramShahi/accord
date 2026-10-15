import base64
import copy
import json
import time
import unittest

import handler as api


CONFIG = {"issuer": "https://issuer", "clientId": "client", "origin": "http://localhost:5174"}


class MemoryStore:
    def __init__(self):
        self.rows = {}
        self.before_commit = lambda: None
        self.commits = 0
        self.page_size = 50

    def get(self, pk, sk):
        return copy.deepcopy(self.rows.get((pk, sk)))

    def query(self, pk, prefix, after=None):
        keys = sorted(key for key in self.rows if key[0] == pk and key[1].startswith(prefix) and (not after or key[1] > after))
        page = keys[:self.page_size]
        return [self.get(*key) for key in page], page[-1][1] if len(keys) > self.page_size else None

    def transact(self, checks, puts, replacements=()):
        self.before_commit()
        if any(self.rows.get((pk, sk)) != expected for pk, sk, expected in checks) or any((pk, sk) in self.rows for pk, sk, data in puts):
            raise api.Conflict()
        if any(self.rows.get((pk, sk)) != expected for pk, sk, expected, data in replacements):
            raise api.Conflict()
        self.rows.update({(pk, sk): copy.deepcopy(data) for pk, sk, data in puts})
        self.rows.update({(pk, sk): copy.deepcopy(data) for pk, sk, expected, data in replacements})
        self.commits += 1


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.store = MemoryStore()
        for user_id, role, workspace in [("owner", "owner", "studio"), ("alex", "client", "studio"), ("jules", "client", "studio"), ("outsider", "owner", "other"), ("foreign", "client", "other")]:
            user = {"id": user_id, "role": role, "workspaceId": workspace, "name": user_id, "email": user_id + "@example.invalid", "active": True, "version": 1}
            self.store.rows[("IDENTITY#" + user_id, "PROFILE")] = user
            if role == "client":
                self.store.rows[("WORKSPACE#" + workspace, "CLIENT#" + user_id)] = {"id": user_id}

    def event(self, who="owner", path="/api/projects", body=None, key="request-123"):
        return {"rawPath": path, "requestContext": {"http": {"method": "GET" if body is None else "POST"}, "authorizer": {"jwt": {"claims": {"sub": who, "iss": CONFIG["issuer"], "client_id": CONFIG["clientId"], "exp": str(time.time() + 900), "token_use": "access", "scope": "openid email profile"}}}}, "headers": {"origin": CONFIG["origin"], "content-type": "application/json", "idempotency-key": key}, "body": json.dumps(body) if body is not None else None}

    def call(self, event):
        response = api.handle(event, self.store, CONFIG)
        self.assertEqual(response["headers"]["cache-control"], "no-store")
        return response["statusCode"], json.loads(response["body"])

    def create(self, client="alex", key="request-123"):
        return self.call(self.event(body={"title": "Atlas", "description": "Synthetic project", "clientId": client}, key=key))

    def test_anonymous_forged_header_and_wrong_token_claims_rejected(self):
        event = self.event()
        del event["requestContext"]["authorizer"]
        event["headers"]["Authorization"] = "Bearer forged"
        self.assertEqual(self.call(event)[0], 401)
        for field, value in [("iss", "foreign"), ("client_id", "foreign"), ("token_use", "id"), ("scope", "email"), ("exp", "0"), ("exp", "nonsense"), ("sub", "../owner")]:
            event = self.event()
            event["requestContext"]["authorizer"]["jwt"]["claims"][field] = value
            self.assertEqual(self.call(event)[0], 401, field)

    def test_database_membership_overrides_claimed_role_and_workspace(self):
        event = self.event("alex", body={"title": "X", "description": "Y", "clientId": "jules"})
        event["requestContext"]["authorizer"]["jwt"]["claims"].update(role="owner", workspaceId="studio")
        self.assertEqual(self.call(event)[0], 403)
        self.store.rows[("IDENTITY#alex", "PROFILE")]["active"] = False
        self.assertEqual(self.call(self.event("alex", "/api/auth/me"))[0], 403)
        self.assertEqual(self.call(self.event("unknown", "/api/auth/me"))[0], 403)

    def test_profile_response_excludes_internal_fields(self):
        status, value = self.call(self.event(path="/api/auth/me"))
        self.assertEqual(status, 200)
        self.assertEqual(set(value), {"id", "role", "workspaceId", "name", "email"})

    def test_create_atomic_audit_indexes_and_idempotent_replay(self):
        status, project = self.create()
        self.assertEqual(status, 201)
        self.assertEqual(self.store.commits, 1)
        self.assertEqual(project["ownerId"], "owner")
        self.assertEqual(self.store.get("USER#alex", "PROJECT#" + project["id"]), {"id": project["id"]})
        self.assertEqual(len(self.store.query("PROJECT#" + project["id"], "AUDIT#")[0]), 1)
        self.assertEqual(self.create(), (200, project))
        self.assertEqual(self.store.commits, 1)
        changed = self.event(body={"title": "Changed", "description": "Synthetic project", "clientId": "alex"})
        self.assertEqual(self.call(changed)[0], 409)

    def test_two_clients_and_second_workspace_isolated_in_lists_and_direct_reads(self):
        _, atlas = self.create()
        _, fieldwork = self.create("jules", "request-456")
        for who, expected in [("owner", {atlas["id"], fieldwork["id"]}), ("alex", {atlas["id"]}), ("jules", {fieldwork["id"]}), ("outsider", set())]:
            self.assertEqual({p["id"] for p in self.call(self.event(who))[1]["items"]}, expected)
        self.assertEqual(self.call(self.event("alex", "/api/projects/" + fieldwork["id"]))[0], 404)
        self.assertEqual(self.call(self.event("outsider", "/api/projects/" + atlas["id"]))[0], 404)
        self.assertEqual(self.create("foreign")[0], 403)

    def test_stale_index_never_grants_project_or_directory_access(self):
        _, project = self.create()
        self.store.rows[("USER#jules", "PROJECT#" + project["id"])] = {"id": project["id"]}
        self.store.rows[("WORKSPACE#studio", "CLIENT#foreign")] = {"id": "foreign"}
        self.assertEqual(self.call(self.event("jules"))[1]["items"], [])
        self.assertEqual({u["id"] for u in self.call(self.event(path="/api/clients"))[1]["items"]}, {"alex", "jules"})
        self.assertEqual(self.call(self.event("alex", "/api/clients"))[0], 403)

    def test_revocation_prevents_existing_token_and_replay(self):
        self.create()
        self.store.rows[("IDENTITY#owner", "PROFILE")]["active"] = False
        self.assertEqual(self.create()[0], 403)
        self.store.rows[("IDENTITY#owner", "PROFILE")]["active"] = True
        self.store.rows[("IDENTITY#alex", "PROFILE")]["active"] = False
        self.assertEqual(self.create()[0], 403)

    def test_revocation_during_commit_prevents_partial_writes(self):
        self.store.before_commit = lambda: self.store.rows[("IDENTITY#alex", "PROFILE")].update(active=False, version=2)
        self.assertEqual(self.create()[0], 403)
        self.assertEqual(self.store.commits, 0)
        self.assertFalse(any(pk.startswith("PROJECT#") for pk, sk in self.store.rows))

    def test_concurrent_duplicate_returns_original_result(self):
        def compete():
            self.store.before_commit = lambda: None
            self.assertEqual(self.create()[0], 201)
        self.store.before_commit = compete
        status, project = self.create()
        self.assertEqual(status, 200)
        self.assertEqual(self.store.commits, 1)
        self.assertEqual(self.store.get("USER#owner", "IDEMPOTENCY#request-123")["projectId"], project["id"])

    def test_mutation_origin_type_key_and_payload_validation(self):
        body = {"title": "X", "description": "Y", "clientId": "alex"}
        for header, value, status in [("origin", "https://evil.invalid", 403), ("content-type", "text/plain", 415), ("idempotency-key", "short", 400)]:
            event = self.event(body=body)
            event["headers"][header] = value
            self.assertEqual(self.call(event)[0], status)
        for invalid in [[], {**body, "ownerId": "outsider"}, {**body, "title": " "}, {**body, "description": "x" * 1001}, {**body, "clientId": "../alex"}]:
            self.assertEqual(self.call(self.event(body=invalid))[0], 400)
        event = self.event(body=body)
        event["body"] = "x" * 23000
        self.assertEqual(self.call(event)[0], 413)
        event["body"] = "not-json"
        self.assertEqual(self.call(event)[0], 400)
        event["isBase64Encoded"] = True
        event["body"] = base64.b64encode(json.dumps(body).encode()).decode()
        self.assertEqual(self.call(event)[0], 201)

    def test_pagination_and_cursor_binding(self):
        self.create()
        self.create("jules", "request-456")
        self.store.page_size = 1
        first = self.call(self.event())[1]
        event = self.event()
        event["queryStringParameters"] = {"cursor": first["nextCursor"]}
        second = self.call(event)[1]
        self.assertEqual(len(first["items"]) + len(second["items"]), 2)
        self.assertNotEqual(first["items"][0]["id"], second["items"][0]["id"])
        event["requestContext"]["authorizer"]["jwt"]["claims"]["sub"] = "jules"
        self.assertEqual(self.call(event)[0], 400)
        for raw in ["garbage", "%%%%", base64.urlsafe_b64encode(b'[]').decode().rstrip("=")]:
            event["queryStringParameters"]["cursor"] = raw
            self.assertEqual(self.call(event)[0], 400)

    def test_unknown_workflow_routes_are_not_fake_empty_successes(self):
        self.assertEqual(self.call(self.event(path="/api/projects/atlas/briefs"))[0], 404)

    def test_dynamo_wire_protocol_and_atomic_conditions(self):
        calls = []
        class Client:
            def get_item(inner, **args):
                calls.append(args)
                return {"Item": api.item("pk", "sk", {"name": "Maya"})}
            def query(inner, **args):
                calls.append(args)
                return {"Items": [api.item("pk", "PROJECT#a", {"id": "a"})], "LastEvaluatedKey": {"pk": {"S": "pk"}, "sk": {"S": "PROJECT#a"}}}
            def transact_write_items(inner, **args):
                calls.append(args)
        store = api.DynamoStore(Client(), "table")
        self.assertEqual(store.get("pk", "sk"), {"name": "Maya"})
        self.assertTrue(calls[-1]["ConsistentRead"])
        self.assertEqual(store.query("pk", "PROJECT#", "PROJECT#0"), ([{"id": "a"}], "PROJECT#a"))
        self.assertEqual(calls[-1]["ExclusiveStartKey"]["pk"], {"S": "pk"})
        store.transact([("IDENTITY#a", "PROFILE", {"active": True})], [("PROJECT#a", "METADATA", {"id": "a"})])
        actions = calls[-1]["TransactItems"]
        self.assertEqual(len(actions), 2)
        self.assertEqual(actions[0]["ConditionCheck"]["ExpressionAttributeValues"][":expected"], {"S": '{"active":true}'})
        self.assertEqual(actions[1]["Put"]["ConditionExpression"], "attribute_not_exists(pk)")


if __name__ == "__main__":
    unittest.main()
