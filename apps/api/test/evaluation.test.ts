import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, loadDataset, validateDataset } from '../../../packages/evaluation/src/dataset.ts';
import { scoreRun, type EvaluationRun, type ManualReview } from '../../../packages/evaluation/src/score.ts';
import type { AnalysisResult } from '../../../packages/shared/src/index.ts';

const { cases, datasetHash } = loadDataset();
function oracle(split: 'development' | 'holdout' = 'development'): EvaluationRun {
  return { schemaVersion: 1, runId: 'scorer-positive-control', mode: 'fixture', split, datasetHash,
    createdAt: '2026-10-12T00:00:00.000Z', configuration: { provider: 'gold-positive-control', model: 'none', promptHash: digest('no inference'), resultSchemaVersion: 'scope-result-v1' },
    records: cases.filter(c => c.split === split).map(c => ({ caseId: c.id, status: 'succeeded',
      output: { findings: c.items.map(i => ({ id: i.id, feedbackId: c.feedbackId, requestSpan: i.requestSpan, label: i.label, rationale: i.rationale,
        citations: structuredClone(i.acceptableEvidence), missingInformation: i.clarificationRequired ? [i.clarificationQuestion] : [], proposedAction: 'Review this synthetic request manually.' })) },
      attempts: [{ modelMs: 10, costUsd: .01, outcome: 'succeeded' }], queuedToCompleteMs: 20, coldStart: false })) };
}
const output = (run: EvaluationRun, n = 0) => run.records[n].output as AnalysisResult;
const score = (run: EvaluationRun, reviews: ManualReview[] = []) => scoreRun(cases, run, datasetHash, reviews);

test('frozen dataset has balanced disjoint projects, exact evidence and 46 annotated items', () => {
  assert.equal(cases.reduce((sum, c) => sum + c.items.length, 0), 46);
  const changed = structuredClone(cases); changed[20].scenarioGroup = changed[0].scenarioGroup;
  assert.throws(() => validateDataset(changed), /distinct/);
  const badEvidence = structuredClone(cases); badEvidence[0].items[0].acceptableEvidence[0].version = 99;
  assert.throws(() => validateDataset(badEvidence), /citation/);
  const badSource = structuredClone(cases); badSource[0].sources[0].paragraphs[0].text += ' Extra';
  assert.throws(() => validateDataset(badSource), /hash mismatch/);
});

test('gold positive controls validate both splits without establishing model quality or manual metrics', () => {
  for (const split of ['development', 'holdout'] as const) {
    const report = score(oracle(split));
    assert.equal(report.classification.macroF1, 1);
    assert.equal(report.classification.expectedItems, 23);
    assert.equal(report.citations.validity, 1);
    assert.equal(report.clarification.recall, 1);
    assert.equal(report.manual.semanticSupport, null);
    assert.equal(report.manual.inventedCommitmentsObserved, null);
    assert.equal(report.targets.semanticSupport, null);
    assert.equal(report.targets.liveGate, 'Not established by this offline scorer.');
  }
});

test('wrong labels affect confusion matrix, precision and recall', () => {
  const run = oracle(); output(run).findings[0].label = 'possible_scope_addition';
  const report = score(run);
  assert.equal(report.classification.confusionMatrix.likely_included.possible_scope_addition, 1);
  assert.equal(report.classification.perClass.likely_included.fn, 1);
  assert.equal(report.classification.perClass.possible_scope_addition.fp, 1);
  assert.ok(report.classification.macroF1 < 1);
});

test('failures, missing records and invalid output all remain in classification denominators', () => {
  const run = oracle(); run.records[0].status = 'failed'; run.records.splice(1, 1);
  output(run, 1).findings[0].citations[0].quote = 'Fabricated citation';
  const report = score(run);
  assert.equal(report.reliability.terminalFailures, 1); assert.equal(report.reliability.missingResults, 1);
  assert.equal(report.reliability.invalidResults, 1); assert.equal(report.classification.missedItems, 3);
  assert.equal(report.classification.expectedItems, 23); assert.ok(report.citations.validity! < 1);
  assert.equal(report.cost.complete, false); assert.equal(report.cost.meanUsdPerValidAnalysisIncludingFailuresAndRetries, null);
});

