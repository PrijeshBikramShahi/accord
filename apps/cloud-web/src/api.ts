import type { CloudSession } from './auth.ts';

export class CloudApi {
  private pending = new Map<string, string>();
  constructor(private session: CloudSession, private transport: typeof fetch = fetch) {}

  async request<T>(path: string, body?: unknown): Promise<T> {
    if (!/^\/(auth\/me|clients|projects(?:\/[a-zA-Z0-9-]+(?:\/briefs(?:\/(?:history|submit|decide))?)?)?)(?:\?cursor=[A-Za-z0-9_%-]+)?$/.test(path)) throw new Error('Unsupported cloud route.');
    const fingerprint = `${path}:${JSON.stringify(body)}`;
    const key = body === undefined ? undefined : (this.pending.get(fingerprint) ?? crypto.randomUUID());
    if (key) this.pending.set(fingerprint, key);
    // A stored native fetch must run against the browser global, not CloudApi.
    const response = await this.transport.call(globalThis, `${this.session.config.apiUrl}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${this.session.accessToken()}`, ...(key ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401) this.session.clear();
    if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429)) this.pending.delete(fingerprint);
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(response.status === 401 ? 'Your session has ended. Sign in again.' : value.error ?? `Request failed (${response.status}). Try again.`);
    return value as T;
  }

  async all<T>(path: '/projects' | '/clients'): Promise<T[]> {
    const result: T[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: { items: T[]; nextCursor: string | null } = await this.request(`${path}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
      result.push(...page.items);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('Could not load the next page. Reload the project list.');
      if (cursor) { cursors.add(cursor); await new Promise(resolve => setTimeout(resolve, 550)); }
    } while (cursor);
    return result;
  }
}
