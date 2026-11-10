import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Cookie } from 'playwright-core';
import { decrypt, encrypt, loadKey } from './crypto.ts';
import { cookieNameMatches, domainMatches, originMatches, type AuthSpec } from './specs.ts';

export const DEFAULT_ACCOUNT = 'default';

export interface OriginStorage { origin: string; localStorage: { name: string; value: string }[] }

/** Result of the last real login check against the provider. */
export interface SessionHealth { checkedAt: string; ok: boolean }

export interface StoredSession {
  provider: string;
  /** Account label chosen by the user (`--account`), "default" when not given. */
  account: string;
  /** When the user logged in. */
  createdAt?: string;
  /** When the cookies were last updated (login, rotation, browser use). Changes whenever cookies change. */
  savedAt: string;
  /** Epoch ms after which the session is deleted (retention). null/undefined = keep forever. */
  keepUntil?: number | null;
  health?: SessionHealth;
  /** User-Agent of the browser used to log in; reused so every request looks like that browser. */
  userAgent: string;
  /**
   * True when the gateway's own browser profile for this account (data/profiles/<provider>-<account>) holds the live
   * login. The cookies below are then only a copy for status checks: requests and keep-alive go through that browser.
   */
  held?: boolean;
  cookies: Cookie[];
  origins: OriginStorage[];
}

/** Unique key of one account of one provider, e.g. "gemini" or "gemini@work". */
export const sessionKey = (provider: string, account: string = DEFAULT_ACCOUNT) =>
  account === DEFAULT_ACCOUNT ? provider : `${provider}@${account}`;

export function validateAccountName(account: string): string {
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(account)) {
    throw new Error('Account name may only contain letters, numbers, "-" and "_" (max 32 characters)');
  }
  return account;
}

const nowSec = () => Date.now() / 1000;
const isLive = (c: Cookie) => c.expires === -1 || c.expires > nowSec();

/** Keeps only the cookies/localStorage that belong to the provider. */
export function scopeToProvider(
  spec: AuthSpec,
  account: string,
  state: { cookies: Cookie[]; origins: OriginStorage[] },
  userAgent: string,
): StoredSession {
  const now = new Date().toISOString();
  return {
    provider: spec.id,
    account,
    createdAt: now,
    savedAt: now,
    userAgent,
    cookies: state.cookies.filter((c) => domainMatches(c.domain, spec)),
    origins: state.origins.filter((o) => originMatches(o.origin, spec)),
  };
}

/**
 * True when the login cookies/keys from the spec are present and not expired.
 * This only looks at local data. It does NOT prove that the provider still accepts the session:
 * see `verifyLogin()` for the real check.
 */
export function hasLoginCookies(spec: AuthSpec, s: Pick<StoredSession, 'cookies' | 'origins'>): boolean {
  const cookiesOk = (spec.cookies ?? []).every((p) => s.cookies.some((c) => cookieNameMatches(p, c.name) && isLive(c)));
  const ls = spec.localStorage;
  const storageOk = !ls || ls.keys.every((k) =>
    s.origins.some((o) => o.origin === ls.origin && o.localStorage.some((e) => e.name === k && e.value)));
  return cookiesOk && storageOk;
}

export type SessionState = 'ok' | 'dead' | 'unverified' | 'no-cookies';

/** ok = last real check passed, dead = provider rejected the session, unverified = never checked. */
export function sessionState(spec: AuthSpec, s: StoredSession): SessionState {
  if (!hasLoginCookies(spec, s)) return 'no-cookies';
  if (s.health) return s.health.ok ? 'ok' : 'dead';
  return 'unverified';
}

/** Earliest expiry (ms epoch) of the login cookies, or null for session cookies / no expiry. */
export function sessionExpiry(spec: AuthSpec, s: StoredSession): number | null {
  const times = s.cookies
    .filter((c) => (spec.cookies ?? []).some((p) => cookieNameMatches(p, c.name)) && c.expires > 0)
    .map((c) => c.expires * 1000);
  return times.length ? Math.min(...times) : null;
}

/** Builds a Cookie header for `url` (used by direct-HTTP mode). */
export function cookieHeader(cookies: Cookie[], url: string): string {
  const u = new URL(url);
  return cookies
    .filter((c) => {
      const d = c.domain.replace(/^\./, '');
      const hostOk = c.domain.startsWith('.') ? u.hostname === d || u.hostname.endsWith(`.${d}`) : u.hostname === d;
      return hostOk && u.pathname.startsWith(c.path || '/') && (!c.secure || u.protocol === 'https:') && isLive(c);
    })
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

export class SessionStore {
  private readonly dir: string;
  private readonly key: Buffer;
  private readonly cache = new Map<string, { mtimeMs: number; session: StoredSession }>();

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'sessions');
    mkdirSync(this.dir, { recursive: true });
    this.key = loadKey(dataDir);
  }

  private file(key: string): string { return join(this.dir, `${key}.bin`); }

  save(session: StoredSession): void {
    const key = sessionKey(session.provider, session.account);
    const path = this.file(key);
    // Write-then-rename so a crash or a concurrent reader never sees a half-written file.
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, encrypt(this.key, session), { mode: 0o600 });
    renameSync(tmp, path);
    this.cache.delete(key);
  }

  /** Reloads from disk only when the file changed, so `bridge login` takes effect without a restart. */
  load(provider: string, account: string = DEFAULT_ACCOUNT): StoredSession | null {
    const key = sessionKey(provider, account);
    const path = this.file(key);
    if (!existsSync(path)) { this.cache.delete(key); return null; }
    const { mtimeMs } = statSync(path);
    const hit = this.cache.get(key);
    if (hit && hit.mtimeMs === mtimeMs) return hit.session;
    try {
      const session = decrypt<StoredSession>(this.key, readFileSync(path));
      session.account ??= account; // sessions saved before multi-account support
      this.cache.set(key, { mtimeMs, session });
      return session;
    } catch {
      const flag = account === DEFAULT_ACCOUNT ? '' : ` --account ${account}`;
      throw new Error(`Cannot decrypt session "${key}" (was data/.key changed?). Run "bridge login ${provider}${flag} --force".`);
    }
  }

  delete(provider: string, account: string = DEFAULT_ACCOUNT): boolean {
    const key = sessionKey(provider, account);
    const path = this.file(key);
    this.cache.delete(key);
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
  }

  /** All saved accounts, optionally for one provider. */
  list(provider?: string): { provider: string; account: string }[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.bin'))
      .map((f) => {
        const [p = '', a = DEFAULT_ACCOUNT] = f.slice(0, -4).split('@');
        return { provider: p, account: a };
      })
      .filter((s) => !provider || s.provider === provider);
  }
}
