import { useRef, useState } from 'react';
import type { Attachment, ChangeRequest } from '../../../packages/shared/src/index.ts';
import { api } from './api';
import { ApprovalActions, Badge, type PanelProps } from './workflow-ui';

const field = (data: FormData, name: string) => String(data.get(name) ?? '');
function SourceFeedback({ view, id }: { view: PanelProps['view']; id: string }) {
  const source = view.comments.find(c => c.id === id);
  return <div className="source-feedback"><h4>Source feedback</h4><blockquote>{source?.body ?? 'Source feedback unavailable.'}</blockquote>{source && <small>{source.authorName}</small>}</div>;
}
function FeedbackSelect({ view, value }: { view: PanelProps['view']; value?: string }) {
  return <label>Source feedback<select name="sourceFeedbackId" required defaultValue={value ?? ''}><option value="" disabled>Select the request this decision addresses</option>{view.comments.map(c => <option key={c.id} value={c.id}>{c.authorName}: {c.body.slice(0, 110)}</option>)}</select></label>;
}

export function ChangesPanel(props: PanelProps) {
  const { view, owner, busy, run, mutate } = props;
  const [editing, setEditing] = useState<ChangeRequest | 'new' | null>(null);
  const [chosen, setChosen] = useState<Record<string, number>>({});
  const latest = view.changes.filter((c, i, all) => all.findIndex(v => v.id === c.id) === i);
  const root = `/projects/${view.project.id}`;
  return <section className="milestone-section" aria-label="Change requests"><div className="section-heading"><div><h2>Change requests</h2><p className="muted">Agree on additional work before it becomes a commitment.</p></div>{owner && <button disabled={busy || !view.scope.brief || !view.comments.length} onClick={() => setEditing('new')}>+ Draft change request</button>}</div>
    {owner && (!view.scope.brief || !view.comments.length) && <p className="muted">An approved brief and source feedback are needed before drafting a change.</p>}
    {editing && <form className="editor" key={editing === 'new' ? 'new' : `${editing.id}-${editing.version}`} onSubmit={e => {
      e.preventDefault(); const data = new FormData(e.currentTarget);
      void run(async () => {
        await mutate(`${root}/changes${editing === 'new' ? '' : `/${editing.id}`}`, { title: field(data, 'title'), scopeDelta: field(data, 'scopeDelta'), acceptanceCriteria: field(data, 'acceptanceCriteria'), scheduleImplications: field(data, 'scheduleImplications'), feeImplications: field(data, 'feeImplications'), rationale: field(data, 'rationale'), sourceFeedbackId: field(data, 'sourceFeedbackId'), expectedVersion: editing === 'new' ? 0 : editing.version, expectedScopeRevision: view.project.scopeRevision }, editing === 'new' ? 'POST' : 'PATCH');
        setEditing(null); setChosen({});
      }, 'Change draft saved. Submit it explicitly to share it with the client.');
    }}><h3>{editing === 'new' ? 'Draft a change request' : 'Create a new change version'}</h3><p className="muted">This version will be based on scope revision {view.project.scopeRevision}. Enter the schedule and fee implications yourself; use “Not yet agreed” when unknown.</p>
      <label>Change title<input name="title" required maxLength={120} defaultValue={editing === 'new' ? '' : editing.title}/></label>
      <FeedbackSelect view={view} value={editing === 'new' ? undefined : editing.sourceFeedbackId}/>
      <label>Scope delta<textarea name="scopeDelta" required maxLength={4000} placeholder="What is being added, removed, or changed? Identify any existing provision this replaces." defaultValue={editing === 'new' ? '' : editing.scopeDelta}/></label>
      <label>Change acceptance criteria<textarea name="acceptanceCriteria" required maxLength={4000} defaultValue={editing === 'new' ? '' : editing.acceptanceCriteria}/></label>
      <div className="form-pair"><label>Schedule implications<textarea name="scheduleImplications" required maxLength={1000} defaultValue={editing === 'new' ? '' : editing.scheduleImplications}/></label><label>Fee implications<textarea name="feeImplications" required maxLength={1000} defaultValue={editing === 'new' ? '' : editing.feeImplications}/></label></div>
      <label>Decision rationale<textarea name="rationale" required maxLength={2000} placeholder="Explain why this request changes the agreed scope. This is shared on submission." defaultValue={editing === 'new' ? '' : editing.rationale}/></label>
      <div className="actions"><button className="primary" disabled={busy}>Save change draft</button><button type="button" disabled={busy} onClick={() => setEditing(null)}>Cancel</button></div>
    </form>}
    <div className="deliverables">{latest.map(newest => {
      const versions = view.changes.filter(c => c.id === newest.id);
      const item = versions.find(c => c.version === chosen[newest.id]) ?? newest;
      const stale = item.baseScopeRevision !== view.project.scopeRevision && item.status !== 'approved';
      const incorporated = view.scope.brief?.incorporatedChangeIds.includes(item.id);
      return <article className="document" key={item.id}><div className="section-heading"><h3>{item.title}</h3><Badge status={item.status}/></div>
        <div className="version-bar"><label className="inline-label">Change version<select value={item.version} onChange={e => setChosen({ ...chosen, [item.id]: Number(e.target.value) })}>{versions.map(v => <option key={v.version} value={v.version}>Version {v.version}</option>)}</select></label>{owner && newest.status !== 'approved' && <button disabled={busy} onClick={() => setEditing(newest)}>Revise change</button>}</div>
        <h4>Scope delta</h4><p className="preserve">{item.scopeDelta}</p><div className="criteria"><h4>Acceptance criteria</h4><p className="preserve">{item.acceptanceCriteria}</p></div>
        <dl className="implications"><div><dt>Schedule</dt><dd>{item.scheduleImplications}</dd></div><div><dt>Fee</dt><dd>{item.feeImplications}</dd></div></dl>
        <h4>Decision rationale</h4><p className="preserve">{item.rationale}</p><SourceFeedback view={view} id={item.sourceFeedbackId}/>
        {item.status === 'approved' && <p className="scope-note">{incorporated ? `Incorporated into brief version ${view.scope.brief?.version}.` : 'Active addition to the approved brief.'}</p>}
        {stale && <p className="error">Scope has changed since this version was written. The freelancer must save a revised version against the current scope before it can be approved.</p>}
        {owner && item === newest && item.status === 'draft' && <div className="approval-box"><p>Submitting shares this exact scope delta, criteria, schedule and fee implications with the client.</p><button className="primary" disabled={busy || stale} onClick={() => void run(() => mutate(`${root}/changes/${item.id}/versions/${item.version}/submit`, { expectedVersion: item.version }), 'Change request submitted for client review.')}>Submit change version {item.version}</button></div>}
        {!owner && item === newest && item.status === 'submitted' && !stale && <ApprovalActions key={`${item.id}-${item.version}`} {...props} item={item} type="change"/>}
      </article>;
    })}</div>{!latest.length && <p className="empty">No change requests yet. Feedback alone does not alter the agreement.</p>}
  </section>;
}

