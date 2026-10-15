#!/usr/bin/env python3
"""Run only in the user's AWS CloudShell. Local validation never calls AWS."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from template import build

HERE = Path(__file__).resolve().parent
STATE = HERE / ".probe-state.json"
REGION = "us-east-1"
PURPOSE = "accord-feasibility-probe"


class ProbeError(Exception):
    pass


class AwsError(ProbeError):
    def __init__(self, service, operation, code, detail):
        super().__init__(f"{service} {operation}: {code}: {redact(detail)}")
        self.code = code


def redact(value):
    text = re.sub(r"arn:aws[^\s\"',;)]+", "[ARN]", str(value))
    text = re.sub(r"https?://[^\s\"']+", "[URL]", text)
    return re.sub(r"\b\d{12}\b", "[ACCOUNT]", text)


def aws(service, operation, data=None):
    # Secrets such as one-time test passwords go into a private temporary file,
    # never command arguments, shell history, logs, reports or persistent state.
    with tempfile.TemporaryDirectory(prefix="accord-probe-") as directory:
        request = Path(directory) / "request.json"
        request.write_text(json.dumps(data or {}))
        request.chmod(0o600)
        result = subprocess.run(["aws", service, operation, "--region", REGION, "--cli-input-json", "file://" + str(request), "--output", "json", "--no-cli-pager", "--cli-connect-timeout", "10", "--cli-read-timeout", "30"], capture_output=True, text=True, timeout=70, env={**os.environ, "AWS_MAX_ATTEMPTS": "2", "AWS_RETRY_MODE": "standard"})
    if result.returncode:
        match = re.search(r"(?:An error occurred|error occurred) \(([^)]+)\)", result.stderr)
        raise AwsError(service, operation, match.group(1) if match else "CliError", result.stderr.strip())
    return json.loads(result.stdout) if result.stdout.strip() else {}


def save(state):
    tmp = STATE.with_suffix(".tmp")
    with os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as file:
        json.dump(state, file, indent=2)
    tmp.replace(STATE)


def load():
    if not STATE.exists():
        raise ProbeError("No probe state. Run create first; do not use existing stack names.")
    state = json.loads(STATE.read_text())
    if state.get("region") != REGION or not re.fullmatch(r"accord-probe-[a-f0-9]{12}", state.get("name", "")) or not re.fullmatch(r"[a-f0-9]{32}", state.get("owner", "")):
        raise ProbeError("Invalid local probe state; stopping.")
    return state


def owned_stack(state):
    try:
        result = aws("cloudformation", "describe-stacks", {"StackName": state.get("stackId", state["name"])})
    except AwsError as error:
        if error.code == "ValidationError" and "does not exist" in str(error):
            return None
        raise
    stack = result["Stacks"][0]
    tags = {t["Key"]: t["Value"] for t in stack.get("Tags", [])}
    if stack["StackName"] != state["name"] or tags.get("Purpose") != PURPOSE or tags.get("ProbeOwner") != state["owner"]:
        raise ProbeError("Stack ownership tags do not match; refusing any mutation.")
    if state.get("stackId") and state["stackId"] != stack["StackId"]:
        raise ProbeError("Stack ID changed; refusing any mutation.")
    if not state.get("stackId"):
        state["stackId"] = stack["StackId"]
        save(state)
    return stack


def wait_stack(state, desired, seconds=600):
    deadline = time.monotonic() + seconds
    last = None
    while time.monotonic() < deadline:
        stack = owned_stack(state)
        if stack is None:
            if desired == "DELETE_COMPLETE":
                return None
            raise ProbeError("Probe stack was not found; run status and inspect the create result.")
        status = stack["StackStatus"]
        if status != last:
            print(status, flush=True)
            last = status
        if status == desired:
            return stack
        if status.endswith("FAILED") or status in ("ROLLBACK_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "DELETE_COMPLETE"):
            raise ProbeError(f"Stack reached {status}. Run status, then cleanup if appropriate.")
        time.sleep(5)
    raise ProbeError("Timed out waiting. State was saved; run status before retrying or cleaning up.")


def resources(state):
    result = []
    token = None
    while True:
        data = {"StackName": state["stackId"]}
        if token:
            data["NextToken"] = token
        page = aws("cloudformation", "list-stack-resources", data)
        result.extend(page.get("StackResourceSummaries", []))
        token = page.get("NextToken")
        if not token:
            return result


def record(state, step, checks):
    report_path = HERE / "probe-results.json"
    report = json.loads(report_path.read_text()) if report_path.exists() else {"stackName": state["name"], "region": REGION, "steps": []}
    if report.get("stackName") != state["name"]:
        raise ProbeError("Report belongs to another probe.")
    report["steps"].append({"step": step, "timeUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "checks": checks})
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"step": step, "checks": checks}, indent=2), flush=True)


def create():
    if STATE.exists():
        raise ProbeError("State already exists. Run status or cleanup; this tool never adopts existing resources.")
    role = aws("iam", "get-role", {"RoleName": "LabRole"})["Role"]["Arn"]
    template = build()
    body = json.dumps(template)
    aws("cloudformation", "validate-template", {"TemplateBody": body})
    state = {"name": "accord-probe-" + uuid.uuid4().hex[:12], "owner": uuid.uuid4().hex, "region": REGION, "revision": "1", "testRuns": 0, "dlqRuns": 0, "templateHash": hashlib.sha256(body.encode()).hexdigest()}
    # Persist the ownership token BEFORE the request so interrupted creates can
    # be recovered by name plus exact tags, never by name alone.
    save(state)
    created = aws("cloudformation", "create-stack", {"StackName": state["name"], "TemplateBody": body, "RoleARN": role, "Parameters": [{"ParameterKey": "LabRoleArn", "ParameterValue": role}, {"ParameterKey": "Revision", "ParameterValue": "1"}], "Tags": [{"Key": "Purpose", "Value": PURPOSE}, {"Key": "ProbeOwner", "Value": state["owner"]}], "TimeoutInMinutes": 10, "ClientRequestToken": state["owner"]})
    state["stackId"] = created["StackId"]
    save(state)
    wait_stack(state, "CREATE_COMPLETE")
    record(state, "create", {"stackCreated": True})


def ready(state):
    stack = owned_stack(state)
    if not stack or stack["StackStatus"] not in ("CREATE_COMPLETE", "UPDATE_COMPLETE"):
        raise ProbeError("Stack is not ready. Run status.")
    return stack, {o["OutputKey"]: o["OutputValue"] for o in stack["Outputs"]}


def http(url, token=None, method="GET"):
    headers = {"Authorization": "Bearer " + token} if token else {}
    request = urllib.request.Request(url, data=b"{}" if method == "POST" else None, headers={**headers, "Content-Type": "application/json"}, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as result:
            return result.status, result.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def expect(condition, message):
    if not condition:
        raise ProbeError(message)


def test_probe():
    state = load()
    stack, outputs = ready(state)
    expect(state["testRuns"] < 3, "Three test runs already reserved. Inspect the report; clean up before starting a new probe.")
    state["testRuns"] += 1
    save(state)
    endpoint = outputs["Endpoint"]
    expect(re.fullmatch(r"https://[a-z0-9]+\.execute-api\.us-east-1\.amazonaws\.com", endpoint), "Unexpected API endpoint.")
    status, _ = http(endpoint + "/probe")
    expect(status == 401, f"Unauthenticated API returned {status}; expected 401.")
    user = "probe-" + uuid.uuid4().hex[:12]
    password = secrets.token_urlsafe(28) + "aA1!"
    created_user = False
    try:
        aws("cognito-idp", "admin-create-user", {"UserPoolId": outputs["UserPool"], "Username": user, "MessageAction": "SUPPRESS"})
        created_user = True
        aws("cognito-idp", "admin-set-user-password", {"UserPoolId": outputs["UserPool"], "Username": user, "Password": password, "Permanent": True})
        auth = aws("cognito-idp", "admin-initiate-auth", {"UserPoolId": outputs["UserPool"], "ClientId": outputs["UserPoolClient"], "AuthFlow": "ADMIN_USER_PASSWORD_AUTH", "AuthParameters": {"USERNAME": user, "PASSWORD": password}})
        token = auth.get("AuthenticationResult", {}).get("IdToken")
        expect(bool(token), "Cognito did not issue an ID token.")
        status, raw = http(endpoint + "/probe", token)
        expected_revision = next(p["ParameterValue"] for p in stack["Parameters"] if p["ParameterKey"] == "Revision")
        expect(status == 200 and json.loads(raw).get("revision") == expected_revision, f"Authenticated GET failed: HTTP {status}.")
        time.sleep(2)  # Respect the intentionally low API throttle.
        status, raw = http(endpoint + "/probe", token, "POST")
        body = json.loads(raw)
        expect(status == 200 and body.get("ok"), f"Worker probe failed: HTTP {status}; {body.get('error', 'unexpected response')}.")
        probe_id = body["id"]
        # Read both transaction rows independently; a partial commit cannot pass.
        for prefix in ["decision#", "task#"]:
            row = aws("dynamodb", "get-item", {"TableName": outputs["Table"], "Key": {"pk": {"S": prefix + probe_id}}, "ConsistentRead": True})
            expect(bool(row.get("Item")), "A transaction row is missing.")
        # GET an existing version without credentials: deletion of the latest
        # version must not turn this into a meaningless test of a missing key.
        object_url = "https://" + outputs["Bucket"] + ".s3.us-east-1.amazonaws.com/" + urllib.parse.quote(body["key"]) + "?versionId=" + urllib.parse.quote(body["version"])
        status, _ = http(object_url)
        expect(status == 403, f"Anonymous object access returned {status}; expected 403.")
        deadline = time.monotonic() + 120
        while True:
            row = aws("dynamodb", "get-item", {"TableName": outputs["Table"], "Key": {"pk": {"S": "queue#" + probe_id}}, "ConsistentRead": True})
            if row.get("Item"):
                break
            expect(time.monotonic() < deadline, "Queue processing not observed within 120 seconds.")
            print("Waiting for queue processing...", flush=True)
            time.sleep(10)
        groups = aws("logs", "describe-log-groups", {"logGroupNamePrefix": outputs["LogGroup"]})["logGroups"]
        expect(any(g["logGroupName"] == outputs["LogGroup"] and g.get("retentionInDays") == 1 for g in groups), "One-day log retention not verified.")
        # Log ingestion is asynchronous; allow it to settle before reporting proof.
        deadline = time.monotonic() + 60
        while True:
            events = aws("logs", "filter-log-events", {"logGroupName": outputs["LogGroup"], "filterPattern": '"' + probe_id + '"'})
            if events.get("events"):
                break
            expect(time.monotonic() < deadline, "Probe log writes not observed within 60 seconds.")
            time.sleep(5)
        record(state, "test", {"revision": expected_revision, "unauthenticatedRejected": True, "cognitoTokenIssued": True, "authenticatedApi": True, "atomicConditionalTransaction": True, "duplicateRejected": True, "versionedFileRoundTrip": True, "deleteMarker": True, "anonymousFileRejected": True, "queueWorker": True, "logWritesAndRetention": True, "browserLogin": "not tested", "bedrock": "not tested"})
    finally:
        if created_user:
            aws("cognito-idp", "admin-delete-user", {"UserPoolId": outputs["UserPool"], "Username": user})


def test_dlq():
    state = load()
    _, outputs = ready(state)
    expect(state["dlqRuns"] < 1, "DLQ test already reserved; inspect its result or clean up.")
    state["dlqRuns"] += 1
    save(state)
    probe_id = uuid.uuid4().hex
    aws("sqs", "send-message", {"QueueUrl": outputs["Queue"], "MessageBody": json.dumps({"id": probe_id, "kind": "poison"})})
    deadline = time.monotonic() + 360
    while time.monotonic() < deadline:
        page = aws("sqs", "receive-message", {"QueueUrl": outputs["DeadLetterQueue"], "MaxNumberOfMessages": 10, "WaitTimeSeconds": 10, "VisibilityTimeout": 15})
        for message in page.get("Messages", []):
            if json.loads(message["Body"]).get("id") == probe_id:
                aws("sqs", "delete-message", {"QueueUrl": outputs["DeadLetterQueue"], "ReceiptHandle": message["ReceiptHandle"]})
                record(state, "test-dlq", {"failedMessageReachedDlq": True, "dlqMessageRemoved": True})
                return
        print("Waiting for the intentional failure to reach the DLQ...", flush=True)
    raise ProbeError("DLQ arrival not observed within six minutes. Clean up; do not report this as passed.")


def update():
    state = load()
    stack, _ = ready(state)
    current = next(p["ParameterValue"] for p in stack["Parameters"] if p["ParameterKey"] == "Revision")
    expect(current == "1", "Probe has already been updated; use test to verify revision 2.")
    aws("cloudformation", "update-stack", {"StackName": state["stackId"], "UsePreviousTemplate": True, "Parameters": [{"ParameterKey": "LabRoleArn", "UsePreviousValue": True}, {"ParameterKey": "Revision", "ParameterValue": "2"}]})
    wait_stack(state, "UPDATE_COMPLETE")
    state["revision"] = "2"
    save(state)
    record(state, "update", {"stackUpdated": True, "revision": "2", "runtimeVerification": "run test next"})


def status():
    state = load()
    stack = owned_stack(state)
    print("Stack:", state["name"], "Status:", stack["StackStatus"] if stack else "not found")
    if not stack:
        return
    events = aws("cloudformation", "describe-stack-events", {"StackName": state["stackId"]})
    for event in events.get("StackEvents", [])[:20]:
        print(event["LogicalResourceId"], event["ResourceStatus"], redact(event.get("ResourceStatusReason", "")))


def empty_bucket(bucket):
    while True:
        page = aws("s3api", "list-object-versions", {"Bucket": bucket, "MaxKeys": 1000})
        objects = [{"Key": item["Key"], "VersionId": item["VersionId"]} for key in ["Versions", "DeleteMarkers"] for item in page.get(key, [])][:1000]
        if not objects:
            return
        result = aws("s3api", "delete-objects", {"Bucket": bucket, "Delete": {"Objects": objects, "Quiet": True}})
        expect(not result.get("Errors"), "Could not remove all probe object versions. Cleanup is incomplete.")


def cleanup():
    state = load()
    stack = owned_stack(state)
    if not stack:
        # If CreateStack failed before accepting, there is no stack to own/delete.
        record(state, "cleanup", {"stackNotFound": True, "note": "No deletion performed; retain state for audit."})
        return
    if stack["StackStatus"] == "DELETE_COMPLETE":
        record(state, "cleanup", {"stackDeleted": True})
        return
    expect(not stack["StackStatus"].endswith("IN_PROGRESS"), "Stack operation still running. Use status and wait before cleanup.")
    existing = resources(state)
    owned = {r["LogicalResourceId"]: r.get("PhysicalResourceId") for r in existing if r["ResourceStatus"] != "DELETE_COMPLETE"}
    mapping = owned.get("QueueMapping")
    if mapping:
        try:
            aws("lambda", "update-event-source-mapping", {"UUID": mapping, "Enabled": False})
            deadline = time.monotonic() + 120
            while True:
                value = aws("lambda", "get-event-source-mapping", {"UUID": mapping})
                if value["State"] == "Disabled":
                    break
                expect(time.monotonic() < deadline, "Queue mapping did not stop. Retry cleanup after it settles.")
                time.sleep(5)
            time.sleep(16)  # Let any 15-second in-flight worker finish.
        except AwsError as error:
            if error.code != "ResourceNotFoundException":
                raise
    bucket = owned.get("Bucket")
    if bucket:
        try:
            empty_bucket(bucket)
        except AwsError as error:
            if error.code != "NoSuchBucket":
                raise
    aws("cloudformation", "delete-stack", {"StackName": state["stackId"]})
    wait_stack(state, "DELETE_COMPLETE")
    remaining = [r["LogicalResourceId"] for r in resources(state) if r["ResourceStatus"] != "DELETE_COMPLETE"]
    expect(not remaining, "CloudFormation still reports resources: " + ", ".join(remaining))
    # Verify physical deletion of the versioned bucket and logs independently.
    if bucket:
        try:
            aws("s3api", "head-bucket", {"Bucket": bucket})
        except AwsError as error:
            expect(error.code in ("404", "NoSuchBucket", "NotFound"), "Bucket absence not established: " + error.code)
        else:
            raise ProbeError("Probe bucket still exists after stack deletion.")
    logs = owned.get("LogGroup")
    if logs:
        groups = aws("logs", "describe-log-groups", {"logGroupNamePrefix": logs})["logGroups"]
        expect(not any(g["logGroupName"] == logs for g in groups), "Probe log group still exists.")
    record(state, "cleanup", {"stackDeleted": True, "allStackResourcesDeleteComplete": True, "bucketAbsent": bool(bucket), "logGroupAbsent": bool(logs), "billingReconciliation": "pending user balance check"})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["validate-local", "create", "status", "test", "test-dlq", "update", "cleanup"])
    command = parser.parse_args().command
    if command == "validate-local":
        template = build()
        expect(len(json.dumps(template).encode()) < 51200, "Template exceeds inline size limit.")
        expect(not any(r["Type"].startswith("AWS::IAM::") for r in template["Resources"].values()), "Unexpected IAM resource.")
        print(f"Local template checks passed: {len(template['Resources'])} resources; no AWS calls made.")
        return
    with (HERE / ".probe.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ProbeError("Another probe command is running in this directory.")
        {"create": create, "status": status, "test": test_probe, "test-dlq": test_dlq, "update": update, "cleanup": cleanup}[command]()


if __name__ == "__main__":
    try:
        main()
    except (ProbeError, subprocess.TimeoutExpired, urllib.error.URLError, OSError, ValueError, KeyError) as error:
        print("STOP:", redact(error), file=sys.stderr)
        print("Do not change IAM permissions. Keep this folder and run status; cleanup is available for this probe only.", file=sys.stderr)
        sys.exit(1)
