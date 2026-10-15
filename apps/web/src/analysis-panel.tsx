import { useEffect, useState } from 'react';
import type { AnalysisFinding, AnalysisView, ReviewDecision } from '../../../packages/shared/src/index.ts';
import { all, api } from './api';
import { Badge, type PanelProps } from './workflow-ui';
const field = (data: FormData, name: string) => String(data.get(name) ?? '');
const labels = { likely_included: 'Likely included', possible_scope_addition: 'Possible scope addition', unclear: 'Unclear' };

export function AnalysisPanel(props: PanelProps) {
  const { view, run, mutate, busy } = props;
  const [jobs, setJobs] = useState<AnalysisView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');
  const root = `/projects/${view.project.id}/analyses`;
  async function refresh() { setJobs(await all<AnalysisView>(root)); setError(''); }
  useEffect(() => {
    let cancelled = false; let loading = false;
    async function poll() {
      if (loading) return; loading = true;
      try { const values = await all<AnalysisView>(root); if (!cancelled) { setJobs(values); setError(''); } }
      catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : 'Analysis could not be loaded.'); }
      finally { loading = false; }
    }
    void poll(); const timer = setInterval(() => void poll(), 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [root]);
  const job = jobs.find(j => j.id === selected) ?? jobs[0];
  const review = async (path: string, body: unknown) => { await mutate(path, body); await refresh(); };
  return <div className="analysis-workspace">
    <div className="section-heading"><div><h2>Review feedback against scope</h2><p className="muted">Private working notes. Your decision determines what happens next.</p></div><span className="local-label">Fixture demo · No live AI</span></div>
    <div className="fixture-note"><strong>Scripted workflow demonstration</strong><p>The original Atlas request has two scripted findings. Other feedback returns an “Unclear” placeholder for manual review. These results do not measure model quality. No model is called and no inference cost is incurred.</p></div>
    <form className="editor" onSubmit={e => { e.preventDefault(); const feedbackId = field(new FormData(e.currentTarget), 'feedbackId'); void run(async () => { const created = await api<{ id: string }>(root, { feedbackId }); setSelected(created.id); await refresh(); }, 'Fixture job saved. Processing happens in the background.'); }}>
      <label>Feedback to review<select name="feedbackId" required defaultValue=""><option value="" disabled>Select a feedback item</option>{view.comments.map(c => <option key={c.id} value={c.id}>{c.authorName}: {c.body.slice(0, 140)}</option>)}</select></label>
      <p className="muted">Includes the complete approved scope, active approved changes and selected feedback thread. Files are excluded. Oversized context is rejected without truncation.</p>
      <button className="primary" disabled={busy || !view.scope.brief || !view.comments.length}>Run fixture analysis</button>{!view.scope.brief && <p>Approve a brief before running an analysis.</p>}
    </form>
    {error && <p className="error" role="alert">{error}</p>}
    {!!jobs.length && <label className="analysis-picker">Analysis history<select value={job?.id ?? ''} onChange={e => setSelected(e.target.value)}>{jobs.map(j => <option key={j.id} value={j.id}>{new Date(j.createdAt).toLocaleString()} — {j.stale ? 'Stale' : j.status.replace('_', ' ')} — {view.comments.find(c => c.id === j.feedbackId)?.body.slice(0, 60)}</option>)}</select></label>}
    {job ? <section className="document" aria-label="Analysis result">
      <div className="section-heading"><h3>Feedback review</h3><Badge status={job.stale ? 'stale' : job.status.replace('_', ' ')}/></div>
      <p className="muted">Fixture run · {job.attempts} of 3 attempts used · Scope revision {job.scopeRevision} · Context revision {job.contextRevision}</p>
      {job.stale && <p className="error" role="status">The scope or feedback has changed. This result is historical. Run a new analysis before acting, or record a separate manual decision in Deliverables.</p>}
      {job.error && <p className="error">{job.error}</p>}
      {['pending_dispatch', 'queued', 'running'].includes(job.status) && <p role="status">{job.status === 'running' ? 'Processing the frozen evidence…' : 'Waiting for the local worker…'} This view refreshes automatically.</p>}
      {job.recoverable && <button disabled={busy} onClick={() => void run(() => review(`${root}/${job.id}/retry`, { expectedVersion: job.version }), 'Job queued for recovery.')}>Recover job</button>}
      <details className="frozen-evidence"><summary>Frozen evidence ({job.sources.length} sources)</summary><p className="muted">Quotes below come from these exact versions. Valid references do not establish semantic support.</p>{job.sources.map(source => <article key={source.id}><h4>{source.type} · {source.resourceId} · version {source.version} · {source.status}</h4>{source.authorName && <p className="muted">{source.authorName}{source.correctionOf && ` · Correction of feedback ${source.correctionOf}`}</p>}{source.paragraphs.map(p => <p key={p.id}><small>{p.id}</small><br/>{p.text}</p>)}</article>)}<p className="record-id">Manifest: {job.manifestHash}<br/>Provider: {job.provider} / {job.modelVersion}<br/>Prompt: {job.promptVersion}<br/>Input: {job.inputBytes} UTF-8 bytes · Cost: $0 (fixture)</p></details>
      {job.result?.findings.map(finding => <FindingReview key={`${job.id}-${finding.id}`} {...props} job={job} finding={finding} root={root} review={review}/>)}
    </section> : !error && <p className="empty">Select feedback to create a durable fixture job. Results remain private to the freelancer.</p>}
  </div>;
}
function FindingReview({ job, finding, root, review, ...props }: PanelProps & { job: AnalysisView; finding: AnalysisFinding; root: string; review: (path: string, body: unknown) => Promise<void> }) {
  const { view, busy, run } = props;
  const [editing, setEditing] = useState(false);
  const [action, setAction] = useState<ReviewDecision['action']>('clarification');
  const decision = job.decisions.find(d => d.findingId === finding.id);
  const canAct = job.status === 'succeeded' && !job.stale;
  const scopeChoices = [...(view.scope.brief ? [{ key: 'brief', label: `Approved brief v${view.scope.brief.version}`, authority: { type: 'brief', id: 'brief', version: view.scope.brief.version, hash: view.scope.brief.hash } }] : []), ...view.scope.changes.map(c => ({ key: c.id, label: `Approved change: ${c.title}`, authority: { type: 'change', id: c.id, version: c.version, hash: c.hash } }))];
  return <article className="analysis-finding">
    <div className="section-heading"><h3>{labels[finding.label]}</h3><span className="muted">Fixture advice</span></div>
    <blockquote>{finding.requestSpan}</blockquote><p>{finding.rationale}</p>
    <h4>Evidence</h4>{finding.citations.map((c, i) => <div className="citation" key={i}><p>“{c.quote}”</p><small>{c.sourceId} · v{c.version} · {c.paragraphId}</small></div>)}
    {!!finding.missingInformation.length && <><h4>Still unanswered</h4><ul>{finding.missingInformation.map((m, i) => <li key={i}>{m}</li>)}</ul></>}
    <h4>Suggested next step</h4><p>{finding.proposedAction}</p>
    {decision ? <div className="scope-note"><strong>Human decision recorded: {decision.action === 'reject' ? 'Advice rejected' : decision.action === 'task' ? 'Task created' : decision.action === 'change' ? 'Change draft saved' : 'Clarification draft saved'}</strong><p>{decision.rationale}</p>{'title' in decision && <p>{decision.title}</p>}{decision.action === 'clarification' && <><blockquote>{decision.body}</blockquote>{decision.publishedCommentId ? <p>Posted to the original feedback thread.</p> : <><p>This draft is private. Posting shares the exact text above with the client.</p><button disabled={busy || !canAct} onClick={() => void run(() => review(`${root}/${job.id}/decisions/${decision.id}/publish`, { expectedVersion: job.version }), 'Clarification posted to the feedback thread.')}>Post clarification to client</button></>}</>}{decision.action === 'change' && <p>Open Brief to review and explicitly submit this draft.</p>}{decision.action === 'task' && <p>The authorized task is visible in Deliverables.</p>}</div> : canAct && <>
      <button disabled={busy} onClick={() => setEditing(!editing)}>{editing ? 'Close decision form' : 'Review and choose action'}</button>
      {editing && <form className="editor decision-editor" onSubmit={e => {
        e.preventDefault(); const data = new FormData(e.currentTarget); const values: Record<string, unknown> = { findingId: finding.id, action, rationale: field(data, 'rationale') };
        if (action === 'task' || action === 'change') { values.title = field(data, 'title'); values.acceptanceCriteria = field(data, 'acceptanceCriteria'); }
        if (action === 'task') values.authority = scopeChoices.find(c => c.key === field(data, 'authority'))?.authority;
        if (action === 'change') for (const k of ['scopeDelta', 'scheduleImplications', 'feeImplications']) values[k] = field(data, k);
        if (action === 'clarification') values.body = field(data, 'body');
        void run(async () => { await review(`${root}/${job.id}/decisions`, values); setEditing(false); }, 'Your decision was recorded.');
      }}><label>Chosen action<select value={action} onChange={e => setAction(e.target.value as ReviewDecision['action'])}><option value="clarification">Save a private clarification draft</option><option value="task">Create a task authorized by approved scope</option><option value="change">Save a private change request draft</option><option value="reject">Reject this advice</option></select></label>
        {(action === 'task' || action === 'change') && <><label>Title<input name="title" required maxLength={120}/></label><label>Acceptance criteria<textarea name="acceptanceCriteria" required maxLength={4000}/></label></>}
        {action === 'task' && <><label>Authorizing scope<select name="authority" required>{scopeChoices.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label><p className="muted">You are confirming this work is covered by the selected approval. The task and rationale will be shared with the client.</p></>}
        {action === 'change' && <><label>Scope delta<textarea name="scopeDelta" required maxLength={4000}/></label><label>Schedule implications<textarea name="scheduleImplications" required maxLength={1000} placeholder="Enter manually, or Not yet agreed"/></label><label>Fee implications<textarea name="feeImplications" required maxLength={1000} placeholder="Enter manually, or Not yet agreed"/></label></>}
        {action === 'clarification' && <label>Clarification text<textarea name="body" required maxLength={4000} defaultValue={finding.missingInformation.join('\n')}/></label>}
        <label>Your decision rationale<textarea name="rationale" required maxLength={2000} placeholder="Explain your judgment and any edits to the advice."/></label>
        <button className="primary" disabled={busy}>{action === 'task' ? 'Create authorized task' : action === 'change' ? 'Save change draft' : action === 'clarification' ? 'Save clarification draft' : 'Record rejection'}</button>
      </form>}
    </>}
  </article>;
}
