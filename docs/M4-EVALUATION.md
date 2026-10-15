# M4 local evaluation tools — 12 October 2026

The offline evaluation foundation is implemented: **40 synthetic cases, 46 requested items, a hash-frozen 20/20 split, deterministic scoring and manual review templates**. No live provider was invoked. M4's live holdout, model latency/cost evidence and cloud failure checks remain incomplete. The existing manual portal and fixture provider are unchanged.

## Dataset and freeze

[`evaluation/manifest.json`](../evaluation/manifest.json) freezes the exact UTF-8 case files using SHA-256. `npm run eval:validate` checks the file hashes, source hashes, project separation, label balance, request spans, gold citations, clarification annotations and the local 5,000-byte input cap.

| Split | Cases | Primary included / addition / unclear | Requested items |
|---|---:|---|---:|
| Development | 20 | 7 / 7 / 6 | 23 |
| Holdout | 20 | 7 / 7 / 6 | 23 |

Every case has a distinct project scenario. The primary label identifies its focus; compound cases also contain other labels. Each split has 8 included, 8 addition and 7 unclear items. The corpus covers explicit exclusions, active approved additions, unapproved proposals, current versus historical scope, missing criteria, paraphrases, irrelevant context and instructions embedded in source text. Compound cases annotate each requested item separately.

Sources follow the application's `AnalysisSource` format, retaining exact source IDs, versions, approval/nonbinding status and paragraph IDs. Synthetic source hashes cover type, version, status and paragraphs; these are corpus integrity hashes, not claimed production document hashes. Each item records its exact request span, expected label, acceptable evidence spans, rationale, clarification requirement/question and forbidden invented commitments. Unapproved proposals and old draft references occur as nonbinding feedback; they do not replace approved scope.

**Annotation limitation:** this is an agent-authored, single-annotator synthetic dataset; independent human gold review is pending. The hash freeze is a structural checkpoint before live prompt tuning, not a claim that gold judgments are independently validated. Shared task concepts across splits are intentional, but project scenarios are not duplicated. A human should review the gold before using it for reported live quality. Material gold corrections require a new version, new manifest and a recorded explanation; do not silently change v1 to improve a score.

## Commands

Run from the repository root with its supported Node runtime:

```sh
npm run eval:validate
npm run eval:fixture
npm run eval:score -- evaluation/reports/development-fixture-v1.json .local/evaluation/rescored.json
npm run eval:review -- evaluation/reports/development-fixture-v1.json .local/evaluation/review.json
npm run eval:inputs -- development .local/evaluation/development-inputs.json
```

The fixture command defaults to a unique run file and companion report under `.local/evaluation/`. An optional path chooses the run destination. All generated files use exclusive creation and refuse to overwrite existing evidence. The fixture runner only uses the development split and passes sources plus the feedback ID to the existing provider; it does not pass gold annotations or tune fixture responses. It has no network client and does not touch the demo database, sessions or attempt ledger.

Input export includes only case IDs, frozen sources, feedback IDs and instructions, without gold labels, annotations or tags. Explicit `inputs holdout OUTPUT.json` is available for the eventual frozen live run. Files in the repository are inspectable, so the holdout is a procedural boundary, not access-controlled secrecy.

`eval:score` consumes a saved JSON run and optionally a JSON array of completed manual reviews. The scorer never invokes a provider. It accepts fixture or imported live records, but does not verify a live record's provenance or billing and never declares the overall live gate passed. Schemas are in [`score.ts`](../packages/evaluation/src/score.ts). The checked-in [fixture run](../evaluation/reports/development-fixture-v1.json) is a complete format example.

Runs bind to the dataset hash and record a run ID, creation timestamp, split, mode, provider/model, prompt hash and result-schema version. Each case record has a status, raw output or failure, every attempt's outcome/model duration/cost, queued-to-complete duration and cold-start flag. Use `null` for unknown timing, cost or cold-start information; never substitute zero. Include failed and uncertain attempts. An omitted case is scored as missing, never silently dropped. Unknown IDs, duplicate IDs, mixed splits and mismatched dataset hashes are rejected.

## Scoring rules

