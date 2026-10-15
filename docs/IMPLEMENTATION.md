# Implementation record

## Decision — 11 October 2026

The supplied MVP plan and feasibility report are preserved in this directory. The user chose local implementation for this session and will operate AWS themselves using `AWS-USER-CHECKLIST.md`.

M0 is **incomplete**: region/role guidance from 10 October remains provisional; no cloud deployment, Cognito flow, SQS processing, Bedrock inference, or cleanup has been verified. No AWS credentials or cloud resources are used by this code.

The local M1 manual portal is implemented and verified on Node 26.4.0. Integration tests, the build, and the browser walkthrough pass. This completes the local M1 increment, not the cloud deployment gate. M2 was subsequently implemented locally on 12 October (see below). The local M3 fixture workflow was subsequently implemented on 12 October (see below). Live model outputs, paid-inference accounting, live M4 evaluation and M5 cloud reproducibility remain incomplete. The local M4 evaluation foundation was subsequently implemented on 12 October (see below).

## Local architecture

React + Vite frontend, Node + Express API, Zod shared validation, and a SQLite store using `node:sqlite`. Domain operations are in `apps/api/src/domain.ts`; HTTP identity and request handling are in `app.ts`; persistence is in `store.ts`. The checked-in lockfile pins dependencies. `.nvmrc` selects Node 24.21.0; this workstation currently runs Node 26.4.0. Node 24 compatibility still requires a run on that exact runtime.

SQLite is a **local adapter**, not the proposed DynamoDB architecture. A single synchronous transaction encloses the domain mutation, audit entry, revision increment and durable idempotency result. Saving edited text creates a new version. A draft deliverable can receive attachments before submission, which updates its content hash; submitted content and attachment manifests are immutable. A new save creates a numbered version, and paragraph IDs carry forward through the editor. An approval stores the exact target/version/content hash and client identity. Approval of an older version after a newer draft exists is rejected; the client must wait for the newer version to be submitted.

Effective scope is the highest approved brief version plus approved changes not incorporated into that brief. Incorporation accepts only approved changes in the same project and preserves previously incorporated IDs. Selecting an ID records a human assertion of incorporation; the reviewer must verify that the brief text actually incorporates the delta.

The local store uses a small seeded identity directory, project owner/client fields as authoritative membership, version records, sessions and idempotency records. Collection reads are paginated at the API boundary (50 records/page). The local store currently loads a project's collection before slicing and scans the local projects table using JSON predicates. Replace those local access patterns with indexed membership and project key queries for DynamoDB; this is not a scalable database implementation. Offset cursors can shift during concurrent insertions; stable key cursors are a cloud-adapter follow-up.

Local authentication uses per-account random seed passwords hashed with scrypt, server-side expiring sessions, httpOnly SameSite cookies, strict origin checks for mutations and basic login rate limiting. All listeners bind to loopback. The application refuses `NODE_ENV=production`. This is a local development adapter; it must not be published as public authentication. Credentials and SQLite files stay in ignored `.local/`. Sessions and credentials persist across process restarts. No role selector or owner ID supplied by the browser establishes identity.

The server rechecks project membership on every project route, including idempotent replays. Clients cannot access drafts, draft history, other clients' records, or internal owner actions. Feedback is append-only; a correction must reference the same author's comment in the same project/thread. Resource IDs always resolve inside the authorized project.

## Interface direction

Palette: ink `#1b2942`, blue `#203f9a`, white `#ffffff`, workspace gray `#f4f6fa`, muted text `#657187`, approved green `#27705b`. DM Sans with system fallbacks; left-aligned text. The agreement is a readable central document with visible version/status controls and an approved-baseline sidebar. Deliverables use acceptance criteria rather than a board. Feedback and history preserve authorship. The design avoids decorative metrics and unsupported AI controls.

## Verification scope

The integration suite exercises real local HTTP requests: credentials/session/logout, origin checks, two-project and second-workspace isolation, private drafts, forged roles/hashes, atomic/idempotent approvals, immutable edits, conflicting versions, deliverable approval/rejection, append-only corrections, cross-project references, persistence/restart, membership revocation on replay, payload validation and pagination.

M2 adds coverage for private files and change incorporation. M3 adds local fixture tests for stale results, dispatch gaps, leases and attempt allowances. Cloud behavior, paid budgets and live evaluation still require independent verification. Existing tests do not prove AWS isolation or infrastructure reliability.

