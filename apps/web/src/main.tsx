import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Approval, Attachment, Audit, Brief, ChangeRequest, Comment, Deliverable, EffectiveScope, Identity, Paragraph, Project, RevisionTask, WorkspaceView } from '../../../packages/shared/src/index.ts';
import { all, api, ApiError } from './api';
import './styles.css';
import { AnalysisPanel } from './analysis-panel';
import { ChangesPanel, TasksPanel, FilesPanel } from './m2-panels';
import { ApprovalActions, Badge, type PanelProps, type Run } from './workflow-ui';

type Tab = 'Brief' | 'Deliverables' | 'Feedback' | 'Analysis' | 'History';
const date = (value: string) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const field = (data: FormData, name: string) => String(data.get(name) ?? '');


function App() {
  const [user, setUser] = useState<Identity | null>(null);
  const [booting, setBooting] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null);
  const [tab, setTab] = useState<Tab>('Brief');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [clients, setClients] = useState<Identity[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => { api<Identity>('/auth/me').then(setUser).catch(e => { if (!(e instanceof ApiError && e.status === 401)) setError('Could not reach Accord. Check that the local API is running.'); }).finally(() => setBooting(false)); }, []);
  const refreshProjects = async () => { setProjects(await all<Project>('/projects')); };
  const loadWorkspace = async (id: string): Promise<WorkspaceView> => {
    const root = `/projects/${id}`;
    const [project, briefs, deliverables, comments, approvals, history, changes, tasks, attachments, scope] = await Promise.all([
      api<Project>(root), all<Brief>(`${root}/briefs`), all<Deliverable>(`${root}/deliverables`), all<Comment>(`${root}/comments`), all<Approval>(`${root}/approvals`), all<Audit>(`${root}/history`), all<ChangeRequest>(`${root}/changes`), all<RevisionTask>(`${root}/tasks`), all<Attachment>(`${root}/attachments`), api<EffectiveScope>(`${root}/scope`),
    ]);
    return { project, briefs, deliverables, comments, approvals, history, changes, tasks, attachments, scope };
  };
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    all<Project>('/projects').then(p => { if (!cancelled) setProjects(p); }).catch(e => { if (!cancelled) setError(e.message); });
    if (user.role === 'owner') all<Identity>('/clients').then(c => { if (!cancelled) setClients(c); }).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [user]);
  useEffect(() => {
    setWorkspace(null);
    if (!selected) return;
    let cancelled = false;
    setLoading(true);
    loadWorkspace(selected).then(value => { if (!cancelled) setWorkspace(value); }).catch(e => { if (!cancelled) setError(e.message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selected]);
  const run: Run = async (fn, message) => {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); setNotice(message); }
    catch (e) {
      setError(e instanceof Error ? e.message : 'The request failed. Try again.');
      if (e instanceof ApiError && e.status === 401) { setUser(null); setSelected(null); setWorkspace(null); setProjects([]); }
    } finally { setBusy(false); }
  };
  const mutate = async (path: string, data: unknown, method?: string) => {
    await api(path, data, method);
    try {
      if (selected) setWorkspace(await loadWorkspace(selected));
      await refreshProjects();
    } catch {
      // The write succeeded. Let forms clear so a failed refresh cannot cause a duplicate post.
      setError('Your change was saved, but the latest view could not be loaded. Reopen the project to refresh it.');
    }
  };
  function openProject(id: string | null) { setError(''); setNotice(''); setSelected(id); setTab('Brief'); setCreating(false); }
  if (booting) return <div className="boot">Opening Accord…</div>;
  if (!user) return <div className="login-layout">
    <section className="login-story"><Brand/><div><h1>Good work starts<br/>with an accord.</h1><p>A shared place for the brief, the feedback, and the decisions that keep a project moving.</p><div className="agreement-graphic" aria-hidden="true"><span>Agreed scope</span><div/><div/><div/><strong>Reviewed together. Recorded clearly.</strong></div></div><small>Clear scope. Considered decisions.</small></section>
    <main className="login-panel"><div className="login-box"><span className="local-label">Local development</span><h2>Welcome to your workspace</h2><p>Sign in with a seeded account to review your projects.</p><form onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); void run(async () => setUser(await api<Identity>('/auth/login', { email: field(data, 'email'), password: field(data, 'password') })), ''); }}>
      <label>Email<input name="email" type="email" autoComplete="username" placeholder="maya@accord.local" required/></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required/></label>
      {error && <p role="alert" className="error">{error}</p>}<button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form><p className="login-help">Login details are saved in <code>.local/demo-accounts.json</code> after running <code>npm run seed</code>.</p></div></main>
  </div>;
  const isOwner = user.role === 'owner';
  return <div className="shell">
    <aside className="sidebar"><Brand/><div className="workspace-name"><span className="avatar">{user.name.split(' ').map(p => p[0]).join('')}</span><div>{user.name}<small>{isOwner ? 'Freelancer workspace' : 'Client workspace'}</small></div></div>
      <nav aria-label="Projects"><button disabled={busy} className={`nav-item ${!selected ? 'active' : ''}`} onClick={() => openProject(null)}><span aria-hidden="true">▦</span> All projects <span className="nav-count">{projects.length}</span></button><p className="nav-heading">Your projects</p>{projects.map(p => <button disabled={busy} className={`project-nav ${selected === p.id ? 'active' : ''}`} key={p.id} onClick={() => openProject(p.id)}><span className="project-dot"/>{p.title}</button>)}</nav>
      <div className="sidebar-bottom"><span className="environment-dot"/> Local workspace<small>Local fixtures · AI not connected</small><button className="text-button" disabled={busy} onClick={() => void run(async () => { await api('/auth/logout', {}); setUser(null); setProjects([]); setSelected(null); setWorkspace(null); setClients([]); }, '')}>Sign out</button></div>
    </aside>
    <div className="main-column"><header className="topbar"><span><button className="text-button" disabled={busy} onClick={() => openProject(null)}>All projects</button>{selected && <><span className="slash">/</span>{workspace?.project.title ?? 'Project'}</>}</span><span className="role-tag">{isOwner ? 'Freelancer' : 'Client approver'}</span></header>
    <main className="main-content">
      {error && <div className="error banner" role="alert">{error}</div>}{notice && <div className="success banner" role="status">{notice}</div>}
      {!selected ? <><div className="page-heading"><div><h1>Your projects</h1><p>Keep the work and the agreement in the same place.</p></div>{isOwner && <button className="primary" disabled={busy} onClick={() => setCreating(!creating)}>{creating ? 'Close form' : '+ New project'}</button>}</div>
        {creating && <form className="editor" onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); void run(async () => { const p = await api<Project>('/projects', { title: field(data, 'title'), description: field(data, 'description'), clientId: field(data, 'clientId') }); await refreshProjects(); openProject(p.id); }, 'Project created. Start with a brief.'); }}><h2>Create a project</h2><label>Project name<input name="title" required maxLength={120}/></label><label>Description<textarea name="description" required maxLength={1000}/></label><label>Client approver<select name="clientId" required>{clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><button className="primary" disabled={busy || !clients.length}>Create project</button></form>}
        <div className="project-list">{projects.map(p => <button className="project-row" disabled={busy} key={p.id} onClick={() => openProject(p.id)}><span className="project-monogram">{p.title.split(' ').slice(0, 2).map(w => w[0]).join('')}</span><span className="project-description"><strong>{p.title}</strong><span>{p.description}</span></span><span className="project-scope">{p.scopeRevision ? 'Scope established' : 'Awaiting brief'}<small>Scope revision {p.scopeRevision}</small></span><span className="chevron" aria-hidden="true">›</span></button>)}</div>
        {!projects.length && <div className="empty">{isOwner ? 'Create a project to start agreeing on the work.' : 'No projects have been assigned to this account.'}</div>}
        <div className="workflow-note"><h2>A clear path from agreement to approval</h2><p>Write the brief, submit it for review, and record the client’s decision on that exact version. Feedback stays connected to the work.</p></div>
      </> : loading ? <p role="status">Loading project…</p> : workspace ? <>
        <div className="page-heading"><div><h1>{workspace.project.title}</h1><p>{workspace.project.description}</p></div><div className="scope-stamp"><span className="environment-dot"/>Scope revision {workspace.project.scopeRevision}</div></div>
        <div className="tabs" role="tablist" aria-label="Project sections">{(['Brief', 'Deliverables', 'Feedback', ...(isOwner ? ['Analysis'] : []), 'History'] as Tab[]).map(t => <button key={t} role="tab" aria-selected={tab === t} aria-controls="project-panel" id={`tab-${t}`} disabled={busy} onClick={() => { setTab(t); setNotice(''); }}>{t}{t === 'Feedback' && <span className="tab-count">{workspace.comments.length}</span>}</button>)}</div>
        <section id="project-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {tab === 'Brief' && <><BriefPanel key={selected} view={workspace} owner={isOwner} busy={busy} run={run} mutate={mutate}/><ChangesPanel view={workspace} owner={isOwner} busy={busy} run={run} mutate={mutate}/></>}
          {tab === 'Deliverables' && <><DeliverablesPanel view={workspace} owner={isOwner} busy={busy} run={run} mutate={mutate}/><TasksPanel view={workspace} owner={isOwner} busy={busy} run={run} mutate={mutate}/><FilesPanel view={workspace} owner={isOwner} busy={busy} run={run} mutate={mutate}/></>}
          {tab === 'Feedback' && <FeedbackPanel view={workspace} user={user} busy={busy} run={run} mutate={mutate}/>}
          {tab === 'Analysis' && isOwner && <AnalysisPanel key={selected} view={workspace} owner={isOwner} busy={busy} run={run} mutate={mutate}/>}
          {tab === 'History' && <div className="document"><h2>Project history</h2><p className="muted">A record of who submitted, discussed, and approved the work.</p><ol className="history">{workspace.history.map(event => <li key={event.id}><span className="history-dot"/><div><strong>{event.action}{event.version ? ` · Version ${event.version}` : ''}</strong><p>{event.actorName}</p></div><time dateTime={event.createdAt}>{date(event.createdAt)}</time></li>)}</ol></div>}
        </section>
      </> : <div className="empty">The project could not be loaded. Return to All projects and try again.</div>}
    </main></div>
  </div>;
}

