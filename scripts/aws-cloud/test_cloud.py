import contextlib
import io
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

import cloud
from template import build


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        for name, value in [("HERE", self.directory), ("STATE", self.directory / ".cloud-state.json"), ("ACCOUNTS", self.directory / "demo-accounts.json")]:
            p = patch.object(cloud, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.state = {"name": "accord-cloud-123456789abc", "owner": "a" * 32, "region": "us-east-1", "stackId": "owned-stack"}
        self.stack = {"StackName": self.state["name"], "StackId": "owned-stack", "StackStatus": "CREATE_COMPLETE", "Tags": [{"Key": "Purpose", "Value": cloud.PURPOSE}, {"Key": "AccordOwner", "Value": self.state["owner"]}]}
        self.outputs = {"Table": "owned-table", "UserPool": "owned-pool", "UserPoolClient": "client", "Endpoint": "endpoint", "LoginDomain": "domain", "Issuer": "issuer"}

    def test_template_has_no_new_roles_and_requires_access_token_scope_everywhere(self):
        template = build()
        resources = template["Resources"]
        self.assertLess(len(json.dumps(template).encode()), 51200)
        self.assertFalse(any(r["Type"].startswith("AWS::IAM::") for r in resources.values()))
        self.assertEqual(resources["Function"]["Properties"]["Role"], {"Ref": "LabRoleArn"})
        routes = [r["Properties"] for r in resources.values() if r["Type"] == "AWS::ApiGatewayV2::Route"]
        self.assertEqual(len(routes), 10)
        for route in routes:
            self.assertEqual(route["AuthorizationType"], "JWT")
            self.assertEqual(route["AuthorizationScopes"], ["openid"])
        client = resources["UserPoolClient"]["Properties"]
        self.assertFalse(client["GenerateSecret"])
        self.assertEqual(client["AllowedOAuthFlows"], ["code"])
        self.assertEqual(client["CallbackURLs"], ["http://localhost:5174/callback"])
        self.assertEqual(resources["Api"]["Properties"]["CorsConfiguration"]["AllowOrigins"], ["http://localhost:5174"])
        self.assertEqual(resources["UserPoolDomain"]["Properties"]["ManagedLoginVersion"], 1)
        self.assertEqual(resources["UserPool"]["Properties"]["AdminCreateUserConfig"], {"AllowAdminCreateUserOnly": True})

    def test_update_preserves_stack_parameters_data_and_identity(self):
        cloud.private_json(cloud.STATE, self.state)
        current = build()
        current["Resources"]["Function"]["Properties"]["Code"]["ZipFile"] = "# old code"
        for name in ("BriefRoute", "BriefHistoryRoute", "SaveBriefRoute", "SubmitBriefRoute", "DecideBriefRoute"):
            del current["Resources"][name]
        def aws(service, operation, data):
            if operation == "get-template":
                return {"TemplateBody": json.dumps(current)}
            return {}
        with patch.object(cloud, "owned", return_value=self.stack), patch.object(cloud, "aws", side_effect=aws) as calls, patch.object(cloud, "wait") as wait, contextlib.redirect_stdout(io.StringIO()):
            cloud.update()
        updates = [call.args[2] for call in calls.call_args_list if call.args[1] == "update-stack"]
        self.assertEqual(len(updates), 1)
        self.assertEqual(updates[0]["StackName"], self.state["stackId"])
        self.assertEqual(updates[0]["Parameters"], [{"ParameterKey": "LabRoleArn", "UsePreviousValue": True}])
        self.assertNotIn("RoleARN", updates[0])
        self.assertFalse(any(call.args[0] in ("cognito-idp", "dynamodb", "iam") for call in calls.call_args_list))
        wait.assert_called_once_with(self.state, "UPDATE_COMPLETE")

    def test_update_noop_does_not_submit_again(self):
        cloud.private_json(cloud.STATE, self.state)
        with patch.object(cloud, "owned", return_value=self.stack), patch.object(cloud, "aws", return_value={"TemplateBody": build()}) as aws, contextlib.redirect_stdout(io.StringIO()):
            cloud.update()
        self.assertEqual([call.args[1] for call in aws.call_args_list], ["get-template"])

    def test_update_refuses_protected_resource_change_and_unexpected_addition(self):
        cloud.private_json(cloud.STATE, self.state)
        for change in ("table", "delete", "new-resource", "unauthenticated"):
            future = build()
            if change == "table":
                future["Resources"]["Table"]["Properties"]["BillingMode"] = "PROVISIONED"
            elif change == "delete":
                del future["Resources"]["UserPool"]
            elif change == "new-resource":
                future["Resources"]["Bucket"] = {"Type": "AWS::S3::Bucket", "Properties": {}}
            else:
                future["Resources"]["PublicRoute"] = {"Type": "AWS::ApiGatewayV2::Route", "Properties": {"AuthorizationType": "NONE"}}
            with patch.object(cloud, "owned", return_value=self.stack), patch.object(cloud, "aws", return_value={"TemplateBody": build()}) as aws, patch.object(cloud, "build", return_value=future), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(cloud.Stop):
                    cloud.update()
            self.assertEqual([call.args[1] for call in aws.call_args_list], ["get-template"])

    def test_foreign_stack_prevents_update(self):
        cloud.private_json(cloud.STATE, self.state)
        self.stack["Tags"][1]["Value"] = "foreign"
        with patch.object(cloud, "aws", return_value={"Stacks": [self.stack]}) as aws:
            with self.assertRaisesRegex(cloud.Stop, "ownership"):
                cloud.update()
        self.assertEqual([call.args[1] for call in aws.call_args_list], ["describe-stacks"])

    def test_update_resumes_pending_operation_and_refuses_failed_stack(self):
        cloud.private_json(cloud.STATE, self.state)
        self.stack["StackStatus"] = "UPDATE_IN_PROGRESS"
        with patch.object(cloud, "owned", return_value=self.stack), patch.object(cloud, "wait") as wait, patch.object(cloud, "aws", side_effect=AssertionError("unexpected mutation")), contextlib.redirect_stdout(io.StringIO()):
            cloud.update()
        wait.assert_called_once_with(self.state, "UPDATE_COMPLETE")
        self.stack["StackStatus"] = "UPDATE_ROLLBACK_FAILED"
        with patch.object(cloud, "owned", return_value=self.stack), patch.object(cloud, "aws", side_effect=AssertionError("unexpected mutation")):
            with self.assertRaisesRegex(cloud.Stop, "not ready"):
                cloud.update()

    def test_local_validation_never_calls_aws(self):
        with patch.object(cloud, "aws", side_effect=AssertionError("AWS called")), contextlib.redirect_stdout(io.StringIO()):
            cloud.validate()

    def test_foreign_stack_tags_prevent_cleanup(self):
        self.stack["Tags"][1]["Value"] = "foreign"
        cloud.private_json(cloud.STATE, self.state)
        with patch.object(cloud, "aws", return_value={"Stacks": [self.stack]}) as aws:
            with self.assertRaisesRegex(cloud.Stop, "ownership"):
                cloud.cleanup(self.state["name"])
        self.assertEqual(aws.call_count, 1)
        self.assertEqual(aws.call_args.args[1], "describe-stacks")

    def test_cleanup_needs_exact_stack_name_before_any_aws_call(self):
        cloud.private_json(cloud.STATE, self.state)
        with patch.object(cloud, "aws", side_effect=AssertionError("AWS called")):
            with self.assertRaisesRegex(cloud.Stop, "deletes"):
                cloud.cleanup("wrong-name")

    def test_existing_state_prevents_duplicate_stack_creation(self):
        cloud.private_json(cloud.STATE, self.state)
        with patch.object(cloud, "aws", side_effect=AssertionError("AWS called")):
            with self.assertRaisesRegex(cloud.Stop, "already exists"):
                cloud.create()

    def test_seed_is_atomic_private_and_second_run_preserves_accounts(self):
        calls = []
        def aws(service, operation, data):
            calls.append((service, operation, data))
            if operation == "admin-get-user":
                return {"UserAttributes": [{"Name": "sub", "Value": "sub-" + data["Username"]}]}
            return {}
        cloud.private_json(cloud.STATE, self.state)
        with patch.object(cloud, "ready", return_value=self.outputs), patch.object(cloud, "aws", side_effect=aws), contextlib.redirect_stdout(io.StringIO()) as output:
            cloud.seed()
            accounts = json.loads(cloud.ACCOUNTS.read_text())
            self.assertEqual(cloud.ACCOUNTS.stat().st_mode & 0o777, 0o600)
            self.assertEqual(len(accounts["accounts"]), 3)
            for account in accounts["accounts"]:
                self.assertNotIn(account["password"], output.getvalue())
                self.assertNotIn(account["password"], cloud.STATE.read_text())
            transactions = [data for service, op, data in calls if op == "transact-write-items"]
            self.assertEqual(len(transactions), 1)
            actions = transactions[0]["TransactItems"]
            self.assertEqual(len(actions), 14)
            self.assertTrue(all(a["Put"]["ConditionExpression"] == "attribute_not_exists(pk)" for a in actions))
            self.assertTrue(all(a["Put"]["TableName"] == "owned-table" for a in actions))
            count = len(calls)
            cloud.seed()
            self.assertEqual(len(calls), count)

    def test_interrupted_seed_recovers_marker_without_resetting_credentials(self):
        cloud.private_json(cloud.STATE, self.state)
        marker = {"Item": {"data": {"S": json.dumps({"owner": self.state["owner"]})}}}
        with patch.object(cloud, "ready", return_value=self.outputs), patch.object(cloud, "aws", return_value=marker) as aws, contextlib.redirect_stdout(io.StringIO()):
            cloud.seed()
        self.assertEqual(aws.call_count, 1)
        self.assertEqual(aws.call_args.args[1], "get-item")
        self.assertTrue(json.loads(cloud.STATE.read_text())["seeded"])

    def test_config_contains_only_public_fields(self):
        cloud.private_json(cloud.STATE, self.state)
        with patch.object(cloud, "ready", return_value=self.outputs), contextlib.redirect_stdout(io.StringIO()):
            cloud.config()
        value = json.loads((self.directory / "cloud-config.json").read_text())
        self.assertEqual(set(value), {"apiUrl", "authDomain", "clientId", "issuer", "redirectUri", "logoutUri"})
        self.assertEqual(value["redirectUri"], "http://localhost:5174/callback")

    def test_cli_secrets_are_private_files_not_arguments_and_errors_are_redacted(self):
        def run(args, **kwargs):
            self.assertNotIn("test-password", str(args))
            path = Path(args[args.index("--cli-input-json") + 1].removeprefix("file://"))
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(path.read_text()), {"Password": "test-password"})
            return types.SimpleNamespace(returncode=1, stderr="An error occurred (AccessDeniedException) with test-password", stdout="")
        with patch.object(cloud.subprocess, "run", side_effect=run):
            with self.assertRaises(cloud.AwsError) as error:
                cloud.aws("cognito-idp", "admin-set-user-password", {"Password": "test-password"})
        self.assertEqual(error.exception.code, "AccessDeniedException")
        self.assertNotIn("test-password", str(error.exception))

    def test_cleanup_checks_every_deleted_resource_and_removes_password_file(self):
        cloud.private_json(cloud.STATE, self.state)
        cloud.private_json(cloud.ACCOUNTS, {"password": "synthetic"})
        calls = []
        def aws(service, operation, data):
            calls.append((operation, data))
            if operation == "list-stack-resources":
                return {"StackResourceSummaries": [{"ResourceStatus": "DELETE_COMPLETE"}]}
            return {}
        with patch.object(cloud, "owned", return_value=self.stack), patch.object(cloud, "wait"), patch.object(cloud, "aws", side_effect=aws), contextlib.redirect_stdout(io.StringIO()):
            cloud.cleanup(self.state["name"])
        self.assertEqual(calls[0], ("delete-stack", {"StackName": "owned-stack"}))
        self.assertFalse(cloud.ACCOUNTS.exists())
        self.assertTrue(json.loads(cloud.STATE.read_text())["deleted"])


if __name__ == "__main__":
    unittest.main()
