# Accord — AWS Learner Lab feasibility check

Latest update: 15 October 2026. Status: **isolated probe lifecycle verified from user output; foundation deployment, browser login, project creation, expected client project lists and logout/reload confirmed by the user. Displayed usage remains $0 of $50. Timed expiry, final billing reconciliation and live inference remain open**.

The [cloud foundation application package](../scripts/aws-cloud/README.md) is deployed by the user. On 15 October the user supplied successful local validation (16 resources, 17,967 template bytes), `CREATE_COMPLETE`, successful seeding of three synthetic accounts/two projects, and configuration export. After a local browser fetch-receiver fix, the user confirmed Maya's hosted login and both seeded projects, then successful project creation and the expected Alex/Jules project lists after account switching. These are user-reported browser results, not an independent audit of all cloud authorization paths. Explicit logout/reload, timed expiry and a refreshed balance remain pending. The foundation stack remains deployed; its cleanup is not yet verified. Do not repeat the deleted infrastructure probe. Full cloud briefs/approvals/files/jobs and any live model adapter remain future slices.

Follow-up on 15 October: the user confirmed sign-out followed by reload returns to the sign-in page, and reported displayed usage of $0 (displayed remaining $50). This completes the requested browser walkthrough; timed expiry and direct unauthorized API checks remain unverified in the cloud. No zero-cost or final billing-reconciliation claim is made. Next development is versioned briefs and client approvals.

## User-supplied lab evidence — 14 October 2026

The user supplied the displayed budget, region restriction and full service-restrictions text, followed by read-only command results recorded below. The agent has not accessed the account or created cloud resources.

| Item | Current evidence | Remaining verification |
|---|---|---|
| Budget | User reports `Used $0 of $50` both before and after probe cleanup: displayed remaining budget $50 | Post-cleanup display recorded; delayed billing reconciliation remains pending. This is not proof of zero cost. |
| Expiration | Not shown | Confirm course/lab access deadline with the instructor. |
| Regions | README limits service access to `us-east-1` and `us-west-2` unless a service exception applies | Use `us-east-1` for initial permission checks. |
| S3 and SQS | CloudShell list operations succeeded and each returned `0`; SQS checked in `us-east-1` | Probe versioned object round-trip, delete marker, anonymous-access rejection and queue worker verified. DLQ delivery/removal and stack cleanup verified, including separate bucket-absence check. S3 bucket listing is account-wide. |
| Cognito | CloudShell `ListUserPools` in `us-east-1` succeeded and returned count `0` | Probe token issuance, unauthenticated rejection and authenticated HTTP API verified. Browser login remains untested. |
| Bedrock | Not in supplied service list; CloudShell `ListFoundationModels` in `us-east-1` returned `AccessDeniedException` | Listing denied for the current lab identity; invocation and worker-role permissions remain untested. Do not assume live Bedrock availability. |
| Core infrastructure | CloudShell listing succeeded: CloudFormation `1`, Lambda `5` (capped at five), HTTP APIs `0`, DynamoDB tables `0`, log groups `3` | Counts are limited query results, not a complete inventory. Isolated probe creation, stack update and revision-1/revision-2 runtime checks succeeded, including transactions and logs. Probe deletion verified; the production Accord deployment remains unimplemented. |
| IAM | `GetRole` for LabRole succeeded. Its Allow statement permits `sts:AssumeRole` for Lambda, CloudFormation, API Gateway and other service principals | Probe creation succeeded using LabRole as CloudFormation service role and Lambda execution role. This verifies role passing/use for this create path only; probe worker runtime access to DynamoDB/S3/SQS/logs is verified. Production application permissions remain untested; ordinary role creation remains restricted. |
| Lambda | Maximum 10 concurrent execution environments | Keep the future API/worker configuration within this account limit. |
| Marketplace | Extremely limited read-only access | No subscriptions or model activation/purchase assumed. |

### User-supplied command output — 14 October 2026

