import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { citationSchema, paragraphSchema } from '../../shared/src/index.ts';
import { instructions } from '../../../apps/api/src/analysis-provider.ts';

export const labels = ['likely_included', 'possible_scope_addition', 'unclear'] as const;
export type Label = typeof labels[number];
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const root = fileURLToPath(new URL('../../../evaluation/', import.meta.url));
const sourceSchema = z.object({
  id: z.string().min(1), resourceId: z.string().min(1), type: z.enum(['brief', 'change', 'feedback', 'deliverable']),
  version: z.number().int().positive(), status: z.string().min(1), hash: z.string().regex(/^[a-f0-9]{64}$/),
  paragraphs: z.array(paragraphSchema).min(1),
}).strict();
const itemSchema = z.object({
  id: z.string().min(1), requestSpan: z.string().min(1), label: z.enum(labels),
  acceptableEvidence: z.array(citationSchema).min(1), clarificationRequired: z.boolean(),
  clarificationQuestion: z.string(), rationale: z.string().min(1), forbiddenCommitments: z.array(z.string().min(1)).min(1),
}).strict();
export const caseSchema = z.object({
  id: z.string().min(1), scenarioGroup: z.string().min(1), split: z.enum(['development', 'holdout']),
  primaryLabel: z.enum(labels), tags: z.array(z.string().min(1)).min(1), feedbackId: z.string().min(1),
  sources: z.array(sourceSchema).min(2), items: z.array(itemSchema).min(1),
}).strict();
export type EvaluationCase = z.infer<typeof caseSchema>;
export function citationResolves(c: EvaluationCase, ref: z.infer<typeof citationSchema>) {
  return !!c.sources.find(s => s.id === ref.sourceId && s.version === ref.version)?.paragraphs
    .some(p => p.id === ref.paragraphId && p.text.includes(ref.quote));
}
function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function validateDataset(cases: EvaluationCase[]) {
  requireCondition(cases.length === 40, 'Expected 40 cases.');
  requireCondition(new Set(cases.map(c => c.id)).size === 40, 'Duplicate case IDs.');
  requireCondition(new Set(cases.map(c => c.scenarioGroup)).size === 40, 'Project scenarios must be distinct across the dataset.');
  for (const split of ['development', 'holdout']) {
    const selected = cases.filter(c => c.split === split);
    requireCondition(selected.length === 20, `Expected 20 ${split} cases.`);
    labels.forEach((label, i) => requireCondition(selected.filter(c => c.primaryLabel === label).length === [7, 7, 6][i], `Unbalanced ${split} labels.`));
  }
  for (const c of cases) {
    requireCondition(c.items.some(i => i.label === c.primaryLabel), `${c.id}: primary label absent.`);
    requireCondition(new Set(c.sources.map(s => s.id)).size === c.sources.length, `${c.id}: duplicate sources.`);
    requireCondition(new Set(c.items.map(i => i.id)).size === c.items.length, `${c.id}: duplicate items.`);
    requireCondition(Buffer.byteLength(JSON.stringify(c.sources) + instructions) <= 5000, `${c.id}: exceeds provider input cap.`);
    for (const s of c.sources) {
      requireCondition(new Set(s.paragraphs.map(p => p.id)).size === s.paragraphs.length, `${c.id}: duplicate paragraphs.`);
      requireCondition(s.hash === digest({ type: s.type, version: s.version, status: s.status, paragraphs: s.paragraphs }), `${c.id}: source hash mismatch.`);
    }
    const feedback = c.sources.find(s => s.resourceId === c.feedbackId && s.type === 'feedback');
    for (const i of c.items) {
      requireCondition(feedback?.paragraphs.some(p => p.text.includes(i.requestSpan)), `${c.id}: item not in feedback.`);
      requireCondition(i.acceptableEvidence.every(ref => citationResolves(c, ref)), `${c.id}: invalid gold citation.`);
      requireCondition(i.clarificationRequired === !!i.clarificationQuestion, `${c.id}: inconsistent clarification.`);
      requireCondition(i.label !== 'unclear' || i.clarificationRequired, `${c.id}: unclear item needs clarification.`);
      requireCondition(i.label === 'unclear' || i.acceptableEvidence.some(ref => c.sources.some(s => s.id === ref.sourceId && s.status === 'approved' && ['brief', 'change'].includes(s.type))), `${c.id}: missing approved evidence.`);
    }
  }
}
export function loadDataset() {
  const manifest = JSON.parse(readFileSync(`${root}/manifest.json`, 'utf8'));
  const cases: EvaluationCase[] = [];
  for (const split of ['development', 'holdout']) {
    const name = `cases/${split}.json`;
    const bytes = readFileSync(`${root}/${name}`);
    requireCondition(createHash('sha256').update(bytes).digest('hex') === manifest.files[name], `${name}: frozen dataset changed; create a reviewed new version.`);
    const parsed = z.array(caseSchema).parse(JSON.parse(bytes.toString()));
    requireCondition(parsed.every(c => c.split === split), `${name}: wrong split.`);
    cases.push(...parsed);
  }
  validateDataset(cases);
  return { cases, manifest, datasetHash: digest(manifest) };
}
