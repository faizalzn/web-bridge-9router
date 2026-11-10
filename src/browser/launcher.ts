import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import type { BrowserConfig } from '../core/config.ts';
import { BROWSER_NAMES, findBrowsers, readProfileOwner, writeProfileOwner, type BrowserKind, type FoundBrowser } from './detect.ts';

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
  /** Login only: the profile may be taken over by the configured browser even if another browser made it. */
  adoptProfile?: boolean;
}

/** Thrown when another process (gateway or `bridge login`) already uses the browser profile. */
export class ProfileInUseError extends Error {
  constructor() {
    super('The browser profile is in use by another web-bridge process. Close the other browser window or wait for it to finish.');
    this.name = 'ProfileInUseError';
  }
}

/** One way to start a browser: a found executable, or a channel name Playwright looks up itself. */
export interface BrowserCandidate { id: string; name: string; channel?: string; executablePath?: string }

/** Browsers to try, in order, for the configured `browser.channel` / `browser.executable_path`. */
export function browserCandidates(cfg: BrowserConfig, found: FoundBrowser[] = findBrowsers(), platform: string = process.platform): BrowserCandidate[] {
  if (cfg.executablePath) return [{ id: 'custom:' + cfg.executablePath, name: cfg.executablePath, executablePath: cfg.executablePath }];
  const fromFound = (b: FoundBrowser): BrowserCandidate => ({ id: b.kind, name: b.name, executablePath: b.path });
  // Chrome and Edge can also be found by Playwright itself (it knows more install locations).
  const byChannel = (kind: string): BrowserCandidate[] => (kind === 'msedge' || kind === 'chrome'
    ? [{ id: kind, name: BROWSER_NAMES[kind], channel: kind }] : []);
  if (cfg.channel !== 'auto') {
    const b = found.find((f) => f.kind === cfg.channel);
    return b ? [fromFound(b)] : byChannel(cfg.channel);
  }
  if (found.length) return found.map(fromFound);
  return (platform === 'win32' ? ['msedge', 'chrome'] : ['chrome', 'msedge']).flatMap(byChannel);
}

const COMMON_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-sync',
];

async function tryCandidates<T>(cfg: BrowserConfig, candidates: BrowserCandidate[], launch: (c: BrowserCandidate) => Promise<T>): Promise<{ value: T; used: BrowserCandidate }> {
  const errors: string[] = [];
  for (const c of candidates) {
    try {
      return { value: await launch(c), used: c };
    } catch (err) {
      const msg = (err as Error).message;
      if (/ProcessSingleton|already in use|SingletonLock|profile.*(in use|locked)/i.test(msg)) throw new ProfileInUseError();
      errors.push(`${c.name}: ${msg.split('\n')[0]}`);
    }
  }
  const wanted = cfg.executablePath ? cfg.executablePath : cfg.channel === 'auto' ? '' : (BROWSER_NAMES[cfg.channel as BrowserKind] ?? cfg.channel);
  throw new Error(
    (wanted ? `Could not start ${wanted}${candidates.length ? '' : ' (not found on this computer)'}. ` : 'Could not start a browser. ')
    + 'Install Microsoft Edge, Google Chrome, Chromium, Brave or Vivaldi, set browser.channel, or set browser.executable_path in config.yaml. '
    + 'Run "bridge browsers" to see what was found.'
    + (errors.length ? `\n  ${errors.join('\n  ')}` : ''),
  );
}

/**
 * Launches the installed Chromium-based browser (see browserCandidates) with our own login profile, never the user's real one.
 * Used for interactive login. Automation flags are removed because Google refuses logins from
 * browsers that announce automation.
 */
export async function launchBrowser(cfg: BrowserConfig, dataDir: string, opts: LaunchOptions): Promise<BrowserContext> {
  const profile = opts.profile ?? profileDir(dataDir);
  let candidates = browserCandidates(cfg);
  const owner = readProfileOwner(profile);
  if (owner && !opts.adoptProfile) {
    const same = candidates.filter((c) => c.id === owner.browser);
    if (!same.length) {
      throw new Error(`The login profile ${profile} was made with ${owner.name}, `
        + (cfg.channel === 'auto' && !cfg.executablePath ? 'which was not found now' : 'but config.yaml now chooses another browser')
        + '. A profile cannot move between browsers (its cookies are encrypted for the browser that made it). '
        + `Set browser.channel back to ${owner.browser.startsWith('custom:') ? 'the same executable_path' : owner.browser}, or log in again with --force.`);
    }
    candidates = same;
  }
  const { value, used } = await tryCandidates(cfg, candidates, (c) =>
    chromium.launchPersistentContext(profile, {
      channel: c.channel,
      executablePath: c.executablePath,
      headless: opts.headless,
      userAgent: opts.userAgent || undefined,
      viewport: opts.headless ? { width: 1280, height: 800 } : null,
      ignoreDefaultArgs: ['--enable-automation'],
      args: opts.offscreen ? [...COMMON_ARGS, '--window-position=-32000,-32000', '--window-size=1280,800'] : COMMON_ARGS,
    }));
  if (owner?.browser !== used.id) writeProfileOwner(profile, { browser: used.id, name: used.name });
  return value;
}

/**
 * Launches a headless browser without a profile on disk. Each account gets its own
 * in-memory context built from its saved session, so accounts never share cookies.
 */
export async function launchHeadless(cfg: BrowserConfig): Promise<Browser> {
  const { value } = await tryCandidates(cfg, browserCandidates(cfg), (c) =>
    chromium.launch({
      channel: c.channel,
      executablePath: c.executablePath,
      headless: true,
      ignoreDefaultArgs: ['--enable-automation'],
      args: COMMON_ARGS,
    }));
  return value;
}
