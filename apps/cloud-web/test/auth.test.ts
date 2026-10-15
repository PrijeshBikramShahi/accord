import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CloudSession, pkceChallenge, validateConfig, type CloudConfig } from '../src/auth.ts';
import { CloudApi } from '../src/api.ts';

const config: CloudConfig = { apiUrl: 'https://abc123.execute-api.us-east-1.amazonaws.com', authDomain: 'https://accord-cloud-123456789abc.auth.us-east-1.amazoncognito.com', clientId: 'abc123', issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc', redirectUri: 'http://localhost:5174/callback', logoutUri: 'http://localhost:5174/' };
function harness() {
  const storage = new Map<string, string>();
  const h = { time: 1_000_000, destination: '', cleaned: false, requests: [] as { url: string; init?: RequestInit }[], status: 200 };
  const session = new CloudSession(config, {
    storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); }, removeItem: key => { storage.delete(key); } },
    now: () => h.time, navigate: url => { h.destination = url; }, cleanUrl: () => { h.cleaned = true; },
    fetch: (async function (this: unknown, url, init) { assert.equal(this === globalThis, true, 'fetch must receive the browser global, not the session adapter'); assert.equal(h.cleaned, true); h.requests.push({ url: String(url), init }); return new Response(JSON.stringify({ access_token: 'synthetic-access-token-for-test', refresh_token: 'must-not-persist', id_token: 'must-not-persist', token_type: 'Bearer', expires_in: 900 }), { status: h.status }); }) as typeof fetch,
  });
  const callback = () => new URL(`${config.redirectUri}?code=one-time-code&state=${new URL(h.destination).searchParams.get('state')}`);
  return { h, session, storage, callback };
}

