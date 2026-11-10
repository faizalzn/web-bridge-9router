// Finds the Chromium-based browsers installed on Windows, macOS and Linux, so the gateway can drive whichever one
// the user has. Firefox and Safari are not supported: Playwright can only drive its own patched builds of them.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';

export const BROWSER_KINDS = ['msedge', 'chrome', 'chromium', 'brave', 'vivaldi'] as const;
export type BrowserKind = (typeof BROWSER_KINDS)[number];

export const BROWSER_NAMES: Record<BrowserKind, string> = {
  msedge: 'Microsoft Edge', chrome: 'Google Chrome', chromium: 'Chromium', brave: 'Brave', vivaldi: 'Vivaldi',
};

/** Preferred order when browser.channel is "auto". */
export const AUTO_ORDER: Record<string, BrowserKind[]> = {
  win32: ['msedge', 'chrome', 'brave', 'vivaldi', 'chromium'],
  darwin: ['chrome', 'msedge', 'brave', 'vivaldi', 'chromium'],
  linux: ['chrome', 'msedge', 'chromium', 'brave', 'vivaldi'],
};

export interface FoundBrowser { kind: BrowserKind; name: string; path: string }

type Env = Record<string, string | undefined>;

/** Where each browser usually lives. Bare names are looked up on PATH (Linux). */
export function knownLocations(platform: string, env: Env): Record<BrowserKind, string[]> {
  if (platform === 'win32') {
    const pf = env.ProgramFiles ?? 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const local = env.LOCALAPPDATA ?? '';
    const roots = [pf, pf86, local].filter(Boolean);
    const under = (...rel: string[]) => roots.map((r) => win32.join(r, ...rel));
    return {
      msedge: under('Microsoft', 'Edge', 'Application', 'msedge.exe'),
      chrome: under('Google', 'Chrome', 'Application', 'chrome.exe'),
      chromium: under('Chromium', 'Application', 'chrome.exe'),
      brave: under('BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      vivaldi: under('Vivaldi', 'Application', 'vivaldi.exe'),
    };
  }
  if (platform === 'darwin') {
    const apps = ['/Applications', env.HOME ? posix.join(env.HOME, 'Applications') : ''].filter(Boolean);
    const app = (bundle: string, bin: string) => apps.map((a) => `${a}/${bundle}.app/Contents/MacOS/${bin}`);
    return {
      msedge: app('Microsoft Edge', 'Microsoft Edge'),
      chrome: app('Google Chrome', 'Google Chrome'),
      chromium: app('Chromium', 'Chromium'),
      brave: app('Brave Browser', 'Brave Browser'),
      vivaldi: app('Vivaldi', 'Vivaldi'),
    };
  }
  return {
    msedge: ['/opt/microsoft/msedge/msedge', 'microsoft-edge', 'microsoft-edge-stable'],
    chrome: ['/opt/google/chrome/chrome', 'google-chrome', 'google-chrome-stable'],
    chromium: ['chromium', 'chromium-browser', '/snap/bin/chromium'],
    brave: ['/opt/brave.com/brave/brave', 'brave-browser', 'brave'],
    vivaldi: ['/opt/vivaldi/vivaldi', 'vivaldi-stable', 'vivaldi'],
  };
}

function resolveOnPath(name: string, env: Env, exists: (p: string) => boolean): string | null {
  // Only used on Linux and macOS, so POSIX paths even when the tests run on Windows.
  for (const dir of (env.PATH ?? '').split(':')) {
    if (dir && exists(posix.join(dir, name))) return posix.join(dir, name);
  }
  return null;
}

/** Installed browsers, in the preferred order for this platform. */
export function findBrowsers(platform: string = process.platform, env: Env = process.env, exists: (p: string) => boolean = existsSync): FoundBrowser[] {
  const where = knownLocations(platform, env);
  const order = AUTO_ORDER[platform] ?? AUTO_ORDER.linux!;
  const out: FoundBrowser[] = [];
  for (const kind of order) {
    for (const loc of where[kind]) {
      const path = loc.includes('/') || loc.includes('\\') ? (exists(loc) ? loc : null) : resolveOnPath(loc, env, exists);
      if (path) { out.push({ kind, name: BROWSER_NAMES[kind], path }); break; }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Which browser a profile belongs to. A profile made by one browser cannot be used by another: on Windows and macOS
// its cookies are encrypted with a key that belongs to that browser, so the login would silently be gone.

const MARKER = 'web-bridge-browser.json';

export interface ProfileOwner { browser: string; name: string }

export function readProfileOwner(profile: string): ProfileOwner | null {
  try {
    const j = JSON.parse(readFileSync(join(profile, MARKER), 'utf8'));
    return typeof j?.browser === 'string' ? { browser: j.browser, name: String(j.name ?? j.browser) } : null;
  } catch { return null; }
}

export function writeProfileOwner(profile: string, owner: ProfileOwner): void {
  try { writeFileSync(join(profile, MARKER), JSON.stringify(owner) + '\n'); } catch { /* best effort */ }
}
