import { randomUUID } from 'node:crypto';
import { analysisRequestSchema, analysisResultSchema, reviewSchema, versionSchema, type AnalysisJob, type AnalysisResult, type AnalysisSource, type AnalysisView, type Comment, type Deliverable, type Identity, type ReviewDecision } from '../../../packages/shared/src/index.ts';
import { addComment, audit, authorize, Problem } from './domain.ts';
import { createChange, createTask, effectiveScope } from './scope.ts';
import { hash, Store } from './store.ts';
import { instructions } from './analysis-provider.ts';

export const fixtureLimits = { total: 300, daily: 60, project: 20 };
export function reserveAttempt(store: Store, projectId: string, jobId: string, ordinal: number, limits = fixtureLimits) {
  const total = Number(store.db.prepare('SELECT COUNT(*) AS n FROM analysis_attempts').get()!.n);
  const daily = Number(store.db.prepare('SELECT COUNT(*) AS n FROM analysis_attempts WHERE reserved_at >= ?').get(Date.now() - 86_400_000)!.n);
  const project = Number(store.db.prepare('SELECT COUNT(*) AS n FROM analysis_attempts WHERE project_id=?').get(projectId)!.n);
  if (total >= limits.total || daily >= limits.daily || project >= limits.project) throw new Problem(422, 'Local fixture attempt allowance exhausted (300 total, 60 per rolling day, 20 per project).');
  store.db.prepare('INSERT INTO analysis_attempts (id, project_id, job_id, ordinal, state, reserved_at) VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), projectId, jobId, ordinal, 'reserved', Date.now());
}
export function saveJob(store: Store, projectId: string, job: AnalysisJob) {
  job.version++; job.updatedAt = new Date().toISOString();
  // Job is mutable state, unlike the frozen sources and persisted result it contains.
  store.put(projectId, 'analyses', job.id, 1, job);
}
export function stale(store: Store, projectId: string, job: AnalysisJob) {
  const p = store.project(projectId);
  return !p || p.scopeRevision !== job.scopeRevision || p.contextRevision !== job.contextRevision;
}
export function loadJob(store: Store, user: Identity, projectId: string, id: string) {
  authorize(store, user, projectId, true);
  const job = store.get<AnalysisJob>(projectId, 'analyses', id, 1);
  if (!job) throw new Problem(404, 'Analysis not found.');
  return job;
}
export function viewJob(store: Store, user: Identity, projectId: string, id: string): AnalysisView {
  const job = loadJob(store, user, projectId, id);
  const { leaseToken: _leaseToken, ...safe } = job;
  const isStale = stale(store, projectId, job);
  const interrupted = job.status === 'running' && (job.leaseUntil ?? 0) <= Date.now();
  return { ...safe, ...(interrupted ? { status: 'failed' as const, error: job.attempts < 3 ? 'Worker lease expired. Recover this interrupted job.' : 'Worker lease expired after the final attempt. No further recovery is allowed.' } : {}), stale: isStale, recoverable: !isStale && (job.status === 'pending_dispatch' || job.status === 'queued' || (interrupted && job.attempts < 3) || (job.status === 'failed' && !!job.retryable && job.attempts < 3 && (job.retryAfter ?? 0) <= Date.now())), decisions: store.list<ReviewDecision>(projectId, 'analysis_decisions').filter(d => d.jobId === id) };
}
export function requestAnalysis(store: Store, user: Identity, projectId: string, input: unknown) {
  const project = authorize(store, user, projectId, true);
  const { feedbackId } = analysisRequestSchema.parse(input);
  const target = store.get<Comment>(projectId, 'comments', feedbackId, 1);
  if (!target) throw new Problem(404, 'Feedback not found.');
  const scope = effectiveScope(store, user, projectId);
  if (!scope.brief) throw new Problem(422, 'Approve a brief before analyzing feedback.');
  const sources: AnalysisSource[] = [{ id: 'brief', resourceId: 'brief', type: 'brief', version: scope.brief.version, status: 'approved', hash: scope.brief.hash, paragraphs: scope.brief.paragraphs }];
  for (const c of scope.changes) sources.push({ id: `change:${c.id}`, resourceId: c.id, type: 'change', version: c.version, status: 'approved', hash: c.hash, paragraphs: [{ id: 'p-delta', text: c.scopeDelta }, { id: 'p-criteria', text: c.acceptanceCriteria }, { id: 'p-schedule', text: c.scheduleImplications }, { id: 'p-fee', text: c.feeImplications }] });
  const comments = store.list<Comment>(projectId, 'comments').filter(c => c.deliverableId === target.deliverableId).reverse();
  for (const c of comments) sources.push({ id: `feedback:${c.id}`, resourceId: c.id, type: 'feedback', version: 1, status: 'nonbinding', authorName: c.authorName, createdAt: c.createdAt, ...(c.correctionOf ? { correctionOf: c.correctionOf } : {}), hash: hash(c), paragraphs: [{ id: 'p-comment', text: c.body }] });
  if (target.deliverableId) {
    const d = store.list<Deliverable>(projectId, 'deliverables').find(d => d.id === target.deliverableId && d.status !== 'draft');
    if (!d) throw new Problem(422, 'The shared deliverable context is unavailable.');
    sources.push({ id: `deliverable:${d.id}`, resourceId: d.id, type: 'deliverable', version: d.version, status: d.status, hash: d.hash, paragraphs: [{ id: 'p-description', text: d.description }, { id: 'p-criteria', text: d.acceptanceCriteria }] });
  }
  const inputBytes = Buffer.byteLength(JSON.stringify(sources) + instructions, 'utf8');
  // Conservative local byte cap with space for a future provider's schema. No scope truncation.
  if (inputBytes > 5000) throw new Problem(422, 'Context too large for this local fixture workflow (5,000 UTF-8 bytes). No scope was truncated. Use a smaller supported project/thread.');
  const timestamp = new Date().toISOString();
  const job: AnalysisJob = { id: randomUUID(), version: 1, requesterId: user.id, feedbackId, scopeRevision: project.scopeRevision, contextRevision: project.contextRevision, sources, manifestHash: hash(sources), provider: 'fixture', modelVersion: 'atlas-demo-v1', promptVersion: 'scope-review-v1', status: 'pending_dispatch', attempts: 0, createdAt: timestamp, updatedAt: timestamp, inputBytes, costMicros: 0 };
  reserveAttempt(store, projectId, job.id, 1);
  store.put(projectId, 'analyses', job.id, 1, job);
  audit(store, projectId, user, 'Analysis draft requested (fixture)', job.id);
  return { id: job.id };
}
export function dispatchJob(store: Store, projectId: string, id: string) {
  store.transaction(() => {
    const job = store.get<AnalysisJob>(projectId, 'analyses', id, 1);
    if (!job || !['pending_dispatch', 'queued'].includes(job.status)) return;
    store.db.prepare('INSERT OR IGNORE INTO analysis_queue VALUES (?, ?)').run(projectId, id);
    if (job.status === 'pending_dispatch') { job.status = 'queued'; saveJob(store, projectId, job); }
  });
}
export function retryAnalysis(store: Store, user: Identity, projectId: string, id: string, input: unknown) {
  const { expectedVersion } = versionSchema.parse(input);
  const job = loadJob(store, user, projectId, id);
  if (job.version !== expectedVersion) throw new Problem(409, 'Job changed. Refresh before recovering it.');
  if (!viewJob(store, user, projectId, id).recoverable) throw new Problem(409, 'This job cannot be recovered. Rerun stale feedback or review its failure.');
  if ((job.status === 'running' || job.status === 'failed') && job.attempts > 0) {
    if (job.attempts >= 3) throw new Problem(422, 'This job has reached its three-attempt limit.');
    const reserved = store.db.prepare("SELECT id FROM analysis_attempts WHERE project_id=? AND job_id=? AND ordinal=? AND state='reserved'").get(projectId, id, job.attempts + 1);
    if (!reserved) reserveAttempt(store, projectId, id, job.attempts + 1);
    store.db.prepare("UPDATE analysis_attempts SET state='uncertain' WHERE project_id=? AND job_id=? AND state='running'").run(projectId, id);
  }
  job.status = 'pending_dispatch'; delete job.leaseToken; delete job.leaseUntil; delete job.error; delete job.retryable; delete job.retryAfter;
  saveJob(store, projectId, job);
  audit(store, projectId, user, 'Analysis draft recovery requested', id);
  return { id };
}
export function validateResult(job: Pick<AnalysisJob, 'sources' | 'feedbackId'>, output: unknown): AnalysisResult {
  if (Buffer.byteLength(JSON.stringify(output) ?? '', 'utf8') > 14000) throw new Error('Result exceeds the local output cap.');
  const result = analysisResultSchema.parse(output);
  if (new Set(result.findings.map(f => f.id)).size !== result.findings.length) throw new Error('Duplicate finding IDs.');
  for (const f of result.findings) {
    const request = job.sources.find(s => s.type === 'feedback' && s.resourceId === f.feedbackId);
    if (f.feedbackId !== job.feedbackId || !request?.paragraphs.some(p => p.text.includes(f.requestSpan))) throw new Error('Request span is not in the selected feedback.');
    for (const c of f.citations) {
      const source = job.sources.find(s => s.id === c.sourceId && s.version === c.version);
      if (!source?.paragraphs.some(p => p.id === c.paragraphId && p.text.includes(c.quote))) throw new Error('Citation does not resolve to an exact frozen source.');
    }
    if (!f.citations.some(c => c.sourceId === request.id && c.quote.includes(f.requestSpan))) throw new Error('A finding must cite its request span.');
    if (f.label !== 'unclear' && !f.citations.some(c => job.sources.some(s => s.id === c.sourceId && (s.type === 'brief' || s.type === 'change') && s.status === 'approved'))) throw new Error('A scope label requires approved-scope evidence.');
    if (f.label === 'unclear' && !f.missingInformation.length) throw new Error('Unclear findings require a clarification question.');
  }
  return result;
}
export function reviewAnalysis(store: Store, user: Identity, projectId: string, id: string, input: unknown) {
  const job = loadJob(store, user, projectId, id);
  const data = reviewSchema.parse(input);
  if (job.status !== 'succeeded' || stale(store, projectId, job)) throw new Problem(409, 'Analysis is incomplete or stale. Rerun before creating a decision. Manual scope decisions remain available.');
  const finding = job.result?.findings.find(f => f.id === data.findingId);
  if (!finding) throw new Problem(404, 'Finding not found.');
  if (store.list<ReviewDecision>(projectId, 'analysis_decisions').some(d => d.jobId === id && d.findingId === data.findingId)) throw new Problem(409, 'This finding already has a recorded decision.');
  const decision: ReviewDecision = { ...data, id: randomUUID(), jobId: id, actorId: user.id, createdAt: new Date().toISOString() };
  if (data.action === 'task') {
    const task = createTask(store, user, projectId, { title: data.title, acceptanceCriteria: data.acceptanceCriteria, rationale: data.rationale, sourceFeedbackId: finding.feedbackId, authority: data.authority, expectedScopeRevision: job.scopeRevision });
    decision.id = task.decisionId; decision.targetId = task.id;
  }
  if (data.action === 'change') {
    const change = createChange(store, user, projectId, { title: data.title, scopeDelta: data.scopeDelta, acceptanceCriteria: data.acceptanceCriteria, scheduleImplications: data.scheduleImplications, feeImplications: data.feeImplications, rationale: data.rationale, sourceFeedbackId: finding.feedbackId, expectedScopeRevision: job.scopeRevision, expectedVersion: 0 });
    decision.targetId = change.id;
  }
  store.put(projectId, 'analysis_decisions', decision.id, 1, decision);
  audit(store, projectId, user, `Analysis draft decision: ${data.action}`, decision.id);
  return decision;
}
export function publishClarification(store: Store, user: Identity, projectId: string, jobId: string, decisionId: string, input: unknown) {
  const { expectedVersion } = versionSchema.parse(input);
  const job = loadJob(store, user, projectId, jobId);
  const decision = store.get<ReviewDecision>(projectId, 'analysis_decisions', decisionId, 1);
  if (!decision || decision.jobId !== jobId || decision.action !== 'clarification') throw new Problem(404, 'Clarification draft not found.');
  if (expectedVersion !== job.version || stale(store, projectId, job) || decision.publishedCommentId) throw new Problem(409, 'Context changed or this clarification was already posted. Review the current feedback before posting.');
  const source = store.get<Comment>(projectId, 'comments', job.feedbackId, 1)!;
  const comment = addComment(store, user, projectId, { body: decision.body, ...(source.deliverableId ? { deliverableId: source.deliverableId } : {}) });
  decision.publishedCommentId = comment.id;
  store.put(projectId, 'analysis_decisions', decision.id, 1, decision);
  return decision;
}
