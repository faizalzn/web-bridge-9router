import type { BrowserCheck } from '../auth/session-service.ts';
import type { BrowserManager } from './manager.ts';

/** Time the page stays open after loading, so its own scripts can refresh the login cookies like an open tab. */
const SETTLE_MS = 6000;

/**
 * Login check and keep-alive for a held login: opens the provider's page in the account's own profile, as a
 * person reopening the tab would, and reports whether the page shows the logged-in state.
 * Throws when the answer is inconclusive (network error, timeout, 5xx), so a flaky moment never marks a good login dead.
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
    const ok = spec.verify ? new RegExp(spec.verify.loggedIn).test(html) : true;
    return {
      ok,
      cookies: await context.cookies(),
      why: ok ? `HTTP ${status}, logged-in marker found` : `page ${at.host}${at.pathname} shows no logged-in marker`,
    };
  });
}
