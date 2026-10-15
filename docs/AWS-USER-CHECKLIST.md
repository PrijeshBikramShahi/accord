# AWS Learner Lab — checks you run

Prepared 11 October 2026; current next step updated 15 October. You operate the lab; the agent does not inspect your browser, copy credentials, or create cloud resources.

**Current step:** your isolated probe passed create/runtime/update/DLQ/cleanup, and you reported a post-cleanup display of `Used $0 of $50`. Those checks do not need repeating. The [cloud foundation walkthrough](../scripts/aws-cloud/README.md) now provides the next application deployment for browser login and project access. Start with its upload/validate/create step. The remaining checklist below preserves the original feasibility sequence; browser login and Bedrock remain unresolved until separately verified.

## 1. Open the lab and record its boundaries

1. Sign in to AWS Academy and open the course's **Learner Lab**.
2. Start the lab and wait until it reports ready. Record today's displayed used/remaining balance and the course/lab expiry date. The session countdown is a different limit.
3. Read the lab's own README/service restrictions. Check whether **S3, SQS, Cognito, and Bedrock** are explicitly allowed. Record any special restrictions. Also reconfirm CloudFormation, API Gateway, Lambda, DynamoDB and CloudWatch.
4. Confirm `us-east-1` is allowed. Use that region for these checks if it is; otherwise report the allowed region before running region-specific commands.
5. Open the lab's embedded terminal. Use its existing credentials; do not run `aws configure`, export new credentials, or paste keys into chat.

If there is no usable embedded terminal, use CloudShell only if the lab explicitly permits it. If neither works, report that and keep the local build moving.

## 2. Run these read-only checks

Run one block at a time. An empty result with no error is a successful list operation. `AccessDenied` proves only that the named operation was denied. `ExpiredToken` means the session needs renewing, not that the service is forbidden. Record `verified`, `denied`, or `not tested` for each command.

First check the CLI and identity. The second command prints only the identity type, not the account number or full ARN:

```sh
aws --version
aws sts get-caller-identity --query 'Arn' --output text | cut -d: -f6 | cut -d/ -f1
```

Inspect the supplied role's name and trust policy. Look for `lambda.amazonaws.com` in the trusted services. A readable role does not establish `iam:PassRole` or runtime permissions:

```sh
aws iam get-role --role-name LabRole --query 'Role.{Name:RoleName,Trust:AssumeRolePolicyDocument}' --output json
aws iam list-attached-role-policies --role-name LabRole --query 'AttachedPolicies[].PolicyName' --output json
aws iam list-role-policies --role-name LabRole --query 'PolicyNames' --output json
```

Check the unresolved authentication, queue, file, and model prerequisites:

```sh
aws cognito-idp list-user-pools --region us-east-1 --max-results 5 --no-paginate --query 'length(UserPools)' --output json --no-cli-pager
aws sqs list-queues --region us-east-1 --max-results 5 --query 'length(QueueUrls || `[]`)' --output json
aws s3api list-buckets --query 'length(Buckets)' --output json
aws bedrock list-foundation-models --region us-east-1 --by-output-modality TEXT --query 'modelSummaries[].{id:modelId,provider:providerName,inference:inferenceTypesSupported}' --output json
```

Finally check the remaining service list permissions:

```sh
aws cloudformation list-stacks --region us-east-1 --max-items 5 --query 'length(StackSummaries)' --output json
aws lambda list-functions --region us-east-1 --max-items 5 --query 'length(Functions)' --output json
aws apigatewayv2 get-apis --region us-east-1 --max-items 5 --query 'length(Items)' --output json
aws dynamodb list-tables --region us-east-1 --limit 5 --query 'length(TableNames)' --output json
aws logs describe-log-groups --region us-east-1 --limit 5 --query 'length(logGroups)' --output json
```

The embedded terminal was observed on 14 October 2026 to run AWS CLI 2.1.11. It requires Cognito's `--max-results`; use the single-page command above. Its command catalog does not include `bedrock`, so use the explicitly permitted AWS CloudShell for that check and record `aws --version` there first. Neither a missing argument nor an unknown CLI command establishes an AWS permission denial. If CloudShell cannot open, report its error. Do not install tools or change IAM permissions just to make these checks pass.

## 3. Send back a small result summary

Copy this template into the chat and fill it in. Redact account IDs, full role ARNs, terminal credentials, session tokens and sign-in URLs. For a failed command, the operation name and error code are enough.

```text
Date:
Allowed region(s):
Displayed used / remaining balance:
Course/lab expiration:
CLI version:
LabRole readable / Lambda trust present:
Role policy names (optional):
Cognito: listed in README? / list call result:
SQS: listed in README? / list call result:
S3: listed in README? / list call result:
Bedrock: listed in README? / list call result:
Bedrock candidate text model IDs, if available:
CloudFormation / Lambda / API Gateway / DynamoDB / Logs list results:
Any special restrictions from the README:
```

## 4. Deployment and inference probes come next

Update — 14 October 2026: the user completed the core service listing checks and inspected LabRole trust. Cognito/S3/SQS and the core infrastructure listing operations succeeded; Bedrock listing was denied. See the dated [feasibility record](Accord-AWS-Feasibility.md) for exact observations and limits. A [disposable CloudShell probe with create/test/update/delete instructions](../scripts/aws-probe/README.md) is ready for the user to run. It has only been tested locally so far.

List access does not verify creation, deletion, model invocation, credit coverage, or the worker execution role. Start with the package's upload, local validation and create steps; inspect the result before proceeding to runtime tests.

That probe must use the existing LabRole (no ordinary role creation), verify create/update/delete, authenticated browser access, DynamoDB transactions, private S3 object/version operations, SQS/DLQ processing, and log retention. Only after confirming an allowed model, current regional price and credit applicability should we prepare a tiny bounded invocation from the actual worker role. No model has been selected.

The first prepared probe covers resource creation/update/deletion, CLI-driven Cognito tokens/JWT HTTP authorization, transactions, file versions, queue/DLQ processing and logs. The browser login/redirect flow is a separate follow-up and must remain unverified until exercised. No inference is included in the package.

Keep the $50 ceiling and the plan's buffers. Do not enable Marketplace purchases, provisioned model throughput, VPC/NAT networking or optional frontend hosting during feasibility checks. Export sanitized results and verify the probe's cleanup before moving to a larger stack.

Command references: [IAM GetRole](https://docs.aws.amazon.com/cli/latest/reference/iam/get-role.html), [Cognito list-user-pools](https://docs.aws.amazon.com/cli/latest/reference/cognito-idp/list-user-pools.html), [SQS list-queues](https://docs.aws.amazon.com/cli/latest/reference/sqs/list-queues.html), [API Gateway get-apis](https://docs.aws.amazon.com/cli/latest/reference/apigatewayv2/get-apis.html), [Bedrock list-foundation-models](https://docs.aws.amazon.com/cli/latest/reference/bedrock/list-foundation-models.html). These describe APIs; your lab README and actual results establish lab availability.
