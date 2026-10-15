"""Synthetic probe only. No user documents, model calls or production endpoints."""
import json
import os
import re
import uuid

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

CONFIG = Config(connect_timeout=2, read_timeout=3, retries={"max_attempts": 1, "mode": "standard"})


def client(service):
    return boto3.client(service, config=CONFIG)


def response(code, body):
    return {"statusCode": code, "headers": {"content-type": "application/json", "cache-control": "no-store"}, "body": json.dumps(body)}


def handler(event, context):
    table = os.environ["TABLE"]
    dynamo = client("dynamodb")
    if "Records" in event:
        for record in event["Records"]:
            body = json.loads(record["body"])
            if not re.fullmatch(r"[a-f0-9]{32}", body.get("id", "")):
                raise ValueError("Invalid synthetic probe ID")
            if body.get("kind") == "poison":
                raise ValueError("Intentional synthetic DLQ probe")
            try:
                dynamo.put_item(TableName=table, Item={"pk": {"S": "queue#" + body["id"]}}, ConditionExpression="attribute_not_exists(pk)")
            except ClientError as error:
                if error.response["Error"]["Code"] != "ConditionalCheckFailedException":
                    raise
            print(json.dumps({"event": "queue_processed", "probeId": body["id"]}))
        return {"ok": True}

    # The HTTP route requires the API Gateway JWT authorizer. Reject invocations
    # that lack its claims as an additional guard; claims are not logged.
    claims = event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {})
    if not claims.get("sub"):
        return response(401, {"error": "Authentication required"})
    if event.get("requestContext", {}).get("http", {}).get("method") == "GET":
        return response(200, {"ok": True, "revision": os.environ["REVISION"]})
    try:
        probe_id = uuid.uuid4().hex
        transaction = [{"Put": {"TableName": table, "Item": {"pk": {"S": prefix + probe_id}}, "ConditionExpression": "attribute_not_exists(pk)"}} for prefix in ("decision#", "task#")]
        dynamo.transact_write_items(TransactItems=transaction)
        try:
            dynamo.transact_write_items(TransactItems=transaction)
            raise RuntimeError("Duplicate transaction unexpectedly accepted")
        except ClientError as error:
            reasons = error.response.get("CancellationReasons", [])
            if error.response["Error"]["Code"] != "TransactionCanceledException" or not any(r.get("Code") == "ConditionalCheckFailed" for r in reasons):
                raise
        bucket = os.environ["BUCKET"]
        s3 = client("s3")
        key = "synthetic/" + probe_id + ".txt"
        old = s3.put_object(Bucket=bucket, Key=key, Body=b"Accord synthetic version one\n", ContentType="text/plain")
        new = s3.put_object(Bucket=bucket, Key=key, Body=b"Accord synthetic version two\n", ContentType="text/plain")
        if not old.get("VersionId") or old["VersionId"] == "null" or old["VersionId"] == new.get("VersionId"):
            raise RuntimeError("Object versioning was not established")
        previous = s3.get_object(Bucket=bucket, Key=key, VersionId=old["VersionId"])["Body"].read()
        latest = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
        if previous != b"Accord synthetic version one\n" or latest != b"Accord synthetic version two\n":
            raise RuntimeError("Object versions did not round-trip")
        # Create a delete marker, while retaining explicit access to old versions.
        marker = s3.delete_object(Bucket=bucket, Key=key)
        if not marker.get("DeleteMarker"):
            raise RuntimeError("Expected a versioned delete marker")
        client("sqs").send_message(QueueUrl=os.environ["QUEUE"], MessageBody=json.dumps({"id": probe_id, "kind": "normal"}))
        print(json.dumps({"event": "probe_completed", "probeId": probe_id}))
        return response(200, {"ok": True, "id": probe_id, "key": key, "version": old["VersionId"], "revision": os.environ["REVISION"], "checks": ["conditional_transaction", "duplicate_rejected", "versioned_objects", "delete_marker", "queue_sent"]})
    except ClientError as error:
        code = error.response["Error"]["Code"]
        print(json.dumps({"event": "probe_failed", "code": code}))
        return response(500, {"error": code})
    except Exception:
        print(json.dumps({"event": "probe_failed", "code": "ProbeAssertionFailed"}))
        return response(500, {"error": "ProbeAssertionFailed"})