- Embedded terminal: AWS CLI **2.1.11**, Python 3.7.3, Linux. User/session identifiers omitted.
- Cognito `list-user-pools`: local argument validation failed because this CLI requires `--max-results`. The previously supplied pagination command was incompatible. No service permission result was obtained. Corrected command uses `--max-results 5 --no-paginate`.
- Bedrock: local CLI rejected `bedrock` as an unknown command; its command catalog lacks Bedrock. No Bedrock request or permission result was obtained.
- At this initial stage both access checks remained **not tested**, not denied. No resource creation or model invocation occurred.

### Follow-up results — 14 October 2026

- Corrected Cognito `ListUserPools` request from the embedded terminal returned **ExpiredTokenException**. This is a session-credential failure, not evidence of denied Cognito permissions.
- CloudShell runs **AWS CLI 2.37.12** and recognizes Bedrock.
- CloudShell `ListFoundationModels` in `us-east-1` returned **AccessDeniedException**: no identity-based policy allows `bedrock:ListFoundationModels` for the current lab session identity. Account number, full ARN and user identity are deliberately omitted.
- Bedrock listing is now **denied** for that identity/region. This does not independently test `InvokeModel`, credit eligibility, model activation or the eventual worker role; live AI feasibility remains unresolved. No model was invoked and no resource was created by these checks.
- Cognito retry in CloudShell: `ListUserPools` with `--max-results 5 --no-paginate` in `us-east-1` succeeded and returned `0`. Listing permission is **verified** and no pools were returned. This does not establish user-pool creation or a working authentication flow.
- `iam:GetRole` for LabRole succeeded. The supplied trust policy has an Allow statement for `sts:AssumeRole` including `lambda.amazonaws.com`, `cloudformation.amazonaws.com` and `apigateway.amazonaws.com`, with no Condition shown. The account-specific AWS principal and full ARN are omitted. Reading this policy does not establish `iam:PassRole` or downstream service permissions.
- `sqs:ListQueues` in `us-east-1` succeeded with `0` queues returned. `s3:ListAllMyBuckets` via `s3api list-buckets` succeeded with `0` buckets returned. Both listing checks are **verified**; no resources were created.
- Remaining CloudShell checks in `us-east-1` succeeded: CloudFormation `ListStacks` returned count `1`; Lambda `ListFunctions` returned `5` under a five-item cap; API Gateway v2 `GetApis` returned `0`; DynamoDB `ListTables` returned `0`; CloudWatch Logs `DescribeLogGroups` returned `3`. At least five functions were returned, not necessarily five total. Stack summaries may include deleted stacks. Existing account resources must not be adopted or altered by the probe.

### Deployment probe — creation, update, runtime, DLQ and cleanup succeeded

The [CloudShell probe package](../scripts/aws-probe/README.md) now contains a plain CloudFormation template, inline Python worker and CLI wrapper for create/status/test/update/DLQ/cleanup. It uses LabRole and creates 16 isolated synthetic resources; no new IAM role, model call or resource adoption is implemented. Cleanup validates exact stack identity and ownership tags before removing only that stack and its object versions/delete markers. Ten local Python tests and local template size/structure checks pass after the Logs driver correction described below. These local checks do not themselves establish AWS behavior.

The user uploaded the ZIP and passed local validation, then supplied `python3 probe.py create` output showing `CREATE_IN_PROGRESS` → `CREATE_COMPLETE` and `stackCreated: true`. The script validates the template before creation and waits for the stack completion status. This establishes successful creation of this synthetic stack, not the production Accord deployment. The user subsequently completed explicit cleanup, as recorded below; session expiry was not used as cleanup.

The first runtime test reached the log-retention check, then failed locally with `ParamValidation` because the driver used `LogGroupNamePrefix` instead of `logGroupNamePrefix`. The CLI error is not an IAM denial. Code ordering indicates the preceding authentication, transaction, object and queue checks completed, but that attempt remained incomplete and emitted no successful test report. The driver now also corrects `logGroupName` and `filterPattern` for log reads and fixes the cleanup path. Two regression tests cover these calls; the ZIP has been rebuilt. No deployed template/worker change or counter reset is needed.

The user applied the driver-only casing patch and reran `test`. The supplied successful revision-1 report sets all of these checks to true: unauthenticated rejection, Cognito token issuance, authenticated API access, atomic conditional transaction, duplicate rejection, versioned file round-trip, delete marker, anonymous file rejection, queue worker, and log writes/retention. Browser login and Bedrock are explicitly `not tested`. This is user-supplied probe evidence, not independent verification or deployment of Accord itself.

