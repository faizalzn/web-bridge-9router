import { readFileSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { BrowserContext, Cookie, Page } from 'playwright-core';
import type { Config } from '../core/config.ts';
import { heldProfileDir, launchBrowser } from '../browser/launcher.ts';
import { hasLoginCookies, scopeToProvider, type OriginStorage, type SessionStore, type StoredSession } from './session-store.ts';
import type { AuthSpec } from './specs.ts';

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 2000;
const SETTLE_MS = 3000; // let the site finish setting its cookies after login

/**
 * Reads cookies plus localStorage of the provider's already-open tabs.
 * We deliberately avoid `context.storageState()`: it opens hidden helper tabs to read
 * localStorage, which flash open and closed in the visible login window.
 */
async function readState(ctx: BrowserContext, page: Page, spec: AuthSpec, account: string): Promise<StoredSession> {
  const cookies = await ctx.cookies();
  const origins: OriginStorage[] = [];
  for (const p of ctx.pages()) {
    let origin: string;
    try { origin = new URL(p.url()).origin; } catch { continue; }
    if (origin === 'null' || origins.some((o) => o.origin === origin)) continue;
    const localStorage = await p
      .evaluate(() => Object.entries(window.localStorage).map(([name, value]) => ({ name, value })))
      .catch(() => null);
    if (localStorage) origins.push({ origin, localStorage });
  }
  const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => '');
  return scopeToProvider(spec, account, { cookies: cookies as Cookie[], origins }, userAgent);
}

async function clearProviderCookies(ctx: BrowserContext, spec: AuthSpec): Promise<void> {
  for (const d of spec.domains) {
    await ctx.clearCookies({ domain: new RegExp(`(^|\\.)${d.replace(/\./g, '\\.')}$`) });
  }
}

/**
 * Opens a visible browser window, waits until the user has logged in, saves the
 * session and closes the browser completely so no RAM stays in use.
 *
 * The provider's cookies are cleared from the login profile before, so the user always sees a fresh login page.
 *
 * With `session.hold_in_browser` (default) each account logs in with its own profile, and that profile keeps the
 * login afterwards: the gateway later reopens it for requests and keep-alive, like a person reopening their browser.
 * Without it, the shared login profile is cleared again after login (so it can never rotate cookies behind our back
 * and invalidate the saved copy). Only our own profiles are touched, never the user's real browser.
 */
export async function interactiveLogin(
  spec: AuthSpec,
  account: string,
  config: Config,
  store: SessionStore,
  keepUntil: number | null,
): Promise<StoredSession> {
  const held = config.session.holdInBrowser;
  const profile = held ? heldProfileDir(config.dataDir, spec.id, account) : undefined;
  // A new login may take over a profile another browser made: its old cookies are cleared below anyway.
  const ctx = await launchBrowser(config.browser, config.dataDir, { headless: false, profile, adoptProfile: true });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    await clearProviderCookies(ctx, spec);
    await page.goto(spec.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    console.log(`\nA browser window opened for ${spec.name} (account "${account}").`);
    console.log('Log in there. Login is detected automatically; you can also press Enter when done.\n');

    const found = await new Promise<StoredSession>((resolve, reject) => {
      let finished = false;
      const done = (fn: () => void) => { if (!finished) { finished = true; clearInterval(poll); clearTimeout(timer); fn(); } };

      const check = async (manual: boolean) => {
        try {
          const s = await readState(ctx, page, spec, account);
          if (hasLoginCookies(spec, s)) {
            await new Promise((r) => setTimeout(r, SETTLE_MS));
            const settled = await readState(ctx, page, spec, account);
            done(() => resolve(settled));
          } else if (manual) {
            console.log('Not logged in yet. Finish logging in, then press Enter again.');
          }
        } catch { /* page navigating; retry on next poll */ }
      };

      const poll = setInterval(() => void check(false), POLL_MS);
      const timer = setTimeout(() => done(() => reject(new Error('Login timed out after 10 minutes'))), LOGIN_TIMEOUT_MS);
      rl.on('line', () => void check(true));
      ctx.on('close', () => done(() => reject(new Error('Browser was closed before the login was detected'))));
    });

    const session: StoredSession = { ...found, keepUntil, ...(held ? { held: true } : {}) };
    store.save(session);
    if (!held) await clearProviderCookies(ctx, spec).catch(() => {});
    return session;
  } finally {
    rl.close();
    await ctx.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Import cookies exported from the user's normal browser (fallback for sites
// that block logins in automated browsers). Accepts Cookie-Editor / EditThisCookie
// JSON arrays and Playwright storageState files.
// ---------------------------------------------------------------------------
function normalizeSameSite(v: unknown): Cookie['sameSite'] {
  const s = String(v ?? '').toLowerCase();
  if (s === 'strict') return 'Strict';
  if (s === 'none' || s === 'no_restriction') return 'None';
  return 'Lax';
}

function normalizeCookie(c: any): Cookie {
  const expires = c.expires ?? c.expirationDate;
  return {
    name: String(c.name),
    value: String(c.value),
    domain: String(c.domain),
    path: String(c.path ?? '/'),
    expires: typeof expires === 'number' && expires > 0 && !c.session ? expires : -1,
    httpOnly: Boolean(c.httpOnly),
    secure: Boolean(c.secure),
    sameSite: normalizeSameSite(c.sameSite),
  };
}

export function importSession(
  spec: AuthSpec,
  account: string,
  file: string,
  userAgent: string,
  store: SessionStore,
  keepUntil: number | null,
): StoredSession {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${(err as Error).message}`);
  }
  const cookies = (Array.isArray(raw) ? raw : raw?.cookies ?? []).filter((c: any) => c?.name && c?.domain).map(normalizeCookie);
  const origins: OriginStorage[] = Array.isArray(raw?.origins) ? raw.origins : [];
  const session: StoredSession = { ...scopeToProvider(spec, account, { cookies, origins }, userAgent), keepUntil };
  if (!hasLoginCookies(spec, session)) {
    const need = [...(spec.cookies ?? []), ...(spec.localStorage?.keys ?? [])].join(', ');
    throw new Error(`The file has no valid login for ${spec.name} (expected: ${need}). Export cookies while logged in.`);
  }
  store.save(session);
  return session;
}

/**
 * Removes the stored session of one account. The login profile's cookies for the provider
 * are cleared too, so the next `bridge login` starts from a clean login page.
 */
export async function logout(spec: AuthSpec, account: string, config: Config, store: SessionStore): Promise<boolean> {
  const removed = store.delete(spec.id, account);
  // The account's own profile holds the live login: remove it entirely.
  try { rmSync(heldProfileDir(config.dataDir, spec.id, account), { recursive: true, force: true }); } catch { /* in use: removed on next login */ }
  const ctx = await launchBrowser(config.browser, config.dataDir, { headless: true }).catch(() => null);
  if (ctx) {
    try { await clearProviderCookies(ctx, spec); } finally { await ctx.close().catch(() => {}); }
  }
  return removed;
}