test('merged compound spans miss both items; duplicate findings add false positives', () => {
  const run = oracle(); const c = cases.find(c => c.id === run.records[4].caseId)!;
  const first = output(run, 4).findings[0];
  first.requestSpan = c.sources.find(s => s.id === 'feedback')!.paragraphs[0].text;
  first.citations[0].quote = first.requestSpan;
  output(run, 4).findings = [first];
  const duplicate = structuredClone(output(run).findings[0]); duplicate.id = 'duplicate'; output(run).findings.push(duplicate);
  const report = score(run);
  assert.equal(report.classification.missedItems, 2); assert.equal(report.classification.unmatchedFindings, 2);
  assert.equal(report.classification.perClass.likely_included.fp, 2);
});

test('clarification scoring includes missed required questions and unnecessary questions', () => {
  const run = oracle(); output(run).findings[0].missingInformation = ['What else?'];
  output(run, 7).findings[0].missingInformation = [];
  const report = score(run);
  assert.equal(report.clarification.falsePositives, 1);
  assert.ok(report.clarification.recall! < 1); assert.ok(report.clarification.unnecessaryRate! > 0);
});

test('a short unique word cannot claim coverage of a complete requested item', () => {
  const run = oracle(); output(run).findings[0].requestSpan = 'croissant';
  const report = score(run);
  assert.equal(report.classification.missedItems, 1);
  assert.equal(report.classification.unmatchedFindings, 1);
});

test('manual reviews bind exact outputs and leave partial review gates unresolved', () => {
  const run = oracle();
  const review: ManualReview = { caseId: run.records[0].caseId, outputHash: digest(run.records[0].output), reviewer: 'Synthetic test reviewer', reviewedAt: run.createdAt,
    completeClaimInventory: true, claims: [{ findingId: 'item-1', claim: 'A spelling correction is included.', supported: true, note: 'The approved copy revision supports this.' }], inventedCommitments: [], notes: 'Scorer test only.' };
  const report = score(run, [review]);
  assert.equal(report.manual.supportedClaims, 1); assert.equal(report.manual.evaluatedClaims, 1);
  assert.equal(report.manual.complete, false); assert.equal(report.targets.noInventedCommitments, null);
  assert.throws(() => score(run, [{ ...review, claims: [] }]), /every finding/);
  output(run).findings[0].proposedAction = 'Changed action';
  assert.throws(() => score(run, [review]), /exact valid output/);
});

test('cost includes failed and uncertain retries; latency reports denominators and missing telemetry', () => {
  const run = oracle(); run.records[0].attempts.unshift({ modelMs: 100, costUsd: .03, outcome: 'uncertain' });
  run.records[1].status = 'failed';
  const report = score(run);
  assert.equal(report.cost.attempts, 21); assert.equal(report.cost.uncertainAttempts, 1);
  assert.ok(Math.abs(report.cost.knownTotalUsd - .23) < 1e-10);
  assert.ok(Math.abs(report.cost.meanUsdPerValidAnalysisIncludingFailuresAndRetries! - .23 / 19) < 1e-10);
  assert.equal(report.latencyMs.modelAttempts.samples, 21); assert.equal(report.latencyMs.modelAttempts.p95, 10);
  run.records[0].attempts[0].costUsd = null;
  assert.equal(score(run).cost.meanUsdPerValidAnalysisIncludingFailuresAndRetries, null);
});

test('wrong dataset, duplicate results and mixed splits are rejected', () => {
  const run = oracle(); assert.throws(() => score({ ...run, datasetHash: digest('changed') }), /frozen dataset/);
  run.records.push(run.records[0]); assert.throws(() => score(run), /Duplicate/);
  run.records.pop(); run.records[0].caseId = 'holdout-01'; assert.throws(() => score(run), /wrong-split/);
});