The user subsequently supplied a successful `test-dlq` result: `failedMessageReachedDlq: true` and `dlqMessageRemoved: true`, after repeated waits. This verifies the synthetic failed message reached the DLQ and was removed. It does not establish application job recovery or a successful stack update.

The user then supplied the full saved report for stack `accord-probe-02ac0b77e899`: create succeeded at 13:16:23 UTC; revision-1 tests at 13:42:14 UTC; update to revision 2 at 13:43:54 UTC; all revision-2 runtime checks at 13:46:02 UTC; DLQ delivery/removal at 14:20:10 UTC on 14 October 2026. A copy of this user-supplied evidence is saved in [the probe report](evidence/aws-probe-2026-10-14.json). Update plus actual revision-2 execution is now verified for the synthetic probe. All three runtime test reservations have been used, including the initial failed attempt; no further runtime rerun is needed.

The user supplied `DELETE_IN_PROGRESS` → `DELETE_COMPLETE` and the final saved report dated 14 October 2026 at 14:32:32 UTC. Cleanup reports `stackDeleted`, `allStackResourcesDeleteComplete`, `bucketAbsent` and `logGroupAbsent` all true. The final evidence file now includes this cleanup step. This establishes deletion of the owned probe resources under the documented checks, not removal of pre-existing account resources. Billing reconciliation remains explicitly pending; no zero-cost claim is made.

After cleanup, the user reported the lab still displays `Used $0 of $50`. The displayed remaining budget is $50 and the displayed usage change is $0. The observation was supplied on 14 October 2026 without a precise timestamp; no elapsed billing-refresh interval is assumed. The unchanged display is not proof of zero actual cost. Recheck after the lab billing refresh during the next work session. The core synthetic infrastructure probe is complete. The next implementation work is the actual Accord cloud adapters/deployment and browser authentication verification; no additional run of this deleted probe is needed. Browser authentication remains a separate follow-up: this package verifies CLI-driven Cognito token issuance and protected HTTP access, not a browser login flow. Resolve the documented Bedrock access limitation through the lab administrator before relying on it in the deployment plan. Do not modify IAM policies or assume an alternate role to bypass the denial. Listing success will not establish pool creation, model invocation or credit coverage. The original observations below are historical and do not indicate that browser inspection is currently required.

## Historical check — 10 October 2026

## Access method

The user is already signed in to AWS Academy in Brave and has a running Learner Lab session. Inspection can use that existing browser session and the lab's embedded terminal without copying temporary credentials to this computer or chat. The user handles initial sign-in and any session renewal that requires authentication.

Local checks found Node, npm and Docker command paths. AWS CLI and SAM were not on the command path. No conventional AWS config/credentials file paths were found by the initial check; alternative credential sources were not inspected. Docker daemon availability was not tested.

## Verified from the actual lab instructions and UI

Source: the authenticated AWS Academy Learner Lab page and embedded README, marked last updated 24 June 2025. Service restrictions may change. Authenticated/session-bearing links and credentials are deliberately omitted from this report.

| Item | Observation | Impact |
|---|---|---|
| Session | Lab environment ready; AWS console tab already open | Browser-based inspection is available. |
| Budget | UI shows Used $0 of $50 | This is the latest displayed figure, not real-time billing. |
| Budget refresh | README says typically 8–12 hours | Preserve a spending buffer. |
| Budget exhaustion | README says the account is disabled and progress/resources lost when the budget is exceeded | Export evidence before approaching the ceiling. |
| Regions | `us-east-1` and `us-west-2`, unless a service-specific exception applies | Prefer `us-east-1`, matching the already-open console. |
| Persistence | Resources/data persist between lab sessions; session ending is not general cleanup | Explicit cleanup remains necessary. |
| IAM | Cannot create users/groups or ordinary roles; service-linked-role exceptions described | Parameterize and reuse the existing `LabRole`; do not generate ordinary IAM roles. |
| Lambda | README permits existing `LabRole`; maximum 10 concurrent execution environments | Keep worker concurrency low and account for API execution capacity. |
| Listed services observed so far | API Gateway, CloudFormation, CloudWatch, DynamoDB, Lambda, CloudShell | Listed availability is not proof of all required API operations. |