- **Classification:** validate successful raw outputs with the same application validator first. Align findings by normalized request spans, independently of predicted labels and finding order. A span must identify exactly one gold item. It can contain the whole gold span or be a contiguous subspan containing at least 60% of its words. Case and punctuation are ignored for alignment only; application citation checks remain exact. Duplicate findings are extras. A merged span covering multiple gold items matches none. This is a deterministic alignment heuristic, not semantic matching; inspect per-case results when wording differs.
- **Coverage and failures:** missed items, invalid outputs, missing case records and terminal failures create false negatives. Wrong labels create a false negative for the expected class and a false positive for the predicted class. Unmatched extra findings create false positives. Reports include macro-F1, class precision/recall/F1, confusion matrix with a missing column, matched/missed counts and extras. Undefined class precision/recall are conservatively zero for macro scoring.
- **Citation validity:** check every presented reference, including references inside invalid or failed outputs, against exact source ID/version/paragraph/quote. Reports show numerator and denominator. Zero references has `null` validity, never 100%. A valid reference does not prove semantic support. Gold acceptable evidence is for human judgment, not a keyword-based semantic judge.
- **Clarification:** count nonempty `missingInformation` on aligned items. Missed required items reduce recall. Questions on non-required items and unmatched findings reduce precision. Unnecessary clarification rate uses non-required gold items as its denominator. These are question-presence metrics; a reviewer must assess relevance and sufficiency.
- **Manual review:** bind each review to the exact raw output hash and record reviewer, timestamp and notes. Inventory every evidence-dependent claim in each finding's label, rationale and proposed action, including unsupported implied claims. Judge the actual cited text against approved scope and gold acceptable evidence. Record supported/unsupported for each claim, with a reason. Inventory all invented promised features, prices, dates or acceptance criteria against the entire source bundle and the item's forbidden commitments. A question or explicitly conditional proposal is not itself a commitment. Add one claim entry for each claim, not one blanket vote per finding. All findings must be represented, and the reviewer must explicitly attest the inventory is complete. The scorer checks IDs and hashes but cannot prove that human inventory is exhaustive. Empty templates are intentionally invalid. Support is reported as supported/evaluated claims; no reviews gives `null`, and incomplete review leaves acceptance targets unresolved.
- **Reliability:** report invalid-result, terminal-failure and missing-result counts over all expected cases. None are removed from classification denominators.
- **Latency:** median and nearest-rank p95, with sample counts, for attempts and queued-to-complete durations. Unknown measurements remain absent and visible in sample counts. Fixture invocation duration is not model or queue latency.
- **Cost:** sum all recorded attempts, including failures/retries/uncertain outcomes. Mean cost divides that total by valid analyses. Any missing case, empty attempt ledger or unknown attempt cost makes the mean `null`; known costs remain a lower bound. This is imported telemetry, not a billing reconciler.

Targets retain the plan's provisional thresholds: macro-F1 ≥0.80, citation validity 100%, manual semantic support ≥95%, zero invented commitments and clarification recall ≥80%. Complete live telemetry is also needed to assess queued p95 <60 seconds and mean cost ≤$0.02. Automated report flags do not substitute for the live release decision, verified provider configuration, gold review or cloud evidence.

## Recorded fixture exercise

The [saved development report](../evaluation/reports/development-fixture-v1.json.report.json) demonstrates the scorer against the unchanged `atlas-demo-v1` fixture:

| Observation | Result |
|---|---:|
| Valid fixture outputs | 20 / 20 |
| Expected / aligned requested items | 23 / 17 |
| Missed items / unmatched findings | 6 / 3 |
| Macro-F1 of scripted fallback | 0.1235 |
| References resolving exactly | 20 / 20 |
| Required clarification presence | 11 / 14 |
| Manual semantic support / invented commitments | Not reviewed |
| Paid calls / known cost | 0 / $0 |
| Queue latency | Not measured |

All these cases are outside the exact Atlas demonstration, so the provider returns its explicit uncertainty placeholder. Compound placeholders merge items and lose coverage. This intentionally shows why valid schemas and citations cannot establish useful model quality. **The fixture score is not an AI accuracy result.** No live or fixture-provider holdout evaluation was run. Tests build gold outputs for both splits solely as scorer positive controls; those perfect scores are not model predictions.

## Live run procedure and remaining gates

1. Finish human gold review and AWS/provider feasibility. Verify real input/output token limits, pricing, per-attempt reservations and the kill switch before live inference. This toolkit grants no spending authorization and implements no live transport.
2. Use only development inputs for up to three tuning runs. Persist all raw outputs and all attempts, including failures. Record actual provider/model, complete prompt/schema hash and inference settings (temperature, token cap and region) in a separate immutable run configuration alongside the result file.
3. Freeze that configuration before exporting and invoking the 20 holdout inputs once. Score every requested item, complete the claim-level manual review and inspect mismatches. The scorer does not enforce paid-run counts: the future live runner must enforce the shared attempt/cost ledger and development/holdout run policy before invocation.
4. If tuning resumes after inspecting holdout results, retire that holdout to development and author a fresh project-level holdout. Do not reuse the old score as unseen evidence.
5. Record live model-only and queued latency, cold starts, token usage, attempt costs and billing reconciliation. Independently verify the planned AWS failure/isolation scenarios. Keep the feature experimental if gates fail or evidence is incomplete.

The broader M4 and M5 cloud milestones remain open. Existing local M1–M3 integration checks remain the reliability evidence available today.

## Verification

`npm run check` passed on Node 26.4.0: **42 tests, zero failures/skips**, strict TypeScript checking and the Vite build. It exercises the frozen dataset and scorer alongside the existing application tests. The saved fixture report reproduces exactly when rescored; CLI smoke checks also verified annotation-free input export and incomplete review templates. Evaluation regression cases cover disjoint projects, corrupted evidence, perfect positive controls, wrong labels, missing/failed/invalid outputs, merged/duplicate findings, insufficient request spans, clarification errors, exact-output review binding, uncertain retry costs and wrong dataset/split rejection. No new dependencies or browser UI changes are required.
