import { z } from 'zod';
import { citationSchema, type AnalysisResult } from '../../shared/src/index.ts';
import { validateResult } from '../../../apps/api/src/analysis.ts';
import { citationResolves, digest, labels, type EvaluationCase, type Label } from './dataset.ts';

const nonnegative = z.number().finite().nonnegative();
const attemptSchema = z.object({ modelMs: nonnegative.nullable(), costUsd: nonnegative.nullable(), outcome: z.enum(['succeeded', 'failed', 'uncertain']) }).strict();
export const recordSchema = z.object({
  caseId: z.string().min(1), status: z.enum(['succeeded', 'failed']), output: z.unknown().optional(),
  error: z.string().optional(), attempts: z.array(attemptSchema), queuedToCompleteMs: nonnegative.nullable(), coldStart: z.boolean().nullable(),
}).strict();
export const runSchema = z.object({
  schemaVersion: z.literal(1), runId: z.string().min(1), mode: z.enum(['fixture', 'live']), split: z.enum(['development', 'holdout']),
  datasetHash: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.iso.datetime(),
  configuration: z.object({ provider: z.string().min(1), model: z.string().min(1), promptHash: z.string().regex(/^[a-f0-9]{64}$/), resultSchemaVersion: z.literal('scope-result-v1') }).strict(),
  records: z.array(recordSchema),
}).strict();
export type EvaluationRun = z.infer<typeof runSchema>;
export const reviewSchema = z.object({
  caseId: z.string().min(1), outputHash: z.string(), reviewer: z.string().min(1), reviewedAt: z.iso.datetime(),
  completeClaimInventory: z.literal(true),
  claims: z.array(z.object({ findingId: z.string().min(1), claim: z.string().min(1), supported: z.boolean(), note: z.string().min(1) }).strict()),
  inventedCommitments: z.array(z.string().min(1)), notes: z.string().min(1),
}).strict();
export type ManualReview = z.infer<typeof reviewSchema>;
const ratio = (n: number, d: number) => d ? n / d : null;
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: sorted.length, median: sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : null, p95: sorted.length ? sorted[Math.ceil(sorted.length * .95) - 1] : null };
}
const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function scoreRun(cases: EvaluationCase[], input: unknown, datasetHash: string, reviewInput: unknown[] = []) {
  const run = runSchema.parse(input);
  if (run.datasetHash !== datasetHash) throw new Error('Run does not match the frozen dataset.');
  const selected = cases.filter(c => c.split === run.split);
  const records = new Map(run.records.map(r => [r.caseId, r]));
  if (records.size !== run.records.length || run.records.some(r => !selected.some(c => c.id === r.caseId))) throw new Error('Duplicate, unknown or wrong-split result case.');
  const reviews = reviewInput.map(r => reviewSchema.parse(r));
  if (new Set(reviews.map(r => r.caseId)).size !== reviews.length || reviews.some(r => !records.has(r.caseId))) throw new Error('Duplicate or unknown review case.');
  const counts = Object.fromEntries(labels.map(l => [l, { tp: 0, fp: 0, fn: 0 }])) as Record<Label, { tp: number; fp: number; fn: number }>;
  const matrix = Object.fromEntries(labels.map(l => [l, { likely_included: 0, possible_scope_addition: 0, unclear: 0, missing: 0 }])) as Record<Label, Record<Label | 'missing', number>>;
  let totalItems = 0, matched = 0, extra = 0, invalid = 0, failed = 0, missing = 0, validCases = 0;
  let references = 0, validReferences = 0, clarificationTp = 0, clarificationFp = 0, required = 0, notRequired = 0;
  let reviewedCases = 0, claims = 0, supportedClaims = 0, invented = 0;
  const caseResults = [];
  for (const c of selected) {
    const record = records.get(c.id);
    let output: AnalysisResult | undefined;
    let error: string | null = null;
    if (!record) { missing++; error = 'Missing result'; }
    else {
      // Audit every presented reference, including references in rejected outputs.
      const raw = record.output as { findings?: unknown } | null;
      if (Array.isArray(raw?.findings)) for (const f of raw.findings) {
        if (Array.isArray(f?.citations)) for (const citation of f.citations) {
          references++;
          const parsed = citationSchema.safeParse(citation);
          if (parsed.success && citationResolves(c, parsed.data)) validReferences++;
        }
      }
      if (record.status === 'failed') { failed++; error = record.error ?? 'Terminal failure'; }
      else {
        try { output = validateResult(c, record.output); validCases++; }
        catch (e) { invalid++; error = e instanceof Error ? e.message : 'Invalid output'; }
      }
    }
    const matchedItems = new Map<string, AnalysisResult['findings'][number]>();
    const unmatchedFindings: string[] = [];
    for (const f of output?.findings ?? []) {
      const span = normalize(f.requestSpan);
      // A finding must identify exactly one gold item. A merged compound span is
      // deliberately unmatched; ordering and labels never influence alignment.
      const candidates = c.items.filter(i => {
        const gold = normalize(i.requestSpan);
        const substantialSubspan = span.split(' ').length >= Math.ceil(gold.split(' ').length * .6);
        return span === gold || (substantialSubspan && (` ${gold} `).includes(` ${span} `)) || (` ${span} `).includes(` ${gold} `);
      });
      if (candidates.length === 1 && !matchedItems.has(candidates[0].id)) matchedItems.set(candidates[0].id, f);
      else { extra++; counts[f.label].fp++; unmatchedFindings.push(f.id); if (f.missingInformation.length) clarificationFp++; }
    }
    const itemResults = c.items.map(i => {
      totalItems++;
      if (i.clarificationRequired) required++; else notRequired++;
      const f = matchedItems.get(i.id);
      if (!f) { counts[i.label].fn++; matrix[i.label].missing++; }
      else {
        matched++; matrix[i.label][f.label]++;
        if (f.label === i.label) counts[i.label].tp++;
        else { counts[i.label].fn++; counts[f.label].fp++; }
        if (f.missingInformation.length) { if (i.clarificationRequired) clarificationTp++; else clarificationFp++; }
      }
      return { itemId: i.id, expected: i.label, findingId: f?.id ?? null, predicted: f?.label ?? 'missing', clarificationExpected: i.clarificationRequired, clarificationPresent: !!f?.missingInformation.length };
    });
    const review = reviews.find(r => r.caseId === c.id);
    if (review) {
      if (!output || review.outputHash !== digest(record?.output)) throw new Error(`${c.id}: review must bind to the exact valid output.`);
      const ids = new Set(output.findings.map(f => f.id));
      if (review.claims.some(claim => !ids.has(claim.findingId)) || output.findings.some(f => !review.claims.some(claim => claim.findingId === f.id))) throw new Error(`${c.id}: review must inventory claims for every finding.`);
      reviewedCases++; claims += review.claims.length; supportedClaims += review.claims.filter(claim => claim.supported).length; invented += review.inventedCommitments.length;
    }
    caseResults.push({ caseId: c.id, error, items: itemResults, unmatchedFindings });
  }
  const perClass = Object.fromEntries(labels.map(l => {
    const { tp, fp, fn } = counts[l];
    return [l, { tp, fp, fn, precision: ratio(tp, tp + fp) ?? 0, recall: ratio(tp, tp + fn) ?? 0, f1: ratio(2 * tp, 2 * tp + fp + fn) ?? 0 }];
  }));
  const attempts = run.records.flatMap(r => r.attempts);
  const measuredCosts = attempts.map(a => a.costUsd).filter((v): v is number => v !== null);
  const costComplete = run.records.length === selected.length && run.records.every(r => r.attempts.length > 0) && measuredCosts.length === attempts.length;
  const manualComplete = reviewedCases === validCases && validCases === selected.length;
  const macroF1 = labels.reduce((sum, l) => sum + perClass[l].f1, 0) / labels.length;
  const semanticRate = ratio(supportedClaims, claims);
  const clarificationRecall = ratio(clarificationTp, required);
  return {
    schemaVersion: 1, runId: run.runId, mode: run.mode, split: run.split, datasetHash, configuration: run.configuration,
    evidenceLabel: run.mode === 'fixture' ? 'Fixture contract exercise only; not model-quality evidence.' : 'Imported live results; provenance, run limits and billing require independent verification.',
    classification: { macroF1, perClass, confusionMatrix: matrix, expectedItems: totalItems, matchedItems: matched, missedItems: totalItems - matched, unmatchedFindings: extra, coverage: ratio(matched, totalItems) },
    citations: { valid: validReferences, presented: references, validity: ratio(validReferences, references), semanticSupportIsManual: true },
    clarification: { required, truePositives: clarificationTp, falsePositives: clarificationFp, precision: ratio(clarificationTp, clarificationTp + clarificationFp), recall: clarificationRecall, unnecessaryRate: ratio(caseResults.flatMap(c => c.items).filter(i => !i.clarificationExpected && i.clarificationPresent).length, notRequired), questionRelevanceNotAutomaticallyScored: true },
    reliability: { expectedCases: selected.length, validCases, invalidResults: invalid, terminalFailures: failed, missingResults: missing, invalidResultRate: ratio(invalid, selected.length), terminalFailureRate: ratio(failed, selected.length) },
    manual: { reviewedCases, complete: manualComplete, supportedClaims, evaluatedClaims: claims, semanticSupport: semanticRate, inventedCommitmentsObserved: reviewedCases ? invented : null },
    latencyMs: { modelAttempts: distribution(attempts.map(a => a.modelMs).filter((v): v is number => v !== null)), queuedToComplete: distribution(run.records.map(r => r.queuedToCompleteMs).filter((v): v is number => v !== null)), coldStarts: run.records.filter(r => r.coldStart === true).length, unknownColdStarts: run.records.filter(r => r.coldStart === null).length },
    cost: { attempts: attempts.length, uncertainAttempts: attempts.filter(a => a.outcome === 'uncertain').length, measuredAttempts: measuredCosts.length, knownTotalUsd: measuredCosts.reduce((a, b) => a + b, 0), complete: costComplete, meanUsdPerValidAnalysisIncludingFailuresAndRetries: costComplete && validCases ? measuredCosts.reduce((a, b) => a + b, 0) / validCases : null },
    targets: { classification: macroF1 >= .8, citationValidity: references > 0 && validReferences === references, semanticSupport: manualComplete && semanticRate !== null ? semanticRate >= .95 : null, noInventedCommitments: manualComplete ? invented === 0 : null, clarificationRecall: clarificationRecall !== null ? clarificationRecall >= .8 : null, liveGate: 'Not established by this offline scorer.' },
    cases: caseResults,
  };
}
