// Several accounts of one provider, logged in and online at the same time: independent sessions, profiles,
// model ids, request queues and keep-alive. No real account or browser is used.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = new URL('../dist/', import.meta.url).href;
const { SessionStore, scopeToProvider, sessionKey } = await import(base + 'auth/session-store.js');
const { SessionService } = await import(base + 'auth/session-service.js');
const { AUTH_SPECS } = await import(base + 'auth/specs.js');
const { heldProfileDir } = await import(base + 'browser/launcher.js');
const { ClaudeProvider } = await import(base + 'providers/claude/index.js');
const { ProviderRegistry } = await import(base + 'providers/registry.js');

const dir = mkdtempSync(join(tmpdir(), 'wb-multi-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const ok = (name) => console.log(`  ok ${++n}. ${name}`);
const spec = AUTH_SPECS.claude;
const ck = (name, value) => ({ name, value, domain: '.claude.ai', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' });

// A store with two held Claude logins: "default" and "work".
const store = new SessionStore(mkdtempSync(join(dir, 's-')));
for (const account of ['default', 'work']) {
  const s = scopeToProvider(spec, account, { cookies: [ck('sessionKey', `sk-${account}`)], origins: [] }, 'UA');
  store.save({ ...s, held: true });
}
const sessions = new SessionService(store, { keepAlive: false, keepAliveInterval: 540, retention: null, holdInBrowser: true });

// 1: both accounts are saved side by side, each with its own key, profile and cookies
{
  assert.deepEqual(store.list('claude').map((s) => s.account).sort(), ['default', 'work']);
  assert.equal(sessionKey('claude', 'work'), 'claude@work');
  assert.notEqual(heldProfileDir(dir, 'claude', 'default'), heldProfileDir(dir, 'claude', 'work'));
  assert.equal(store.load('claude', 'work').cookies[0].value, 'sk-work');
  assert.equal(store.load('claude', 'default').cookies[0].value, 'sk-default');
  ok('two accounts of one provider are stored side by side, each with its own key, profile and cookies');
}

// 2: both are offered as distinct model ids; each resolves to its own account
{
  const r = new ProviderRegistry();
  r.add(new ClaudeProvider({ enabled: true }, { config: {}, sessions }, { async *send() {} }));
  const ids = r.models().map((m) => m.id);
  assert.ok(ids.includes('claude/sonnet'));       // the default account
  assert.ok(ids.includes('claude@work/sonnet'));  // the second account
  assert.equal(r.resolve('claude/sonnet').account, undefined);
  assert.equal(r.resolve('claude@work/sonnet').account, 'work');
  assert.equal(r.resolve('claude@work/haiku').localId, 'haiku');
  ok('each account appears as its own model id (claude/… and claude@work/…) and resolves to that account');
}

// 3: the two accounts run at the same time — a slow request on one does not block the other
{
  const gate = { default: null, work: null };
  const started = { default: false, work: false };
  const transport = {
    async *send(session, input) {
      const a = session.account;
      started[a] = true;
      await new Promise((r) => { gate[a] = r; });           // hold until released
      yield { type: 'chat', chat: `chat-${a}` };
      yield { type: 'message', uuid: `asst-${a}` };
      yield { type: 'text', text: `from ${a}` };
      yield { type: 'stop', reason: 'end_turn' };
    },
  };
  const provider = new ClaudeProvider({ enabled: true, min_interval: 0, jitter: 0 }, { config: {}, sessions }, transport);
  const collect = async (account) => {
    const out = [];
    const req = { stream: true, model: 'sonnet', account, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
    for await (const e of provider.chat(req, new AbortController().signal)) if (e.type === 'text') out.push(e.text);
    return out.join('');
  };
  const pDefault = collect('default');
  const pWork = collect('work');
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(started.default && started.work, 'both requests are in flight at once (neither account blocks the other)');
  gate.work();                                              // finish "work" first, out of order
  assert.equal(await pWork, 'from work');
  gate.default();
  assert.equal(await pDefault, 'from default');
  ok('both accounts answer concurrently; one account being busy does not queue the other');
}

// 4: keep-alive checks every saved account, each in its own profile
{
  const seen = [];
  sessions.setBrowserCheck(async (sp, s) => { seen.push(s.account); return { ok: true, why: 'marker found', cookies: s.cookies }; });
  for (const { provider, account } of store.list('claude')) {
    await sessions.refresh(AUTH_SPECS[provider], account, { rotate: false, verify: true });
  }
  assert.deepEqual(seen.sort(), ['default', 'work']);
  ok('keep-alive verifies each account separately (both logins stay online together)');
}

console.log(`multiaccount-test: ${n} passed`);
