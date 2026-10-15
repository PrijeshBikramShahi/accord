export interface CloudConfig {
  apiUrl: string; authDomain: string; clientId: string; issuer: string;
  redirectUri: string; logoutUri: string;
}
const pendingKey = 'accord.cloud.pkce';

export function validateConfig(value: unknown, origin: string): CloudConfig {
  if (!value || typeof value !== 'object') throw new Error('Cloud configuration is missing.');
  const c = value as CloudConfig;
  if (origin !== 'http://localhost:5174' || c.redirectUri !== `${origin}/callback` || c.logoutUri !== `${origin}/`)
    throw new Error('Open this preview at http://localhost:5174.');
  if (!/^https:\/\/[a-z0-9]+\.execute-api\.us-east-1\.amazonaws\.com$/.test(c.apiUrl ?? '') ||
      !/^https:\/\/accord-cloud-[a-f0-9]{12}\.auth\.us-east-1\.amazoncognito\.com$/.test(c.authDomain ?? '') ||
      !/^https:\/\/cognito-idp\.us-east-1\.amazonaws\.com\/us-east-1_[a-zA-Z0-9]+$/.test(c.issuer ?? '') ||
      !/^[a-z0-9]{1,128}$/.test(c.clientId ?? '')) throw new Error('Cloud configuration is invalid. Download it again from your stack.');
  return c;
}

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

interface Browser {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  fetch: typeof fetch;
  navigate: (url: string) => void;
  cleanUrl: () => void;
  now: () => number;
}

export class CloudSession {
  private token: { value: string; expiresAt: number } | null = null;
  constructor(readonly config: CloudConfig, private browser: Browser) {}

  async signIn(): Promise<void> {
    this.clear();
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = await pkceChallenge(verifier);
    this.browser.storage.setItem(pendingKey, JSON.stringify({ verifier, state, createdAt: this.browser.now(), clientId: this.config.clientId, domain: this.config.authDomain, redirectUri: this.config.redirectUri }));
    const url = new URL('/oauth2/authorize', this.config.authDomain);
    url.search = new URLSearchParams({ client_id: this.config.clientId, response_type: 'code', scope: 'openid email profile', redirect_uri: this.config.redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
    this.browser.navigate(url.href);
  }

  async finish(url: URL): Promise<boolean> {
    if (url.pathname !== '/callback') return false;
    const raw = this.browser.storage.getItem(pendingKey);
    this.clear();
    // Remove the authorization code before making requests or rendering anything.
    this.browser.cleanUrl();
    let pending;
    try { pending = JSON.parse(raw ?? 'null'); } catch { /* fail closed below */ }
    const age = this.browser.now() - (pending?.createdAt ?? 0);
    if (url.origin + url.pathname !== this.config.redirectUri || !pending || age < 0 || age > 600_000 ||
        pending.clientId !== this.config.clientId || pending.domain !== this.config.authDomain || pending.redirectUri !== this.config.redirectUri ||
        !/^[A-Za-z0-9_-]{43}$/.test(pending.verifier ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(pending.state ?? '') ||
        url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== pending.state)
      throw new Error('Sign-in expired or could not be verified. Start sign-in again.');
    if (url.searchParams.has('error')) throw new Error('Sign-in was cancelled or denied. Try again.');
    const code = url.searchParams.get('code');
    if (!code || code.length > 4096 || url.searchParams.getAll('code').length !== 1)
      throw new Error('The sign-in response was incomplete. Try again.');
    // Native browser fetch rejects the adapter object as its receiver.
    const response = await this.browser.fetch.call(globalThis, `${this.config.authDomain}/oauth2/token`, {
      method: 'POST', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: this.config.clientId, redirect_uri: this.config.redirectUri, code, code_verifier: pending.verifier }),
    });
    if (!response.ok) throw new Error('Could not complete sign-in. Start again.');
    const result = await response.json();
    if (typeof result.access_token !== 'string' || result.access_token.length < 20 ||
        String(result.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(result.expires_in) || result.expires_in < 1 || result.expires_in > 900)
      throw new Error('Unexpected sign-in response. Start again.');
    // Ignore ID and refresh tokens. Access tokens live only in this page's memory.
    this.token = { value: result.access_token, expiresAt: this.browser.now() + result.expires_in * 1000 };
    return true;
  }

  accessToken(): string {
    if (!this.token || this.token.expiresAt <= this.browser.now() + 5000) {
      this.clear();
      throw new Error('Your session has ended. Sign in again.');
    }
    return this.token.value;
  }

  remainingMs(): number { return Math.max(0, (this.token?.expiresAt ?? 0) - this.browser.now() - 5000); }
  clear(): void { this.token = null; this.browser.storage.removeItem(pendingKey); }
  signOut(): void {
    this.clear();
    const url = new URL('/logout', this.config.authDomain);
    url.search = new URLSearchParams({ client_id: this.config.clientId, logout_uri: this.config.logoutUri }).toString();
    this.browser.navigate(url.href);
  }
}
