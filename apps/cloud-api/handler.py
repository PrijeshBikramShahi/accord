"""Accord cloud project directory. Only API Gateway JWT context establishes identity.

No local SQLite adapter, passwords, model calls or unimplemented workflow routes.
The runtime supplies boto3; imports are lazy so domain tests need no AWS SDK.
"""
import base64
import hashlib
import json
import os
import re
import time
import uuid
from datetime import datetime, timezone


class Rejected(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


class Conflict(Exception):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def item(pk, sk, data):
    return {"pk": {"S": pk}, "sk": {"S": sk}, "data": {"S": canonical(data)}}


class DynamoStore:
    def __init__(self, client, table):
        self.client, self.table = client, table

    def get(self, pk, sk):
        row = self.client.get_item(TableName=self.table, Key={"pk": {"S": pk}, "sk": {"S": sk}}, ConsistentRead=True).get("Item")
        return json.loads(row["data"]["S"]) if row else None

    def query(self, pk, prefix, after=None):
        args = dict(TableName=self.table, KeyConditionExpression="pk = :pk AND begins_with(sk, :prefix)",
                    ExpressionAttributeValues={":pk": {"S": pk}, ":prefix": {"S": prefix}}, ConsistentRead=True, Limit=50)
        if after:
            args["ExclusiveStartKey"] = {"pk": {"S": pk}, "sk": {"S": after}}
        page = self.client.query(**args)
        return [json.loads(row["data"]["S"]) for row in page.get("Items", [])], page.get("LastEvaluatedKey", {}).get("sk", {}).get("S")

    def transact(self, checks, puts, replacements=()):
        actions = [{"ConditionCheck": {"TableName": self.table, "Key": {"pk": {"S": pk}, "sk": {"S": sk}},
                    "ConditionExpression": "#data = :expected", "ExpressionAttributeNames": {"#data": "data"},
                    "ExpressionAttributeValues": {":expected": {"S": canonical(data)}}}} for pk, sk, data in checks]
        actions += [{"Put": {"TableName": self.table, "Item": item(pk, sk, data), "ConditionExpression": "attribute_not_exists(pk)"}} for pk, sk, data in puts]
        for pk, sk, expected, data in replacements:
            put = {"TableName": self.table, "Item": item(pk, sk, data), "ConditionExpression": "attribute_not_exists(pk)"}
            if expected is not None:
                put.update(ConditionExpression="#data = :expected", ExpressionAttributeNames={"#data": "data"},
                           ExpressionAttributeValues={":expected": {"S": canonical(expected)}})
            actions.append({"Put": put})
        try:
            self.client.transact_write_items(TransactItems=actions)
        except Exception as error:
            code = getattr(error, "response", {}).get("Error", {}).get("Code")
            if code == "TransactionCanceledException":
                raise Conflict() from error
            raise


def profile(store, subject):
    user = store.get("IDENTITY#" + subject, "PROFILE")
    if not user or user.get("active") is not True or user.get("id") != subject or user.get("role") not in ("owner", "client"):
        raise Rejected(403, "This account has no active workspace access.")
    return user


def public_user(user):
    return {key: user[key] for key in ("id", "workspaceId", "name", "email", "role")}


def identity(event, store, config):
    claims = event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {})
    try:
        valid = (claims.get("iss") == config["issuer"] and claims.get("client_id") == config["clientId"]
                 and claims.get("token_use") == "access" and "openid" in claims.get("scope", "").split()
                 and float(claims.get("exp", 0)) > time.time() and re.fullmatch(r"[a-zA-Z0-9-]{1,100}", claims.get("sub", "")))
    except (ValueError, TypeError):
        valid = False
    if not valid:
        raise Rejected(401, "Sign in again to continue.")
    return profile(store, claims["sub"])


def project_for(store, user, project_id):
    project = store.get("PROJECT#" + project_id, "METADATA")
    if (not project or project["workspaceId"] != user["workspaceId"]
            or project.get("ownerId" if user["role"] == "owner" else "clientId") != user["id"]):
        raise Rejected(404, "Project not found.")
    return project