export function TasksPanel({ view, owner, busy, run, mutate }: PanelProps) {
  const [editing, setEditing] = useState(false);
  const scopeChoices = [...(view.scope.brief ? [{ key: 'brief', label: `Approved brief v${view.scope.brief.version}`, authority: { type: 'brief', id: 'brief', version: view.scope.brief.version, hash: view.scope.brief.hash } }] : []), ...view.scope.changes.map(c => ({ key: c.id, label: `Approved change: ${c.title} (v${c.version})`, authority: { type: 'change', id: c.id, version: c.version, hash: c.hash } }))];
  const root = `/projects/${view.project.id}`;
  return <section className="milestone-section" aria-label="Revision tasks"><div className="section-heading"><div><h2>Revision tasks</h2><p className="muted">Work authorized by an exact approval and a recorded human decision.</p></div>{owner && <button disabled={busy || !scopeChoices.length || !view.comments.length} onClick={() => setEditing(!editing)}>{editing ? 'Close task form' : '+ Create revision task'}</button>}</div>
    {editing && <form className="editor" onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); const selected = scopeChoices.find(c => c.key === field(data, 'authority')); if (!selected) return; void run(async () => {
      await mutate(`${root}/tasks`, { title: field(data, 'title'), acceptanceCriteria: field(data, 'acceptanceCriteria'), rationale: field(data, 'rationale'), sourceFeedbackId: field(data, 'sourceFeedbackId'), authority: selected.authority, expectedScopeRevision: view.project.scopeRevision }); setEditing(false);
    }, 'Revision task created with its source feedback and approval.'); }}><h3>Record a manual scope decision</h3><label>Task title<input name="title" required maxLength={120}/></label><FeedbackSelect view={view}/><label>Authorizing scope<select name="authority" required>{scopeChoices.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label><label>Task acceptance criteria<textarea name="acceptanceCriteria" required maxLength={4000}/></label><label>Why this work is authorized<textarea name="rationale" required maxLength={2000} placeholder="Cite the relevant agreement and explain your decision. The client can see this rationale."/></label><p className="muted">Unapproved changes cannot authorize tasks. Selecting a scope reference records your judgment; Accord does not determine semantic coverage.</p><button className="primary" disabled={busy}>Create authorized task</button></form>}
    <div className="deliverables">{view.tasks.map(task => <article className="document" key={task.id}><div className="section-heading"><h3>{task.title}</h3><Badge status={task.status.replace('_', ' ')}/></div><h4>Acceptance criteria</h4><p className="preserve">{task.acceptanceCriteria}</p><h4>Human decision</h4><p className="preserve">{task.rationale}</p><SourceFeedback view={view} id={task.sourceFeedbackId}/><p className="muted">Authorized by {task.authority.type === 'brief' ? 'brief' : view.changes.find(c => c.id === task.authority.id)?.title ?? 'change'} version {task.authority.version}, scope revision {task.scopeRevision}.</p><details><summary>Approval reference</summary><p className="record-id">Approval: {task.approvalId}<br/>Decision: {task.decisionId}</p></details>
      {owner && <label className="task-status">Task status<select value={task.status} disabled={busy} onChange={e => void run(() => mutate(`${root}/tasks/${task.id}`, { expectedVersion: task.version, expectedScopeRevision: view.project.scopeRevision, status: e.target.value }, 'PATCH'), 'Task status updated.')}><option value="todo">To do</option><option value="in_progress">In progress</option><option value="complete">Complete</option></select></label>}
    </article>)}</div>{!view.tasks.length && <p className="empty">No revision tasks yet. Record a decision against approved scope to authorize work.</p>}
  </section>;
}