### M1 results — 11 October 2026

- Passed on Node 26.4.0: strict TypeScript checking and Vite build (`npm run build`).
- Passed: seed creation, safe repeated seeding, SQLite integrity check, and direct checks of three accounts, two client-isolated projects, approved briefs, submitted deliverables and cross-client authorization rejection.
- Passed in the user's terminal on Node 26.4.0: `npm run check`, with ten passing tests, zero failures/skips, TypeScript checking and the Vite production build.
- Independently passed by the agent after the approval service recovered: `npm run check`, ten tests, zero failures/skips, 4.728 seconds total test duration, TypeScript checking and Vite 8.3.4 production build. The earlier approval-service token failure is resolved.
- Passed in the in-app browser: freelancer login; project creation; brief draft/save/submit; deliverable draft/save/submit; designated-client login and explicit brief/deliverable approval; scope revision advancing only for the brief; feedback posting and append-only correction; history attribution; Jules seeing only Fieldwork; new brief version retaining the previous approved baseline and original paragraph ID/content; narrow-screen project navigation and feedback display. Browser warning/error log was empty at completion.
- Responsive check used a temporary requested 390×844 viewport override. The browser reported a 487px effective inner width and 468px document width, so this establishes the narrow-screen breakpoint without horizontal overflow, not exact 390 CSS-pixel coverage. The override was reset afterward.
- Evidence: [approval and version history](evidence/m1-history.png), [narrow-screen feedback and correction](evidence/m1-mobile-feedback.png).
- Not verified: Node 24 runtime execution and all AWS behavior. Browser coverage is a manual smoke walkthrough, not an automated cross-browser/accessibility suite.

The walkthrough created a third local project named **Browser walkthrough · M1**, assigned to Alex. It retains an approved brief v1, unsubmitted draft v2, approved deliverable, original feedback, correction and audit history. The two original seeded projects were not edited. The already-running local development server was reused and left running; the preview is left on the freelancer's walkthrough history.

## M2 — 12 October 2026

Private attachments, manual revision tasks and versioned change-request approval are implemented locally. `npm run check` passed all 20 tests with zero failures/skips, TypeScript checking and the Vite build. The browser walkthrough verifies a submitted change becoming active scope, a task authorized by that exact approval, task status updates, and the change's subsequent incorporation into approved brief v3. Both tasks preserve their original approval/decision references. See [M2 verification](M2-VERIFICATION.md) for evidence and remaining verification limits.

File bytes live in SQLite behind authenticated API routes. Upload intents reserve quota for 15 minutes; completion checks size, SHA-256, canonical base64 and basic type signatures. Draft deliverable files enter the deliverable hash and block submission while an unexpired upload is pending. Download grants expire after 60 seconds and recheck the same user's session, project membership and parent visibility. This is a local adapter, not S3 or presigned upload behavior. Signature checks do not constitute malware scanning. The UI deliberately supports download only and synthetic demo files.

Change drafts bind to the current scope revision. Only the designated client can approve the exact latest submitted version/hash; stale changes must be revised. An approved change is immutable and subsequent amendments are separate requests. A task records source feedback, human rationale, exact approved authority, approval ID and decision ID atomically; selecting a scope reference does not prove semantic coverage.

The original walkthrough project now also retains approved change v1, approved brief v3 incorporating it, two manual tasks, and one synthetic project attachment. Scope revision is 3. Original seed projects remain untouched. The preview remains available on the running local development server.

## M3 local fixture workflow — 12 October 2026

The owner-only Analysis workspace now creates durable jobs, freezes complete scope/thread evidence, runs a background fixture worker, validates exact citations, and records human-reviewed tasks, change drafts, clarification drafts or rejections. Persistent dispatch state, leases, fencing, bounded attempts and explicit recovery cover local failure paths. Stale results remain readable but cannot produce new actions. Clarification publication is a separate, idempotent operation that advances context.

`npm run check` passed 32 tests, TypeScript checking and Vite build. Browser verification covered the Atlas compound fixture, human-edited task/change draft, client isolation, explicit clarification publication and immediate stale-result protection. A 390 CSS-pixel responsive check found and fixed tab overflow. See [M3 verification, limits and recovery](M3-VERIFICATION.md).