def cursor_decode(raw, pk, prefix):
    if raw is None:
        return None
    try:
        if len(raw) > 1000 or not re.fullmatch(r"[A-Za-z0-9_-]+", raw):
            raise ValueError()
        value = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
        if set(value) != {"pk", "sk"} or value["pk"] != pk or not isinstance(value["sk"], str) or not value["sk"].startswith(prefix) or len(value["sk"]) > 150:
            raise ValueError()
        return value["sk"]
    except (ValueError, TypeError, KeyError):
        raise Rejected(400, "Invalid page cursor.")


def collection(store, user, kind, raw_cursor):
    is_clients = kind == "clients"
    if is_clients and user["role"] != "owner":
        raise Rejected(403, "Only the freelancer can view the client directory.")
    pk = ("WORKSPACE#" + user["workspaceId"]) if is_clients else ("USER#" + user["id"])
    prefix = "CLIENT#" if is_clients else "PROJECT#"
    pointers, last = store.query(pk, prefix, cursor_decode(raw_cursor, pk, prefix))
    result = []
    for pointer in pointers:
        try:
            if is_clients:
                client = profile(store, pointer["id"])
                if client["workspaceId"] == user["workspaceId"] and client["role"] == "client":
                    result.append(public_user(client))
            else:
                result.append(project_for(store, user, pointer["id"]))
        except Rejected:
            # Index rows are pointers, never authority; stale/revoked rows disclose nothing.
            continue
    cursor = base64.urlsafe_b64encode(canonical({"pk": pk, "sk": last}).encode()).decode().rstrip("=") if last else None
    return {"items": result, "nextCursor": cursor}


def create_project(event, user, store, config):
    if user["role"] != "owner":
        raise Rejected(403, "Only the freelancer can create projects.")
    headers = {key.lower(): value for key, value in event.get("headers", {}).items()}
    if headers.get("origin") != config["origin"]:
        raise Rejected(403, "Request origin is not allowed.")
    if headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        raise Rejected(415, "Send JSON.")
    key = headers.get("idempotency-key", "")
    if not re.fullmatch(r"[a-zA-Z0-9_-]{8,128}", key):
        raise Rejected(400, "A valid idempotency key is required.")
    raw = event.get("body") or ""
    if len(raw.encode()) > 22000:
        raise Rejected(413, "Request is too large.")
    try:
        raw = base64.b64decode(raw, validate=True).decode() if event.get("isBase64Encoded") else raw
        if len(raw.encode()) > 16000:
            raise Rejected(413, "Request is too large.")
        body = json.loads(raw)
        if not isinstance(body, dict) or set(body) != {"title", "description", "clientId"}:
            raise ValueError()
        for field, limit in (("title", 120), ("description", 1000), ("clientId", 100)):
            if not isinstance(body[field], str) or not 1 <= len(body[field].strip()) <= limit:
                raise ValueError()
        body = {field: value.strip() for field, value in body.items()}
        if not re.fullmatch(r"[a-zA-Z0-9-]+", body["clientId"]):
            raise ValueError()
    except (ValueError, TypeError, UnicodeError):
        raise Rejected(400, "Provide a project name, description and valid client.")
    # Recheck both participants even for idempotent replay.
    client = profile(store, body["clientId"])
    if client["role"] != "client" or client["workspaceId"] != user["workspaceId"]:
        raise Rejected(403, "Choose an active client in your workspace.")
    fingerprint = hashlib.sha256(canonical(body).encode()).hexdigest()
    replay_key = ("USER#" + user["id"], "IDEMPOTENCY#" + key)

    def replay(saved):
        if saved["fingerprint"] != fingerprint:
            raise Rejected(409, "This request key was already used for different content.")
        return project_for(store, user, saved["projectId"])

    previous = store.get(*replay_key)
    if previous:
        return replay(previous), 200
    project_id = str(uuid.uuid4())
    created = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    project = {"id": project_id, "workspaceId": user["workspaceId"], "ownerId": user["id"], **body,
               "scopeRevision": 0, "contextRevision": 0, "createdAt": created}
    checks = [("IDENTITY#" + p["id"], "PROFILE", p) for p in (user, client)]
    puts = [("PROJECT#" + project_id, "METADATA", project),
            ("USER#" + user["id"], "PROJECT#" + project_id, {"id": project_id}),
            ("USER#" + client["id"], "PROJECT#" + project_id, {"id": project_id}),
            ("PROJECT#" + project_id, "AUDIT#" + created, {"type": "project.created", "actorId": user["id"], "projectId": project_id, "createdAt": created}),
            (*replay_key, {"fingerprint": fingerprint, "projectId": project_id})]
    try:
        store.transact(checks, puts)
    except Conflict:
        # Concurrent revocation must also invalidate a concurrent replay.
        fresh_user, fresh_client = profile(store, user["id"]), profile(store, client["id"])
        if fresh_user != user or fresh_client != client:
            raise Rejected(409, "Workspace access changed. Reload before trying again.")
        previous = store.get(*replay_key)
        if previous:
            return replay(previous), 200
        raise Rejected(409, "Project creation conflicted. Reload before trying again.")
    return project, 201


