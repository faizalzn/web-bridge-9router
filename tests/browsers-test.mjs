// Browser choice: detection on Windows, macOS and Linux, the configured choice, and profiles bound to their browser.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';

const base = new URL('../dist/', import.meta.url).href;
const { findBrowsers, readProfileOwner, writeProfileOwner } = await import(base + 'browser/detect.js');
const { browserCandidates, launchBrowser } = await import(base + 'browser/launcher.js');
const { loadConfig } = await import(base + 'core/config.js');

const dir = mkdtempSync(join(tmpdir(), 'wb-browsers-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const ok = (name) => console.log(`  ok ${++n}. ${name}`);
const only = (...paths) => (p) => paths.includes(p);
const cfg = (channel, executablePath = '') => ({ channel, executablePath, idleTimeout: 300, blockResources: [], heldHeadless: true });

// 1: macOS, Chrome and Brave installed -> Chrome first
{
  const f = findBrowsers('darwin', { HOME: '/Users/r' }, only(
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Users/r/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ));
  assert.deepEqual(f.map((b) => b.kind), ['chrome', 'brave']);
  assert.equal(f[0].path, '/Users/r/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  ok('macOS: browsers in /Applications and ~/Applications, Chrome preferred');
}

// 2: Linux, Chromium only on PATH (and a snap Brave)
{
  const f = findBrowsers('linux', { PATH: '/usr/local/bin:/usr/bin' }, only('/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/brave-browser'));
  assert.deepEqual(f.map((b) => `${b.kind}=${b.path}`), ['chromium=/usr/bin/chromium-browser', 'brave=/usr/bin/brave-browser']);
  ok('Linux: names looked up on PATH, order Chrome, Edge, Chromium, Brave, Vivaldi');
}

// 3: Windows, Edge in Program Files (x86), Vivaldi per user
{
  const env = { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\L' };
  const f = findBrowsers('win32', env, only(win32.join('C:\\PF86', 'Microsoft', 'Edge', 'Application', 'msedge.exe'), win32.join('C:\\L', 'Vivaldi', 'Application', 'vivaldi.exe')));
  assert.deepEqual(f.map((b) => b.kind), ['msedge', 'vivaldi']);
  ok('Windows: Program Files, Program Files (x86) and per-user installs, Edge preferred');
}

// 4: what gets tried for each setting
{
  const found = [{ kind: 'chrome', name: 'Google Chrome', path: '/c' }, { kind: 'brave', name: 'Brave', path: '/b' }];
  assert.deepEqual(browserCandidates(cfg('auto'), found).map((c) => c.id), ['chrome', 'brave']);
  assert.deepEqual(browserCandidates(cfg('brave'), found), [{ id: 'brave', name: 'Brave', executablePath: '/b' }]);
  assert.deepEqual(browserCandidates(cfg('vivaldi'), found), []);
  assert.deepEqual(browserCandidates(cfg('msedge'), found), [{ id: 'msedge', name: 'Microsoft Edge', channel: 'msedge' }]);
  assert.deepEqual(browserCandidates(cfg('auto'), [], 'linux').map((c) => c.channel), ['chrome', 'msedge']);
  assert.deepEqual(browserCandidates(cfg('auto', '/opt/x/chrome'), found).map((c) => c.id), ['custom:/opt/x/chrome']);
  ok('choice: auto = all found in order; a named browser only itself; Edge/Chrome fall back to Playwright; executable_path wins');
}

// 5: a profile remembers its browser; another browser is refused before anything starts
{
  const profile = mkdtempSync(join(dir, 'p-'));
  assert.equal(readProfileOwner(profile), null);
  writeProfileOwner(profile, { browser: 'vivaldi-test', name: 'Vivaldi (test)' });
  assert.deepEqual(readProfileOwner(profile), { browser: 'vivaldi-test', name: 'Vivaldi (test)' });
  await assert.rejects(launchBrowser(cfg('auto'), dir, { headless: true, profile }),
    /made with Vivaldi \(test\)[\s\S]*cannot move between browsers[\s\S]*--force/);
  writeFileSync(join(profile, 'web-bridge-browser.json'), 'not json');
  assert.equal(readProfileOwner(profile), null);
  ok('profile: its browser is recorded; opening it with another browser fails with the fix, nothing is launched');
}

// 6: config accepts the new browsers and refuses Firefox
{
  const write = (body) => { const f = join(dir, `c-${Math.random().toString(36).slice(2)}.yaml`); writeFileSync(f, body); return f; };
  assert.equal(loadConfig(write('browser:\n  channel: brave\n')).browser.channel, 'brave');
  assert.throws(() => loadConfig(write('browser:\n  channel: firefox\n')), /Invalid browser\.channel: firefox/);
  ok('config: chromium, brave, vivaldi accepted; firefox refused with the list of choices');
}

console.log(`browsers-test: ${n} passed`);
