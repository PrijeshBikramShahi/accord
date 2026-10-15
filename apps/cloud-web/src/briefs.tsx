import React, { useEffect, useState } from 'react';
import type { Approval, Brief, Identity, Paragraph, Project } from '../../../packages/shared/src/index.ts';
import type { CloudApi } from './api.ts';

export type CloudBrief = Brief & { createdByName?: string; submittedAt?: string; approval?: Approval & { actorName: string } };
export type BriefView = { project: Project; latest: CloudBrief | null; baseline: CloudBrief | null; canDecide: boolean };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Could not load the brief. Try again.';
const date = (value: string) => new Date(value).toLocaleString();

function BriefDocument({ brief }: { brief: CloudBrief }) {
  return <>
    <div className="version-bar"><strong>Version {brief.version}</strong><span className={`badge ${brief.status}`}>{brief.status}</span></div>
    {brief.paragraphs.map((paragraph, index) => <div className="brief-paragraph" key={paragraph.id}><span className="paragraph-number">{String(index + 1).padStart(2, '0')}</span><p>{paragraph.text}</p></div>)}
    <div className="document-footer">Saved {date(brief.createdAt)}{brief.createdByName && ` by ${brief.createdByName}`}.
      {brief.approval && <p>{brief.status === 'approved' ? 'Approved' : 'Rejected'} by {brief.approval.actorName} on {date(brief.approval.createdAt)}.</p>}
      <details><summary>Version fingerprint</summary><code>{brief.hash}</code></details>
    </div>
  </>;
}