## Remaining checks

- Read the rest of the service list, including S3/SQS and whether Cognito/Bedrock are listed.
- Run read-only service/role checks using the embedded lab terminal; distinguish list access from runtime/write access.
- Confirm exact authentication and live AI feasibility before locking the architecture.
- Later, exercise a disposable minimal deployment, runtime access, bounded inference, and cleanup. No cloud resources or paid model invocations have been created by this check so far.
- Confirm course/lab expiration separately; the current session timer is not the course expiration date.

Browser inspection was interrupted by user activity. Automatic approval review then rejected a browser-state read because it might capture unrelated private content from the active tab. Further browser inspection is awaiting the user leaving Brave on the AWS Academy lab page and confirming continuation, or choosing to run checks themselves. No AWS permission denial has been inferred from this UI-access blocker.


### Cloud brief/approval update prepared — 15 October 2026

Versioned cloud briefs, private drafts, submission, exact client decisions, history and baseline retention are implemented and locally verified. All 92 tests and both builds pass; an isolated browser walkthrough passed using synthetic in-memory data, not AWS. The user-operated ZIP updates the existing stack's Lambda and adds five JWT routes while preserving table/Cognito definitions and existing data. This update has not been deployed or tested in AWS. Use the [existing-stack update walkthrough](../scripts/aws-cloud/README.md#update-the-existing-stack--briefs-and-approvals); do not create or seed a replacement stack. Foundation status and the last user-reported $0 used / $50 remaining observation remain unchanged. Live AI and final billing reconciliation are still unresolved.


### Cloud brief/approval stack update completed — user report, 15 October 2026

The user supplied successful extraction, local validation (21 resources, 31,202 template bytes), and the existing-stack update progressing from UPDATE_IN_PROGRESS to UPDATE_COMPLETE. This establishes successful CloudFormation deployment of the brief/approval increment on user-reported evidence. The driver reported that projects, accounts and public configuration were preserved; their runtime behavior still needs the live walkthrough. No AWS actions were performed by the agent. Next: reload localhost:5174, save a private brief as Maya, verify client draft privacy, then submit and approve as Alex before checking replacement/rejection/baseline retention. Updated balance, direct API runtime isolation and live AI remain unverified.

CloudShell rejected uploading over an existing ZIP. Renaming only the old ZIP with a timestamp resolved the upload; the extracted directory and hidden stack state were retained.


### Cloud draft privacy passed — user report, 15 October 2026

The user confirmed both requested browser checks: Maya can save the first brief draft in the walkthrough project, and Alex cannot see that draft text. This is user-reported runtime evidence for draft creation and client draft privacy, not an independent direct-API audit. Next: Maya submits version 1; Alex reads it and explicitly confirms approval; verify approved baseline version 1 and scope revision 1. Replacement draft privacy, rejection preserving the baseline, subsequent approval/history and an updated balance observation remain pending.


### First cloud brief approval passed — user report, 15 October 2026

The user confirmed the requested submission/approval walkthrough: Maya submitted brief version 1, Alex read it and explicitly confirmed approval, and the interface showed approved baseline version 1 with scope revision 1. This is user-reported browser evidence, not an independent API audit. Next: save a replacement draft as Maya, check that Alex still sees only the approved version, then submit and reject the replacement as Alex; baseline version 1 and scope revision 1 must remain unchanged. Subsequent approval/history and a new displayed balance observation remain pending.


### Replacement privacy and rejection passed — user report, 15 October 2026

The user confirmed the requested replacement walkthrough: Maya saved version 2 with changed scope; Alex still saw only the approved version 1 while the replacement was private; Maya submitted version 2; Alex explicitly rejected it. Version 2 showed rejected while approved baseline version 1 and scope revision 1 remained unchanged. This is user-reported browser evidence, not an independent direct-API audit. Next: create and submit version 3, approve it as Alex, and verify baseline version 3, scope revision 2 and all three submitted versions/decisions in history. A current displayed balance observation remains pending.
