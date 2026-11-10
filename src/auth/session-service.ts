import { setTimeout as sleep } from 'node:timers/promises';
import type { Cookie } from 'playwright-core';
import type { SessionConfig } from '../core/config.ts';
import { httpRequest } from '../core/http.ts';
import { logger } from '../core/logger.ts';
import { mergeSetCookies } from './cookies.ts';
import {
  cookieHeader, hasLoginCookies, sessionKey, sessionState,
  type SessionHealth, type SessionState, type SessionStore, type StoredSession,
} from './session-store.ts';
import { AUTH_SPECS, domainMatches, type AuthSpec } from './specs.ts';

const FALLBACK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

export const userAgentFor = (s: Pick<StoredSession, 'userAgent'>): string => s.userAgent || FALLBACK_UA;

// ---------------------------------------------------------------------------
// Real login check and cookie rotation (plain HTTP, no browser)
// ---------------------------------------------------------------------------

/**
 * Asks the provider whether the cookies are still accepted. Returns `ok: false` when the provider
 * clearly treats the session as logged out; throws when the answer is inconclusive (network error,
 * 5xx, rate limit), so a flaky connection never marks a good session as dead.
 */
export async function verifyLogin(
  spec: AuthSpec,
  session: Pick<StoredSession, 'cookies' | 'userAgent'>,
): Promise<{ ok: boolean; cookies: Cookie[]; why: string }> {
  const v = spec.verify;
  if (!v) throw new Error(`No login check is available for ${spec.id} yet`);
  const res = await httpRequest(v.url, {
    compress: true,
    timeoutMs: 30_000,
    headers: {
      cookie: cookieHeader(session.cookies, v.url),
      'user-agent': userAgentFor(session),
      accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      ...v.headers,
    },
  });
  const cookies = mergeSetCookies(session.cookies, res.setCookie, v.url).cookies;
  if (res.status === 200) {
    const ok = new RegExp(v.loggedIn).test(res.text());
    return { ok, cookies, why: ok ? 'HTTP 200, logged-in marker found' : 'HTTP 200 but the logged-in marker is missing' };
  }
  if ((res.status >= 300 && res.status < 400) || res.status === 401) {
    // Where it redirects tells a login page apart from anything else. The query string is left out on purpose.
    const loc = typeof res.headers.location === 'string' ? res.headers.location : '';
    let to = '';
    try { if (loc) { const u = new URL(loc, v.url); to = ' to ' + u.host + u.pathname; } } catch { /* unparsable Location */ }
    return { ok: false, cookies, why: 'HTTP ' + res.status + to };
  }
  throw new Error(`${spec.name} answered HTTP ${res.status}`);
}

const GOOGLE_ROTATE_URL = 'https://accounts.google.com/RotateCookies';

/**
 * Google rotates its short-lived cookies (__Secure-1PSIDTS). A copied session goes stale within
 * hours unless it is rotated too; this is the call the Gemini web app itself makes periodically.
 */
async function rotateGoogleCookies(
  cookies: Cookie[],
  userAgent: string,
): Promise<{ cookies: Cookie[]; changed: string[]; rejected: boolean }> {
  const res = await httpRequest(GOOGLE_ROTATE_URL, {
    method: 'POST',
    timeoutMs: 20_000,
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader(cookies, GOOGLE_ROTATE_URL),
      'user-agent': userAgent,
      origin: 'https://accounts.google.com',
    },
    body: '[000,"-0000000000000000000"]',
  });
  if (res.status === 401 || res.status === 403) return { cookies, changed: [], rejected: true };
  if (res.status !== 200) throw new Error(`RotateCookies answered HTTP ${res.status}`);
  return { ...mergeSetCookies(cookies, res.setCookie, GOOGLE_ROTATE_URL), rejected: false };
}

// ---------------------------------------------------------------------------
// Session service: owns reads/writes of sessions while the gateway runs
// ---------------------------------------------------------------------------

/**
 * Checks a held login inside the account's own browser profile (see StoredSession.held) and returns that
 * profile's cookies. Provided by whoever owns the browser; throws when the answer is inconclusive.
 */
export type BrowserCheck = (spec: AuthSpec, session: StoredSession) => Promise<{ ok: boolean; cookies: Cookie[]; why: string }>;

