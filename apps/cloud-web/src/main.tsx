import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Identity, Project } from '../../../packages/shared/src/index.ts';
import { CloudSession, validateConfig } from './auth.ts';
import { CloudApi } from './api.ts';
import { BriefWorkspace } from './briefs.tsx';
import '../../web/src/styles.css';

type Connection = { session: CloudSession; api: CloudApi; signedIn: boolean };
async function connect(): Promise<Connection> {
  const response = await fetch('/cloud-config.json', { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json'))
    throw new Error('Add your downloaded cloud-config.json to apps/cloud-web/public, then reload this page.');
  const config = validateConfig(await response.json(), location.origin);
  const session = new CloudSession(config, { storage: sessionStorage, fetch, navigate: url => location.assign(url), cleanUrl: () => history.replaceState(null, '', '/'), now: Date.now });
  return { session, api: new CloudApi(session), signedIn: await session.finish(new URL(location.href)) };
}
// A callback code must be exchanged once, including under React StrictMode.
let bootstrap: Promise<Connection> | undefined;
const brand = <div className="brand"><span className="brand-icon" aria-hidden="true">a</span>accord<span className="brand-period">.</span></div>;
const message = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Try again.';

function App() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [user, setUser] = useState<Identity | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [clients, setClients] = useState<Identity[]>([]);
  const [selected, setSelected] = useState<Project | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let active = true;
    bootstrap ??= connect();
    void bootstrap.then(async c => {
      if (!active) return;
      setConnection(c);
      if (c.signedIn) {
        const me = await c.api.request<Identity>('/auth/me');
        if (!active) return;
        setUser(me);
        const list = await c.api.all<Project>('/projects');
        if (active) setProjects(list);
        if (me.role === 'owner') {
          const directory = await c.api.all<Identity>('/clients');
          if (active) setClients(directory);
        }
      }
    }).catch(e => { if (active) setError(message(e)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);

  function forget() { setUser(null); setProjects([]); setClients([]); setSelected(null); setCreating(false); }
  useEffect(() => {
    if (!user || !connection) return;
    const timer = setTimeout(() => { connection.session.clear(); forget(); setError('Your session has ended. Sign in again.'); }, connection.session.remainingMs());
    return () => clearTimeout(timer);
  }, [user, connection]);

  async function run(work: () => Promise<void>) {
    setBusy(true); setError('');
    try { await work(); } catch (e) {
      setError(message(e));
      if (connection && connection.session.remainingMs() === 0) forget();
    } finally { setBusy(false); }
  }

  if (!user) return <main className="login-layout">
    <section className="login-story">{brand}<div><p className="eyebrow">A shared understanding</p><h1>Clear scope.<br/>Confident work.</h1><p>A place for freelancers and clients to agree on what comes next.</p></div><small>Accord · Cloud preview</small></section>
    <section className="login-panel"><div className="login-box"><span className="local-label">Cloud preview</span><h2>Your project workspace</h2><p>Sign in with the demo account provided for this workspace.</p>
      {error && <p role="alert" className="error">{error}</p>}
      <button className="primary" disabled={busy || !connection} onClick={() => void run(async () => { await connection!.session.signIn(); })}>{busy ? 'Connecting…' : 'Sign in'}</button>
      {connection && !busy && <p><button className="text-button" onClick={() => connection.session.signOut()}>Use another account</button></p>}
      {!connection && !busy && <p><button className="text-button" onClick={() => location.assign('/')}>Reload after setup</button></p>}
      <p className="muted" style={{ marginTop: 24 }}>Agree on a versioned brief and record your client’s decision. Files and other workflows remain in the local demo.</p>
    </div></section>
  </main>;

  return <div className="shell"><aside className="sidebar">{brand}<div className="workspace-name"><span className="avatar">{user.name[0]}</span><div>{user.name}<small>{user.role === 'owner' ? 'Freelancer workspace' : 'Client workspace'}</small></div></div>
    <nav aria-label="Workspace"><button className={`nav-item ${!selected ? 'active' : ''}`} disabled={busy} onClick={() => { setSelected(null); setCreating(false); }}>All projects <span className="nav-count">{projects.length}</span></button></nav>
    <div className="sidebar-bottom"><span className="environment-dot"/> Cloud preview<small>Briefs and approvals · AI not connected</small><button className="text-button" onClick={() => { forget(); connection!.session.signOut(); }}>Sign out</button></div>
  </aside><div className="main-column"><header className="topbar"><button className="text-button" onClick={() => setSelected(null)}>All projects</button><span className="role-tag">{user.role === 'owner' ? 'Freelancer' : 'Client'}</span></header>
    <main className="main-content">{error && <p className="error banner" role="alert">{error}</p>}
      <div className="page-heading"><div><h1>{selected?.title ?? 'Your projects'}</h1><p>{selected?.description ?? 'The work you share, in one place.'}</p></div>{!selected && user.role === 'owner' && <button className="primary" disabled={busy} onClick={() => setCreating(!creating)}>{creating ? 'Close form' : '+ New project'}</button>}</div>
      {!selected && creating && <form className="editor" onSubmit={e => { e.preventDefault(); const form = new FormData(e.currentTarget); const body = Object.fromEntries(['title', 'description', 'clientId'].map(key => [key, String(form.get(key) ?? '').trim()])); void run(async () => { const project = await connection!.api.request<Project>('/projects', body); setProjects(previous => [...previous.filter(p => p.id !== project.id), project]); setCreating(false); setSelected(project); }); }}>
        <h2>Create a project</h2><label>Project name<input name="title" required maxLength={120} disabled={busy}/></label><label>Description<textarea name="description" required maxLength={1000} disabled={busy}/></label><label>Client approver<select name="clientId" required disabled={busy}>{clients.map(client => <option value={client.id} key={client.id}>{client.name}</option>)}</select></label><button className="primary" disabled={busy || !clients.length}>{busy ? 'Creating…' : 'Create project'}</button>
      </form>}
      {selected ? <BriefWorkspace key={selected.id} api={connection!.api} user={user} project={selected} onProject={project => { setSelected(previous => previous?.id === project.id ? project : previous); setProjects(previous => previous.map(p => p.id === project.id ? project : p)); }} onExpired={() => { if (connection!.session.remainingMs() === 0) forget(); }}/> : <>
        <div className="project-list">{projects.map(project => <button key={project.id} className="project-row" disabled={busy} onClick={() => void run(async () => setSelected(await connection!.api.request<Project>(`/projects/${project.id}`)))}><span className="project-monogram" aria-hidden="true">{project.title.split(' ').slice(0, 2).map(word => word[0]).join('')}</span><span className="project-description"><strong>{project.title}</strong><span>{project.description}</span></span><span className="chevron" aria-hidden="true">›</span></button>)}</div>
        {busy && <p role="status">Loading workspace…</p>}{!busy && !projects.length && <p className="empty">No projects are assigned to this account yet.</p>}
        <div className="workflow-note"><h2>A shared starting point</h2><p>Open a project to draft a brief, review its versions and record a client decision. The approved brief stays visible as your shared baseline.</p><button disabled={busy} onClick={() => void run(async () => { setProjects(await connection!.api.all<Project>('/projects')); if (user.role === 'owner') setClients(await connection!.api.all<Identity>('/clients')); })}>Refresh projects</button></div>
      </>}
    </main>
  </div></div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
