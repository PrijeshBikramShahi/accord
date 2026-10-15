import { dispatchJob, loadJob, publishClarification, requestAnalysis, retryAnalysis, reviewAnalysis, viewJob } from './analysis.ts';
import type { AnalysisJob } from '../../../packages/shared/src/index.ts';
import express, { type Request, type Response, type NextFunction } from 'express';
import { randomBytes } from 'node:crypto';
import { ZodError } from 'zod';
import type { Attachment, Audit, Brief, ChangeRequest, Deliverable, Identity, RevisionTask } from '../../../packages/shared/src/index.ts';
import { loginSchema } from '../../../packages/shared/src/index.ts';
import { addComment, approve, authorize, createBrief, createDeliverable, createProject, Problem, submit } from './domain.ts';
import { hash, Store } from './store.ts';
import { createChange, createTask, effectiveScope, updateTask } from './scope.ts';
import { canReadAttachment, completeUpload, downloadContent, issueDownload, uploadIntent } from './attachments.ts';

export function createApp(store: Store, origin = 'http://127.0.0.1:5173') {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); next(); });
  app.use((req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.get('origin') !== origin) throw new Problem(403, 'Request origin is not allowed.');
      if (!req.is('application/json')) throw new Problem(422, 'Send JSON content.');
    }
    next();
  });
  const smallJson = express.json({ limit: '160kb' });
  app.use((req, res, next) => {
    if (req.method === 'POST' && /^\/api\/projects\/[^/]+\/attachments\/[^/]+\/complete$/.test(req.path)) next();
    else smallJson(req, res, next);
  });
  const failures = new Map<string, { count: number; until: number }>();
  app.post('/api/auth/login', (req, res) => {
    const key = req.ip ?? 'local';
    const old = failures.get(key);
    if (old && old.until > Date.now() && old.count >= 10) throw new Problem(429, 'Too many login attempts. Try again in 15 minutes.');
    const data = loginSchema.parse(req.body);
    const user = store.authenticate(data.email, data.password);
    if (!user) {
      failures.set(key, { count: old && old.until > Date.now() ? old.count + 1 : 1, until: old && old.until > Date.now() ? old.until : Date.now() + 900_000 });
      throw new Problem(401, 'Email or password is incorrect.');
    }
    failures.delete(key);
    const token = randomBytes(32).toString('hex');
    store.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    store.db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(token), user.id, Date.now() + 8 * 60 * 60 * 1000);
    res.cookie('accord_session', token, { httpOnly: true, sameSite: 'strict', path: '/api', maxAge: 8 * 60 * 60 * 1000 });
    res.json(user);
  });
  app.use('/api', (req, res, next) => {
    const token = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('accord_session='))?.slice('accord_session='.length);
    const session = token ? store.db.prepare('SELECT user_id FROM sessions WHERE token=? AND expires>?').get(hash(token), Date.now()) : undefined;
    const user = session ? store.user(String(session.user_id)) : undefined;
    if (!user) throw new Problem(401, 'Sign in to continue.');
    res.locals.user = user;
    res.locals.sessionToken = token;
    next();
  });
  app.get('/api/auth/me', (_req, res) => res.json(res.locals.user));
  app.post('/api/auth/logout', (_req, res) => {
    store.db.prepare('DELETE FROM sessions WHERE token=?').run(hash(res.locals.sessionToken));
    res.clearCookie('accord_session', { path: '/api', httpOnly: true, sameSite: 'strict' }).json({ ok: true });
  });
  app.get('/api/clients', (req, res) => {
    const user: Identity = res.locals.user;
    if (user.role !== 'owner') throw new Problem(404, 'Resource not found.');
    res.json(page(store.users().filter(u => u.workspaceId === user.workspaceId && u.role === 'client'), req));
  });
  app.get('/api/projects', (req, res) => res.json(page(store.projects(res.locals.user), req)));
  function write(req: Request, res: Response, status: number, fn: (user: Identity) => unknown) {
    const user: Identity = res.locals.user;
    // Authorization is rechecked even on an idempotent replay.
    if (req.params.projectId) authorize(store, user, String(req.params.projectId));
    const key = req.get('idempotency-key');
    if (!key || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new Problem(422, 'Provide an Idempotency-Key of 8–128 letters, numbers, dashes or underscores.');
    const fingerprint = hash({ method: req.method, path: req.path, body: req.body });
    const result = store.transaction(() => {
      const previous = store.db.prepare('SELECT * FROM idempotency WHERE actor_id=? AND key=?').get(user.id, key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Problem(409, 'This idempotency key was already used for different content.');
        return { status: Number(previous.status), body: JSON.parse(String(previous.response)) };
      }
      const body = fn(user);
      store.db.prepare('INSERT INTO idempotency VALUES (?, ?, ?, ?, ?)').run(user.id, key, fingerprint, status, JSON.stringify(body));
      return { status, body };
    });
    res.status(result.status).json(result.body);
    return result.body;
  }
  app.post('/api/projects', (req, res) => write(req, res, 201, u => createProject(store, u, req.body)));
  app.get('/api/projects/:projectId', (req, res) => res.json(authorize(store, res.locals.user, String(req.params.projectId))));
  for (const kind of ['briefs', 'deliverables', 'comments', 'approvals', 'history', 'changes', 'tasks', 'attachments']) {
    app.get(`/api/projects/:projectId/${kind}`, (req, res) => {
      const user: Identity = res.locals.user;
      const project = authorize(store, user, String(req.params.projectId));
      let values = store.list<Brief | Deliverable | ChangeRequest | Audit | RevisionTask | Attachment>(project.id, kind);
      if (kind === 'tasks') values = (values as RevisionTask[]).filter((t, i, all) => all.findIndex(v => v.id === t.id) === i);
      if (kind === 'attachments') values = (values as Attachment[]).filter(a => canReadAttachment(store, user, project.id, a));
      if (user.role === 'client') {
        if (['briefs', 'deliverables', 'changes'].includes(kind)) values = values.filter(v => 'status' in v && v.status !== 'draft');
        if (kind === 'history') values = values.filter(v => 'action' in v && !v.action.includes('draft'));
      }
      res.json(page(values, req));
    });
  }
  app.post('/api/projects/:projectId/briefs', (req, res) => write(req, res, 201, u => createBrief(store, u, String(req.params.projectId), req.body)));
  app.post('/api/projects/:projectId/briefs/:version/submit', (req, res) => write(req, res, 200, u => submit(store, u, String(req.params.projectId), 'briefs', 'brief', Number(req.params.version), req.body)));
  app.post('/api/projects/:projectId/deliverables', (req, res) => write(req, res, 201, u => createDeliverable(store, u, String(req.params.projectId), req.body)));
  app.patch('/api/projects/:projectId/deliverables/:id', (req, res) => write(req, res, 201, u => createDeliverable(store, u, String(req.params.projectId), req.body, String(req.params.id))));
  app.post('/api/projects/:projectId/deliverables/:id/versions/:version/submit', (req, res) => write(req, res, 200, u => submit(store, u, String(req.params.projectId), 'deliverables', String(req.params.id), Number(req.params.version), req.body)));
  app.post('/api/projects/:projectId/comments', (req, res) => write(req, res, 201, u => addComment(store, u, String(req.params.projectId), req.body)));
  app.post('/api/projects/:projectId/approvals', (req, res) => write(req, res, 201, u => approve(store, u, String(req.params.projectId), req.body)));
  app.get('/api/projects/:projectId/scope', (req, res) => res.json(effectiveScope(store, res.locals.user, String(req.params.projectId))));
  app.post('/api/projects/:projectId/changes', (req, res) => write(req, res, 201, u => createChange(store, u, String(req.params.projectId), req.body)));
  app.patch('/api/projects/:projectId/changes/:id', (req, res) => write(req, res, 201, u => createChange(store, u, String(req.params.projectId), req.body, String(req.params.id))));
  app.post('/api/projects/:projectId/changes/:id/versions/:version/submit', (req, res) => write(req, res, 200, u => submit(store, u, String(req.params.projectId), 'changes', String(req.params.id), Number(req.params.version), req.body)));
  app.post('/api/projects/:projectId/tasks', (req, res) => write(req, res, 201, u => createTask(store, u, String(req.params.projectId), req.body)));
  app.patch('/api/projects/:projectId/tasks/:id', (req, res) => write(req, res, 200, u => updateTask(store, u, String(req.params.projectId), String(req.params.id), req.body)));
  app.post('/api/projects/:projectId/attachments/upload-intent', (req, res) => write(req, res, 201, u => uploadIntent(store, u, String(req.params.projectId), req.body)));
  app.post('/api/projects/:projectId/attachments/:id/complete', (req, res, next) => {
    authorize(store, res.locals.user, String(req.params.projectId));
    next();
  }, express.json({ limit: '7mb' }), (req, res) => write(req, res, 200, u => completeUpload(store, u, String(req.params.projectId), String(req.params.id), req.body)));
  app.get('/api/projects/:projectId/attachments/:id/download', (req, res) => res.json(issueDownload(store, res.locals.user, String(req.params.projectId), String(req.params.id))));
  app.get('/api/projects/:projectId/attachments/:id/content', (req, res) => {
    const { file, bytes } = downloadContent(store, res.locals.user, String(req.params.projectId), String(req.params.id), req.query.token);
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.filename).replace(/'/g, '%27')}`, 'Content-Security-Policy': "default-src 'none'; sandbox" }).send(bytes);
  });
  // Owner authorization also runs before idempotent replay, so role revocation cannot expose saved results.
  app.use('/api/projects/:projectId/analyses', (req, res, next) => { authorize(store, res.locals.user, String(req.params.projectId), true); next(); });
  app.get('/api/projects/:projectId/analyses', (req, res) => {
    const projectId = String(req.params.projectId);
    const jobs = page(store.list<AnalysisJob>(projectId, 'analyses'), req);
    res.json({ ...jobs, items: jobs.items.map(job => viewJob(store, res.locals.user, projectId, job.id)) });
  });
  app.get('/api/projects/:projectId/analyses/:id', (req, res) => res.json(viewJob(store, res.locals.user, String(req.params.projectId), String(req.params.id))));
  function dispatchAfterWrite(req: Request, value: unknown) {
    try { dispatchJob(store, String(req.params.projectId), (value as { id: string }).id); }
    catch { console.error('Analysis saved with pending dispatch; use owner recovery.'); }
  }
  app.post('/api/projects/:projectId/analyses', (req, res) => {
    const result = write(req, res, 202, u => requestAnalysis(store, u, String(req.params.projectId), req.body));
    dispatchAfterWrite(req, result);
  });
  app.post('/api/projects/:projectId/analyses/:id/retry', (req, res) => {
    const result = write(req, res, 202, u => retryAnalysis(store, u, String(req.params.projectId), String(req.params.id), req.body));
    dispatchAfterWrite(req, result);
  });
  app.post('/api/projects/:projectId/analyses/:id/decisions', (req, res) => {
    loadJob(store, res.locals.user, String(req.params.projectId), String(req.params.id));
    write(req, res, 201, u => reviewAnalysis(store, u, String(req.params.projectId), String(req.params.id), req.body));
  });
  app.post('/api/projects/:projectId/analyses/:id/decisions/:decisionId/publish', (req, res) => write(req, res, 201, u => publishClarification(store, u, String(req.params.projectId), String(req.params.id), String(req.params.decisionId), req.body)));
  app.use((_req, _res, next) => next(new Problem(404, 'Resource not found.')));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ZodError) { res.status(422).json({ error: error.issues.map(i => `${i.path.join('.') || 'Input'}: ${i.message}`).join('; ') }); return; }
    if (error instanceof Problem) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof SyntaxError) { res.status(422).json({ error: 'Invalid JSON content.' }); return; }
    if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') { res.status(422).json({ error: 'Content is too large.' }); return; }
    console.error('Unhandled API error', error instanceof Error ? error.name : 'unknown');
    res.status(500).json({ error: 'The request could not be saved. Please try again.' });
  });
  return app;
}
function page<T>(items: T[], req: Request) {
  const cursor = req.query.cursor ?? '0';
  if (typeof cursor !== 'string' || !/^\d{1,8}$/.test(cursor)) throw new Problem(422, 'Invalid page cursor.');
  const start = Number(cursor);
  return { items: items.slice(start, start + 50), nextCursor: items.length > start + 50 ? String(start + 50) : null };
}