/** Names of the cookies whose value differs between two copies. */
function changedCookies(before: Cookie[], after: Cookie[]): string[] {
  const old = new Map(before.map((c) => [`${c.domain}|${c.path}|${c.name}`, c.value]));
  return [...new Set(after.filter((c) => old.get(`${c.domain}|${c.path}|${c.name}`) !== c.value).map((c) => c.name))].sort();
}

export interface RefreshResult {
  /** true = provider accepts the session, false = provider rejected it, null = could not tell. */
  ok: boolean | null;
  /** True when the provider issued a new __Secure-1PSIDTS-style token. */
  rotated: boolean;
  /** True when a real login check was performed in this refresh. */
  verified: boolean;
  detail: string;
  ms: number;
}

export interface SessionInfo {
  provider: string;
  account: string;
  state: SessionState;
  createdAt?: string;
  lastCheck?: SessionHealth;
  keepUntil: number | null;
}

export class SessionService {
  readonly store: SessionStore;
  private readonly cfg: SessionConfig;
  private readonly locks = new Map<string, Promise<unknown>>();
  private browserCheck: BrowserCheck | null = null;

  constructor(store: SessionStore, cfg: SessionConfig) {
    this.store = store;
    this.cfg = cfg;
  }

  /** Lets held logins be checked and kept alive in their browser profile instead of over plain HTTP. */
  setBrowserCheck(check: BrowserCheck | null): void { this.browserCheck = check; }

  /** Loads a session and applies the retention policy: expired sessions are deleted. */
  get(provider: string, account = 'default'): StoredSession | null {
    const s = this.store.load(provider, account);
    if (s?.keepUntil && s.keepUntil < Date.now()) {
      this.store.delete(provider, account);
      logger.info(`Session ${sessionKey(provider, account)} deleted: retention period is over`);
      return null;
    }
    return s;
  }