def brief_key(version):
    return "BRIEF#%010d" % version


def brief_view(store, user, project_id):
    pk = "PROJECT#" + project_id
    # Multiple strongly consistent reads are not a snapshot. Verify pointers and
    # revisions again before returning content/status assembled across those reads.
    for _ in range(3):
        project = project_for(store, user, project_id)
        head = store.get(pk, "BRIEF_HEAD")
        pointers = head or {"version": 0, "published": 0, "approved": 0}
        version = pointers["version" if user["role"] == "owner" else "published"]
        latest = store.get(pk, brief_key(version)) if version else None
        baseline = store.get(pk, brief_key(pointers["approved"])) if pointers["approved"] else None
        if head == store.get(pk, "BRIEF_HEAD") and project == project_for(store, user, project_id):
            return {"project": project, "latest": latest, "baseline": baseline,
                    "canDecide": bool(latest and latest["status"] == "submitted" and latest["version"] == pointers["version"])}
    raise Rejected(409, "The brief changed while loading. Refresh to review it.")


def brief_history(store, user, project_id, raw_cursor):
    project_for(store, user, project_id)
    pk, prefix = "PROJECT#" + project_id, "BRIEF#"
    # Bind the cursor to the actor as well as the project and collection.
    cursor_pk = pk + ":" + user["id"]
    rows, last = store.query(pk, prefix, cursor_decode(raw_cursor, cursor_pk, prefix))
    visible = [row for row in rows if user["role"] == "owner" or row["status"] != "draft"]
    cursor = base64.urlsafe_b64encode(canonical({"pk": cursor_pk, "sk": last}).encode()).decode().rstrip("=") if last else None
    return {"items": visible, "nextCursor": cursor}


def brief_input(event, config):
    headers = {key.lower(): value for key, value in event.get("headers", {}).items()}
    if headers.get("origin") != config["origin"]:
        raise Rejected(403, "Request origin is not allowed.")
    if headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        raise Rejected(415, "Send JSON.")
    key = headers.get("idempotency-key", "")
    if not re.fullmatch(r"[a-zA-Z0-9_-]{8,128}", key):
        raise Rejected(400, "A valid idempotency key is required.")
    raw = event.get("body") or ""
    if len(raw.encode()) > 270000:
        raise Rejected(413, "Request is too large.")
    try:
        raw = base64.b64decode(raw, validate=True).decode() if event.get("isBase64Encoded") else raw
        if len(raw.encode()) > 200000:
            raise Rejected(413, "Keep the brief under 200 KB.")
        body = json.loads(raw)
        if not isinstance(body, dict):
            raise ValueError()
    except (ValueError, TypeError, UnicodeError):
        raise Rejected(400, "Provide valid brief JSON.")
    return body, key


def integer(value, minimum=0):
    return type(value) is int and minimum <= value <= 9999999999


