import { randomUUID } from 'node:crypto';
import type { AnalysisJob } from '../../../packages/shared/src/index.ts';
import { authorize } from './domain.ts';
import { saveJob, stale, validateResult } from './analysis.ts';
import { fixtureProvider, type AnalysisProvider } from './analysis-provider.ts';
import { Store } from './store.ts';

export class TransientProviderError extends Error {}
type WorkerOptions = { provider?: AnalysisProvider; enabled?: () => boolean; leaseMs?: number; timeoutMs?: number };
function requesterCanAccess(store: Store, projectId: string, job: AnalysisJob) {
  const user = store.user(job.requesterId);
  if (!user) return false;
  try { authorize(store, user, projectId, true); return true; } catch { return false; }
}
export async function processOne(store: Store, options: WorkerOptions = {}) {
  const provider = options.provider ?? fixtureProvider;
  if (provider.mode !== 'fixture') throw new Error('Only the local fixture provider is enabled.');
  const claimed = store.transaction(() => {
    const row = store.db.prepare('SELECT project_id, job_id FROM analysis_queue ORDER BY rowid LIMIT 1').get();
    if (!row) return null;
    const projectId = String(row.project_id);
    const job = store.get<AnalysisJob>(projectId, 'analyses', String(row.job_id), 1);
    store.db.prepare('DELETE FROM analysis_queue WHERE project_id=? AND job_id=?').run(projectId, row.job_id);
    if (!job || job.status !== 'queued') return null; // Duplicate delivery, including a running lease.
    if (!requesterCanAccess(store, projectId, job)) { job.status = 'failed'; job.error = 'Requester access was revoked.'; job.retryable = false; saveJob(store, projectId, job); return null; }
    if (stale(store, projectId, job)) { job.status = 'stale'; job.error = 'Sources changed before execution. Rerun with current context.'; saveJob(store, projectId, job); return null; }
    if (options.enabled && !options.enabled()) { job.status = 'failed'; job.error = 'Local analysis is disabled. Enable it before recovery.'; job.retryable = true; saveJob(store, projectId, job); return null; }
    if (job.attempts >= 3) { job.status = 'failed'; job.error = 'Three-attempt limit reached.'; job.retryable = false; saveJob(store, projectId, job); return null; }
    const reservation = store.db.prepare("UPDATE analysis_attempts SET state='running' WHERE project_id=? AND job_id=? AND ordinal=? AND state='reserved'").run(projectId, job.id, job.attempts + 1);
    if (reservation.changes !== 1) { job.status = 'failed'; job.error = 'No reserved attempt is available.'; job.retryable = false; saveJob(store, projectId, job); return null; }
    job.attempts++; job.status = 'running'; job.leaseToken = randomUUID(); job.leaseUntil = Date.now() + (options.leaseMs ?? 30_000);
    saveJob(store, projectId, job);
    return { projectId, job };
  });
  if (!claimed) return false;
  const { projectId, job } = claimed;
  const started = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let output: unknown;
  let error: unknown;
  try {
    output = await Promise.race([
      provider.invoke(job, controller.signal),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new TransientProviderError('Provider timeout.')); }, options.timeoutMs ?? 5000); }),
    ]);
    output = validateResult(job, output);
  } catch (caught) { error = caught; }
  finally { if (timer) clearTimeout(timer); }
  store.transaction(() => {
    const current = store.get<AnalysisJob>(projectId, 'analyses', job.id, 1);
    // Fencing check: a timed-out/lost lease cannot overwrite a newer attempt.
    if (!current || current.status !== 'running' || current.leaseToken !== job.leaseToken || (current.leaseUntil ?? 0) <= Date.now()) return;
    current.durationMs = Date.now() - started;
    if (!requesterCanAccess(store, projectId, current)) { current.status = 'failed'; current.error = 'Requester access was revoked.'; current.retryable = false; }
    else if (error) {
      current.status = 'failed'; current.retryable = error instanceof TransientProviderError && current.attempts < 3;
      current.retryAfter = Date.now() + 1000 * 2 ** current.attempts;
      current.error = error instanceof TransientProviderError ? 'Fixture provider timed out or failed temporarily. Recover after the retry delay.' : 'Output failed validation or the provider failed permanently. No actions were created.';
    } else {
      current.result = output as AnalysisJob['result'];
      current.status = stale(store, projectId, current) ? 'stale' : 'succeeded';
      if (current.status === 'stale') current.error = 'Sources changed during execution. Result is historical; rerun before acting.';
    }
    store.db.prepare('UPDATE analysis_attempts SET state=? WHERE project_id=? AND job_id=? AND ordinal=?').run(error instanceof TransientProviderError ? 'uncertain' : current.status, projectId, job.id, current.attempts);
    delete current.leaseToken; delete current.leaseUntil;
    saveJob(store, projectId, current);
  });
  return true;
}
export function startLocalWorker(store: Store, options: WorkerOptions = {}) {
  let running: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    if (!running) running = processOne(store, options).catch(() => { console.error('Local analysis worker stopped a tick; recover interrupted jobs from Analysis.'); }).finally(() => { running = undefined; });
  }, 1000);
  timer.unref();
  return async () => { clearInterval(timer); await running; };
}