test('PKCE matches the RFC 7636 S256 example', async () => {
  assert.equal(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('cloud configuration restricts API, auth domain, region and local callback', () => {
  assert.deepEqual(validateConfig(config, 'http://localhost:5174'), config);
  for (const change of [{ apiUrl: 'https://evil.invalid' }, { authDomain: `${config.authDomain}@evil.invalid` }, { redirectUri: 'https://evil.invalid/callback' }, { clientId: 'x&redirect_uri=evil' }, { issuer: config.issuer.replace('us-east-1', 'us-west-2') }])
    assert.throws(() => validateConfig({ ...config, ...change }, 'http://localhost:5174'));
  assert.throws(() => validateConfig(config, 'http://127.0.0.1:5174'));
});

test('code exchange binds state and verifier, consumes callback once, keeps tokens only in memory', async () => {
  const { h, session, storage, callback } = harness();
  await session.signIn();
  const authorize = new URL(h.destination);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('response_type'), 'code');
  const pending = JSON.parse([...storage.values()][0]);
  assert.equal(authorize.searchParams.get('code_challenge'), await pkceChallenge(pending.verifier));
  const url = callback();
  assert.equal(await session.finish(url), true);
  assert.equal(storage.size, 0);
  assert.equal(session.accessToken(), 'synthetic-access-token-for-test');
  assert.equal(h.requests.length, 1);
  const body = h.requests[0].init!.body as URLSearchParams;
  assert.equal(body.get('code_verifier'), pending.verifier);
  assert.equal(body.get('client_secret'), null);
  assert.equal(h.requests[0].init!.credentials, 'omit');
  await assert.rejects(session.finish(url), /could not be verified/);
  assert.equal(h.requests.length, 1);
});

test('wrong, duplicated, expired and missing state stop before token exchange', async () => {
  for (const problem of ['wrong', 'duplicate', 'expired', 'missing', 'origin', 'code']) {
    const { h, session, storage, callback } = harness();
    await session.signIn();
    const url = callback();
    if (problem === 'wrong') url.searchParams.set('state', 'forged');
    if (problem === 'duplicate') url.searchParams.append('state', url.searchParams.get('state')!);
    if (problem === 'expired') h.time += 600_001;
    if (problem === 'missing') storage.clear();
    if (problem === 'origin') url.hostname = 'evil.invalid';
    if (problem === 'code') url.searchParams.append('code', 'second');
    await assert.rejects(session.finish(url));
    assert.equal(h.requests.length, 0);
    assert.equal(storage.size, 0);
    assert.equal(h.cleaned, true);
  }
});

test('denied or failed exchange produces no session and does not disclose provider errors', async () => {
  const { h, session, callback } = harness();
  await session.signIn();
  const url = callback();
  url.searchParams.set('error', 'sensitive-provider-details');
  await assert.rejects(session.finish(url), /cancelled or denied/);
  assert.equal(h.requests.length, 0);
  await session.signIn();
  h.status = 400;
  await assert.rejects(session.finish(callback()), /Could not complete sign-in/);
  assert.throws(() => session.accessToken(), /session has ended/);
});

test('expiry and logout clear the in-memory session', async () => {
  const { h, session, storage, callback } = harness();
  await session.signIn(); await session.finish(callback());
  h.time += 900_000;
  assert.throws(() => session.accessToken(), /session has ended/);
  await session.signIn(); await session.finish(callback());
  session.signOut();
  assert.equal(new URL(h.destination).pathname, '/logout');
  assert.equal(new URL(h.destination).searchParams.get('logout_uri'), config.logoutUri);
  assert.throws(() => session.accessToken());
  assert.equal(storage.size, 0);
});

test('API retry preserves idempotency key on network/503/429 and clears it on success', async () => {
  const { session, callback } = harness();
  await session.signIn(); await session.finish(callback());
  const keys: string[] = [];
  let attempt = 0;
  const api = new CloudApi(session, (async (url, init) => {
    assert.equal(String(url), `${config.apiUrl}/api/projects`);
    assert.equal(init!.credentials, 'omit');
    const headers = new Headers(init!.headers);
    assert.equal(headers.get('Authorization'), 'Bearer synthetic-access-token-for-test');
    keys.push(headers.get('Idempotency-Key')!);
    attempt++;
    if (attempt === 1) throw new TypeError('Network failure');
    return new Response('{}', { status: attempt === 2 ? 503 : attempt === 3 ? 429 : 201 });
  }) as typeof fetch);
  const body = { title: 'Atlas', description: 'Example', clientId: 'alex' };
  await assert.rejects(api.request('/projects', body));
  await assert.rejects(api.request('/projects', body));
  await assert.rejects(api.request('/projects', body));
  await api.request('/projects', body);
  await api.request('/projects', body);
  assert.equal(new Set(keys.slice(0, 4)).size, 1);
  assert.notEqual(keys[4], keys[0]);
});

test('API rejects foreign URLs and clears auth on 401', async () => {
  const { session, callback } = harness();
  await session.signIn(); await session.finish(callback());
  let calls = 0;
  const api = new CloudApi(session, (async () => { calls++; return new Response('{}', { status: 401 }); }) as typeof fetch);
  await assert.rejects(api.request('https://evil.invalid'), /Unsupported/);
  assert.equal(calls, 0);
  await assert.rejects(api.request('/auth/me'), /session has ended/);
  assert.throws(() => session.accessToken());
});

test('default API transport invokes browser fetch with the global receiver', async t => {
  const { session, callback } = harness();
  await session.signIn(); await session.finish(callback());
  const transport = t.mock.method(globalThis, 'fetch', async function (this: unknown, url: string | URL | Request, init?: RequestInit) {
    assert.equal(this === globalThis, true, 'fetch must receive the browser global, not CloudApi');
    assert.equal(String(url), `${config.apiUrl}/api/auth/me`);
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer synthetic-access-token-for-test');
    return new Response(JSON.stringify({ id: 'maya' }));
  });
  assert.deepEqual(await new CloudApi(session).request('/auth/me'), { id: 'maya' });
  assert.equal(transport.mock.callCount(), 1);
});


test('brief routes preserve retry keys and reject paths outside the workflow', async () => {
  const { session, callback } = harness();
  await session.signIn(); await session.finish(callback());
  const calls: { url: string; key: string | null }[] = [];
  let fail = true;
  const api = new CloudApi(session, (async (url, init) => {
    calls.push({ url: String(url), key: new Headers(init!.headers).get('Idempotency-Key') });
    return new Response('{}', { status: fail ? 503 : 200 });
  }) as typeof fetch);
  const body = { version: 1, hash: 'a'.repeat(64), decision: 'approve', expectedScopeRevision: 0 };
  await assert.rejects(api.request('/projects/atlas/briefs/decide', body));
  fail = false;
  await api.request('/projects/atlas/briefs/decide', body);
  assert.equal(calls[0].key, calls[1].key);
  for (const path of ['/projects/atlas/briefs', '/projects/atlas/briefs/history?cursor=abc', '/projects/atlas/briefs/submit']) await api.request(path);
  for (const path of ['/projects/atlas/briefs/delete', '/projects/atlas/../briefs', '/projects/atlas/briefs?token=secret']) await assert.rejects(api.request(path), /Unsupported/);
  assert.equal(calls.length, 5);
});