def change_brief(event, user, store, config, project_id, action):
    project = project_for(store, user, project_id)
    if user["role"] != ("client" if action == "decide" else "owner"):
        raise Rejected(403, "Only the designated client can decide; only the freelancer can draft or submit.")
    body, request_key = brief_input(event, config)
    if action == "draft":
        if set(body) != {"expectedVersion", "paragraphs"} or not integer(body.get("expectedVersion")):
            raise Rejected(400, "Provide paragraphs and the expected version.")
        paragraphs = body["paragraphs"]
        if not isinstance(paragraphs, list) or not 1 <= len(paragraphs) <= 30:
            raise Rejected(400, "Provide between 1 and 30 paragraphs.")
        ids = set()
        for paragraph in paragraphs:
            if (not isinstance(paragraph, dict) or set(paragraph) != {"id", "text"}
                    or not isinstance(paragraph["id"], str) or not re.fullmatch(r"p-[a-zA-Z0-9-]{1,80}", paragraph["id"])
                    or paragraph["id"] in ids or not isinstance(paragraph["text"], str) or not 1 <= len(paragraph["text"].strip()) <= 4000):
                raise Rejected(400, "Each paragraph needs a unique ID and 1–4000 characters.")
            ids.add(paragraph["id"])
            paragraph["text"] = paragraph["text"].strip()
    else:
        fields = {"version", "hash"} | ({"decision", "expectedScopeRevision"} if action == "decide" else set())
        if (set(body) != fields or not integer(body.get("version"), 1)
                or not isinstance(body.get("hash"), str) or not re.fullmatch(r"[a-f0-9]{64}", body["hash"])):
            raise Rejected(400, "Provide the exact version and content hash.")
        if action == "decide" and (body["decision"] not in ("approve", "reject") or not integer(body["expectedScopeRevision"])):
            raise Rejected(400, "Provide a decision and the expected scope revision.")
    # Check both active participants, including on replays; token claims alone
    # never authorize a write. Transaction checks close the concurrent-revoke gap.
    participants = [profile(store, project[field]) for field in ("ownerId", "clientId")]
    if any(p["workspaceId"] != project["workspaceId"] or p["role"] != role for p, role in zip(participants, ("owner", "client"))):
        raise Rejected(403, "Project membership changed. Reload before trying again.")
    pk = "PROJECT#" + project_id
    replay_key = ("USER#" + user["id"], "BRIEF-REQUEST#" + request_key)
    fingerprint = hashlib.sha256(canonical({"project": project_id, "action": action, "body": body}).encode()).hexdigest()

    def replay(saved):
        if saved["fingerprint"] != fingerprint:
            raise Rejected(409, "This request key was already used for different content.")
        return saved["result"], 200

    previous = store.get(*replay_key)
    if previous:
        return replay(previous)
    head = store.get(pk, "BRIEF_HEAD")
    pointers = dict(head or {"version": 0, "published": 0, "approved": 0})
    changed_project = dict(project)
    created = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    event_id = str(uuid.uuid4())
    puts, replacements = [], []
    if action == "draft":
        if body["expectedVersion"] != pointers["version"]:
            raise Rejected(409, "A newer brief exists. Refresh before saving another version.")
        content = {"paragraphs": body["paragraphs"], "incorporatedChangeIds": []}
        # Canonical ASCII JSON can expand Unicode; keep every DynamoDB item
        # (including the idempotency result) safely below the 400 KB limit.
        if len(canonical(content).encode()) > 300000:
            raise Rejected(413, "Brief content is too large to save.")
        version = pointers["version"] + 1
        brief = {**content, "version": version, "hash": hashlib.sha256(canonical(content).encode()).hexdigest(),
                 "status": "draft", "createdAt": created, "createdBy": user["id"], "createdByName": user["name"]}
        pointers["version"] = version
        puts.append((pk, brief_key(version), brief))
    else:
        version = body["version"]
        target = store.get(pk, brief_key(version))
        if not target or (action == "decide" and target["status"] == "draft"):
            raise Rejected(404, "Submitted brief not found.")
        if version != pointers["version"] or target["hash"] != body["hash"] or target["status"] != ("draft" if action == "submit" else "submitted"):
            raise Rejected(409, "Only the exact latest version can be submitted or reviewed. Refresh first.")
        brief = dict(target)
        changed_project["contextRevision"] += 1
        if action == "submit":
            brief.update(status="submitted", submittedAt=created, submittedBy=user["id"])
            pointers["published"] = version
        else:
            if body["expectedScopeRevision"] != project["scopeRevision"]:
                raise Rejected(409, "Approved scope changed. Refresh and review it before deciding.")
            approval = {"id": event_id, "targetType": "brief", "targetId": "brief", **body,
                        "actorId": user["id"], "actorName": user["name"], "createdAt": created}
            brief.update(status="approved" if body["decision"] == "approve" else "rejected", approval=approval)
            if body["decision"] == "approve":
                pointers["approved"] = version
                changed_project["scopeRevision"] += 1
            puts.append((pk, "APPROVAL#" + event_id, approval))
        replacements.append((pk, brief_key(version), target, brief))
    audit = {"id": event_id, "type": "brief." + ("saved" if action == "draft" else brief["status"]),
             "actorId": user["id"], "actorName": user["name"], "projectId": project_id,
             "version": version, "hash": brief["hash"], "createdAt": created}
    puts.extend([(pk, "AUDIT#" + created + "#" + event_id, audit), (*replay_key, {"fingerprint": fingerprint, "result": brief})])
    replacements.extend([(pk, "METADATA", project, changed_project), (pk, "BRIEF_HEAD", head, pointers)])
    checks = [("IDENTITY#" + p["id"], "PROFILE", p) for p in participants]
    try:
        store.transact(checks, puts, replacements)
    except Conflict:
        fresh_project = project_for(store, profile(store, user["id"]), project_id)
        if any(profile(store, p["id"]) != p for p in participants) or any(fresh_project[k] != project[k] for k in ("ownerId", "clientId", "workspaceId")):
            raise Rejected(409, "Project membership changed. Reload before retrying.")
        previous = store.get(*replay_key)
        if previous:
            return replay(previous)
        raise Rejected(409, "The brief changed. Refresh and review the latest version.")
    return brief, 201 if action == "draft" else 200