function Brand() { return <div className="brand"><span className="brand-icon" aria-hidden="true">a</span>accord<span className="brand-period">.</span></div>; }

function BriefPanel(props: PanelProps) {
  const { view, owner, busy, run, mutate } = props;
  const latest = view.briefs[0];
  const baseline = view.briefs.find(b => b.status === 'approved');
  const [chosen, setChosen] = useState<number | null>(null);
  const current = view.briefs.find(b => b.version === chosen) ?? latest;
  const [editing, setEditing] = useState(false);
  const [paragraphs, setParagraphs] = useState<Paragraph[]>([]);
  const [incorporated, setIncorporated] = useState<string[]>([]);
  const approvedChanges = view.changes.filter(c => c.status === 'approved');
  function start() { setIncorporated(latest?.incorporatedChangeIds ?? []); setParagraphs(latest?.paragraphs.map(p => ({ ...p })) ?? [{ id: `p-${crypto.randomUUID()}`, text: '' }]); setEditing(true); }
  return <div className="workspace-grid"><div className="document"><div className="section-heading"><div><h2>Project brief</h2><p className="muted">The agreement behind the work.</p></div>{owner && !editing && <button disabled={busy} onClick={start}>{latest ? 'Create new version' : 'Write brief'}</button>}</div>
    {editing ? <form className="brief-editor" onSubmit={e => { e.preventDefault(); void run(async () => { await mutate(`/projects/${view.project.id}/briefs`, { paragraphs, expectedVersion: latest?.version ?? 0, incorporatedChangeIds: incorporated }); setEditing(false); setChosen(null); }, 'New draft saved. Submit it when ready for client review.'); }}><p className="muted">Each save creates a new version. Existing approvals remain attached to their original text.</p>{paragraphs.map((p, index) => <div key={p.id} className="paragraph-field"><label>Paragraph {index + 1}<textarea value={p.text} required maxLength={4000} onChange={e => setParagraphs(paragraphs.map(old => old.id === p.id ? { ...old, text: e.target.value } : old))}/></label>{paragraphs.length > 1 && <button type="button" className="text-button" disabled={busy} onClick={() => setParagraphs(paragraphs.filter(old => old.id !== p.id))}>Remove paragraph {index + 1}</button>}</div>)}<button type="button" disabled={busy || paragraphs.length >= 30} onClick={() => setParagraphs([...paragraphs, { id: `p-${crypto.randomUUID()}`, text: '' }])}>+ Add paragraph</button><fieldset className="incorporation"><legend>Changes incorporated into this brief</legend><p>Include the selected scope delta in the brief text. Unselected approved changes remain active separately.</p>{approvedChanges.map(c => <label key={c.id}><input type="checkbox" checked={incorporated.includes(c.id)} disabled={busy || !!baseline?.incorporatedChangeIds.includes(c.id)} onChange={e => setIncorporated(e.target.checked ? [...incorporated, c.id] : incorporated.filter(id => id !== c.id))}/>{c.title} (version {c.version})</label>)}{!approvedChanges.length && <p>No approved changes yet.</p>}</fieldset><div className="actions form-actions"><button className="primary" disabled={busy}>Save draft version</button><button type="button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button></div></form> : current ? <>
      <div className="version-bar"><label className="inline-label">Version<select value={current.version} onChange={e => setChosen(Number(e.target.value))}>{view.briefs.map(b => <option key={b.version} value={b.version}>Version {b.version}{b === baseline ? ' · Current agreed scope' : ''}</option>)}</select></label><Badge status={current.status}/></div>
      <div className="brief-content">{current.paragraphs.map((p, i) => <div className="brief-paragraph" key={p.id} id={`brief-${current.version}-${p.id}`}><span className="paragraph-number" title={p.id}>{String(i + 1).padStart(2, '0')}</span><p>{p.text}</p></div>)}</div><div className="incorporated-summary"><h4>Incorporated changes</h4>{current.incorporatedChangeIds.length ? <ul>{current.incorporatedChangeIds.map(id => <li key={id}>{view.changes.find(c => c.id === id && c.status === 'approved')?.title ?? id}</li>)}</ul> : <p className="muted">None. Approved changes remain active separately.</p>}</div><p className="document-footer">Version {current.version} · Saved {date(current.createdAt)} · Content {current.hash.slice(0, 12)}</p>
      {owner && current.status === 'draft' && current === latest && <div className="approval-box"><h3>Ready for client review?</h3><p>Submitting shares this exact version with the client approver. Scope changes only after approval.</p><button className="primary" disabled={busy} onClick={() => void run(() => mutate(`/projects/${view.project.id}/briefs/${current.version}/submit`, { expectedVersion: current.version }), 'Brief submitted for client approval.')}>Submit version {current.version}</button></div>}
      {!owner && current.status === 'submitted' && <ApprovalActions {...props} item={current} type="brief"/>}
    </> : <div className="empty">{owner ? 'Start with the outcomes, included revisions, and boundaries of the project.' : 'The freelancer has not shared a brief yet.'}</div>}
  </div><aside className="context-panel"><h3>Agreed scope</h3>{baseline ? <><Badge status="approved"/><h4>Brief version {baseline.version}</h4><p>This is the current approved baseline. New drafts and feedback do not change it.</p><button className="text-button" onClick={() => { setChosen(baseline.version); setEditing(false); }}>Read approved version</button></> : <p>No approved brief yet. Submit a brief and ask the designated client to review it.</p>}<div className="context-divider"/><h3>Active approved changes ({view.scope.changes.length})</h3>{view.scope.changes.map(c => <div key={c.id}><h4>{c.title}</h4><p>{c.scopeDelta}</p></div>)}{!view.scope.changes.length && <p>No additional approved changes outside the brief.</p>}<div className="context-divider"/><h3>Keep the agreement clear</h3><p>Every edit is a new version. Every approval belongs to one version. The history keeps both.</p></aside></div>;
}
function DeliverablesPanel(props: PanelProps) {
  const { view, owner, busy, run, mutate } = props;
  const [editor, setEditor] = useState<Deliverable | 'new' | null>(null);
  const [selectedVersions, setSelectedVersions] = useState<Record<string, number>>({});
  const ids = [...new Set(view.deliverables.map(d => d.id))];
  return <div><div className="section-heading"><div><h2>Deliverables</h2><p className="muted">Define the work and what it takes to approve it.</p></div>{owner && <button disabled={busy} onClick={() => setEditor('new')}>+ Add deliverable</button>}</div>
    {editor && <form className="editor" key={typeof editor === 'string' ? editor : editor.id} onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); const values = { title: field(data, 'title'), description: field(data, 'description'), acceptanceCriteria: field(data, 'acceptanceCriteria') }; void run(async () => { await mutate(`/projects/${view.project.id}/deliverables${editor === 'new' ? '' : `/${editor.id}`}`, editor === 'new' ? values : { ...values, expectedVersion: editor.version }, editor === 'new' ? 'POST' : 'PATCH'); setEditor(null); setSelectedVersions({}); }, 'Deliverable draft saved. Submit it for client review when ready.'); }}><h3>{editor === 'new' ? 'New deliverable' : 'New deliverable version'}</h3><label>Title<input name="title" maxLength={120} defaultValue={editor === 'new' ? '' : editor.title} required/></label><label>Description<textarea name="description" maxLength={2000} defaultValue={editor === 'new' ? '' : editor.description} required/></label><label>Acceptance criteria<textarea name="acceptanceCriteria" maxLength={4000} defaultValue={editor === 'new' ? '' : editor.acceptanceCriteria} required/></label><div className="actions"><button className="primary" disabled={busy}>Save draft</button><button type="button" disabled={busy} onClick={() => setEditor(null)}>Cancel</button></div></form>}
    <div className="deliverables">{ids.map(id => { const versions = view.deliverables.filter(d => d.id === id); const latest = versions[0]; const d = versions.find(v => v.version === selectedVersions[id]) ?? latest; return <article className="document" key={d.id}><div className="section-heading"><h3>{d.title}</h3><Badge status={d.status}/></div><div className="version-bar"><label className="inline-label">Version<select value={d.version} onChange={e => setSelectedVersions({ ...selectedVersions, [id]: Number(e.target.value) })}>{versions.map(v => <option value={v.version} key={v.version}>Version {v.version}</option>)}</select></label>{owner && <button disabled={busy} onClick={() => setEditor(latest)}>Create new version</button>}</div><p className="preserve">{d.description}</p><div className="criteria"><h4>Acceptance criteria</h4><p className="preserve">{d.acceptanceCriteria}</p></div>{owner && d.status === 'draft' && d === latest && <button className="primary" disabled={busy} onClick={() => void run(() => mutate(`/projects/${view.project.id}/deliverables/${d.id}/versions/${d.version}/submit`, { expectedVersion: d.version }), 'Deliverable submitted for approval.')}>Submit version {d.version}</button>}{!owner && d.status === 'submitted' && <ApprovalActions {...props} item={d} type="deliverable"/>}</article>; })}</div>{!ids.length && <div className="empty">{owner ? 'Add the first deliverable and its acceptance criteria.' : 'No deliverables have been shared yet.'}</div>}
  </div>;
}
function FeedbackPanel({ view, user, busy, run, mutate }: Omit<PanelProps, 'owner'> & { user: Identity }) {
  const [target, setTarget] = useState('');
  const [body, setBody] = useState('');
  const [correction, setCorrection] = useState<Comment | null>(null);
  const shared = view.deliverables.filter((d, i, all) => d.status !== 'draft' && all.findIndex(other => other.id === d.id && other.status !== 'draft') === i);
  const comments = [...view.comments].reverse().filter(c => (c.deliverableId ?? '') === target);
  return <div className="workspace-grid"><div className="document"><div className="section-heading"><div><h2>Feedback</h2><p className="muted">Discuss the work without losing the original request.</p></div></div><label>Conversation<select value={target} disabled={busy} onChange={e => { setTarget(e.target.value); setCorrection(null); }}>{<option value="">Project feedback</option>}{shared.map(d => <option value={d.id} key={d.id}>{d.title}</option>)}</select></label><div className="comments">{comments.map(c => <article className="comment" key={c.id}><div className="comment-meta"><strong>{c.authorName}</strong><time dateTime={c.createdAt}>{date(c.createdAt)}</time></div>{c.correctionOf && <span className="correction-label">Correction to an earlier comment</span>}<p className="preserve">{c.body}</p>{c.authorId === user.id && <button disabled={busy} className="text-button" onClick={() => { setCorrection(c); setBody(''); }}>Add correction</button>}</article>)}{!comments.length && <div className="empty">No feedback yet. Start the conversation below.</div>}</div><form onSubmit={e => { e.preventDefault(); void run(async () => { await mutate(`/projects/${view.project.id}/comments`, { body, ...(target ? { deliverableId: target } : {}), ...(correction ? { correctionOf: correction.id } : {}) }); setBody(''); setCorrection(null); }, 'Feedback posted.'); }}>
      {correction && <div className="correction-note"><strong>Correcting your comment</strong><blockquote>{correction.body}</blockquote><button type="button" className="text-button" disabled={busy} onClick={() => setCorrection(null)}>Cancel correction</button></div>}<label>{correction ? 'Your correction' : 'Add feedback'}<textarea value={body} maxLength={4000} required onChange={e => setBody(e.target.value)} placeholder="What would you like to discuss or change?"/></label><button className="primary" disabled={busy}>{correction ? 'Post correction' : 'Post feedback'}</button></form></div><aside className="context-panel"><h3>Feedback is a conversation</h3><p>Comments are kept as written. Add a correction if something changes.</p><div className="context-divider"/><h3>Scope stays explicit</h3><p>A comment does not update the agreed scope. Approval of a submitted brief or change request records that decision.</p></aside></div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
