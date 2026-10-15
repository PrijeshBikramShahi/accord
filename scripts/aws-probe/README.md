# Accord AWS feasibility probe

Prepared 14 October 2026. **Locally checked; not yet deployed or verified in AWS.** Run this package yourself in the authorized Learner Lab CloudShell, in `us-east-1`. It uses Python's standard library and your existing AWS CLI session; no credentials are copied or installed.

This is a disposable synthetic probe, not the Accord deployment. It creates a uniquely named CloudFormation stack using the existing LabRole as the CloudFormation service role and Lambda execution role. The 16 resources include one Lambda function, one-day logs, one on-demand DynamoDB table, one private encrypted/versioned S3 bucket, an SQS queue and dead-letter queue, one event-source mapping, a Cognito pool/client and a JWT-protected HTTP API. There are no IAM resources, model invocations, Marketplace subscriptions, VPC/NAT, EC2, provisioned capacity or hosted frontend. Existing account resources are not adopted or edited.

AWS request/storage/compute usage can consume lab credit. Keep the probe to this session, and run cleanup after collecting evidence or investigating a failure. Do not leave it deployed merely because the session timer ends. The lab's displayed balance may be delayed. No dollar cost or live success is claimed before measurement.

## Fix for the initial uploaded package

The first live runtime attempt exposed incorrect CloudWatch Logs JSON parameter casing in the driver. The corrected package uses `logGroupNamePrefix`, `logGroupName` and `filterPattern` in both test and cleanup calls. The CloudFormation template and deployed worker are unchanged. Existing deployments can patch only `probe.py` in place, preserving `.probe-state.json` and its attempt reservations; no stack recreation is needed. Two driver regression tests now cover runtime log checks and cleanup log checks.

## 1. Upload and inspect

Download `accord-aws-probe.zip` from the chat. In CloudShell choose **Actions → Upload file** and upload the ZIP. Then run:

```sh
unzip accord-aws-probe.zip
cd accord-aws-probe
python3 probe.py validate-local
```

Use a fresh folder. If `unzip` asks to overwrite files, stop and preserve the previous probe directory and its hidden state; never overwrite an active probe. You can inspect `template.json`, `worker.py` and `probe.py` before continuing. `template.py` generates the same template used by `create`.

`validate-local` checks basic structure and size only and makes no AWS call. Ten local unit tests additionally exercise ownership rejection, version/marker cleanup, partial deletion errors, worker transactions, authentication guard and queue behavior. They do not prove CloudFormation schema acceptance or live service access. Run them with `python3 -m unittest discover -p 'test_*.py' -v` if desired.

## 2. Create the isolated stack

```sh
python3 probe.py create
```

The command first reads LabRole and asks CloudFormation to validate the template, then creates the stack. It prints state transitions and waits up to ten minutes. Successful output ends with `CREATE_COMPLETE` and a `stackCreated` result. It may fail if resource creation, `iam:PassRole`, the CloudFormation service role, Cognito creation, event-source configuration or another operation is denied. That is useful feasibility evidence; do not change policies to force success.

The state is saved before the create request in `.probe-state.json` with an unpredictable ownership token. Keep this file and directory until cleanup succeeds. It contains resource identifiers but no passwords/tokens. Never copy another stack's name or ID into it. `create` refuses to run again while state exists, including after cleanup; extract into a separate fresh directory only when a new probe is deliberately needed.

If a command fails or is interrupted:

```sh
python3 probe.py status
```

Share the sanitized output. If failure occurred before state was written, share the original STOP message instead. If stack creation rolled back, cleanup still applies. If an operation is still in progress, wait and check status before cleanup. The agent has not deployed anything on your behalf.

## 3. Exercise authenticated services

Once creation has succeeded:

```sh
python3 probe.py test
```

This verifies anonymous API rejection; creates a temporary test user without sending email; obtains a Cognito token; invokes the protected HTTP API; runs an atomic two-item DynamoDB transaction and rejects its duplicate; writes and reads two S3 versions and creates a delete marker; verifies an existing version is not anonymously readable; sends a message and observes the Lambda queue worker's database write; and checks actual logs and one-day retention.