This remains a zero-cost fixture provider: no live model, AWS queue, Lambda worker, S3 source bundle, paid-inference ledger or live evaluation is claimed. The local attempt ledger uses conservative reservations; fixtures cannot establish model quality. M0 and cloud M3 remain open.

The next local increment was M4 evaluation scenarios and deterministic scoring; its implementation is recorded below. Continue M0 through the user-operated AWS checklist independently; no AWS actions have been taken.

## M4 offline evaluation foundation — 12 October 2026

Added 40 synthetic cases with 46 annotated requested items, split into 20 development and 20 holdout scenarios with 7/7/6 primary labels each. SHA-256 manifests freeze both files; validators check scenario separation, exact gold evidence, source hashes and context limits. Gold is agent-authored and awaits independent human review.

The CLI exports annotation-free inputs, runs the existing fixture on development only, scores saved results and prepares exact-output-bound manual review templates. Missing/failed/invalid outputs and unmatched items remain in classification denominators. Reports separate citation existence from manually reviewed semantic support and track incomplete telemetry explicitly. No model judge, live provider or paid call was added.

The saved development fixture exercise has 20 valid outputs, 17/23 aligned items and macro-F1 0.1235; this is a demonstration of the scripted fallback's limitations, not model accuracy. The holdout has not been used for provider evaluation. Gold positive controls only verify scorer behavior. See [M4 tools, evidence and run protocol](M4-EVALUATION.md).

`npm run check` passed all 42 tests (ten evaluation regressions and 32 existing workflow tests), zero failures/skips, strict TypeScript checking and the Vite build on Node 26.4.0. M4 live holdout, real token/cost accounting and cloud failure evidence remain open. Next work is human gold review and the user-operated M0 feasibility checks, followed by a separately funded/authorized live adapter and frozen evaluation if feasibility permits. M5 fresh cloud deployment and cleanup remain unverified.

## M0 user-operated AWS checks and prepared probe — 14 October 2026

The user verified read-only Cognito, S3, SQS, CloudFormation, Lambda, API Gateway v2, DynamoDB and CloudWatch Logs access in us-east-1, and supplied LabRole's trust policy including Lambda. Bedrock listing was denied; live AI remains unresolved. See the updated [feasibility record](Accord-AWS-Feasibility.md). No resource creation or runtime permission is inferred from listing success.

Prepared `scripts/aws-probe/` and an uploadable ZIP under `dist/` for the user to operate in CloudShell. The isolated CloudFormation stack reuses LabRole and supplies create/test/update/DLQ/cleanup commands for synthetic resources. Cleanup binds to the exact stack and ownership tags and removes bucket versions and delete markers. Eight local unit tests and basic template structure/size validation passed; no AWS calls were made by the agent. CloudFormation validation, deployment, runtime tests and deletion remain unverified until the user runs the package. CLI-driven authentication does not verify the remaining browser login flow. The application's 42-test suite was not rerun for this standalone Python tooling change.

### Probe creation and runtime correction

The user reported `CREATE_COMPLETE` for the isolated probe. The first runtime test reached CloudWatch Logs and failed on JSON parameter casing in the driver. Corrected the test and cleanup calls to `logGroupNamePrefix`, `logGroupName` and `filterPattern`; ten Python tests now pass, including new driver regressions. Rebuilt the upload ZIP. The existing CloudShell copy needs an in-place driver patch; the deployed stack and saved state stay valid. Runtime completion, update, DLQ and cleanup still await user results.

### Probe revision-1 runtime verified

The user applied the CloudWatch parameter fix in place and supplied a successful revision-1 test report: Cognito token issuance/JWT API authorization, anonymous rejection, conditional database transaction and duplicate rejection, private versioned objects/delete marker, queue processing and log writes/retention all passed. Browser login and Bedrock remain untested. Next are stack update plus revision-2 retest, DLQ delivery and cleanup. Two of three reserved runtime test runs have been used; the last is for post-update verification.

### Probe DLQ delivery verified

The user supplied `failedMessageReachedDlq: true` and `dlqMessageRemoved: true` from `test-dlq`. Stack update/revision-2 evidence has not been supplied; inspect the saved report before deciding whether that step remains. Cleanup, browser login and live AI remain unverified.

### Probe update and revision-2 runtime verified