export function BriefWorkspace({ api, user, project, onProject, onExpired }: { api: CloudApi; user: Identity; project: Project; onProject: (project: Project) => void; onExpired: () => void }) {
  const [view, setView] = useState<BriefView | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<{ expectedVersion: number; paragraphs: Paragraph[] } | null>(null);
  const [confirmation, setConfirmation] = useState<'approve' | 'reject' | null>(null);
  const [history, setHistory] = useState<CloudBrief[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [reading, setReading] = useState<CloudBrief | null>(null);
  const path = `/projects/${project.id}/briefs`;
  const owner = user.role === 'owner';

  useEffect(() => {
    let active = true;
    void api.request<BriefView>(path).then(value => { if (active) { setView(value); onProject(value.project); } })
      .catch(e => { if (active) { setError(errorMessage(e)); onExpired(); } }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
    // The component is keyed by project ID; changing project metadata must not discard edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, path]);

  async function refresh() {
    const value = await api.request<BriefView>(path);
    setView(value); onProject(value.project); setConfirmation(null); setReading(null);
    setHistory([]); setHistoryLoaded(false); setHistoryCursor(null);
  }
  async function run(work: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (e) { setError(errorMessage(e)); onExpired(); } finally { setBusy(false); }
  }
  async function mutate(body: unknown, suffix: string, success: string) {
    await api.request(path + suffix, body);
    setEditing(null); setConfirmation(null); setReading(null);
    // Clear action controls once the write succeeds, even if the follow-up read fails.
    setView(null); setHistory([]); setHistoryLoaded(false); setHistoryCursor(null);
    setNotice(success);
    await refresh();
  }
  const latest = view?.latest;
  const displayed = reading ?? latest;
  const current = !reading || reading.version === latest?.version;

  return <>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="success" role="status">{notice}</p>}
    <div className="section-heading"><div><h2>Project brief</h2><p className="muted">Agree on the work before it begins.</p></div><div className="actions">
      <button disabled={busy || !!editing} onClick={() => void run(refresh)}>Refresh brief</button>
      {owner && view && !editing && <button className="primary" disabled={busy} onClick={() => { setEditing({ expectedVersion: latest?.version ?? 0, paragraphs: latest?.paragraphs.map(p => ({ ...p })) ?? [{ id: `p-${crypto.randomUUID()}`, text: '' }] }); setConfirmation(null); setReading(null); }}>{latest ? 'Create new version' : 'Write the first brief'}</button>}
    </div></div>
    {busy && <p className="muted" role="status">Updating brief…</p>}
    {editing && <form className="editor" onSubmit={event => { event.preventDefault(); void run(() => mutate(editing, '', `Draft version ${editing.expectedVersion + 1} saved. Only you can see it until you submit it.`)); }}>
      <h3>Draft version {editing.expectedVersion + 1}</h3><p className="muted">Saving creates a new version. The approved baseline stays in place.</p>
      {editing.paragraphs.map((paragraph, index) => <div className="paragraph-field" key={paragraph.id}><label>Paragraph {index + 1}<textarea required maxLength={4000} disabled={busy} value={paragraph.text} onChange={event => setEditing({ ...editing, paragraphs: editing.paragraphs.map(p => p.id === paragraph.id ? { ...p, text: event.target.value } : p) })}/></label>
        {editing.paragraphs.length > 1 && <button className="text-button" type="button" disabled={busy} onClick={() => setEditing({ ...editing, paragraphs: editing.paragraphs.filter(p => p.id !== paragraph.id) })}>Remove paragraph {index + 1}</button>}
      </div>)}
      <button type="button" disabled={busy || editing.paragraphs.length >= 30} onClick={() => setEditing({ ...editing, paragraphs: [...editing.paragraphs, { id: `p-${crypto.randomUUID()}`, text: '' }] })}>Add paragraph</button>
      <div className="actions form-actions"><button className="primary" disabled={busy || editing.paragraphs.some(p => !p.text.trim())}>Save draft</button><button type="button" disabled={busy} onClick={() => setEditing(null)}>Cancel editing</button></div>
    </form>}
    {!editing && view && <div className="workspace-grid"><section className="document" aria-label="Brief document">
      {reading && <div className="section-heading"><p className="muted">Reading version history</p><button onClick={() => { setReading(null); setConfirmation(null); }}>Back to latest</button></div>}
      {displayed ? <BriefDocument brief={displayed}/> : <p className="empty">{owner ? 'Write the first brief, then submit it for your client to review.' : 'Your freelancer has not shared a brief yet.'}</p>}
      {current && latest && owner && latest.status === 'draft' && <div className="approval-box"><h3>Ready for client review?</h3><p>Submit version {latest.version} to share its exact text with your client. Further edits will create a new version.</p><button className="primary" disabled={busy} onClick={() => void run(() => mutate({ version: latest.version, hash: latest.hash }, '/submit', `Version ${latest.version} submitted for review.`))}>Submit version {latest.version}</button></div>}
      {current && latest?.status === 'submitted' && !owner && (view.canDecide ? <div className="approval-box"><h3>Review version {latest.version}</h3><p>Approval makes this version the agreed scope. Rejection keeps the previous approved brief in place.</p>
        {confirmation ? <><p>Confirm that you have read version {latest.version} and want to {confirmation} this exact text. Your name and decision will be recorded.</p><div className="actions"><button className="primary" disabled={busy} onClick={() => void run(() => mutate({ version: latest.version, hash: latest.hash, decision: confirmation, expectedScopeRevision: view.project.scopeRevision }, '/decide', `Version ${latest.version} ${confirmation === 'approve' ? 'approved' : 'rejected'}.`))}>Confirm {confirmation === 'approve' ? 'approval' : 'rejection'}</button><button disabled={busy} onClick={() => setConfirmation(null)}>Cancel</button></div></> : <div className="actions"><button className="primary" disabled={busy} onClick={() => setConfirmation('approve')}>Approve version {latest.version}</button><button disabled={busy} onClick={() => setConfirmation('reject')}>Reject version {latest.version}</button></div>}
      </div> : <p className="muted" style={{ marginTop: 24 }}>Your freelancer is preparing a newer version. Review will be available when it is submitted.</p>)}
    </section><aside className="context-panel" aria-label="Approved baseline"><h3>Approved baseline</h3><p>Scope revision {view.project.scopeRevision}</p>
      {view.baseline ? <><strong>Brief version {view.baseline.version}</strong><p>{view.baseline.approval?.actorName ? `Approved by ${view.baseline.approval.actorName}.` : 'Approved scope.'}</p><button disabled={busy} onClick={() => { setReading(view.baseline); setConfirmation(null); }}>Read approved brief</button></> : <p>No brief has been approved yet.</p>}
      <div className="context-divider"/><p>A new draft or a rejection leaves the approved baseline in place.</p>
    </aside></div>}
    {!editing && view && <section className="document" style={{ marginTop: 28 }} aria-label="Version history"><h3>Version history</h3><p className="muted">{owner ? 'Every save preserves the earlier text.' : 'Submitted versions and their recorded decisions.'}</p>
      {history.map(brief => <div className="section-heading" key={brief.version}><div><strong>Version {brief.version}</strong> <span className={`badge ${brief.status}`}>{brief.status}</span><p className="muted">{brief.approval ? `${brief.approval.actorName} ${brief.status} this version on ${date(brief.approval.createdAt)}.` : `Saved ${date(brief.createdAt)}.`}</p></div><button disabled={busy} onClick={() => { setReading(brief); setConfirmation(null); }}>Read version {brief.version}</button></div>)}
      {(!historyLoaded || historyCursor) && <button disabled={busy} onClick={() => void run(async () => { const page = await api.request<{ items: CloudBrief[]; nextCursor: string | null }>(`${path}/history${historyCursor ? `?cursor=${encodeURIComponent(historyCursor)}` : ''}`); setHistory(previous => [...previous, ...page.items]); setHistoryCursor(page.nextCursor); setHistoryLoaded(true); })}>{historyLoaded ? 'Load more versions' : 'Load version history'}</button>}
      {historyLoaded && !history.length && !historyCursor && <p className="muted">No shared versions yet.</p>}
    </section>}
  </>;
}