The temporary user's generated password and tokens stay in memory or a private temporary request file, never shell arguments/history, output or persistent state. The user is deleted in a finally block; stack cleanup removes the entire pool if that deletion fails. Use one command at a time in this directory: a local lock prevents overlap. This does not coordinate independent copied probe folders.

Queue processing may take up to two minutes and log delivery up to another minute. A failed check is reported as failed, not inferred from resource creation. A maximum of three test invocations is conservatively reserved, allowing one initial run, one post-update run and one diagnostic rerun. Do not edit the counter to bypass it.

## 4. Verify stack updates

```sh
python3 probe.py update
python3 probe.py test
```

`update` keeps the same template/resources and changes the function's revision environment variable from `1` to `2`. The subsequent test must observe revision `2` from the actual HTTP response. The update command alone does not prove new code/configuration is executing.

## 5. Verify failure delivery

```sh
python3 probe.py test-dlq
```

This optional separate command should be run after the ordinary service test succeeds. It sends one deliberately failing synthetic message and checks that it reaches the DLQ after bounded redelivery. It removes that DLQ message after observation. The queue has a 90-second visibility timeout (six times the 15-second Lambda timeout), two permitted receives before redrive and a one-day message retention. The test waits up to six minutes. A timeout leaves the result unverified; do not repeat or edit the one-run reservation. Clean up when finished or after investigating.

The event-source mapping allows at most two concurrent executions. No reserved Lambda concurrency is requested, so this does not reduce capacity assigned to existing functions. The API is throttled to one request/second with a burst of two, and has no public sign-up or unauthenticated business route. This is a low-volume probe, not proof of production throughput or a strict account-wide spend cap.

## 6. Clean up—even after a failed test

```sh
python3 probe.py cleanup
```

Cleanup checks the exact stack identity and both ownership tags before mutations. It discovers resource IDs from that stack, disables its queue mapping and lets in-flight workers finish, removes every version and delete marker from only its bucket, and deletes only that stack. It then checks CloudFormation resource deletion status and independently checks bucket/log-group absence. Partial failures stop with an explicit error; keep state and rerun cleanup after diagnosing the cause. It never removes the existing LabRole or the account's pre-existing stacks, functions, queues, buckets or log groups.

A stack in progress must finish/roll back before cleanup. If the first create request never produced a stack, cleanup reports `stackNotFound` and performs no deletions. If a prior cleanup already completed, it reports that state. Keep the original successful deletion report as evidence. Do not treat an access-denied check as proof a resource disappeared.

`probe-results.json` contains sanitized successful-step evidence; download it through **Actions → Download file** and send it here. Also retain sanitized STOP/status output for failures. Check the lab balance after cleanup and again after billing refresh. The report deliberately records billing reconciliation as pending.

## What this does not establish

- A browser login/redirect/CORS flow: this probe exercises Cognito token issuance and JWT authorization through a CLI-driven HTTP client. Browser authentication still needs its own follow-up.
- Bedrock listing/invocation, activation, credits, model pricing, token or cost accounting. Listing was denied for the user's lab identity; nothing in this probe attempts to work around it.
- The production Accord cloud adapter, tenant authorization, presigned file URLs, stale-result fencing, concurrent application approvals or full cloud failure suite.
- Exactly-once queue delivery. The worker tolerates repeated normal messages using a conditional write. DLQ arrival is tested separately.
- A paid-inference budget ledger or complete billing reconciliation.

## Implementation references

The template uses [inline Python Lambda code](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lambda-function.html), [HTTP API JWT authorization](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-apigatewayv2-authorizer.html), and a [Cognito user pool client](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cognito-userpoolclient.html). Queue configuration follows [Lambda SQS guidance](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html); mapping properties are documented under [EventSourceMapping](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lambda-eventsourcemapping.html).