  /** One operation at a time per account, so rotation and requests never overwrite each other. */
  private lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.locks.set(key, next);
    next.finally(() => { if (this.locks.get(key) === next) this.locks.delete(key); }).catch(() => {});
    return next;
  }

  /**
   * Saves `next` only if nobody replaced the session since `base` was read (for example a
   * `bridge login --force` running at the same moment). Returns false when it was discarded.
   */
  private persist(base: StoredSession, next: StoredSession): boolean {
    const current = this.store.load(base.provider, base.account);
    if (!current || current.savedAt !== base.savedAt) return false;
    this.store.save({ ...next, savedAt: new Date().toISOString() });
    return true;
  }

  /** Rotates cookies and/or verifies the login, then stores whatever changed. */
  refresh(spec: AuthSpec, account: string, opts: { rotate: boolean; verify: boolean }): Promise<RefreshResult> {
    return this.lock(sessionKey(spec.id, account), async () => {
      const started = Date.now();
      const base = this.get(spec.id, account);
      if (!base) return { ok: false, rotated: false, verified: false, detail: 'no saved session', ms: 0 };

      let cookies = base.cookies;
      let rotated = false;
      let verified = false;
      let ok: boolean | null = null;
      const notes: string[] = [];

      try {
        if (base.held) {
          // The profile owns the login: never rotate its cookies from outside, just let the page run.
          if (!this.browserCheck) throw new Error('this login lives in a browser profile and no browser is available here');
          const v = await this.browserCheck(spec, base);
          const scoped = v.cookies.filter((c) => domainMatches(c.domain, spec));
          const changed = changedCookies(cookies, scoped);
          rotated = changed.includes('__Secure-1PSIDTS');
          cookies = scoped;
          ok = v.ok;
          verified = true;
          notes.push('browser visit changed ' + (changed.length ? changed.join(',') : 'no cookie'));
          notes.push(v.ok ? 'login verified (' + v.why + ')' : 'login check failed (' + v.why + ')');
        } else if (opts.rotate && spec.keepAlive?.kind === 'google-rotate') {
          const r = await rotateGoogleCookies(cookies, userAgentFor(base));
          cookies = r.cookies;
          rotated = r.changed.includes('__Secure-1PSIDTS');
          notes.push(r.changed.length ? 'rotation changed ' + r.changed.join(',') : 'rotation changed no cookie');
          if (r.rejected) { ok = false; verified = true; notes.push('provider rejected the session'); }
        }
        if (!base.held && opts.verify && spec.verify && ok === null) {
          const v = await verifyLogin(spec, { ...base, cookies });
          cookies = v.cookies;
          ok = v.ok;
          verified = true;
          notes.push(v.ok ? 'login verified (' + v.why + ')' : 'login check failed (' + v.why + ')');
        }
        if (ok !== false && !hasLoginCookies(spec, { cookies, origins: base.origins })) {
          ok = false; verified = true;
          notes.push('provider removed the login cookies');
        }
      } catch (err) {
        notes.push(`inconclusive: ${(err as Error).message}`);
      }

      const health: SessionHealth | undefined = verified
        ? { checkedAt: new Date().toISOString(), ok: ok === true }
        : base.health;
      if (!this.persist(base, { ...base, cookies, health })) notes.push('session was replaced meanwhile, update discarded');
      if (ok === false) notes.push('login again with --force');

      return { ok, rotated, verified, detail: notes.join('; '), ms: Date.now() - started };
    });
  }

  /**
   * Stores cookies taken from a browser context after it was used. Page scripts rotate cookies
   * (Google does this on every visit), so not saving them would leave the stored copy stale.
   */
  saveBrowserCookies(spec: AuthSpec, account: string, cookies: Cookie[]): Promise<void> {
    return this.lock(sessionKey(spec.id, account), async () => {
      const current = this.get(spec.id, account);
      const scoped = cookies.filter((c) => domainMatches(c.domain, spec));
      // Never overwrite a working copy with a browser that ended up logged out.
      if (!current || !hasLoginCookies(spec, { cookies: scoped, origins: [] })) return;
      this.store.save({ ...current, cookies: scoped, savedAt: new Date().toISOString() });
    });
  }

  /** Stores cookies the provider set in a plain HTTP response (e.g. rotated SIDCC values). */
  applySetCookies(spec: AuthSpec, account: string, setCookie: string[], requestUrl: string): Promise<void> {
    if (setCookie.length === 0) return Promise.resolve();
    return this.lock(sessionKey(spec.id, account), async () => {
      const current = this.get(spec.id, account);
      if (!current) return;
      const merged = mergeSetCookies(current.cookies, setCookie, requestUrl);
      if (merged.changed.length === 0) return;
      this.store.save({ ...current, cookies: merged.cookies, savedAt: new Date().toISOString() });
    });
  }

  states(): SessionInfo[] {
    const out: SessionInfo[] = [];
    for (const { provider, account } of this.store.list()) {
      const spec = AUTH_SPECS[provider];
      if (!spec) continue;
      let s: StoredSession | null = null;
      try { s = this.get(provider, account); } catch { /* undecryptable: skipped */ }
      if (!s) continue;
      out.push({
        provider, account, state: sessionState(spec, s),
        createdAt: s.createdAt, lastCheck: s.health, keepUntil: s.keepUntil ?? null,
      });
    }
    return out;
  }

  /**
   * Keeps every saved session alive while the gateway runs. Copied logins: cookies are rotated and the login is
   * verified over HTTP on every tick. Held logins: the page is opened in the account's own browser profile on every tick.
   * Either way the minute a session dies is known to within one interval. Sessions already known to be dead are
   * skipped until the user logs in again.
   */
  startKeepAlive(): () => void {
    if (!this.cfg.keepAlive) return () => {};
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;

    const tick = async () => {
      for (const { provider, account } of this.store.list()) {
        if (stopped) return;
        const spec = AUTH_SPECS[provider];
        if (!spec?.keepAlive) continue;
        const key = sessionKey(provider, account);
        try {
          const s = this.get(provider, account);
          if (!s || s.health?.ok === false) continue;
          const r = await this.refresh(spec, account, { rotate: true, verify: true });
          const line = `Keep-alive ${key}: ${r.detail || 'ok'} (${r.ms}ms)`;
          if (r.ok === false) logger.warn(`${key}: ${spec.name} no longer accepts this session. ${r.detail}`);
          else if (r.detail.includes('inconclusive')) logger.warn(line);
          else logger.info(line);
        } catch (err) {
          logger.warn(`Keep-alive ${key} failed: ${(err as Error).message}`);
        }
        await sleep(1000 + Math.random() * 2000); // never hit several accounts in the same instant
      }
    };

    const schedule = (delayMs: number) => {
      timer = setTimeout(() => {
        void tick().finally(() => { if (!stopped) schedule(this.cfg.keepAliveInterval * 1000 * (0.9 + Math.random() * 0.2)); });
      }, delayMs);
      timer.unref();
    };
    schedule(2000); // first pass right after start: refreshes a session that went stale while the gateway was off

    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }
}