export function FilesPanel({ view, owner, busy, run, mutate }: PanelProps) {
  const [file, setFile] = useState<File | null>(null);
  const [parent, setParent] = useState('project');
  const [inputKey, setInputKey] = useState(0);
  const pending = useRef<{ signature: string; file: Attachment } | null>(null);
  const root = `/projects/${view.project.id}`;
  const drafts = view.deliverables.filter((d, i, all) => d.status === 'draft' && all.findIndex(v => v.id === d.id) === i);
  const ready = view.attachments.filter(a => a.status === 'ready');
  return <section className="milestone-section" aria-label="Private attachments"><div className="section-heading"><div><h2>Private attachments</h2><p className="muted">PDF, PNG, JPEG or UTF-8 text. Up to 5 MB each and 20 files per project. Download only.</p></div></div>
    <form className="editor" onSubmit={e => { e.preventDefault(); if (!file) return; void run(async () => {
      if (!file.size || file.size > 5 * 1024 * 1024) throw new Error('Choose a nonempty file of 5 MB or less.');
      const extensions: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', txt: 'text/plain' };
      const mime = extensions[file.name.split('.').pop()?.toLowerCase() ?? ''];
      if (!mime) throw new Error('Choose a PDF, PNG, JPEG or .txt file.');
      const bytes = await file.arrayBuffer();
      const checksum = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2, '0')).join('');
      const draft = drafts.find(d => `${d.id}:${d.version}` === parent);
      if (parent !== 'project' && !draft) throw new Error('That draft changed. Select the latest version and try again.');
      const values = { filename: file.name, size: file.size, mime, checksum, parent: draft ? { type: 'deliverable', id: draft.id, version: draft.version } : { type: 'project' } };
      const signature = JSON.stringify(values);
      if (!pending.current || pending.current.signature !== signature || pending.current.file.expiresAt <= Date.now()) pending.current = { signature, file: await api<Attachment>(`${root}/attachments/upload-intent`, values) };
      const dataBase64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('Could not read the selected file.')); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file); });
      await mutate(`${root}/attachments/${pending.current.file.id}/complete`, { expectedVersion: 1, dataBase64 });
      pending.current = null; setFile(null); setInputKey(inputKey + 1);
    }, 'Attachment saved privately.'); }}>
      <label>Attach to<select value={parent} disabled={busy} onChange={e => { setParent(e.target.value); pending.current = null; }}><option value="project">Project (shared with project participants)</option>{owner && drafts.map(d => <option key={`${d.id}:${d.version}`} value={`${d.id}:${d.version}`}>{d.title} · draft v{d.version}</option>)}</select></label>
      <label>Choose attachment<input key={inputKey} type="file" accept=".pdf,.png,.jpg,.jpeg,.txt" required disabled={busy} onChange={e => { setFile(e.target.files?.[0] ?? null); pending.current = null; }}/></label><p className="muted">Draft deliverable files stay private until submission. Their checksums become part of the submitted content. Project files are shared context, not approved commitments. Use synthetic demo files.</p><button className="primary" disabled={busy || !file}>{busy ? 'Saving…' : 'Upload attachment'}</button>
    </form>
    <div className="file-list">{ready.map(a => <div className="file-row" key={a.id}><div><strong>{a.filename}</strong><small>{Math.ceil(a.size / 1024)} KB · {a.parent.type === 'project' ? 'Project' : `Deliverable v${a.parent.version}`} · Immutable version 1</small></div><button disabled={busy} onClick={() => void run(async () => { const result = await api<{ url: string }>(`${root}/attachments/${a.id}/download`); const link = document.createElement('a'); link.href = result.url; link.download = a.filename; document.body.appendChild(link); link.click(); link.remove(); }, 'Download requested. The link expires in 60 seconds.')}>Download {a.filename}</button></div>)}</div>
    {!ready.length && <p className="empty">No completed attachments visible here yet.</p>}{view.attachments.some(a => a.status === 'pending') && <p className="muted">An upload is awaiting completion. Retry the same selected file; unused reservations expire after 15 minutes.</p>}
  </section>;
}
