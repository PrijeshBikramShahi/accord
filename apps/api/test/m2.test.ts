import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Attachment, Brief, ChangeRequest } from '../../../packages/shared/src/index.ts';
import { fixture } from './fixture.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function baseline(f: Fixture) {
  const b = await f.brief();
  assert.equal((await f.request('alex', `${f.root}/approvals`, { targetType: 'brief', targetId: 'brief', version: 1, hash: b.hash, decision: 'approve', expectedScopeRevision: 0 })).status, 201);
  const comment = (await f.request('alex', `${f.root}/comments`, { body: 'Please change the label and add scheduled weekly exports.' })).body;
  return { b, comment };
}
function changeInput(sourceFeedbackId: string, expectedScopeRevision = 1, expectedVersion = 0) {
  return { title: 'Weekly scheduled exports', scopeDelta: 'Add scheduled weekly CSV exports; replaces the brief exclusion for scheduled exports only.', acceptanceCriteria: 'A configured weekly schedule generates one CSV export.', scheduleImplications: 'Not yet agreed', feeImplications: 'No additional fee for this synthetic demo', sourceFeedbackId, rationale: 'The current brief excludes scheduled exports.', expectedScopeRevision, expectedVersion };
}
async function submittedChange(f: Fixture, source: string, revision = 1) {
  const change = await f.request('owner', `${f.root}/changes`, changeInput(source, revision));
  assert.equal(change.status, 201);
  assert.equal((await f.request('owner', `${f.root}/changes/${change.body.id}/versions/1/submit`, { expectedVersion: 1 })).status, 200);
  return change.body as ChangeRequest;
}
const changeApproval = (c: ChangeRequest, revision = 1) => ({ targetType: 'change', targetId: c.id, version: c.version, hash: c.hash, decision: 'approve', expectedScopeRevision: revision });
const taskInput = (feedbackId: string, b: Brief) => ({ title: 'Revise export label', acceptanceCriteria: 'Label reads Download CSV.', sourceFeedbackId: feedbackId, rationale: 'The approved brief explicitly includes copy revisions.', authority: { type: 'brief', id: 'brief', version: b.version, hash: b.hash }, expectedScopeRevision: 1 });
const checksum = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fileInput = (bytes = Buffer.from('Synthetic project evidence.')) => ({ filename: 'evidence.txt', mime: 'text/plain', size: bytes.length, checksum: checksum(bytes), parent: { type: 'project' } });

test('change drafts stay private, exact client approval advances scope once, approved changes are immutable', async () => {
  const f = await fixture();
  try {
    const { comment } = await baseline(f);
    const c = (await f.request('owner', `${f.root}/changes`, changeInput(comment.id))).body;
    assert.equal((await f.request('alex', `${f.root}/changes`)).body.items.length, 0);
    assert.equal((await f.request('owner', `${f.root}/scope`)).body.changes.length, 0);
    assert.equal((await f.request('jules', `${f.root}/changes`)).status, 404);
    assert.equal((await f.request('outsider', `${f.root}/tasks`)).status, 404);
    assert.equal((await f.request('alex', `${f.root}/changes/${c.id}/versions/1/submit`, { expectedVersion: 1 })).status, 404);
    await f.request('owner', `${f.root}/changes/${c.id}/versions/1/submit`, { expectedVersion: 1 });
    assert.equal((await f.request('owner', `${f.root}/approvals`, changeApproval(c))).status, 404);
    assert.equal((await f.request('alex', `${f.root}/approvals`, { ...changeApproval(c), hash: '0'.repeat(64) })).status, 409);
    const key = randomUUID();
    const accepted = await f.request('alex', `${f.root}/approvals`, changeApproval(c), { key });
    assert.equal(accepted.status, 201);
    assert.deepEqual((await f.request('alex', `${f.root}/approvals`, changeApproval(c), { key })).body, accepted.body);
    const scope = (await f.request('alex', `${f.root}/scope`)).body;
    assert.equal(scope.scopeRevision, 2); assert.equal(scope.changes.length, 1);
    assert.equal((await f.request('owner', `${f.root}/changes/${c.id}`, changeInput(comment.id, 2, 1), { method: 'PATCH' })).status, 409);
    assert.equal((await f.request('owner', `${f.root}/history`)).body.items.filter((e: { action: string }) => e.action === 'Change request approved').length, 1);
  } finally { await f.close(); }
});

