# Accord cloud foundation — user-operated walkthrough

Updated 15 October 2026. The package supports Cognito browser sign-in, private project access, versioned briefs and client approvals. Files, deliverables, feedback, change requests, analysis jobs and live AI are not part of this cloud slice.

The foundation stack is deployed and its login/project/logout walkthrough passed on user-reported evidence. **The user reported UPDATE_COMPLETE for the brief/approval update on 15 October 2026. The live brief/approval browser walkthrough remains pending.** Continue using the existing application stack; the earlier disposable infrastructure probe was deleted. No IAM resources, Bedrock, hosting, queues or storage buckets are added.

## Update the existing stack — briefs and approvals

On your Mac, the rebuilt upload package is `dist/accord-cloud-foundation.zip`. CloudShell refuses to overwrite an existing upload. If the old ZIP exists, first run `mv ~/accord-cloud-foundation.zip ~/accord-cloud-foundation-previous-$(date +%s).zip` in CloudShell, then upload the new ZIP. Keep the existing extracted directory: its hidden `.cloud-state.json` identifies the deployed stack. The ZIP contains source files only and does not overwrite saved state, account passwords or configuration.

Run in CloudShell:

```sh
cd ~
unzip -o accord-cloud-foundation.zip
cd accord-cloud-foundation
python3 cloud.py validate-local
python3 cloud.py update
```

Expected local validation: 21 resources, no AWS calls. Expected update result: `UPDATE_COMPLETE`. The driver checks the existing stack ID and ownership tags, then permits only Lambda code changes and added JWT-protected routes. Existing table, Cognito, API and other resource definitions must match exactly. It preserves the previous LabRole parameter and does not reseed anything. If the template is already current, it reports that without resubmitting. An interrupted in-progress update is awaited; run `update` again after it completes to verify the uploaded package is current.

**Do not run `create`, `seed`, or delete the old directory/state.** If it stops, run `python3 cloud.py status` and share only the status/error text. An existing protected-resource mismatch is a stop condition, not a reason to remove state or recreate the stack.

After `UPDATE_COMPLETE`, reload **http://localhost:5174** on your Mac and sign in again. Your existing public config and demo passwords still apply. Use the existing **Cloud browser walkthrough** project for this check:

1. As Maya, open the walkthrough project, choose **Write the first brief**, add two synthetic scope paragraphs, and **Save draft**. It should show version 1, a draft badge and no approved baseline.
2. As Alex, open that project: the private draft text must not appear. As Jules, the walkthrough project must still be absent.
3. As Maya, open the project and **Submit version 1**.
4. As Alex, read the text, select **Approve version 1**, then **Confirm approval**. Confirm the approved baseline is version 1, scope revision is 1, and your decision is attributed by name and time.
5. As Maya, **Create new version**, change one paragraph and **Save draft**. Confirm version 2 is private while the baseline remains version 1. Alex still sees only the submitted/approved version 1.
6. As Maya, submit version 2. As Alex, **Reject version 2** and **Confirm rejection**. The baseline and scope revision must remain at version 1 / revision 1. **Read approved brief** must show the original text.
7. As Maya, save a third version and submit it. As Alex, approve it. Confirm baseline version 3, scope revision 2, and all three submitted versions and decisions in **Load version history**.
8. Sign out, reload and confirm the sign-in screen. Check the current displayed lab balance.

If a request times out, retry the same action without changing its content; the page keeps its idempotency key through network/5xx/429 failures. After a reload, inspect the latest brief/history before creating another version. A conflict requires refreshing and reviewing current state; cancel unsaved editing before refreshing. Another draft prevents a decision on an older submitted version, even while the draft itself remains private.

Report the update status and walkthrough outcomes. These runtime checks remain separate from the 92 passing local tests and the synthetic browser check. This update does not complete the full cloud migration or live-AI feasibility.

The sections below remain the fresh-stack setup and cleanup reference. They are not needed to apply this update.

## 1. Upload, validate and create — CloudShell

Start your Learner Lab session, confirm its current displayed balance, and open its AWS CloudShell. Upload `accord-cloud-foundation.zip` from the project's `dist` folder using CloudShell's file upload action.

Run:

```sh
cd ~
unzip accord-cloud-foundation.zip
cd accord-cloud-foundation
python3 cloud.py validate-local
python3 cloud.py create
```

