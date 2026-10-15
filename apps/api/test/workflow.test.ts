import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { Identity, Project } from '../../../packages/shared/src/index.ts';
import { Store } from '../src/store.ts';
import { createApp } from '../src/app.ts';
import { createProject } from '../src/domain.ts';

import { fixture } from './fixture.ts';
const password = 'test-only-local-password';
const approval = (hash: string) => ({ targetType: 'brief', targetId: 'brief', version: 1, hash, decision: 'approve', expectedScopeRevision: 0 });

test('login uses credentials, httpOnly session, origin checks, and logout invalidates the session', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request(null, '/projects')).status, 401);
    assert.equal((await f.request(null, '/auth/login', { email: 'owner@test.local', password: 'wrong' })).status, 401);
    const login = await f.request(null, '/auth/login', { email: 'owner@test.local', password });
    assert.match(login.cookie!, /HttpOnly/);
    assert.match(login.cookie!, /SameSite=Strict/);
    assert.equal((await f.request('owner', `${f.root}/comments`, { body: 'Forged request' }, { origin: 'https://attacker.example' })).status, 403);
    assert.equal((await f.request('owner', '/auth/logout', {})).status, 200);
    assert.equal((await f.request('owner', '/projects')).status, 401);
  } finally { await f.close(); }
});

test('clients and a second workspace cannot read or mutate another project', async () => {
  const f = await fixture();
  try {
    const mine = await f.request('alex', '/projects');
    assert.deepEqual(mine.body.items.map((p: Project) => p.id), [f.project.id]);
    for (const actor of ['jules', 'outsider', 'other-client']) {
      for (const suffix of ['', '/briefs', '/deliverables', '/comments', '/approvals', '/history']) assert.equal((await f.request(actor, f.root + suffix)).status, 404);
      assert.equal((await f.request(actor, `${f.root}/comments`, { body: 'Intrusion' })).status, 404);
    }
    assert.equal((await f.request('owner', `/projects/${f.other.id}`)).status, 404);
    assert.equal((await f.request('owner', '/projects', { title: 'Forged', description: 'Other tenant', clientId: 'other-client' })).status, 422);
  } finally { await f.close(); }
});

test('draft content and internal draft history remain private until submission', async () => {
  const f = await fixture();
  try {
    await f.request('owner', `${f.root}/briefs`, { expectedVersion: 0, paragraphs: [{ id: 'p-secret', text: 'Unshared text' }] });
    assert.equal((await f.request('alex', `${f.root}/briefs`)).body.items.length, 0);
    assert.ok(!(await f.request('alex', `${f.root}/history`)).body.items.some((v: { action: string }) => v.action.includes('draft')));
    assert.equal((await f.request('alex', `${f.root}/briefs/1/submit`, { expectedVersion: 1 })).status, 404);
    await f.request('owner', `${f.root}/briefs/1/submit`, { expectedVersion: 1 });
    assert.equal((await f.request('alex', `${f.root}/briefs`)).body.items[0].paragraphs[0].text, 'Unshared text');
  } finally { await f.close(); }
});

test('only designated client approves the exact submitted version; approval and revisions commit once', async () => {
  const f = await fixture();
  try {
    const brief = await f.brief();
    assert.equal((await f.request('owner', `${f.root}/approvals`, approval(brief.hash))).status, 404);
    assert.equal((await f.request('jules', `${f.root}/approvals`, approval(brief.hash))).status, 404);
    assert.equal((await f.request('alex', `${f.root}/approvals`, approval('0'.repeat(64)))).status, 409);
    const key = randomUUID();
    const accepted = await f.request('alex', `${f.root}/approvals`, approval(brief.hash), { key });
    assert.equal(accepted.status, 201);
    assert.equal(accepted.body.actorId, 'alex');
    const repeated = await f.request('alex', `${f.root}/approvals`, approval(brief.hash), { key });
    assert.deepEqual(repeated.body, accepted.body);
    assert.equal((await f.request('alex', `${f.root}/approvals`, approval(brief.hash))).status, 409);
    assert.equal((await f.request('alex', `${f.root}/approvals`, { ...approval(brief.hash), decision: 'reject' }, { key })).status, 409);
    assert.equal((await f.request('owner', `${f.root}/approvals`)).body.items.length, 1);
    const project = (await f.request('owner', f.root)).body;
    assert.equal(project.scopeRevision, 1);
    assert.equal(project.contextRevision, 2);
    assert.equal((await f.request('owner', `${f.root}/history`)).body.items.filter((a: { action: string }) => a.action === 'Brief approved').length, 1);
  } finally { await f.close(); }
});

test('new edits create immutable versions and cannot silently replace approved scope', async () => {
  const f = await fixture();
  try {
    const first = await f.brief();
    await f.request('alex', `${f.root}/approvals`, approval(first.hash));
    const saved = await f.request('owner', `${f.root}/briefs`, { expectedVersion: 1, paragraphs: [{ id: 'p-scope', text: 'Manual and scheduled exports.' }] });
    assert.equal(saved.status, 201);
    assert.equal(saved.body.version, 2);
    const versions = (await f.request('owner', `${f.root}/briefs`)).body.items;
    assert.equal(versions[1].hash, first.hash);
    assert.equal(versions[1].status, 'approved');
    assert.equal((await f.request('owner', f.root)).body.scopeRevision, 1);
    assert.equal((await f.request('alex', `${f.root}/briefs`)).body.items.length, 1);
    assert.equal((await f.request('owner', `${f.root}/briefs`, { expectedVersion: 1, paragraphs: [{ id: 'p-scope', text: 'Stale edit' }] })).status, 409);
  } finally { await f.close(); }
});

