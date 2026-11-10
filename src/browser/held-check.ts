import type { BrowserCheck } from '../auth/session-service.ts';
import type { BrowserManager } from './manager.ts';

/** Time the page stays open after loading, so its own scripts can refresh the login cookies like an open tab. */
const SETTLE_MS = 6000;

/**
 * Cloudflare's challenge page; seeing it means "could not tell", never "logged out". Normal pages also load a
 * script from /cdn-cgi/challenge-platform/, so only markers of the interstitial page itself count.
 */
const CHALLENGE = /<title>\s*Just a moment\.\.\.\s*<\/title>|window\._cf_chl_opt|id="challenge-form"/i;

/**
 * Login check and keep-alive for a held login: opens the provider's page in the account's own profile, as a
 * person reopening the tab would, and reports whether the page shows the logged-in state. With `verify.inPage`
 * the page then fetches the provider's own API (as its scripts do) and the marker is looked for in that answer.
 * Throws when the answer is inconclusive (network error, timeout, 5xx, a bot challenge), so a flaky moment never
 * marks a good login dead.
 */
export function browserLoginCheck(manager: BrowserManager): BrowserCheck {
  return (spec, session) => manager.withPage(session, async (page, context) => {
    const res = await page.goto(spec.homeUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const status = res?.status() ?? 0;
    if (status === 429 || status >= 500) throw new Error(`${spec.name} answered HTTP ${status} in the browser`);
    await page.waitForTimeout(SETTLE_MS);
    let html = '';
    for (let i = 0; i < 3 && !html; i++) {
      html = await page.content().catch(() => '');
      if (!html) await page.waitForTimeout(1000); // still navigating
    }
    if (!html) throw new Error('the page did not settle');
    const at = new URL(page.url());
    const v = spec.verify;
    if (v?.inPage && CHALLENGE.test(html)) throw new Error(`${spec.name} showed a bot check instead of its page`);

    if (v?.inPage) {
      const api = await page.evaluate(async (url) => {
        const r = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
        return { status: r.status, text: await r.text() };
      }, v.url);
      const path = new URL(v.url).pathname;
      if (api.status === 200) {
        const ok = new RegExp(v.loggedIn).test(api.text);
        return { ok, cookies: await context.cookies(), why: ok ? `${path} HTTP 200, logged-in marker found` : `${path} HTTP 200 without the logged-in marker` };
      }
      if (CHALLENGE.test(api.text) || api.status === 429 || api.status >= 500) {
        throw new Error(`${path} answered HTTP ${api.status}${CHALLENGE.test(api.text) ? ' with a bot check' : ''}`);
      }
      if (api.status === 401 || api.status === 403) {
        return { ok: false, cookies: await context.cookies(), why: `${path} HTTP ${api.status} (page ${at.host}${at.pathname})` };
      }
      throw new Error(`${path} answered HTTP ${api.status}`);
    }

    const ok = v ? new RegExp(v.loggedIn).test(html) : true;
    return {
      ok,
      cookies: await context.cookies(),
      why: ok ? `HTTP ${status}, logged-in marker found` : `page ${at.host}${at.pathname} shows no logged-in marker`,
    };
  });
}
