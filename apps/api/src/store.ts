import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Identity, Project } from '../../../packages/shared/src/index.ts';

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (project_id TEXT NOT NULL REFERENCES projects(id), kind TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(project_id, kind, id, version));
      CREATE TABLE IF NOT EXISTS idempotency (actor_id TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, status INTEGER NOT NULL, response TEXT NOT NULL, PRIMARY KEY(actor_id, key));
      CREATE TABLE IF NOT EXISTS attachment_bytes (object_key TEXT PRIMARY KEY, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS download_grants (token_hash TEXT PRIMARY KEY, actor_id TEXT NOT NULL, project_id TEXT NOT NULL, attachment_id TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS analysis_queue (project_id TEXT NOT NULL, job_id TEXT NOT NULL, PRIMARY KEY(project_id, job_id));
      CREATE TABLE IF NOT EXISTS analysis_attempts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, job_id TEXT NOT NULL, ordinal INTEGER NOT NULL, state TEXT NOT NULL, reserved_at INTEGER NOT NULL, cost_micros INTEGER NOT NULL DEFAULT 0, UNIQUE(project_id, job_id, ordinal));`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  user(id: string): Identity | undefined {
    const row = this.db.prepare('SELECT body FROM users WHERE id = ?').get(id);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  users(): Identity[] { return this.db.prepare('SELECT body FROM users ORDER BY id').all().map(row => JSON.parse(String(row.body))); }
  addUser(user: Identity, password: string) {
    this.db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run(user.id, user.email.toLowerCase(), hashPassword(password), JSON.stringify(user));
  }
  authenticate(email: string, password: string): Identity | undefined {
    const row = this.db.prepare('SELECT password, body FROM users WHERE email = ?').get(email.toLowerCase());
    const valid = verifyPassword(password, row ? String(row.password) : dummyPasswordHash);
    return row && valid ? JSON.parse(String(row.body)) : undefined;
  }
  project(id: string): Project | undefined {
    const row = this.db.prepare('SELECT body FROM projects WHERE id = ?').get(id);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  projects(user: Identity): Project[] {
    return this.db.prepare(`SELECT body FROM projects WHERE json_extract(body, '$.workspaceId') = ? AND (json_extract(body, '$.ownerId') = ? OR json_extract(body, '$.clientId') = ?) ORDER BY id`).all(user.workspaceId, user.id, user.id).map(row => JSON.parse(String(row.body)));
  }
  saveProject(project: Project) { this.db.prepare('INSERT INTO projects VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(project.id, JSON.stringify(project)); }
  put(projectId: string, kind: string, id: string, version: number, value: unknown) {
    this.db.prepare('INSERT INTO records VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, kind, id, version) DO UPDATE SET body=excluded.body').run(projectId, kind, id, version, JSON.stringify(value));
  }
  get<T>(projectId: string, kind: string, id: string, version: number): T | undefined {
    const row = this.db.prepare('SELECT body FROM records WHERE project_id=? AND kind=? AND id=? AND version=?').get(projectId, kind, id, version);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  list<T>(projectId: string, kind: string): T[] {
    return this.db.prepare('SELECT body FROM records WHERE project_id=? AND kind=? ORDER BY version DESC, rowid DESC').all(projectId, kind).map(row => JSON.parse(String(row.body)));
  }
  close() { this.db.close(); }
}

export function hash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function hashPassword(password: string) { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; }
function verifyPassword(password: string, encoded: string) { const [salt, expected] = encoded.split(':'); return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(expected, 'hex')); }
const dummyPasswordHash = hashPassword(randomBytes(32).toString('hex'));
