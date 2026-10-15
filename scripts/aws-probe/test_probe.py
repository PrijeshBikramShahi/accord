import importlib.util
import json
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

import probe
from template import build


class FakeClientError(Exception):
    def __init__(self, code, **extra):
        self.response = {"Error": {"Code": code}, **extra}


def load_worker():
    modules = {"boto3": types.SimpleNamespace(client=lambda *args, **kwargs: None), "botocore": types.ModuleType("botocore"), "botocore.config": types.SimpleNamespace(Config=lambda **kwargs: kwargs), "botocore.exceptions": types.SimpleNamespace(ClientError=FakeClientError)}
    spec = importlib.util.spec_from_file_location("probe_test_worker", Path(__file__).with_name("worker.py"))
    worker = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, modules):
        spec.loader.exec_module(worker)
    return worker


class ProbeTests(unittest.TestCase):
    def test_driver_runtime_checks_use_logs_wire_parameter_names(self):
        state = {"testRuns": 1}
        stack = {"Parameters": [{"ParameterKey": "Revision", "ParameterValue": "1"}]}
        outputs = {"Endpoint": "https://abc.execute-api.us-east-1.amazonaws.com", "UserPool": "pool", "UserPoolClient": "client", "Table": "table", "Bucket": "bucket", "LogGroup": "logs"}
        calls = []
        def aws(service, operation, data):
            calls.append((service, operation, data))
            if operation == "admin-initiate-auth":
                return {"AuthenticationResult": {"IdToken": "synthetic-token"}}
            if operation == "get-item":
                return {"Item": {"pk": data["Key"]["pk"]}}
            if operation == "describe-log-groups":
                self.assertEqual(data, {"logGroupNamePrefix": "logs"})
                return {"logGroups": [{"logGroupName": "logs", "retentionInDays": 1}]}
            if operation == "filter-log-events":
                self.assertEqual(data, {"logGroupName": "logs", "filterPattern": '"' + "a" * 32 + '"'})
                return {"events": [{"message": "synthetic probe completed"}]}
            return {}
        responses = [(401, b'{}'), (200, b'{"revision":"1"}'), (200, json.dumps({"ok": True, "id": "a" * 32, "key": "synthetic/a.txt", "version": "v1"}).encode()), (403, b'{}')]
        with patch.object(probe, "load", return_value=state), patch.object(probe, "ready", return_value=(stack, outputs)), patch.object(probe, "save"), patch.object(probe, "aws", side_effect=aws), patch.object(probe, "http", side_effect=responses), patch.object(probe.time, "sleep"), patch.object(probe, "record") as record:
            probe.test_probe()
            self.assertTrue(record.call_args.args[2]["logWritesAndRetention"])
        self.assertEqual(state["testRuns"], 2)
        self.assertEqual(calls[-1][1], "admin-delete-user")

    def test_cleanup_log_absence_check_uses_logs_wire_parameter_names(self):
        state = {"stackId": "owned-id"}
        before = [{"LogicalResourceId": "LogGroup", "PhysicalResourceId": "logs", "ResourceStatus": "CREATE_COMPLETE"}]
        after = [{"LogicalResourceId": "LogGroup", "PhysicalResourceId": "logs", "ResourceStatus": "DELETE_COMPLETE"}]
        def aws(service, operation, data):
            if operation == "describe-log-groups":
                self.assertEqual(data, {"logGroupNamePrefix": "logs"})
                return {"logGroups": []}
            self.assertEqual((service, operation, data), ("cloudformation", "delete-stack", {"StackName": "owned-id"}))
            return {}
        with patch.object(probe, "load", return_value=state), patch.object(probe, "owned_stack", return_value={"StackStatus": "CREATE_COMPLETE"}), patch.object(probe, "resources", side_effect=[before, after]), patch.object(probe, "wait_stack"), patch.object(probe, "aws", side_effect=aws), patch.object(probe, "record") as record:
            probe.cleanup()
            self.assertTrue(record.call_args.args[2]["logGroupAbsent"])

    def test_template_limits_and_authentication(self):
        template = build()
        resources = template["Resources"]
        self.assertLess(len(json.dumps(template).encode()), 51200)
        self.assertFalse(any(r["Type"].startswith("AWS::IAM::") for r in resources.values()))
        self.assertEqual(resources["Function"]["Properties"]["Role"], {"Ref": "LabRoleArn"})
        for name in ["GETRoute", "POSTRoute"]:
            self.assertEqual(resources[name]["Properties"]["AuthorizationType"], "JWT")
        self.assertGreaterEqual(resources["Queue"]["Properties"]["VisibilityTimeout"], resources["Function"]["Properties"]["Timeout"] * 6)
        self.assertEqual(resources["QueueMapping"]["Properties"]["ScalingConfig"]["MaximumConcurrency"], 2)
        self.assertTrue(all(resources["Bucket"]["Properties"]["PublicAccessBlockConfiguration"].values()))
        self.assertFalse(any(r.get("DeletionPolicy") == "Retain" for r in resources.values()))

    def test_ownership_mismatch_stops_cleanup_before_mutation(self):
        state = {"name": "accord-probe-123456789abc", "owner": "a" * 32, "stackId": "owned-id", "region": "us-east-1"}
        foreign = {"Stacks": [{"StackName": state["name"], "StackId": "owned-id", "Tags": [{"Key": "Purpose", "Value": probe.PURPOSE}, {"Key": "ProbeOwner", "Value": "different"}]}]}
        with patch.object(probe, "load", return_value=state), patch.object(probe, "aws", return_value=foreign) as call:
            with self.assertRaisesRegex(probe.ProbeError, "ownership"):
                probe.cleanup()
            self.assertEqual(call.call_count, 1)
            self.assertEqual(call.call_args.args[:2], ("cloudformation", "describe-stacks"))

    def test_version_cleanup_removes_versions_and_delete_markers(self):
        calls = []
        def aws(service, op, data):
            calls.append((op, data))
            if op == "delete-objects":
                return {}
            if len(calls) == 1:
                return {"Versions": [{"Key": "synthetic/a", "VersionId": "v1"}], "DeleteMarkers": [{"Key": "synthetic/a", "VersionId": "marker"}]}
            return {}
        with patch.object(probe, "aws", side_effect=aws):
            probe.empty_bucket("owned-bucket")
        self.assertEqual(calls[1][1]["Delete"]["Objects"], [{"Key": "synthetic/a", "VersionId": "v1"}, {"Key": "synthetic/a", "VersionId": "marker"}])

    def test_partial_delete_failure_is_not_reported_as_cleanup_success(self):
        with patch.object(probe, "aws", side_effect=[{"Versions": [{"Key": "a", "VersionId": "v1"}]}, {"Errors": [{"Code": "AccessDenied"}]}]):
            with self.assertRaisesRegex(probe.ProbeError, "incomplete"):
                probe.empty_bucket("owned-bucket")

    def test_redaction(self):
        self.assertEqual(probe.redact("arn:aws:iam::123456789012:role/LabRole 123456789012 https://example.com/token"), "[ARN] [ACCOUNT] [URL]")

    def test_worker_rejects_missing_authorizer_and_poison_has_no_write(self):
        worker = load_worker()
        client = types.SimpleNamespace()
        with patch.dict(os.environ, {"TABLE": "table", "REVISION": "1"}), patch.object(worker, "client", return_value=client):
            self.assertEqual(worker.handler({}, None)["statusCode"], 401)
            with self.assertRaisesRegex(ValueError, "Intentional"):
                worker.handler({"Records": [{"body": json.dumps({"id": "a" * 32, "kind": "poison"})}]}, None)

    def test_queue_duplicate_is_idempotent_but_other_errors_fail(self):
        worker = load_worker()
        event = {"Records": [{"body": json.dumps({"id": "a" * 32, "kind": "normal"})}]}
        def duplicate(**kwargs):
            raise FakeClientError("ConditionalCheckFailedException")
        def denied(**kwargs):
            raise FakeClientError("AccessDeniedException")
        with patch.dict(os.environ, {"TABLE": "table"}), patch.object(worker, "client", return_value=types.SimpleNamespace(put_item=duplicate)):
            self.assertEqual(worker.handler(event, None), {"ok": True})
        with patch.dict(os.environ, {"TABLE": "table"}), patch.object(worker, "client", return_value=types.SimpleNamespace(put_item=denied)):
            with self.assertRaises(FakeClientError):
                worker.handler(event, None)

    def test_api_exercises_conditional_transactions_and_versions(self):
        worker = load_worker()
        transactions = []
        sent = []
        def transaction(**kwargs):
            transactions.append(kwargs)
            if len(transactions) == 2:
                raise FakeClientError("TransactionCanceledException", CancellationReasons=[{"Code": "ConditionalCheckFailed"}])
        versions = {}
        def put_object(**kwargs):
            version = "v" + str(len(versions) + 1)
            versions[version] = kwargs["Body"]
            return {"VersionId": version}
        def get_object(**kwargs):
            value = versions[kwargs.get("VersionId", "v2")]
            return {"Body": types.SimpleNamespace(read=lambda: value)}
        clients = {"dynamodb": types.SimpleNamespace(transact_write_items=transaction), "s3": types.SimpleNamespace(put_object=put_object, get_object=get_object, delete_object=lambda **kwargs: {"DeleteMarker": True}), "sqs": types.SimpleNamespace(send_message=lambda **kwargs: sent.append(kwargs))}
        with patch.dict(os.environ, {"TABLE": "table", "BUCKET": "bucket", "QUEUE": "queue", "REVISION": "2"}), patch.object(worker, "client", side_effect=lambda service: clients[service]):
            result = worker.handler({"requestContext": {"authorizer": {"jwt": {"claims": {"sub": "test-user"}}}, "http": {"method": "POST"}}}, None)
        self.assertEqual(result["statusCode"], 200)
        body = json.loads(result["body"])
        self.assertEqual(body["revision"], "2")
        self.assertEqual(transactions[0], transactions[1])
        self.assertEqual(len(transactions[0]["TransactItems"]), 2)
        self.assertEqual(len(sent), 1)
        self.assertEqual(json.loads(sent[0]["MessageBody"])["id"], body["id"])


if __name__ == "__main__":
    unittest.main()