test('concurrent change approvals reject stale baselines and revision rebases explicitly', async () => {
  const f = await fixture();
  try {
    const { comment } = await baseline(f);
    const a = await submittedChange(f, comment.id); const b = await submittedChange(f, comment.id);
    const results = await Promise.all([a, b].map(c => f.request('alex', `${f.root}/approvals`, changeApproval(c))));
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
    const stale = results[0].status === 409 ? a : b;
    assert.equal((await f.request('alex', `${f.root}/approvals`, changeApproval(stale, 2))).status, 409);
    const rebased = await f.request('owner', `${f.root}/changes/${stale.id}`, changeInput(comment.id, 2, 1), { method: 'PATCH' });
    assert.equal(rebased.status, 201); assert.equal(rebased.body.version, 2);
    await f.request('owner', `${f.root}/changes/${stale.id}/versions/2/submit`, { expectedVersion: 2 });
    assert.equal((await f.request('alex', `${f.root}/approvals`, changeApproval(rebased.body, 2))).status, 201);
    assert.equal((await f.request('owner', `${f.root}/scope`)).body.changes.length, 2);
  } finally { await f.close(); }
});

test('replacement briefs incorporate only approved local changes and preserve other active changes', async () => {
  const f = await fixture();
  try {
    const { comment } = await baseline(f);
    const a = await submittedChange(f, comment.id);
    await f.request('alex', `${f.root}/approvals`, changeApproval(a));
    const b = await submittedChange(f, comment.id, 2);
    await f.request('alex', `${f.root}/approvals`, changeApproval(b, 2));
    const draft = { expectedVersion: 1, paragraphs: [{ id: 'p-scope', text: 'Manual CSV exports, copy revisions, and scheduled weekly exports as specified in the incorporated change.' }], incorporatedChangeIds: [a.id] };
    assert.equal((await f.request('owner', `${f.root}/briefs`, { ...draft, incorporatedChangeIds: ['foreign-or-pending'] })).status, 422);
    const saved = (await f.request('owner', `${f.root}/briefs`, draft)).body;
    assert.equal((await f.request('owner', `${f.root}/scope`)).body.changes.length, 2);
    await f.request('owner', `${f.root}/briefs/2/submit`, { expectedVersion: 2 });
    await f.request('alex', `${f.root}/approvals`, { targetType: 'brief', targetId: 'brief', version: 2, hash: saved.hash, decision: 'approve', expectedScopeRevision: 3 });
    const scope = (await f.request('owner', `${f.root}/scope`)).body;
    assert.equal(scope.brief.version, 2); assert.deepEqual(scope.changes.map((c: ChangeRequest) => c.id), [b.id]);
    assert.equal((await f.request('owner', `${f.root}/briefs`, { ...draft, expectedVersion: 2, incorporatedChangeIds: [] })).status, 422);
  } finally { await f.close(); }
});

test('manual tasks need approved scope, source feedback and rationale; decisions and updates are idempotent', async () => {
  const f = await fixture();
  try {
    const { b, comment } = await baseline(f);
    const change = await submittedChange(f, comment.id);
    const input = taskInput(comment.id, b);
    assert.equal((await f.request('alex', `${f.root}/tasks`, input)).status, 404);
    assert.equal((await f.request('owner', `${f.root}/tasks`, { ...input, rationale: '' })).status, 422);
    assert.equal((await f.request('owner', `${f.root}/tasks`, { ...input, sourceFeedbackId: 'foreign' })).status, 404);
    assert.equal((await f.request('owner', `${f.root}/tasks`, { ...input, authority: { type: 'change', id: change.id, version: 1, hash: change.hash } })).status, 422);
    const key = randomUUID();
    const task = await f.request('owner', `${f.root}/tasks`, input, { key });
    assert.equal(task.status, 201);
    assert.deepEqual((await f.request('owner', `${f.root}/tasks`, input, { key })).body, task.body);
    assert.equal((await f.request('owner', `${f.root}/tasks`, { ...input, title: 'Different' }, { key })).status, 409);
    assert.equal(f.store.list(f.project.id, 'decisions').length, 1);
    assert.equal((await f.request('owner', `${f.root}/tasks/${task.body.id}`, { expectedVersion: 1, status: 'complete', expectedScopeRevision: 1 }, { method: 'PATCH' })).status, 200);
    assert.equal((await f.request('owner', `${f.root}/tasks/${task.body.id}`, { expectedVersion: 1, status: 'todo', expectedScopeRevision: 1 }, { method: 'PATCH' })).status, 409);
    await f.request('alex', `${f.root}/approvals`, changeApproval(change));
    assert.equal((await f.request('owner', `${f.root}/tasks`, input)).status, 409);
    const added = await f.request('owner', `${f.root}/tasks`, { ...input, expectedScopeRevision: 2, authority: { type: 'change', id: change.id, version: 1, hash: change.hash } });
    assert.equal(added.status, 201);
    assert.equal((await f.request('alex', `${f.root}/tasks`)).body.items.length, 2);
  } finally { await f.close(); }
});

