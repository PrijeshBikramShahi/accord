import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { attachmentSchema, attachmentCompleteSchema, type Attachment, type Deliverable, type Identity } from '../../../packages/shared/src/index.ts';
import { audit, authorize, Problem } from './domain.ts';
import { hash, Store } from './store.ts';

export function canReadAttachment(store: Store, user: Identity, projectId: string, file: Attachment): boolean {
  if (file.status !== 'ready') return user.id === file.uploaderId && file.expiresAt > Date.now();
  if (file.parent.type === 'project') return true;
  const parent = store.get<Deliverable>(projectId, 'deliverables', file.parent.id, file.parent.version);
  return !!parent && (user.role === 'owner' || parent.status !== 'draft');
}
function parentCheck(store: Store, user: Identity, projectId: string, parent: Attachment['parent']) {
  if (parent.type === 'project') return;
  authorize(store, user, projectId, true);
  const versions = store.list<Deliverable>(projectId, 'deliverables').filter(d => d.id === parent.id);
  if (!versions.length) throw new Problem(404, 'Deliverable not found.');
  if (versions[0].version !== parent.version || versions[0].status !== 'draft') throw new Problem(409, 'Attach files only to the latest draft deliverable. Create a new version for revised files.');
}
export function uploadIntent(store: Store, user: Identity, projectId: string, input: unknown) {
  authorize(store, user, projectId);
  const data = attachmentSchema.parse(input);
  const extension = data.filename.split('.').pop()?.toLowerCase();
  const allowed = { 'application/pdf': ['pdf'], 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'text/plain': ['txt'] };
  if (!extension || !allowed[data.mime].includes(extension)) throw new Problem(422, 'Filename extension must match PDF, PNG, JPEG or plain text.');
  parentCheck(store, user, projectId, data.parent);
  const files = store.list<Attachment>(projectId, 'attachments').filter(a => a.status === 'ready' || a.expiresAt > Date.now());
  if (files.length >= 20) throw new Problem(422, 'This project has reached its 20-file limit. Pending uploads expire after 15 minutes.');
  const row = store.db.prepare(`SELECT COALESCE(SUM(json_extract(body, '$.size')), 0) AS bytes FROM records WHERE kind='attachments' AND (json_extract(body, '$.status')='ready' OR json_extract(body, '$.expiresAt')>?)`).get(Date.now());
  if (Number(row?.bytes ?? 0) + data.size > 1024 ** 3) throw new Problem(422, 'The local demo has reached its 1 GB storage limit.');
  const file: Attachment = { ...data, id: randomUUID(), version: 1, objectKey: randomUUID(), status: 'pending', uploaderId: user.id, createdAt: new Date().toISOString(), expiresAt: Date.now() + 15 * 60_000 };
  store.put(projectId, 'attachments', file.id, 1, file);
  return file;
}
export function completeUpload(store: Store, user: Identity, projectId: string, id: string, input: unknown) {
  authorize(store, user, projectId);
  const data = attachmentCompleteSchema.parse(input);
  const file = store.get<Attachment>(projectId, 'attachments', id, 1);
  if (!file || file.uploaderId !== user.id) throw new Problem(404, 'Upload not found.');
  if (file.status !== 'pending' || file.expiresAt <= Date.now()) throw new Problem(409, 'Upload already completed or expired. Start a new upload if needed.');
  parentCheck(store, user, projectId, file.parent);
  const bytes = Buffer.from(data.dataBase64, 'base64');
  if (bytes.toString('base64') !== data.dataBase64) throw new Problem(422, 'Invalid base64 encoding.');
  if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.checksum) throw new Problem(422, 'File size or checksum did not match the upload intent.');
  if (file.mime === 'application/pdf' && bytes.subarray(0, 5).toString() !== '%PDF-') throw new Problem(422, 'File is not a PDF.');
  if (file.mime === 'image/png' && !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Problem(422, 'File is not a PNG.');
  if (file.mime === 'image/jpeg' && !bytes.subarray(0, 3).equals(Buffer.from([255,216,255]))) throw new Problem(422, 'File is not a JPEG.');
  if (file.mime === 'text/plain') {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Problem(422, 'Plain text must use UTF-8.'); }
    if (bytes.includes(0)) throw new Problem(422, 'Plain text cannot contain binary null bytes.');
  }
  store.db.prepare('INSERT INTO attachment_bytes VALUES (?, ?)').run(file.objectKey, bytes);
  file.status = 'ready';
  store.put(projectId, 'attachments', id, 1, file);
  if (file.parent.type === 'deliverable') {
    const parent = store.get<Deliverable>(projectId, 'deliverables', file.parent.id, file.parent.version)!;
    const attachments = store.list<Attachment>(projectId, 'attachments').filter(a => a.status === 'ready' && a.parent.type === 'deliverable' && a.parent.id === parent.id && a.parent.version === parent.version).sort((a, b) => a.id.localeCompare(b.id)).map(a => ({ id: a.id, version: a.version, checksum: a.checksum, filename: a.filename, mime: a.mime, size: a.size }));
    parent.hash = hash({ title: parent.title, description: parent.description, acceptanceCriteria: parent.acceptanceCriteria, attachments });
    store.put(projectId, 'deliverables', parent.id, parent.version, parent);
    audit(store, projectId, user, 'Deliverable draft attachment saved', id, 1);
  } else audit(store, projectId, user, 'Project attachment saved', id, 1);
  return file;
}
export function issueDownload(store: Store, user: Identity, projectId: string, id: string) {
  authorize(store, user, projectId);
  const file = store.get<Attachment>(projectId, 'attachments', id, 1);
  if (!file || file.status !== 'ready' || !canReadAttachment(store, user, projectId, file)) throw new Problem(404, 'File not found.');
  const token = randomBytes(32).toString('hex');
  store.db.prepare('DELETE FROM download_grants WHERE expires <= ?').run(Date.now());
  store.db.prepare('INSERT INTO download_grants VALUES (?, ?, ?, ?, ?)').run(hash(token), user.id, projectId, id, Date.now() + 60_000);
  return { url: `/api/projects/${projectId}/attachments/${id}/content?token=${token}`, expiresIn: 60 };
}
export function downloadContent(store: Store, user: Identity, projectId: string, id: string, token: unknown) {
  authorize(store, user, projectId);
  const grant = typeof token === 'string' && token.length === 64 ? store.db.prepare('SELECT * FROM download_grants WHERE token_hash=? AND actor_id=? AND project_id=? AND attachment_id=? AND expires>?').get(hash(token), user.id, projectId, id, Date.now()) : undefined;
  const file = store.get<Attachment>(projectId, 'attachments', id, 1);
  if (!grant || !file || file.status !== 'ready' || !canReadAttachment(store, user, projectId, file)) throw new Problem(404, 'Download expired or file not found. Request a new download.');
  const row = store.db.prepare('SELECT data FROM attachment_bytes WHERE object_key=?').get(file.objectKey);
  if (!row) throw new Problem(404, 'File content not found.');
  return { file, bytes: Buffer.from(row.data as Uint8Array) };
}
