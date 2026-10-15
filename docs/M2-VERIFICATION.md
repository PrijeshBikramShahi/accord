# M2 local verification — 12 October 2026

Status: files and manual scope decisions are implemented locally. HTTP attachment round-trips pass. Browser upload and workflow checks pass; native browser file-save completion is not confirmed. This does not establish AWS readiness.

## Automated checks

`npm run check` passed on Node 26.4.0: **20 tests, 0 failures, 0 skipped**, TypeScript checking and the Vite production build. The suite uses disposable SQLite databases and local HTTP servers; it does not mutate the demo workspace.

The ten M1 tests remain passing. Ten M2 tests cover:

- Change draft privacy, exact designated-client approval, idempotency and immutable approved content.
- Conflicting approvals, stale scope and explicit rebasing.
- Brief incorporation preserving other active changes and previously incorporated IDs.
- Task authority, source feedback, human rationale, idempotency and status updates.
- Private file bytes, download identity/project binding, expiry and membership revocation.
- Draft attachment visibility, pending-upload submission blocking and manifest hash binding.
- Invalid filename, size, checksum, type and expired completion rejection.
- Twenty-file quota, pending reservations, reservation expiry and aggregate 1 GB limit.
- Persistence of bytes and idempotency across restart.
- Full 5 MB file round-trip without base64 validation stack overflow.

## Browser evidence

The synthetic **Browser walkthrough · M1** project was extended using the freelancer and designated-client UI:

1. Posted synthetic follow-up feedback; drafted and submitted a weekly-export change including manual schedule/fee implications and rationale.
2. Confirmed an unapproved change was absent from task-authorizing choices; created an included-work task against approved brief v1.
3. Uploaded `m2-synthetic-attachment.txt` through the file chooser; the completed project file is visible to both participants.
4. Approved change v1 as Alex: scope revision advanced from 1 to 2 and the active-change count became 1. [Evidence](evidence/m2-approved-change.png).
5. Created a task against the now-approved change and moved it to In progress. [Tasks and file evidence](evidence/m2-tasks-files.png).
6. Saved brief v3 with the change text and incorporation ID, submitted it, and approved it as Alex. Scope revision became 3, the active-change count became 0, and the change is marked incorporated. [Evidence](evidence/m2-incorporated-brief.png).
7. Verified the client sees both tasks with their original authorities (brief v1 at scope revision 1 and change v1 at scope revision 2). Browser warning/error logs were empty at completion.

The Download button displayed “Download requested” without an app error. A browser download-event wait timed out, so native file-save completion is **unverified**. Byte-for-byte authenticated downloads, including 5 MB, are verified by the HTTP suite. Browser coverage is a manual smoke walkthrough, not a cross-browser or accessibility test suite.

## Local-adapter boundaries

- SQLite stores file bytes; upload completion carries base64 JSON. There is no S3 upload, bucket policy, object versioning, lifecycle cleanup or cloud presigned URL verification.
- Local download grants require a live authenticated session and recheck membership at retrieval. Future S3 URLs may remain usable until expiry after membership changes; do not infer these local revocation guarantees for S3.
- Files are immutable, limited to 5 MB each, 20 per project and 1 GB overall. Type checks are basic signatures/UTF-8 validation, not malware scanning. Attachments are neither rendered inline nor processed as model evidence.
- Scope inclusion and incorporation are human judgments. The server validates references, approval state and concurrency, not semantic coverage.
- Node 24 execution and all AWS behavior remain unverified. AI jobs, live inference and evaluation belong to later milestones.

For AWS, follow [the user-operated checklist](AWS-USER-CHECKLIST.md). No credentials or cloud resources were accessed during this milestone.