The user supplied the complete saved report confirming create, revision-1 checks, a successful stack update, all revision-2 runtime checks, and DLQ delivery/removal. The user-supplied report is preserved at `docs/evidence/aws-probe-2026-10-14.json`. The next step is cleanup and balance reconciliation. Browser login and Bedrock remain untested; this is a synthetic infrastructure probe, not a deployed Accord application.

### Probe cleanup verified — 14 October 2026

The final user-supplied report confirms stack deletion, all stack resources DELETE_COMPLETE, and separate absence checks for the bucket and log group at 14:32:32 UTC. The final report is saved in `docs/evidence/aws-probe-2026-10-14.json`. The core synthetic infrastructure probe has completed create/test/update/retest/DLQ/delete successfully. Billing reconciliation, browser authentication, live AI access/evaluation, and the actual Accord cloud implementation/deployment remain open. No claim is made that unrelated account resources were removed or that this probe completes M0/M5 in full.

### Post-cleanup displayed balance

The user reported `Used $0 of $50` after probe cleanup on 14 October 2026. Recorded displayed remaining budget: $50; displayed usage change: $0. Delayed billing reconciliation remains pending until a later balance observation; no zero-cost claim is made. Next implementation work is the Accord cloud backend and browser authentication, with Bedrock access still unresolved.

## Cloud foundation — 15 October 2026

Implemented the first application cloud slice, separate from the complete local M1–M3 portal: Cognito authorization code + PKCE browser sign-in, authenticated identity/client/project reads, and atomic project creation in DynamoDB. The cloud preview reuses the existing visual language and identifies its limited project-access scope. It has no fake workflow endpoints or enabled AI controls.

The Lambda implementation uses Python 3.13 and runtime boto3, matching the proven probe runtime; it is not a port of the synchronous SQLite domain. Its API shares the TypeScript frontend's Identity/Project data shapes. All five HTTP routes require a JWT authorizer and openid scope, with additional access-token claim checks in Lambda. Database profiles and per-project membership establish access. DynamoDB transactions condition-check both participant profiles, then create project metadata, membership pointers, audit and idempotency together. Tests cover concurrent revocation/duplicate requests, cross-client/workspace direct reads, stale indexes and actor-bound pagination.

The browser stores only the pending PKCE verifier/state in sessionStorage, consumes it once, strips callback parameters before the token exchange, and keeps access tokens only in memory. No refresh token is persisted. Expiry clears workspace state; logout clears memory and redirects through Cognito logout. Same-page retry keys survive network/5xx/429 failures; after a page reload users must inspect the list before resubmitting an uncertain create.

The user-operated package creates 16 resources using existing LabRole, with classic Cognito hosted login, localhost callbacks, a private DynamoDB table and seven-day logs. No new IAM roles/policies, Bedrock, S3 or SQS are part of this slice. The driver safeguards exact stack ownership, uses private files for CLI secrets, seeds three synthetic accounts/two projects in an atomic transaction and supports interrupted-seed recovery and explicit deletion. Packaging allowlists source files. See the [full walkthrough, design details and limits](../scripts/aws-cloud/README.md).

Local verification: all 73 tests pass: 42 existing local workflow/evaluation regressions, eight browser-auth/API tests, 13 cloud API/domain tests and ten deployment/template tests. Strict TypeScript and both Vite builds pass. The extracted upload ZIP independently passes its 23 Python tests and validates its 16-resource, 17,967-byte inline template. A local browser smoke check confirms the unconfigured preview shows setup instructions and disables sign-in, with no browser warnings/errors. Authenticated cloud screens have not been browser-tested. These are local/mock checks; the actual CloudFormation deployment, Cognito domain permissions, browser redirect and cloud application behavior remain unverified. The next user step is upload/validate/create, then seed/config and the three-account browser walkthrough. Subsequent implementation slices remain versioned brief/approval operations, private files, background jobs and any separately resolved live-AI adapter. This does not complete M0/M5 or the full cloud migration.

### Cloud foundation creation verified — 15 October 2026

The user supplied successful CloudShell extraction/local validation (16 resources, 17,967 template bytes) and `python3 cloud.py create` output progressing from `CREATE_IN_PROGRESS` to `CREATE_COMPLETE`. This verifies creation of the foundation stack, including its Cognito domain resource, through the user-operated driver. No stack name was included in the supplied output. Seeding, exported configuration, actual browser login, application API behavior and eventual cleanup remain unverified. Next: run `python3 cloud.py seed`, then `python3 cloud.py config` and `pwd`; download the public config and private account file separately. No AWS actions were performed by the agent.

