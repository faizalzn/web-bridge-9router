// Logins held by their own browser profile: checks and keep-alive go through the browser, never plain HTTP.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = new URL('../dist/', import.meta.url).href;
const { SessionStore, scopeToProvider, sessionState } = await import(base + 'auth/session-store.js');
const { SessionService } = await import(base + 'auth/session-service.js');
const { AUTH_SPECS } = await import(base + 'auth/specs.js');
const { GeminiProvider } = await import(base + 'providers/gemini/index.js');
const { BridgeError } = await import(base + 'core/errors.js');
const { loadConfig } = await import(base + 'core/config.js');
const { heldProfileDir } = await import(base + 'browser/launcher.js');

const spec = AUTH_SPECS.gemini;
const dir = mkdtempSync(join(tmpdir(), 'wb-held-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const ok = (name) => console.log(`  ok ${++n}. ${name}`);

const ck = (name, value) => ({ name, value, domain: '.google.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'None' });
function fresh(held = true) {
  const store = new SessionStore(mkdtempSync(join(dir, 's-')));
  const s = scopeToProvider(spec, 'default', { cookies: [ck('__Secure-1PSID', 'p'), ck('__Secure-1PSIDTS', 'ts1')], origins: [] }, 'UA');
  store.save(held ? { ...s, held: true } : s);
  return { store, svc: new SessionService(store, { keepAlive: false, keepAliveInterval: 540, retention: null, holdInBrowser: true }) };
}

// 1: a held login is checked in the browser, and the profile's cookies become the saved copy
{
  const { store, svc } = fresh();
  const seen = [];
  svc.setBrowserCheck(async (sp, s) => { seen.push(s.held); return { ok: true, why: 'marker found', cookies: [ck('__Secure-1PSID', 'p'), ck('__Secure-1PSIDTS', 'ts2'), { ...ck('other', 'x'), domain: '.example.com' }] }; });
  const r = await svc.refresh(spec, 'default', { rotate: true, verify: true });
  assert.equal(r.ok, true); assert.equal(r.verified, true); assert.equal(r.rotated, true);
  assert.deepEqual(seen, [true]);
  assert.match(r.detail, /browser visit changed __Secure-1PSIDTS/);
  assert.doesNotMatch(r.detail, /rotation/);
  const saved = store.load('gemini');
  assert.equal(saved.held, true);
  assert.equal(saved.cookies.find((c) => c.name === '__Secure-1PSIDTS').value, 'ts2');
  assert.ok(!saved.cookies.some((c) => c.domain === '.example.com'));
  assert.equal(sessionState(spec, saved), 'ok');
  ok('held login: checked in its browser, no HTTP rotation, cookies of the profile saved (scoped)');
}

// 2: the browser sees the logged-out page -> dead
{
  const { store, svc } = fresh();
  svc.setBrowserCheck(async () => ({ ok: false, why: 'page gemini.google.com/app shows no logged-in marker', cookies: [ck('__Secure-1PSID', 'p')] }));
  const r = await svc.refresh(spec, 'default', { rotate: true, verify: true });
  assert.equal(r.ok, false);
  assert.match(r.detail, /login check failed \(page gemini\.google\.com\/app/);
  assert.equal(sessionState(spec, store.load('gemini')), 'dead');
  ok('held login: logged-out page in the browser marks the session dead');
}

// 3: no browser available, or the browser check is inconclusive -> nothing is decided, nothing over HTTP
{
  const { store, svc } = fresh();
  const r = await svc.refresh(spec, 'default', { rotate: true, verify: true });
  assert.equal(r.ok, null); assert.equal(r.verified, false);
  assert.match(r.detail, /inconclusive: this login lives in a browser profile/);
  assert.equal(sessionState(spec, store.load('gemini')), 'unverified');
  svc.setBrowserCheck(async () => { throw new Error('page.goto: Timeout 45000ms exceeded'); });
  const r2 = await svc.refresh(spec, 'default', { rotate: true, verify: true });
  assert.equal(r2.ok, null); assert.match(r2.detail, /inconclusive: page\.goto: Timeout/);
  assert.equal(store.load('gemini').cookies.find((c) => c.name === '__Secure-1PSIDTS').value, 'ts1');
  ok('held login: no browser or a timeout is inconclusive and leaves the session untouched');
}

// 4: a copied login never calls the browser check
{
  const { svc } = fresh(false);
  let called = false;
  svc.setBrowserCheck(async () => { called = true; return { ok: true, why: '', cookies: [] }; });
  await svc.refresh(spec, 'default', { rotate: false, verify: false });
  assert.equal(called, false);
  ok('copied login: the browser check is never used');
}

// 5-6: the provider never uses plain HTTP (mode A) for a held login
{
  const { svc } = fresh();
  const config = { browser: { channel: 'auto', executablePath: '', idleTimeout: 10, blockResources: [], heldHeadless: true } };
  const calls = [];
  const fake = (mode) => ({ mode, async *generate() { calls.push(mode); yield { text: 'from ' + mode, conv: { cid: 'c', rid: 'r', rcid: 'rc' } }; } });
  const make = (opts = {}) => {
    const p = new GeminiProvider({ enabled: true, min_interval: 0, jitter: 0, ...opts }, { config, sessions: svc });
    p.transports.set('A', fake('A')); p.transports.set('B', fake('B'));
    return p;
  };
  const chat = async (p) => {
    let t = '';
    const req = { model: 'pro', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], stream: false };
    for await (const e of p.chat(req, new AbortController().signal)) if (e.type === 'text') t += e.text;
    return t;
  };
  assert.equal(await chat(make()), 'from B');
  assert.deepEqual(calls, ['B']);
  ok('provider: a held login skips mode A and is answered by mode B');

  await assert.rejects(chat(make({ mode: 'A' })), (e) => e instanceof BridgeError && e.kind === 'unavailable' && /mode A cannot use a login held/.test(e.message));
  const st = await make().status();
  assert.match(st.detail, /held by its browser profile/);
  ok('provider: mode A forced on a held login gives a clear error; status says the login is held');
}

// 7: config defaults and profile path
{
  const cfgFile = join(dir, 'c.yaml');
  writeFileSync(cfgFile, 'data_dir: ./d\n');
  let c = loadConfig(cfgFile);
  assert.equal(c.session.holdInBrowser, true); assert.equal(c.browser.heldHeadless, true);
  writeFileSync(cfgFile, 'session:\n  hold_in_browser: false\nbrowser:\n  held_headless: false\n');
  c = loadConfig(cfgFile);
  assert.equal(c.session.holdInBrowser, false); assert.equal(c.browser.heldHeadless, false);
  assert.equal(heldProfileDir(join('x', 'data'), 'gemini', 'work'), join('x', 'data', 'profiles', 'gemini-work'));
  ok('config: hold_in_browser and held_headless default to true; one profile per account');
}
console.log(`held-test: ${n} passed`);
