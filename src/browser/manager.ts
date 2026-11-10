import type { Browser, BrowserContext, Cookie, Page } from 'playwright-core';
import type { Config } from '../core/config.ts';
import { logger } from '../core/logger.ts';
import { sessionKey, type StoredSession } from '../auth/session-store.ts';
import { heldProfileDir, launchBrowser, launchHeadless } from './launcher.ts';

const FALLBACK_KEY = '__anonymous__';

interface ContextEntry { version: string; held: boolean; context: Promise<BrowserContext> }

/**
 * Background browser that only exists while it is needed:
 * - started on the first `withPage()` call,
 * - copied logins: one isolated in-memory context per account (cookies never mix between accounts),
 * - held logins (StoredSession.held): the account's own profile on disk, which keeps the live session,
 * - images/fonts/media are never downloaded,
 * - closed automatically after `browser.idle_timeout` seconds without work.
 */
export class BrowserManager {
  private readonly config: Config;
  private browser: Promise<Browser> | null = null;
  /** session key -> context and the session version it was built from. */
  private readonly contexts = new Map<string, ContextEntry>();
  private active = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(config: Config) {
    this.config = config;
  }

  get isRunning(): boolean { return this.browser !== null || this.contexts.size > 0; }

  /**
   * `persist` receives the context's cookies after `fn` ran. Page scripts rotate cookies (Google does it
   * on every visit), so callers must store them or the saved session goes stale.
   */
  async withPage<T>(
    session: StoredSession | null,
    fn: (page: Page, context: BrowserContext) => Promise<T>,
    persist?: (cookies: Cookie[]) => Promise<void> | void,
  ): Promise<T> {
    this.active++;
    this.clearIdle();
    let page: Page | null = null;
    let context: BrowserContext | null = null;
    try {
      context = await this.getContext(session);
      page = await context.newPage();
      return await fn(page, context);
    } finally {
      if (persist && context) {
        try { await persist(await context.cookies()); } catch (err) { logger.warn(`Could not store browser cookies: ${(err as Error).message}`); }
      }
      await page?.close().catch(() => {});
      this.active--;
      this.scheduleIdle();
    }
  }

  async close(): Promise<void> {
    this.clearIdle();
    const pending = this.browser;
    this.browser = null;
    const held = [...this.contexts.values()].filter((e) => e.held);
    this.contexts.clear();
    // Closing a held profile cleanly writes its cookies to disk.
    await Promise.allSettled(held.map(async (e) => (await e.context.catch(() => null))?.close()));
    if (pending) await (await pending.catch(() => null))?.close().catch(() => {});
  }

  private getBrowser(): Promise<Browser> {
    if (!this.browser) {
      const started = Date.now();
      const launching = launchHeadless(this.config.browser).then((b) => {
        b.on('disconnected', () => {
          if (this.browser === launching) {
            this.browser = null;
            for (const [k, e] of this.contexts) if (!e.held) this.contexts.delete(k);
          }
        });
        logger.info(`Background browser started (${Date.now() - started}ms)`);
        return b;
      });
      launching.catch(() => { if (this.browser === launching) this.browser = null; });
      this.browser = launching;
    }
    return this.browser;
  }

  private async getContext(session: StoredSession | null): Promise<BrowserContext> {
    const key = session ? sessionKey(session.provider, session.account) : FALLBACK_KEY;
    const held = session?.held === true;
    // A held profile follows its own cookies, so only a new login (createdAt) replaces it.
    const version = held ? `held:${session?.createdAt ?? ''}` : session?.savedAt ?? '';
    const existing = this.contexts.get(key);
    if (existing && existing.version === version) return existing.context;

    // Session changed (re-login / refreshed cookies): rebuild that account's context.
    if (existing) {
      this.contexts.delete(key);
      await existing.context.then((c) => c.close()).catch(() => {});
    }

    const context = held ? this.openHeld(session!) : this.getBrowser().then(async (browser) => {
      const ctx = await browser.newContext({
        // Same UA as the login browser, so the headless browser does not announce "HeadlessChrome".
        userAgent: session?.userAgent || undefined,
        viewport: { width: 1280, height: 800 },
        storageState: session ? { cookies: session.cookies, origins: session.origins } : undefined,
      });
      await this.blockResources(ctx);
      return ctx;
    });
    const entry: ContextEntry = { version, held, context };
    context.catch(() => { if (this.contexts.get(key) === entry) this.contexts.delete(key); });
    this.contexts.set(key, entry);
    return context;
  }

  /** Opens the account's own profile; its cookies are the live login, nothing is injected. */
  private async openHeld(session: StoredSession): Promise<BrowserContext> {
    const started = Date.now();
    const key = sessionKey(session.provider, session.account);
    const headless = this.config.browser.heldHeadless;
    const ctx = await launchBrowser(this.config.browser, this.config.dataDir, {
      headless,
      offscreen: !headless,
      userAgent: session.userAgent || undefined,
      profile: heldProfileDir(this.config.dataDir, session.provider, session.account),
    });
    ctx.on('close', () => {
      const e = this.contexts.get(key);
      if (e?.held) void e.context.then((c) => { if (c === ctx && this.contexts.get(key) === e) this.contexts.delete(key); });
    });
    await this.blockResources(ctx);
    logger.info(`Browser for ${key} started (login held in its own profile, ${Date.now() - started}ms)`);
    return ctx;
  }

  private async blockResources(ctx: BrowserContext): Promise<void> {
    const blocked = new Set<string>(this.config.browser.blockResources);
    if (blocked.size === 0) return;
    await ctx.route('**/*', (route) =>
      blocked.has(route.request().resourceType()) ? route.abort() : route.continue());
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private scheduleIdle(): void {
    if (this.active > 0 || !this.isRunning) return;
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      logger.info('Background browser idle, closing it to free memory');
      void this.close();
    }, this.config.browser.idleTimeout * 1000);
    this.idleTimer.unref();
  }
}
