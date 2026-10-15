import type { Page } from '../../../packages/shared/src/index.ts';
export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const pendingKeys = new Map<string, string>();
export async function api<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const signature = JSON.stringify([path, method, body]);
  const key = pendingKeys.get(signature) ?? crypto.randomUUID();
  if (body !== undefined) pendingKeys.set(signature, key);
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : method, credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status < 500) pendingKeys.delete(signature);
    throw new ApiError(response.status, data.error ?? 'Request failed.');
  }
  pendingKeys.delete(signature);
  return data as T;
}
export async function all<T>(path: string): Promise<T[]> {
  const result: T[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<T> = await api(`${path}${cursor ? `?cursor=${cursor}` : ''}`);
    result.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return result;
}
