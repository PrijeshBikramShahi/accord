#!/usr/bin/env python3
"""User-operated CloudShell deployment. No AWS calls during validate-local/package."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
import time
import uuid

from template import build

HERE = Path(__file__).resolve().parent
STATE = HERE / ".cloud-state.json"
ACCOUNTS = HERE / "demo-accounts.json"
REGION = "us-east-1"
PURPOSE = "accord-cloud-foundation"


class Stop(Exception):
    pass


class AwsError(Stop):
    def __init__(self, service, operation, code):
        self.code = code
        # Raw service messages may contain credentials, account IDs or URLs.
        super().__init__(f"{service} {operation}: {code}. Run status; do not change IAM permissions.")


def aws(service, operation, data=None):
    with tempfile.TemporaryDirectory(prefix="accord-cloud-") as directory:
        request = Path(directory) / "request.json"
        private_json(request, data or {})
        result = subprocess.run(["aws", service, operation, "--region", REGION, "--cli-input-json", "file://" + str(request), "--output", "json", "--no-cli-pager", "--cli-connect-timeout", "10", "--cli-read-timeout", "30"], capture_output=True, text=True, timeout=70, env={**os.environ, "AWS_MAX_ATTEMPTS": "2", "AWS_RETRY_MODE": "standard"})
    if result.returncode:
        match = re.search(r"error occurred \(([^)]+)\)", result.stderr)
        raise AwsError(service, operation, match.group(1) if match else "CliError")
    return json.loads(result.stdout) if result.stdout.strip() else {}


def private_json(path, value):
    tmp = path.with_suffix(".tmp")
    with os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as file:
        os.fchmod(file.fileno(), 0o600)
        json.dump(value, file, indent=2)
    tmp.replace(path)


def load():
    if not STATE.exists():
        raise Stop("No saved cloud stack. Run create first.")
    state = json.loads(STATE.read_text())
    if state.get("region") != REGION or not re.fullmatch(r"accord-cloud-[a-f0-9]{12}", state.get("name", "")) or not re.fullmatch(r"[a-f0-9]{32}", state.get("owner", "")):
        raise Stop("Invalid saved state; refusing to continue.")
    return state


def owned(state):
    stack = aws("cloudformation", "describe-stacks", {"StackName": state.get("stackId", state["name"])})["Stacks"][0]
    tags = {entry["Key"]: entry["Value"] for entry in stack.get("Tags", [])}
    if stack["StackName"] != state["name"] or tags.get("Purpose") != PURPOSE or tags.get("AccordOwner") != state["owner"] or (state.get("stackId") and state["stackId"] != stack["StackId"]):
        raise Stop("Stack ownership does not match. No mutation allowed.")
    state["stackId"] = stack["StackId"]
    private_json(STATE, state)
    return stack


def wait(state, target):
    deadline, previous = time.monotonic() + 900, None
    while time.monotonic() < deadline:
        stack = owned(state)
        status = stack["StackStatus"]
        if status != previous:
            print(status, flush=True)
            previous = status
        if status == target:
            return stack
        if not status.endswith("IN_PROGRESS"):
            raise Stop(f"Stack reached {status}; run status before proceeding.")
        time.sleep(5)
    raise Stop("Wait timed out. State is saved; run status before retrying.")


def ready(state):
    stack = owned(state)
    if stack["StackStatus"] not in ("CREATE_COMPLETE", "UPDATE_COMPLETE"):
        raise Stop("Stack is not ready. Run status.")
    return {output["OutputKey"]: output["OutputValue"] for output in stack["Outputs"]}


def validate():
    template = build()
    size = len(json.dumps(template).encode())
    if size > 51200 or any(r["Type"].startswith("AWS::IAM::") for r in template["Resources"].values()):
        raise Stop("Template exceeds inline limit or creates IAM resources.")
    compile(template["Resources"]["Function"]["Properties"]["Code"]["ZipFile"], "handler.py", "exec")
    print(f"Local checks passed: {len(template['Resources'])} resources; {size} template bytes; no AWS calls.")


def create():
    if STATE.exists():
        raise Stop("Saved state already exists. Run status; never overwrite it to create another stack.")
    validate()
    body = json.dumps(build())
    role = aws("iam", "get-role", {"RoleName": "LabRole"})["Role"]["Arn"]
    aws("cloudformation", "validate-template", {"TemplateBody": body})
    state = {"name": "accord-cloud-" + uuid.uuid4().hex[:12], "owner": uuid.uuid4().hex, "region": REGION}
    private_json(STATE, state)
    result = aws("cloudformation", "create-stack", {"StackName": state["name"], "TemplateBody": body, "RoleARN": role, "Parameters": [{"ParameterKey": "LabRoleArn", "ParameterValue": role}], "Tags": [{"Key": "Purpose", "Value": PURPOSE}, {"Key": "AccordOwner", "Value": state["owner"]}], "TimeoutInMinutes": 15, "ClientRequestToken": state["owner"]})
    state["stackId"] = result["StackId"]
    private_json(STATE, state)
    wait(state, "CREATE_COMPLETE")
    print("Stack created. Next: python3 cloud.py seed")


def update():
    state = load()
    stack = owned(state)
    if stack["StackStatus"] in ("UPDATE_IN_PROGRESS", "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS"):
        wait(state, "UPDATE_COMPLETE")
        print("Existing update completed. Run update again to check this package's template.")
        return
    if stack["StackStatus"] not in ("CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"):
        raise Stop("Stack is not ready for an update. Run status.")
    validate()
    template = build()
    current = aws("cloudformation", "get-template", {"StackName": state["stackId"], "TemplateStage": "Original"})["TemplateBody"]
    current = json.loads(current) if isinstance(current, str) else current
    # This increment may change Lambda code and add authenticated routes only.
    # Refuse removal/replacement or identity/storage changes in future packages.
    for name, resource in current["Resources"].items():
        replacement = template["Resources"].get(name)
        if name == "Function" and replacement:
            old, new = json.loads(json.dumps(resource)), json.loads(json.dumps(replacement))
            old["Properties"].pop("Code", None)
            new["Properties"].pop("Code", None)
            if old == new:
                continue
        if replacement != resource:
            raise Stop("Update would change an existing protected resource. No update submitted.")
    for name, resource in template["Resources"].items():
        if name not in current["Resources"] and (resource["Type"] != "AWS::ApiGatewayV2::Route" or resource["Properties"].get("AuthorizationType") != "JWT" or resource["Properties"].get("AuthorizationScopes") != ["openid"]):
            raise Stop("Update would add an unexpected resource. No update submitted.")
    if current == template:
        print("This template is already deployed; existing data and accounts are preserved.")
        return
    body = json.dumps(template)
    aws("cloudformation", "validate-template", {"TemplateBody": body})
    aws("cloudformation", "update-stack", {"StackName": state["stackId"], "TemplateBody": body,
        "Parameters": [{"ParameterKey": "LabRoleArn", "UsePreviousValue": True}], "ClientRequestToken": str(uuid.uuid4())})
    wait(state, "UPDATE_COMPLETE")
    print("Stack updated. Existing projects, accounts and public configuration were preserved. Reload the cloud preview.")


def seed():
    state = load()
    outputs = ready(state)
    if state.get("seeded"):
        print("Seed already completed; existing accounts and projects were preserved.")
        return
    marker = {"pk": {"S": "SYSTEM"}, "sk": {"S": "SEED"}}
    existing = aws("dynamodb", "get-item", {"TableName": outputs["Table"], "Key": marker, "ConsistentRead": True}).get("Item")
    if existing:
        if json.loads(existing["data"]["S"]).get("owner") != state["owner"]:
            raise Stop("Seed marker ownership mismatch.")
        state["seeded"] = True
        private_json(STATE, state)
        print("Seed already exists; recovered local state without resetting accounts or memberships.")
        return
    state.setdefault("seedCreatedAt", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    private_json(STATE, state)
    if ACCOUNTS.exists():
        accounts = json.loads(ACCOUNTS.read_text())
        if accounts.get("stackId") != state["stackId"]:
            raise Stop("Account file belongs to another stack.")
    else:
        # Save passwords BEFORE creating users so an interruption is recoverable.
        accounts = {"stackId": state["stackId"], "accounts": [{"username": username, "name": name, "email": username + "@example.invalid", "role": role, "password": "Aa1!" + secrets.token_urlsafe(24)} for username, name, role in [("maya", "Maya Chen", "owner"), ("alex", "Alex Morgan", "client"), ("jules", "Jules Rivera", "client")]]}
        private_json(ACCOUNTS, accounts)
    for account in accounts["accounts"]:
        try:
            aws("cognito-idp", "admin-create-user", {"UserPoolId": outputs["UserPool"], "Username": account["username"], "TemporaryPassword": account["password"], "MessageAction": "SUPPRESS", "UserAttributes": [{"Name": "email", "Value": account["email"]}, {"Name": "email_verified", "Value": "true"}]})
        except AwsError as error:
            if error.code != "UsernameExistsException":
                raise
        aws("cognito-idp", "admin-set-user-password", {"UserPoolId": outputs["UserPool"], "Username": account["username"], "Password": account["password"], "Permanent": True})
        account["id"] = next(attr["Value"] for attr in aws("cognito-idp", "admin-get-user", {"UserPoolId": outputs["UserPool"], "Username": account["username"]})["UserAttributes"] if attr["Name"] == "sub")
        private_json(ACCOUNTS, accounts)
    workspace = "studio-" + state["owner"][:12]
    rows = []
    for account in accounts["accounts"]:
        user = {key: account[key] for key in ("id", "name", "email", "role")}
        user.update(workspaceId=workspace, active=True, version=1)
        rows.append(("IDENTITY#" + user["id"], "PROFILE", user))
        if user["role"] == "client":
            rows.append(("WORKSPACE#" + workspace, "CLIENT#" + user["id"], {"id": user["id"]}))
    owner, alex, jules = accounts["accounts"]
    for title, client in [("Atlas brand refresh", alex), ("Fieldwork website", jules)]:
        project_id = str(uuid.uuid5(uuid.NAMESPACE_URL, state["stackId"] + title))
        project = {"id": project_id, "workspaceId": workspace, "title": title, "description": "Synthetic project for browser login and client access verification.", "ownerId": owner["id"], "clientId": client["id"], "scopeRevision": 0, "contextRevision": 0, "createdAt": state["seedCreatedAt"]}
        rows.extend([("PROJECT#" + project_id, "METADATA", project), ("USER#" + owner["id"], "PROJECT#" + project_id, {"id": project_id}), ("USER#" + client["id"], "PROJECT#" + project_id, {"id": project_id}), ("PROJECT#" + project_id, "AUDIT#" + state["seedCreatedAt"], {"type": "project.seeded", "actorId": owner["id"], "projectId": project_id, "createdAt": state["seedCreatedAt"]})])
    # One transaction including a seed marker: an interrupted seed is recoverable,
    # while an existing marker prevents overwriting modified/revoked memberships.
    if not existing:
        puts = [{"Put": {"TableName": outputs["Table"], "Item": {"pk": {"S": pk}, "sk": {"S": sk}, "data": {"S": json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=True)}}, "ConditionExpression": "attribute_not_exists(pk)"}} for pk, sk, data in rows]
        puts.append({"Put": {"TableName": outputs["Table"], "Item": {**marker, "data": {"S": json.dumps({"owner": state["owner"]})}}, "ConditionExpression": "attribute_not_exists(pk)"}})
        aws("dynamodb", "transact-write-items", {"TransactItems": puts})
    elif json.loads(existing["data"]["S"]).get("owner") != state["owner"]:
        raise Stop("Seed marker ownership mismatch.")
    state["seeded"] = True
    private_json(STATE, state)
    print("Seed ready: 3 synthetic accounts, 2 isolated projects. Passwords are in private demo-accounts.json; do not paste them into chat.")


def config():
    outputs = ready(load())
    private_json(HERE / "cloud-config.json", {"apiUrl": outputs["Endpoint"], "authDomain": outputs["LoginDomain"], "clientId": outputs["UserPoolClient"], "issuer": outputs["Issuer"], "redirectUri": "http://localhost:5174/callback", "logoutUri": "http://localhost:5174/"})
    print("Wrote cloud-config.json (public configuration, no credentials). Download it to the local cloud preview.")


def status():
    state = load()
    stack = owned(state)
    print(json.dumps({"stackName": state["name"], "status": stack["StackStatus"], "seeded": bool(state.get("seeded")), "region": REGION}, indent=2))
    if "FAILED" in stack["StackStatus"] or "ROLLBACK" in stack["StackStatus"]:
        events = aws("cloudformation", "describe-stack-events", {"StackName": state["stackId"]})
        print(json.dumps([{key: event.get(key) for key in ("LogicalResourceId", "ResourceType", "ResourceStatus")} for event in events.get("StackEvents", []) if "FAILED" in event.get("ResourceStatus", "")], indent=2))


def cleanup(confirm):
    state = load()
    if confirm != state["name"]:
        raise Stop("Cleanup deletes this demo's users and all its project data. Pass --confirm followed by the exact stackName from status.")
    stack = owned(state)
    if stack["StackStatus"] != "DELETE_COMPLETE":
        if stack["StackStatus"].endswith("IN_PROGRESS") and stack["StackStatus"] != "DELETE_IN_PROGRESS":
            raise Stop("Wait for the current stack operation before cleanup.")
        if stack["StackStatus"] != "DELETE_IN_PROGRESS":
            aws("cloudformation", "delete-stack", {"StackName": state["stackId"]})
        wait(state, "DELETE_COMPLETE")
    state["deleted"] = True
    private_json(STATE, state)
    for path in (ACCOUNTS, HERE / "cloud-config.json"):
        path.unlink(missing_ok=True)
    resources, token = [], None
    while True:
        page = aws("cloudformation", "list-stack-resources", {"StackName": state["stackId"], **({"NextToken": token} if token else {})})
        resources.extend(page.get("StackResourceSummaries", []))
        token = page.get("NextToken")
        if not token:
            break
    complete = bool(resources) and all(resource["ResourceStatus"] == "DELETE_COMPLETE" for resource in resources)
    print(json.dumps({"stackDeleted": True, "allStackResourcesDeleteComplete": complete}, indent=2))
    if not complete:
        raise Stop("Stack deleted, but per-resource deletion was not fully confirmed. Inspect this stack's Resources tab.")
    print("Demo account/config copies in this folder removed. Recheck the displayed lab balance; remove downloaded copies on your Mac.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["validate-local", "create", "update", "seed", "config", "status", "cleanup"])
    parser.add_argument("--confirm")
    args = parser.parse_args()
    with (HERE / ".cloud.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Stop("Another cloud command is running in this folder.")
        if args.command == "cleanup":
            cleanup(args.confirm)
        else:
            {"validate-local": validate, "create": create, "update": update, "seed": seed, "config": config, "status": status}[args.command]()


if __name__ == "__main__":
    try:
        main()
    except (Stop, subprocess.TimeoutExpired, KeyboardInterrupt) as error:
        print("STOP: " + (str(error) if isinstance(error, Stop) else "Command interrupted or timed out. Keep this folder; run status before retrying."))
        raise SystemExit(1)