Local validation makes no AWS calls. Creation validates the template, then creates a uniquely named stack. Expect `CREATE_IN_PROGRESS` followed by `CREATE_COMPLETE`. It can take several minutes. **Send back only the status output at this checkpoint.** A Cognito domain is new to this package, so the earlier probe does not establish its permission or readiness.

If an error occurs, keep this directory, including its hidden state file. Run `python3 cloud.py status`. Do not delete state, repeatedly create new stacks, modify IAM or use another role. For an expired session, renew the lab session before checking status. Failed resource names and statuses are safe to share; passwords, tokens and full callback URLs are not needed.

## 2. Seed the demo and export configuration — CloudShell

After creation succeeds:

```sh
python3 cloud.py seed
python3 cloud.py config
pwd
```

Seed creates three synthetic Cognito accounts and two projects. Account passwords are generated randomly and written to `demo-accounts.json` with private file permissions. Repeated completed seeding preserves existing passwords and project data. If interrupted, rerunning `seed` recovers the same accounts and checks a database seed marker before attempting any reset. Keep the account file; there is no password recovery through the synthetic email addresses.

Use CloudShell's **Download file** action twice, entering the full directory printed by `pwd` followed by each filename:

- `cloud-config.json`: public connection settings; no AWS credentials or passwords.
- `demo-accounts.json`: private demo passwords. Keep this file on your own computer and do not paste it into chat.

The example account usernames are `maya`, `alex`, and `jules`; use the passwords in that downloaded file. These differ from the local demo accounts.

## 3. Start the cloud preview — your Mac terminal

From the Accord repository:

```sh
cd /Users/prizesh/code/accord
mkdir -p .local
cp ~/Downloads/cloud-config.json apps/cloud-web/public/cloud-config.json
cp ~/Downloads/demo-accounts.json .local/cloud-demo-accounts.json
chmod 600 .local/cloud-demo-accounts.json
npm run dev:cloud
```

If the browser saved a filename with a number suffix, adjust the `cp` source to that downloaded file. Do not overwrite the local demo's `.local/demo-accounts.json`.

Open **http://localhost:5174** on your Mac. Use this exact host and port; `127.0.0.1:5174` is a different OAuth callback origin. The preview binds to loopback and needs no AWS access keys. It must not be exposed publicly. After placing the configuration, reload the page if it was already open.

Click **Sign in**. The browser redirects to the stack's Cognito hosted login. Enter a synthetic demo account. A successful login returns to the preview and removes the authorization code from the address bar.

The access token is held only in memory, for at most 15 minutes. Reloading the page requires sign-in again; Cognito may still have its own login session. **Sign out** clears the page session and visits Cognito logout so you can change accounts. It does not revoke every already-issued access token; the server also checks current database membership on every request.

## 4. Verify the browser flow

1. Sign in as **Maya**. Confirm Atlas and Fieldwork are both listed. Open each and return to All projects.
2. Create a synthetic project named **Cloud browser walkthrough**, assigned to **Alex**. Open it and confirm the title and description persisted. Note the project ID for your own test record.
3. Sign out. Sign in as **Alex**. Confirm Atlas and the walkthrough are visible, Fieldwork is absent, and there is no New project control.
4. Sign out. Sign in as **Jules**. Confirm only Fieldwork is visible.
5. Sign out and reload. Confirm the workspace is not shown until another sign-in. Check the browser console for errors without sharing token-bearing network headers or callback URLs.
6. Optionally leave one session open for 15 minutes. Confirm it returns to sign-in on expiry.

Report:

```text
Stack created:
Seed/config exported:
Hosted login returned to localhost:
Maya sees both seeded projects:
Maya created the walkthrough project:
Alex sees Atlas + walkthrough only:
Jules sees Fieldwork only:
Sign-out/reload:
Session expiration (or not tested):
Displayed used / remaining balance:
```

Browser list checks supplement local direct-request authorization tests; they do not alone prove every cloud denial path. This foundation walkthrough does not verify briefs; use the brief walkthrough above after updating. Files, queues and live AI remain outside this package.

## 5. Status and explicit cleanup — CloudShell