test('private files round-trip exactly and download grants enforce identity, project, expiry and revocation', async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from('Synthetic project evidence.');
    const intent = await f.request('owner', `${f.root}/attachments/upload-intent`, fileInput(bytes));
    assert.equal(intent.status, 201); const id = intent.body.id;
    assert.equal((await f.request('alex', `${f.root}/attachments/${id}/download`)).status, 404);
    const body = { expectedVersion: 1, dataBase64: bytes.toString('base64') }; const key = randomUUID();
    assert.equal((await f.request('alex', `${f.root}/attachments/${id}/complete`, body)).status, 404);
    const complete = await f.request('owner', `${f.root}/attachments/${id}/complete`, body, { key });
    assert.equal(complete.status, 200);
    assert.deepEqual((await f.request('owner', `${f.root}/attachments/${id}/complete`, body, { key })).body, complete.body);
    assert.equal((await f.request('owner', `${f.root}/attachments/${id}/complete`, body)).status, 409);
    for (const actor of ['jules', 'outsider']) {
      assert.equal((await f.request(actor, `${f.root}/attachments`)).status, 404);
      assert.equal((await f.request(actor, `${f.root}/attachments/${id}/download`)).status, 404);
    }
    const link = (await f.request('alex', `${f.root}/attachments/${id}/download`)).body;
    const path = link.url.slice(4);
    const downloaded = await f.request('alex', path, undefined, { raw: true });
    assert.equal(downloaded.status, 200); assert.deepEqual(downloaded.body, bytes);
    assert.match(downloaded.headers.get('content-disposition')!, /^attachment;/);
    assert.equal(downloaded.headers.get('content-type'), 'application/octet-stream');
    assert.equal((await f.request('owner', path)).status, 404);
    assert.equal((await f.request('alex', path.replace(f.project.id, f.second.id))).status, 404);
    f.store.db.prepare('UPDATE download_grants SET expires=0').run();
    assert.equal((await f.request('alex', path)).status, 404);
    const fresh = (await f.request('alex', `${f.root}/attachments/${id}/download`)).body.url.slice(4);
    f.store.saveProject({ ...f.store.project(f.project.id)!, clientId: 'jules' });
    assert.equal((await f.request('alex', fresh)).status, 404);
  } finally { await f.close(); }
});

test('deliverable attachments remain private, block submission while pending and bind immutable approval hashes', async () => {
  const f = await fixture();
  try {
    const d = (await f.request('owner', `${f.root}/deliverables`, { title: 'Export screenshot', description: 'Draft screen', acceptanceCriteria: 'Button is visible.' })).body;
    const bytes = Buffer.from('Synthetic supporting attachment.');
    const input = { ...fileInput(bytes), parent: { type: 'deliverable', id: d.id, version: 1 } };
    assert.equal((await f.request('alex', `${f.root}/attachments/upload-intent`, input)).status, 404);
    const a = (await f.request('owner', `${f.root}/attachments/upload-intent`, input)).body;
    assert.equal((await f.request('owner', `${f.root}/deliverables/${d.id}/versions/1/submit`, { expectedVersion: 1 })).status, 409);
    assert.equal((await f.request('owner', `${f.root}/attachments/${a.id}/complete`, { expectedVersion: 1, dataBase64: bytes.toString('base64') })).status, 200);
    assert.equal((await f.request('alex', `${f.root}/attachments`)).body.items.length, 0);
    assert.equal((await f.request('alex', `${f.root}/attachments/${a.id}/download`)).status, 404);
    const submitted = (await f.request('owner', `${f.root}/deliverables/${d.id}/versions/1/submit`, { expectedVersion: 1 })).body;
    assert.notEqual(submitted.hash, d.hash);
    assert.equal((await f.request('alex', `${f.root}/attachments`)).body.items.length, 1);
    assert.equal((await f.request('owner', `${f.root}/attachments/upload-intent`, input)).status, 409);
    const review = { targetType: 'deliverable', targetId: d.id, version: 1, hash: submitted.hash, decision: 'approve', expectedScopeRevision: 0 };
    assert.equal((await f.request('alex', `${f.root}/approvals`, { ...review, hash: d.hash })).status, 409);
    assert.equal((await f.request('alex', `${f.root}/approvals`, review)).status, 201);
  } finally { await f.close(); }
});

