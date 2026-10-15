import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Identity } from '../../../packages/shared/src/index.ts';
import { Store } from '../src/store.ts';
import { createApp } from '../src/app.ts';
import { createProject } from '../src/domain.ts';
const origin = 'http://127.0.0.1:5173';
const password = 'test-only-local-password';
export async function fixture(path = ':memory:') {
  const store = new Store(path);
  const users: Identity[] = [
    { id: 'owner', workspaceId: 'w1', name: 'Owner', email: 'owner@test.local', role: 'owner' },
    { id: 'alex', workspaceId: 'w1', name: 'Alex', email: 'alex@test.local', role: 'client' },
    { id: 'jules', workspaceId: 'w1', name: 'Jules', email: 'jules@test.local', role: 'client' },
    { id: 'outsider', workspaceId: 'w2', name: 'Other owner', email: 'other@test.local', role: 'owner' },
    { id: 'other-client', workspaceId: 'w2', name: 'Other client', email: 'client@test.local', role: 'client' },
  ];
  if (!store.users().length) users.forEach(u => store.addUser(u, password));
  const project = store.projects(users[0]).find(p => p.clientId === 'alex') ?? store.transaction(() => createProject(store, users[0], { title: 'Atlas', description: 'Test project', clientId: 'alex' }));
  const second = store.projects(users[2])[0] ?? store.transaction(() => createProject(store, users[0], { title: 'Fieldwork', description: 'Other project', clientId: 'jules' }));
  const other = store.projects(users[3])[0] ?? store.transaction(() => createProject(store, users[3], { title: 'Private', description: 'Other workspace', clientId: 'other-client' }));
  const server = createApp(store, origin).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server address');
  const base = `http://127.0.0.1:${address.port}/api`;
  const cookies = new Map<string, string>();
  async function request(actor: string | null, path: string, body?: unknown, options: { key?: string; method?: string; origin?: string; raw?: boolean } = {}) {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : options.method ?? 'POST',
      headers: { ...(actor && cookies.has(actor) ? { cookie: cookies.get(actor)! } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json', Origin: options.origin ?? origin, 'Idempotency-Key': options.key ?? randomUUID() } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: options.raw ? Buffer.from(await response.arrayBuffer()) : await response.json(), headers: response.headers, cookie: response.headers.get('set-cookie') };
  }
  for (const user of users) {
    const login = await request(null, '/auth/login', { email: user.email, password });
    assert.equal(login.status, 200);
    cookies.set(user.id, login.cookie!.split(';')[0]);
  }
  const root = `/projects/${project.id}`;
  async function brief() {
    const saved = await request('owner', `${root}/briefs`, { expectedVersion: 0, paragraphs: [{ id: 'p-scope', text: 'Manual CSV exports and two copy revisions. Scheduled exports are excluded.' }] });
    assert.equal(saved.status, 201);
    const submitted = await request('owner', `${root}/briefs/1/submit`, { expectedVersion: 1 });
    assert.equal(submitted.status, 200);
    return saved.body;
  }
  async function close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); store.close(); }
  return { store, users, project, second, other, request, root, brief, close };
}