def handle(event, store, config):
    try:
        user = identity(event, store, config)
        method = event.get("requestContext", {}).get("http", {}).get("method")
        path = event.get("rawPath", "")
        status = 200
        if method == "GET" and path == "/api/auth/me":
            body = public_user(user)
        elif method == "GET" and path in ("/api/projects", "/api/clients"):
            body = collection(store, user, path.rsplit("/", 1)[1], (event.get("queryStringParameters") or {}).get("cursor"))
        elif method == "GET" and re.fullmatch(r"/api/projects/[a-zA-Z0-9-]{1,100}", path):
            body = project_for(store, user, path.rsplit("/", 1)[1])
        elif method == "POST" and path == "/api/projects":
            body, status = create_project(event, user, store, config)
        elif re.fullmatch(r"/api/projects/[a-zA-Z0-9-]{1,100}/briefs(?:/(?:history|submit|decide))?", path):
            parts = path.split("/")
            project_id, action = parts[3], parts[5] if len(parts) > 5 else "draft"
            if method == "GET" and action == "draft":
                body = brief_view(store, user, project_id)
            elif method == "GET" and action == "history":
                body = brief_history(store, user, project_id, (event.get("queryStringParameters") or {}).get("cursor"))
            elif method == "POST" and action in ("draft", "submit", "decide"):
                body, status = change_brief(event, user, store, config, project_id, action)
            else:
                raise Rejected(404, "Route not found.")
        else:
            raise Rejected(404, "Route not found.")
    except Rejected as error:
        status, body = error.status, {"error": error.message}
    except Exception:
        # Never log request bodies, claims, tokens or raw AWS errors.
        print(json.dumps({"event": "request_failed", "requestId": event.get("requestContext", {}).get("requestId", "unknown")}))
        status, body = 503, {"error": "Service temporarily unavailable. Retry the same request."}
    return {"statusCode": status, "headers": {"content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff"}, "body": canonical(body)}


_store = None


def handler(event, context):
    global _store
    if _store is None:
        import boto3
        from botocore.config import Config
        _store = DynamoStore(boto3.client("dynamodb", config=Config(retries={"mode": "standard", "total_max_attempts": 2})), os.environ["TABLE"])
    return handle(event, _store, {"issuer": os.environ["ISSUER"], "clientId": os.environ["CLIENT_ID"], "origin": os.environ["WEB_ORIGIN"]})