test('upload validation rejects size, checksum, MIME, path names and expired intents without accepting bytes', async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from('Test text');
    for (const patch of [{ size: 5 * 1024 * 1024 + 1 }, { filename: '../evidence.txt' }, { filename: 'fake.pdf' }, { mime: 'text/html' }]) assert.equal((await f.request('owner', `${f.root}/attachments/upload-intent`, { ...fileInput(bytes), ...patch })).status, 422);
    const intent = (await f.request('owner', `${f.root}/attachments/upload-intent`, fileInput(bytes))).body;
    assert.equal((await f.request('owner', `${f.root}/attachments/${intent.id}/complete`, { expectedVersion: 1, dataBase64: Buffer.from('bad').toString('base64') })).status, 422);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attachment_bytes').get()!.n, 0);
    const fakePdf = (await f.request('owner', `${f.root}/attachments/upload-intent`, { ...fileInput(bytes), mime: 'application/pdf', filename: 'fake.pdf' })).body;
    assert.equal((await f.request('owner', `${f.root}/attachments/${fakePdf.id}/complete`, { expectedVersion: 1, dataBase64: bytes.toString('base64') })).status, 422);
    f.store.put(f.project.id, 'attachments', intent.id, 1, { ...intent, expiresAt: 0 });
    assert.equal((await f.request('owner', `${f.root}/attachments/${intent.id}/complete`, { expectedVersion: 1, dataBase64: bytes.toString('base64') })).status, 409);
  } finally { await f.close(); }
});

test('project file quota counts reservations and releases expired intents; global quota is enforced', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 20; i++) assert.equal((await f.request('owner', `${f.root}/attachments/upload-intent`, fileInput())).status, 201);
    assert.equal((await f.request('owner', `${f.root}/attachments/upload-intent`, fileInput())).status, 422);
    const expired = f.store.list<Attachment>(f.project.id, 'attachments')[0];
    f.store.put(f.project.id, 'attachments', expired.id, 1, { ...expired, expiresAt: 0 });
    assert.equal((await f.request('owner', `${f.root}/attachments/upload-intent`, fileInput())).status, 201);
    // Represent occupied storage without allocating a gigabyte in the test.
    f.store.put(f.other.id, 'attachments', 'quota-fixture', 1, { ...expired, id: 'quota-fixture', size: 1024 ** 3, status: 'ready' });
    assert.equal((await f.request('owner', `/projects/${f.second.id}/attachments/upload-intent`, fileInput())).status, 422);
  } finally { await f.close(); }
});

test('private bytes and completed upload idempotency survive a process restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'accord-m2-')); const path = join(dir, 'accord.sqlite');
  let f = await fixture(path);
  try {
    const bytes = Buffer.from('Persistent synthetic attachment');
    const intent = (await f.request('owner', `${f.root}/attachments/upload-intent`, fileInput(bytes))).body;
    const key = randomUUID(); const body = { expectedVersion: 1, dataBase64: bytes.toString('base64') };
    await f.request('owner', `${f.root}/attachments/${intent.id}/complete`, body, { key });
    await f.close(); f = await fixture(path);
    assert.equal((await f.request('owner', `${f.root}/attachments/${intent.id}/complete`, body, { key })).status, 200);
    const link = (await f.request('owner', `${f.root}/attachments/${intent.id}/download`)).body.url.slice(4);
    assert.deepEqual((await f.request('owner', link, undefined, { raw: true })).body, bytes);
  } finally { await f.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the full 5 MB boundary uploads and downloads without truncation', async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.alloc(5 * 1024 * 1024, 'x');
    const intent = await f.request('owner', `${f.root}/attachments/upload-intent`, fileInput(bytes));
    assert.equal(intent.status, 201);
    const result = await f.request('owner', `${f.root}/attachments/${intent.body.id}/complete`, { expectedVersion: 1, dataBase64: bytes.toString('base64') });
    assert.equal(result.status, 200);
    const path = (await f.request('alex', `${f.root}/attachments/${intent.body.id}/download`)).body.url.slice(4);
    const downloaded = await f.request('alex', path, undefined, { raw: true });
    assert.equal(downloaded.body.length, bytes.length);
    assert.equal(checksum(downloaded.body), checksum(bytes));
  } finally { await f.close(); }
});
