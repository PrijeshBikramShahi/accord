import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fixtureProvider, instructions } from '../../../apps/api/src/analysis-provider.ts';
import type { AnalysisJob } from '../../shared/src/index.ts';
import { digest, loadDataset, type EvaluationCase } from './dataset.ts';
import { runSchema, scoreRun, type EvaluationRun } from './score.ts';

function read(path: string | undefined) {
  if (!path) throw new Error('A JSON file path is required.');
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}
function write(path: string, value: unknown) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  console.log(`Wrote ${resolve(path)}`);
}
export function fixtureJob(c: EvaluationCase): AnalysisJob {
  const timestamp = new Date().toISOString();
  return { id: c.id, version: 1, requesterId: 'offline-evaluation', feedbackId: c.feedbackId,
    scopeRevision: 1, contextRevision: 1, sources: c.sources, manifestHash: digest(c.sources),
    provider: 'fixture', modelVersion: 'atlas-demo-v1', promptVersion: 'scope-review-v1',
    status: 'running', attempts: 1, createdAt: timestamp, updatedAt: timestamp,
    inputBytes: Buffer.byteLength(JSON.stringify(c.sources) + instructions), costMicros: 0 };
}
async function main() {
  const [command, path, output, reviewsPath] = process.argv.slice(2);
  const { cases, manifest, datasetHash } = loadDataset();
  if (command === 'validate') {
    console.log(JSON.stringify({ version: manifest.version, datasetHash, cases: cases.length, items: cases.reduce((n, c) => n + c.items.length, 0), annotationStatus: manifest.annotationStatus, splits: ['development', 'holdout'].map(split => ({ split, cases: 20, primaryLabels: { likely_included: 7, possible_scope_addition: 7, unclear: 6 } })) }, null, 2));
  } else if (command === 'fixture') {
    const run: EvaluationRun = { schemaVersion: 1, runId: randomUUID(), mode: 'fixture', split: 'development', datasetHash, createdAt: new Date().toISOString(), configuration: { provider: 'fixture', model: 'atlas-demo-v1', promptHash: digest(instructions), resultSchemaVersion: 'scope-result-v1' }, records: [] };
    for (const c of cases.filter(c => c.split === 'development')) {
      const started = performance.now();
      try {
        const result = await fixtureProvider.invoke(fixtureJob(c), new AbortController().signal);
        run.records.push({ caseId: c.id, status: 'succeeded', output: result, attempts: [{ modelMs: performance.now() - started, costUsd: 0, outcome: 'succeeded' }], queuedToCompleteMs: null, coldStart: null });
      } catch (e) {
        run.records.push({ caseId: c.id, status: 'failed', error: e instanceof Error ? e.message : 'Fixture failed', attempts: [{ modelMs: performance.now() - started, costUsd: 0, outcome: 'failed' }], queuedToCompleteMs: null, coldStart: null });
      }
    }
    const destination = path ?? `.local/evaluation/${run.runId}.json`;
    write(destination, run);
    write(`${destination}.report.json`, scoreRun(cases, run, datasetHash));
    console.log('Development fixture only. No network, paid inference, live evaluation or holdout run.');
  } else if (command === 'score') {
    if (!output) throw new Error('Usage: score RUN.json REPORT.json [REVIEWS.json]');
    const reviews = reviewsPath ? read(reviewsPath) : [];
    if (!Array.isArray(reviews)) throw new Error('Reviews must be an array.');
    write(output, scoreRun(cases, read(path), datasetHash, reviews));
  } else if (command === 'review-template') {
    if (!output) throw new Error('Usage: review-template RUN.json REVIEWS.json');
    const run = runSchema.parse(read(path));
    const report = scoreRun(cases, run, datasetHash);
    write(output, run.records.filter(r => report.cases.some(c => c.caseId === r.caseId && !c.error)).map(r => ({ caseId: r.caseId, outputHash: digest(r.output), reviewer: '', reviewedAt: '', completeClaimInventory: false, claims: [], inventedCommitments: [], notes: '' })));
  } else if (command === 'inputs') {
    if (!['development', 'holdout'].includes(path ?? '') || !output) throw new Error('Usage: inputs development|holdout OUTPUT.json');
    write(output, { datasetHash, split: path, instructions, cases: cases.filter(c => c.split === path).map(({ id, feedbackId, sources }) => ({ caseId: id, feedbackId, sources })) });
  } else throw new Error('Commands: validate | fixture [RUN.json] | score RUN.json REPORT.json [REVIEWS.json] | review-template RUN.json REVIEWS.json | inputs development|holdout OUTPUT.json');
}
main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