### Cloud foundation seed and configuration exported — 15 October 2026

The user supplied successful `seed` output confirming three synthetic accounts and two isolated projects, followed by successful generation of `cloud-config.json`. CloudShell working directory: `/home/cloudshell-user/accord-cloud-foundation`. Passwords remain in the user's private `demo-accounts.json`; they were not supplied to or read by the agent. Next: the user downloads both files, installs the public config into `apps/cloud-web/public/cloud-config.json`, keeps the separate credentials in `.local/cloud-demo-accounts.json`, and runs the localhost:5174 preview. Actual browser sign-in, API runtime isolation and project creation remain unverified.

### Browser fetch receiver correction — 15 October 2026

The user reached the local cloud preview and supplied a screenshot of `Failed to execute 'fetch' on 'Window': Illegal invocation`. Inspection found native fetch stored on the session adapter/API instance and invoked as an instance method, giving it an invalid receiver. Both the OAuth token exchange and authenticated API transport now explicitly call fetch with `globalThis` as the receiver. The token-exchange mock now checks the receiver, and a new default-transport regression checks the API path. The strengthened tests reproduced the bug before the fix; all nine browser-auth/API tests, strict TypeScript and both builds pass afterward. The remaining suites were not rerun for this frontend-only correction. No cloud resources or credentials changed, and no deployment/package update is needed. The user must reload the local page and start a fresh sign-in; actual browser login and API runtime checks remain pending.

### Cloud browser walkthrough passed — user report, 15 October 2026

After the fetch correction, the user confirmed Maya could sign in and see Atlas and Fieldwork. The user then confirmed success for the requested walkthrough: Maya creates `Cloud browser walkthrough` assigned to Alex; after switching accounts Alex sees Atlas plus the walkthrough, and Jules sees only Fieldwork. Record these as user-reported successful browser login, project creation and expected client project lists. This is not an independent browser audit or proof of all direct-API denial paths. Account switching exercised sign-out/sign-in; explicit sign-out followed by page reload, timed session expiration, and a new displayed balance observation remain pending. The foundation stack remains deployed; its cleanup is separate from the already-deleted infrastructure probe. Next implementation slice: versioned cloud briefs and client approvals. Files, jobs, live AI and full cloud reproducibility remain incomplete.

### Logout/reload and displayed balance confirmed — 15 October 2026

The user subsequently reported displayed usage of $0 against the $50 lab allowance (displayed remaining $50), and confirmed that signing out and reloading returns to the sign-in page. The requested foundation walkthrough is complete on user-reported evidence. Timed session expiration and direct unauthorized cloud API requests have not been independently exercised; local regression coverage does not substitute for these runtime checks. The balance is a display observation, not proof of zero actual charges or final billing reconciliation. The foundation stack remains deployed. Next implementation slice remains versioned briefs and client approvals.


## Cloud versioned briefs and client approvals — 15 October 2026

Implemented the next cloud slice on the existing project foundation. Owners save immutable brief text versions, submit the latest draft and retain the prior approved baseline. Designated clients read published history and explicitly confirm approval/rejection of the exact latest submitted version and content hash against the current scope revision. Drafts and private history remain hidden from clients. Paragraph IDs carry forward through editing. Each visible decision includes client name, time, version and hash.

