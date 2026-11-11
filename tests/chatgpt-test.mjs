// ChatGPT (chatgpt.com web, mode C) provider, with a fake page transport. No real account or browser is used.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = new URL('../dist/', import.meta.url).href;
const { ChatGPTProvider } = await import(base + 'providers/chatgpt/index.js');
const { ChatGPTError } = await import(base + 'providers/chatgpt/dom.js');
const { SessionStore, scopeToProvider } = await import(base + 'auth/session-store.js');
const { SessionService } = await import(base + 'auth/session-service.js');
const { AUTH_SPECS } = await import(base + 'auth/specs.js');
const { BridgeError } = await import(base + 'core/errors.js');
const { ProviderRegistry } = await import(base + 'providers/registry.js');

const dir = mkdtempSync(join(tmpdir(), 'wb-chatgpt-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const ok = (name) => console.log(`  ok ${++n}. ${name}`);
const spec = AUTH_SPECS.chatgpt;
const ck = (name, value) => ({ name, value, domain: '.chatgpt.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' });

function deps({ held = true } = {}) {
  const store = new SessionStore(mkdtempSync(join(dir, 's-')));
  const s = scopeToProvider(spec, 'default', { cookies: [ck('__Secure-next-auth.session-token', 't')], origins: [] }, 'UA');
  store.save(held ? { ...s, held: true } : s);
  return { sessions: new SessionService(store, { keepAlive: false, keepAliveInterval: 540, retention: null, holdInBrowser: true }), config: {} };
}
/** Fake page transport: yields cumulative text chunks from a script, records prompts. */
function fake(script) {
  const calls = [];
  return {
    calls,
    async *send(session, input) {
      calls.push({ prompt: input.prompt, account: session.account });
      const step = script[calls.length - 1];
      if (step instanceof Error) throw step;
      for (const t of step) yield { text: t };     // cumulative snapshots, as the DOM grows
    },
  };
}
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
async function run(provider, req) {
  const events = [];
  for await (const e of provider.chat({ stream: true, model: 'auto', ...req }, new AbortController().signal)) events.push(e);
  return events;
}

// 1: cumulative page snapshots become clean deltas; every request is a fresh chat with the whole prompt
{
  const t = fake([['Hey', 'Hey! How', 'Hey! How are you?']]);
  const p = new ChatGPTProvider({ enabled: true, min_interval: 0, jitter: 0 }, deps(), t);
  const e = await run(p, { system: 'Be nice.', messages: [user('hey chat')] });
  assert.equal(e.filter((x) => x.type === 'text').map((x) => x.text).join(''), 'Hey! How are you?');
  assert.deepEqual(e.at(-1), { type: 'done', stopReason: 'stop' });
  assert.match(t.calls[0].prompt, /Be nice\.[\s\S]*hey chat/);
  ok('mode C: cumulative page text becomes deltas; the system prompt and message are typed as one fresh chat');
}

// 2: only one model id, and it is the default
{
  const r = new ProviderRegistry();
  r.add(new ChatGPTProvider({ enabled: true }, deps(), fake([])));
  assert.deepEqual(r.models().map((m) => m.id), ['chatgpt/auto']);
  assert.equal(r.resolve('chatgpt').localId, 'auto');
  await assert.rejects(run(new ChatGPTProvider({ enabled: true, min_interval: 0, jitter: 0 }, deps(), fake([])), { model: 'gpt-5', messages: [user('x')] }),
    (e) => e instanceof BridgeError && e.status === 404);
  ok('registry: only chatgpt/auto is offered; another model id is a 404');
}

// 3: a Cloudflare bot check pauses the account; a retry is answered from the pause without reopening the page
{
  const t = fake([new ChatGPTError('blocked', 'chatgpt.com answered with a Cloudflare bot check'), ['never']]);
  const p = new ChatGPTProvider({ enabled: true, min_interval: 0, jitter: 0 }, deps(), t);
  await assert.rejects(run(p, { messages: [user('x')] }), (e) => e instanceof BridgeError && e.status === 503 && /Cloudflare[\s\S]*paused until/.test(e.message));
  await assert.rejects(run(p, { messages: [user('x')] }), (e) => e instanceof BridgeError && e.status === 503 && /paused until/.test(e.message));
  assert.equal(t.calls.length, 1);
  assert.match((await p.status()).detail, /PAUSED after a Cloudflare bot check/);
  ok('a bot check pauses the account (503); retries are answered from the pause, the page is not reopened');
}

// 4: login not held -> 401 before anything is typed; an auth error from the page -> 401 with the fix
{
  const t = fake([new ChatGPTError('auth', 'login page shown')]);
  await assert.rejects(run(new ChatGPTProvider({ enabled: true, min_interval: 0, jitter: 0 }, deps({ held: false }), fake([['x']])), { messages: [user('x')] }),
    (e) => e instanceof BridgeError && e.status === 401 && /hold_in_browser/.test(e.message));
  await assert.rejects(run(new ChatGPTProvider({ enabled: true, min_interval: 0, jitter: 0 }, deps(), t), { messages: [user('x')] }),
    (e) => e instanceof BridgeError && e.status === 401 && /bridge login chatgpt.*--force/.test(e.message));
  ok('login not held -> 401 before typing; an auth error from the page -> 401 with the login fix');
}

console.log(`chatgpt-test: ${n} passed`);