This application stack persists until you delete it. Ending a lab session is not cleanup. It contains only synthetic test data, but deletion removes its projects and demo accounts permanently.

```sh
python3 cloud.py status
```

To remove it after the walkthrough, replace the placeholder with the exact `stackName` printed above:

```sh
python3 cloud.py cleanup --confirm accord-cloud-REPLACE_WITH_YOUR_SUFFIX
```

Cleanup requires the exact saved stack ID, ownership tags and name. It cannot adopt an unrelated stack. Expect `DELETE_COMPLETE`, `stackDeleted: true`, and `allStackResourcesDeleteComplete: true`. Keep the hidden state as an ownership record. The command removes the account/config copies in this CloudShell directory. Remove your downloaded copies and the cloud-specific `.local/cloud-demo-accounts.json` and `apps/cloud-web/public/cloud-config.json` on your Mac when they are no longer needed. Preserve the separate local demo data.

Check the displayed balance again after the lab's billing refresh; the earlier `$0 of $50` observation was a display reading, not proof of zero usage. Expiration remains unknown, and Bedrock access remains unresolved.

## Implementation and local verification

- Python 3.13 Lambda with the runtime's boto3, API Gateway HTTP API, Cognito classic hosted login and one DynamoDB table. Runtime boto3 is supplied by AWS rather than bundled/pinned.
- Public OAuth client with authorization code + PKCE S256, one-use state, ten-minute pending-login timeout, no stored access/refresh tokens and no client secret. Exact localhost redirect/logout allowlist.
- Every route requires the configured issuer/client and `openid` scope. Lambda additionally checks `token_use=access`, expiry and the authenticated subject passed by API Gateway. It does not trust caller-supplied roles or headers. There is no Lambda function URL.
- Profiles and project metadata are authoritative. User/project and workspace/client index rows are pointers, rechecked on reads. Queries use partition/sort keys, strong reads, 50-row pages and cursors bound to the user's collection; no table scans.
- Project creation uses an atomic DynamoDB transaction for profile snapshot conditions, metadata, two participant indexes, audit and idempotency. A concurrent membership change aborts the write. Replays recheck current access. Idempotency is retained server-side for the stack's lifetime; the browser preserves the key on network/5xx/429 retries in the same page. Reloading loses an unconfirmed request key: inspect the project list before resubmitting after a reload.
- Briefs use a project-local head record with latest/private, published and approved version pointers. Clients receive only published versions. Read assembly rechecks the head and project revisions so a concurrent draft or decision cannot produce a mixed current view. History is fetched in bounded key-query pages; client cursors are actor/project-bound and draft rows are filtered out.
- Saving never overwrites version text. Submission and decisions conditionally transition status; content hashes are generated server-side from canonical JSON. Paragraph IDs persist through edits. Only the designated active client can approve/reject the exact latest submitted version/hash and scope revision. No change incorporation is offered before cloud change requests exist.
- DynamoDB transactions condition-check both active identity profiles and replace the exact expected metadata/head/version while inserting audit, approval (for decisions) and actor-bound idempotency records. Concurrent drafts, decisions or revocations cannot partially commit. Approval advances scope once; rejection retains the baseline. Audit records remain private storage records; visible version history includes attribution and decisions.
- JSON bodies and exact origin are checked for writes. No request bodies/tokens/raw AWS errors in application logs. Retention is seven days; API rate/burst throttles are two/five. LabRole is broad and shared; this is a constrained lab demo, not production least-privilege IAM.
- Deployment takes no AWS credentials on your Mac. The user runs the CLI in CloudShell; sensitive CLI parameters use private temporary files. Package creation allowlists source files and never includes local state or passwords.

In the repository, `npm run check` runs the existing local suite, browser-auth tests, Python cloud tests, TypeScript and both Vite builds. `npm run package:cloud` creates the upload ZIP. In an extracted upload directory, `python3 -m unittest discover -p 'test_*.py' -v` runs the 40 Python tests without AWS calls. Neither mock tests nor template validation establish a live deployment.

References: [Cognito PKCE](https://docs.aws.amazon.com/cognito/latest/developerguide/using-pkce-in-authorization-code.html), [authorization endpoint and localhost callback](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html), [API Gateway JWT validation and scopes](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html), [classic hosted UI domain version](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cognito-userpooldomain.html).
