import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import type { BrowserConfig } from '../core/config.ts';

export const profileDir = (dataDir: string) => join(dataDir, 'browser-profile');

/** Profile that keeps one account's login alive (see StoredSession.held). One per account, never shared. */
export const heldProfileDir = (dataDir: string, provider: string, account: string) =>
  join(dataDir, 'profiles', `${provider}-${account}`);

export interface LaunchOptions {
  headless: boolean;
  userAgent?: string;
  /** Profile directory; defaults to the shared login profile. */
  profile?: string;
  /** Visible browser placed off-screen (for a held login run without headless mode). */
  offscreen?: boolean;
}

/** Thrown when another process (gateway or `bridge login`) already uses the browser profile. */
export class ProfileInUseError extends Error {
  constructor() {
    super('The browser profile is in use by another web-bridge process. Close the other browser window or wait for it to finish.');
    this.name = 'ProfileInUseError';
  }
}

function channelsToTry(cfg: BrowserConfig): (string | undefined)[] {
  if (cfg.executablePath) return [undefined];
  if (cfg.channel !== 'auto') return [cfg.channel];
  return process.platform === 'win32' ? ['msedge', 'chrome'] : ['chrome', 'msedge'];
}

const COMMON_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-sync',
];

async function tryChannels<T>(cfg: BrowserConfig, launch: (channel: string | undefined) => Promise<T>): Promise<T> {
  const errors: string[] = [];
  for (const channel of channelsToTry(cfg)) {
    try {
      return await launch(channel);
    } catch (err) {
      const msg = (err as Error).message;
      if (/ProcessSingleton|already in use|SingletonLock|profile.*(in use|locked)/i.test(msg)) throw new ProfileInUseError();
      errors.push(`${channel ?? cfg.executablePath}: ${msg.split('\n')[0]}`);
    }
  }
  throw new Error(
    `Could not start a browser. Install Microsoft Edge or Google Chrome, or set browser.executable_path in config.yaml.\n  ${errors.join('\n  ')}`,
  );
}

/**
 * Launches the user's installed Edge/Chrome with our own login profile (never the user's real one).
 * Used for interactive login. Automation flags are removed because Google refuses logins from
 * browsers that announce automation.
 */
export function launchBrowser(cfg: BrowserConfig, dataDir: string, opts: LaunchOptions): Promise<BrowserContext> {
  return tryChannels(cfg, (channel) =>
    chromium.launchPersistentContext(opts.profile ?? profileDir(dataDir), {
      channel,
      executablePath: cfg.executablePath || undefined,
      headless: opts.headless,
      userAgent: opts.userAgent || undefined,
      viewport: opts.headless ? { width: 1280, height: 800 } : null,
      ignoreDefaultArgs: ['--enable-automation'],
      args: opts.offscreen ? [...COMMON_ARGS, '--window-position=-32000,-32000', '--window-size=1280,800'] : COMMON_ARGS,
    }));
}

/**
 * Launches a headless browser without a profile on disk. Each account gets its own
 * in-memory context built from its saved session, so accounts never share cookies.
 */
export function launchHeadless(cfg: BrowserConfig): Promise<Browser> {
  return tryChannels(cfg, (channel) =>
    chromium.launch({
      channel,
      executablePath: cfg.executablePath || undefined,
      headless: true,
      ignoreDefaultArgs: ['--enable-automation'],
      args: COMMON_ARGS,
    }));
}