The Python Lambda adds project-local version rows and a separate latest/published/approved head; private version pointers are never exposed in public project metadata. DynamoDB transactions condition-check both active participant profiles and the expected metadata/head/version, then atomically commit version/status, audit, approval where applicable, revision changes and the durable actor-bound idempotency result. There are no scans. Client-filtered history uses 50-row key-query pages (subject to DynamoDB's page byte limit) with actor/project-bound cursors. Current-view reads recheck pointer and project state before returning a combined view. Approvals advance scope once; rejection or a replacement draft preserves the existing baseline. The UI clears action controls after a successful write even if its subsequent refresh fails.

The user-operated update driver preserves the exact existing table, Cognito, API and other resource definitions, permits only Lambda code changes and additional JWT-protected routes, and checks stack ID/tags before mutation. It reuses the previous LabRole parameter. Existing accounts, projects, state and public configuration remain valid. The updated allowlisted ZIP contains no local credentials or state; the template now has 21 resources. See [update and live walkthrough](../scripts/aws-cloud/README.md#update-the-existing-stack--briefs-and-approvals).

Verification: `npm run check` passed 92 tests: 52 TypeScript/HTTP, 25 cloud API/domain and 15 deployment/template checks, plus strict TypeScript and both production builds on Node 26.4.0. The test command needed sandbox escalation to open its local sockets. Added regressions cover private draft/history filtering, cursor binding, exact version/hash/scope validation, approval/rejection and baseline retention, idempotent replay, competing decisions/drafts, concurrent revocation/reassignment and protected-resource update refusal.

An isolated headless Chromium walkthrough exercised the actual React preview and Python handler with an in-memory test store. OAuth and API requests were intercepted; no AWS calls, credentials or deployed data were used. It passed draft/save/submit, explicit confirmation/cancel, approval attribution, private replacement drafts, history visibility, rejection retaining the baseline and reading the approved text. Forty-seven synthetic API requests succeeded; there were no page errors. At 390 CSS pixels, document width was exactly 390, with no horizontal overflow. Reviewed screenshots: [owner draft](evidence/cloud-brief-draft.png), [client decision/history](evidence/cloud-brief-decision.png), [mobile approved baseline](evidence/cloud-brief-mobile.png).

The new slice is **not deployed or runtime-verified in AWS**. The existing foundation remains deployed, and the user continues to operate AWS themselves. Next checkpoint: upload the rebuilt ZIP into the existing CloudShell directory, run `validate-local` then `update`, and report `UPDATE_COMPLETE` before the live walkthrough. Cloud files, deliverables, feedback, changes, jobs, live AI and full reproducibility remain incomplete. This increment adds no paid model calls or new IAM/storage/queue services.


### Cloud brief/approval stack update completed — user report, 15 October 2026

The user supplied successful extraction, local validation (21 resources, 31,202 template bytes), and the existing-stack update progressing from UPDATE_IN_PROGRESS to UPDATE_COMPLETE. This establishes successful CloudFormation deployment of the brief/approval increment on user-reported evidence. The driver reported that projects, accounts and public configuration were preserved; their runtime behavior still needs the live walkthrough. No AWS actions were performed by the agent. Next: reload localhost:5174, save a private brief as Maya, verify client draft privacy, then submit and approve as Alex before checking replacement/rejection/baseline retention. Updated balance, direct API runtime isolation and live AI remain unverified.

CloudShell rejected uploading over an existing ZIP. Renaming only the old ZIP with a timestamp resolved the upload; the extracted directory and hidden stack state were retained.


### Cloud draft privacy passed — user report, 15 October 2026

The user confirmed both requested browser checks: Maya can save the first brief draft in the walkthrough project, and Alex cannot see that draft text. This is user-reported runtime evidence for draft creation and client draft privacy, not an independent direct-API audit. Next: Maya submits version 1; Alex reads it and explicitly confirms approval; verify approved baseline version 1 and scope revision 1. Replacement draft privacy, rejection preserving the baseline, subsequent approval/history and an updated balance observation remain pending.


### First cloud brief approval passed — user report, 15 October 2026

The user confirmed the requested submission/approval walkthrough: Maya submitted brief version 1, Alex read it and explicitly confirmed approval, and the interface showed approved baseline version 1 with scope revision 1. This is user-reported browser evidence, not an independent API audit. Next: save a replacement draft as Maya, check that Alex still sees only the approved version, then submit and reject the replacement as Alex; baseline version 1 and scope revision 1 must remain unchanged. Subsequent approval/history and a new displayed balance observation remain pending.


### Replacement privacy and rejection passed — user report, 15 October 2026

The user confirmed the requested replacement walkthrough: Maya saved version 2 with changed scope; Alex still saw only the approved version 1 while the replacement was private; Maya submitted version 2; Alex explicitly rejected it. Version 2 showed rejected while approved baseline version 1 and scope revision 1 remained unchanged. This is user-reported browser evidence, not an independent direct-API audit. Next: create and submit version 3, approve it as Alex, and verify baseline version 3, scope revision 2 and all three submitted versions/decisions in history. A current displayed balance observation remains pending.
