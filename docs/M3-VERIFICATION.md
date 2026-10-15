# M3 local analysis workflow — 12 October 2026

The local asynchronous analysis and human-review workflow is implemented and verified. **This is a fixture demonstration, not live AI.** Cloud M3 remains incomplete: SQS/Lambda delivery, a live provider, model token accounting and a paid-inference budget ledger have not been implemented or verified.

## What is implemented

An owner requests analysis of one feedback item. The API returns `202` with a durable job ID. It freezes the complete approved brief, active approved changes, the selected item's feedback thread (including correction provenance), and the latest shared deliverable description/criteria when applicable. Draft scope and file bytes are excluded. Sources retain exact versions, hashes, paragraph IDs and approval/nonbinding status. The job records scope/context revisions, source-manifest hash and fixture/prompt versions.

The local queue and job store are SQLite. Saving a job and dispatching it are separate operations: pending dispatch remains recoverable. Replaying the original idempotency key redispatches the same pending job. The owner can also select an interrupted job in Analysis and choose **Recover job**. No model output is returned by the creation request.

A single worker in the API process polls once per second. It rechecks requester membership and freshness, claims a 30-second lease and enforces a 5-second invocation timeout. Duplicate completed/running deliveries do not invoke the provider. A lease token fences completion; an old worker cannot overwrite a newer attempt. Expired leases appear as failed/interrupted in the API and UI instead of running forever. Recovery requires an explicit owner action; exhausted jobs cannot recover.

The only provider is `fixture / atlas-demo-v1`. The exact original Atlas brief and compound feedback produce two scripted findings. Changed or other context produces one explicit uncertainty placeholder, without claiming semantic classification or complete request decomposition. Source text is treated as data and rendered as React text. There are no model tools, network calls or autonomous writes.

Validation requires bounded structured output, unique finding IDs, request spans from the chosen comment, exact source/version/paragraph quotes, approved-scope evidence for non-unclear labels, and a missing-information question for unclear findings. Existence of a valid quote does **not** prove that the quote supports the classification.

A human can reject advice, create an approval-backed task, save a private change-request draft, or save a private clarification draft. Each finding accepts one recorded decision. Decision and business action commit atomically. Replays return the original result; changed content under the same key is rejected. Task decisions retain the exact approval and manual rationale. Change drafts still require the normal submission and client-approval flow. Clarifications have a separate **Post clarification to client** button. That post creates one comment in the original thread, increments context and makes the old result stale.

## Limits and recovery

- Up to three invocation attempts per job. Transient timeout/provider failures permit explicit retry after bounded backoff. Invalid output is terminal. Historical results remain readable, but stale jobs cannot create new decisions or publish clarification drafts.
- The fixture ledger reserves an attempt before job creation and before new retries: 300 total, 60 per rolling 24 hours, 20 per project. All amounts are zero dollars. Unused and uncertain reservations continue to count conservatively. This is a local attempt allowance, **not** a verified paid-inference ledger.
- Input is capped at 5,000 UTF-8 bytes of serialized sources plus instructions. Oversized context fails with `422`; agreed scope is never silently truncated. Output is capped at 14,000 bytes plus field limits. These are local byte caps, not measured model tokens. A future live provider needs its own token and cost accounting before enablement.
- Set `ACCORD_ANALYSIS_ENABLED=false` before starting the API to disable execution. Enabling requires restarting with the flag true and explicit recovery of stopped jobs. Only the fixture provider is available; this flag cannot enable external inference.
- Queued work survives restart. A crash in the save/send gap leaves `pending_dispatch`; a crash during execution leaves a lease that becomes recoverable after expiry. Open Analysis, select the job and choose Recover job. Stale jobs require a fresh run. Three-attempt exhaustion is terminal for that job.
- There is no SQS DLQ, Lambda timeout tuning, cloud recovery command, live provider access or cloud deployment claim. Fixture attempts and tests do not count toward live evaluation quality.

## Automated evidence

`npm run check` on Node 26.4.0 passed **32 tests, zero failures/skips**, TypeScript checking and Vite production build. The 12 M3 tests exercise:

1. Owner-only job access and role revocation on replay; source freezing and client history privacy.
2. Save/send-gap repair, persistent idempotency and duplicate delivery.
3. Requester revocation, changed context and disable flag before invocation.
4. Invalid quotes, versions, spans, duplicate findings and missing clarification rejection.
5. Atomic, idempotent approval-backed tasks and stale-action rejection.
6. Private change/clarification drafts and explicit idempotent publication.
7. Expired leases, fencing and uncertain attempt accounting.
8. Bounded retries and terminal failures.
9. Context/attempt limits and inert prompt-like source text.
10. Pending dispatch, sources and decisions surviving restart.
11. Exact Atlas compound fixture and correction provenance/fallback behavior.
12. Recovery across disabled execution with an existing reservation; exhausted project quota rolls back job creation.

The final CSS-only adjustment makes the five tabs fit the 390 CSS-pixel responsive layout; the production build was rerun after it. API test coverage uses disposable stores and test providers. It does not establish AWS reliability or live model quality.

## Browser evidence

- Atlas: observed queued → succeeded, two findings with exact source quotes, a human-edited task and a private change-request draft. Scope stayed at revision 1. [Reviewed findings](evidence/m3-reviewed-findings.png).
- Client Alex: Analysis tab absent, unsubmitted change absent, authorized task visible with its approval-backed rationale. [Client task](evidence/m3-client-task.png).
- Walkthrough project: non-scripted feedback returned Unclear; saved a private, human-edited clarification; separately posted it to the original thread; feedback count advanced once and the result immediately became stale. [Stale clarification](evidence/m3-stale-clarification.png).
- Responsive check: requested 312×675 viewport due to the browser's scale factor; observed **390 CSS-pixel inner width**, 371px body width and equal 371px body scroll width after fixing tab overflow. The temporary override was reset. [Narrow-screen review](evidence/m3-mobile.png).

The synthetic Atlas seed now retains the new task, one unsubmitted change and its analysis/decisions. The existing walkthrough project retains an analysis and one additional clarification comment. Fieldwork is unchanged. Demo records and credentials were preserved.

## Next milestone

The [M4 offline evaluation foundation](M4-EVALUATION.md) is now implemented with 40 scenarios, a frozen development/holdout split and deterministic scoring tools. Human gold review remains pending before live prompt tuning. Live evaluation, paid-call limits and infrastructure verification remain gated on the user-operated [AWS checklist](AWS-USER-CHECKLIST.md). Do not report fixture labels as model metrics.