test('concurrent edits and approvals reject stale versions without partial audit writes', async () => {
  const f = await fixture();
  try {
    const brief = await f.brief();
    const versions = await Promise.all(['First edit', 'Competing edit'].map(text => f.request('owner', `${f.root}/briefs`, { expectedVersion: 1, paragraphs: [{ id: 'p-scope', text }] })));
    assert.deepEqual(versions.map(v => v.status).sort(), [201, 409]);
    assert.equal((await f.request('alex', `${f.root}/approvals`, approval(brief.hash))).status, 409);
    assert.equal((await f.request('owner', `${f.root}/approvals`)).body.items.length, 0);
    assert.equal((await f.request('owner', f.root)).body.scopeRevision, 0);
  } finally { await f.close(); }
});

test('deliverable submission, exact version review, and rejection preserve scope', async () => {
  const f = await fixture();
  try {
    const d = (await f.request('owner', `${f.root}/deliverables`, { title: 'Dashboard', description: 'Manual exports', acceptanceCriteria: 'Downloads CSV.' })).body;
    assert.equal((await f.request('alex', `${f.root}/deliverables`)).body.items.length, 0);
    await f.request('owner', `${f.root}/deliverables/${d.id}/versions/1/submit`, { expectedVersion: 1 });
    const result = await f.request('alex', `${f.root}/approvals`, { ...approval(d.hash), targetType: 'deliverable', targetId: d.id, decision: 'reject' });
    assert.equal(result.status, 201);
    assert.equal((await f.request('owner', f.root)).body.scopeRevision, 0);
    const revised = await f.request('owner', `${f.root}/deliverables/${d.id}`, { expectedVersion: 1, title: 'Dashboard', description: 'Revised export', acceptanceCriteria: 'Downloads the selected date range as CSV.' }, { method: 'PATCH' });
    assert.equal(revised.body.version, 2);
    await f.request('owner', `${f.root}/deliverables/${d.id}/versions/2/submit`, { expectedVersion: 2 });
    const accepted = await f.request('alex', `${f.root}/approvals`, { ...approval(revised.body.hash), targetType: 'deliverable', targetId: d.id, version: 2 });
    assert.equal(accepted.status, 201);
    assert.equal((await f.request('alex', `${f.root}/deliverables`)).body.items[0].status, 'approved');
  } finally { await f.close(); }
});

test('feedback is append-only, project-bound, and corrections retain the original', async () => {
  const f = await fixture();
  try {
    const root2 = `/projects/${f.second.id}`;
    const d = (await f.request('owner', `${root2}/deliverables`, { title: 'Private', description: 'Other project', acceptanceCriteria: 'Stay private.' })).body;
    await f.request('owner', `${root2}/deliverables/${d.id}/versions/1/submit`, { expectedVersion: 1 });
    assert.equal((await f.request('alex', `${f.root}/comments`, { body: 'Cross-project', deliverableId: d.id })).status, 404);
    const original = (await f.request('alex', `${f.root}/comments`, { body: 'Change the label.' })).body;
    assert.equal((await f.request('owner', `${f.root}/comments`, { body: 'Forged correction', correctionOf: original.id })).status, 422);
    assert.equal((await f.request('alex', `${f.root}/comments/${original.id}`, { body: 'Overwrite' }, { method: 'PATCH' })).status, 404);
    assert.equal((await f.request('alex', `${f.root}/comments`, { body: 'Use Download CSV.', correctionOf: original.id })).status, 201);
    const comments = (await f.request('owner', `${f.root}/comments`)).body.items;
    assert.equal(comments.length, 2);
    assert.equal(comments[1].body, 'Change the label.');
    assert.equal((await f.request('owner', f.root)).body.contextRevision, 2);
  } finally { await f.close(); }
});

test('persistent idempotency survives restart and replay rechecks project membership', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'accord-test-'));
  const path = join(dir, 'accord.sqlite');
  let f = await fixture(path);
  try {
    const key = randomUUID();
    const original = await f.request('alex', `${f.root}/comments`, { body: 'Please revise.' }, { key });
    await f.close();
    f = await fixture(path);
    const replay = await f.request('alex', `${f.root}/comments`, { body: 'Please revise.' }, { key });
    assert.deepEqual(replay.body, original.body);
    assert.equal((await f.request('owner', `${f.root}/comments`)).body.items.length, 1);
    f.store.saveProject({ ...f.store.project(f.project.id)!, clientId: 'jules' });
    assert.equal((await f.request('alex', `${f.root}/comments`, { body: 'Please revise.' }, { key })).status, 404);
  } finally { await f.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('validation rejects forged fields, duplicate paragraph IDs and invalid cursors; list pagination works', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('alex', `${f.root}/comments`, { body: 'Feedback', authorId: 'owner' })).status, 422);
    assert.equal((await f.request('owner', `${f.root}/briefs`, { expectedVersion: 0, paragraphs: [{ id: 'p-a', text: 'One' }, { id: 'p-a', text: 'Two' }] })).status, 422);
    assert.equal((await f.request('owner', `${f.root}/comments?cursor=-1`)).status, 422);
    for (let i = 0; i < 51; i++) assert.equal((await f.request('alex', `${f.root}/comments`, { body: `Comment ${i}` })).status, 201);
    const first = (await f.request('owner', `${f.root}/comments`)).body;
    assert.equal(first.items.length, 50);
    const second = (await f.request('owner', `${f.root}/comments?cursor=${first.nextCursor}`)).body;
    assert.equal(second.items.length, 1);
    assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.items, ...second.items].map(c => c.id)).size, 51);
  } finally { await f.close(); }
});
