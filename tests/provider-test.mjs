import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = new URL('../dist/', import.meta.url).href;
const { SessionStore, scopeToProvider } = await import(base + 'auth/session-store.js');
const { SessionService } = await import(base + 'auth/session-service.js');
const { AUTH_SPECS } = await import(base + 'auth/specs.js');
const { GeminiProvider } = await import(base + 'providers/gemini/index.js');
const { GeminiError } = await import(base + 'providers/gemini/protocol.js');
const { BridgeError } = await import(base + 'core/errors.js');

const dir = mkdtempSync(join(tmpdir(), 'wb-test-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const store = new SessionStore(dir);
const cookie = { name: '__Secure-1PSID', value: 'x', domain: '.google.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'None' };
store.save(scopeToProvider(AUTH_SPECS.gemini, 'default', { cookies: [cookie], origins: [] }, ''));
const sessions = new SessionService(store, { keepAlive: false, keepAliveInterval: 540, retention: null });
const config = { browser: { channel: 'auto', executablePath: '', idleTimeout: 10, blockResources: [] } };

const msg = (role, text) => ({ role, content: [{ type: 'text', text }] });
const conv = (n) => ({ cid: `c_${n}`, rid: `r_${n}`, rcid: `rc_${n}` });
let n = 0;
const ok = (name) => console.log(`  ok ${++n}. ${name}`);

function fake(mode, calls, behavior) {
  return { mode, async *generate(ctx, req) { calls.push({ mode, prompt: req.prompt, conv: req.conv, model: req.modelId }); yield* behavior(req, calls.length); } };
}
const reply = (parts, c = conv(1)) => async function* () { for (const text of parts) yield { text, conv: c }; };
const fails = (err) => async function* () { throw err; };
const partialThenFail = (err) => async function* () { yield { text: 'Partial answer so far', conv: conv(1) }; throw err; };

function makeProvider(overrides = {}, opts = {}) {
  const p = new GeminiProvider({ enabled: true, min_interval: 0, jitter: 0, ...opts }, { config, sessions });
  for (const [mode, t] of Object.entries(overrides)) p.transports.set(mode, t);
  return p;
}
async function run(p, messages, extra = {}) {
  const events = [];
  for await (const e of p.chat({ model: 'flash-lite', messages, stream: false, ...extra }, new AbortController().signal)) events.push(e);
  return { events, text: events.filter((e) => e.type === 'text').map((e) => e.text).join('') };
}
const kindOf = async (promise) => { try { await promise; return 'no error'; } catch (e) { return e instanceof BridgeError ? e.kind : `other: ${e.message}`; } };

// 1 ------------------------------------------------------------------
{
  const calls = [];
  const p = makeProvider({ A: fake('A', calls, reply(['He', 'Hello', 'Hello\n\nhttp://googleusercontent.com/lmdx_content/abc'])) });
  const r = await run(p, [msg('user', 'hi')]);
  assert.equal(r.text, 'Hello');
  assert.equal(r.events.at(-1).type, 'done');
  assert.equal(calls.length, 1); assert.equal(calls[0].mode, 'A'); assert.equal(calls[0].prompt, 'hi'); assert.equal(calls[0].conv, null);
  ok('mode A answers; placeholder link is stripped; a plain question is sent untouched');

  // 2: history grew -> same web chat, only the new message is sent
  const r2 = await run(p, [msg('user', 'hi'), msg('assistant', 'Hello'), msg('user', 'and now?')]);
  assert.deepEqual(calls[1].conv, conv(1));
  assert.equal(calls[1].prompt, 'and now?');
  ok('a longer history continues the same chat and sends only the new message');

  // 2b: a different model never reuses that chat
  await run(p, [msg('user', 'hi'), msg('assistant', 'Hello'), msg('user', 'and now?')], { model: 'pro' });
  assert.equal(calls[2].conv, null); assert.ok(calls[2].prompt.includes('Conversation so far'));
  ok('another model starts its own chat');
}

// 3 ------------------------------------------------------------------
{
  const calls = [];
  const p = makeProvider({
    A: fake('A', calls, fails(new GeminiError('protocol', 'HTTP 404'))),
    B: fake('B', calls, reply(['from B'])),
  });
  const r = await run(p, [msg('user', 'q')]);
  assert.equal(r.text, 'from B');
  assert.deepEqual(calls.map((c) => c.mode), ['A', 'B']);
  assert.equal(p.switcher.describe('gemini:default').mode, 'B');
  ok('A breaks before any output -> the same request is answered by B, client sees no error');

  await run(p, [msg('user', 'q2')]);
  assert.deepEqual(calls.map((c) => c.mode), ['A', 'B', 'B']);
  ok('later requests go straight to B (A is not hammered)');
  assert.match((await p.status()).detail, /mode B/);
  ok('status reports the active mode');
}

// 4 ------------------------------------------------------------------
{
  const calls = [];
  const p = makeProvider({
    A: fake('A', calls, fails(new GeminiError('protocol', 'bad format'))),
    B: fake('B', calls, fails(new GeminiError('protocol', 'bad format too'))),
    C: fake('C', calls, reply(['from the DOM'])),
  });
  assert.equal((await run(p, [msg('user', 'q')])).text, 'from the DOM');
  assert.deepEqual(calls.map((c) => c.mode), ['A', 'B', 'C']);
  ok('A and B broken -> falls through to C');

  const calls2 = [];
  const p2 = makeProvider({
    A: fake('A', calls2, fails(new GeminiError('protocol', 'x'))),
    B: fake('B', calls2, fails(new GeminiError('protocol', 'y'))),
    C: fake('C', calls2, fails(new GeminiError('protocol', 'z'))),
  });
  assert.equal(await kindOf(run(p2, [msg('user', 'q')])), 'provider');
  ok('every mode broken -> one clear provider error');
}

// 5 ------------------------------------------------------------------
{
  const calls = [];
  const p = makeProvider({ A: fake('A', calls, partialThenFail(new GeminiError('protocol', 'cut'))), B: fake('B', calls, reply(['never'])) });
  assert.equal(await kindOf(run(p, [msg('user', 'q')])), 'provider');
  assert.deepEqual(calls.map((c) => c.mode), ['A']);
  ok('failure after output was already streamed is not retried (would duplicate text)');

  for (const [err, kind] of [
    [new GeminiError('rate_limit', 'limit'), 'rate_limit'],
    [new GeminiError('blocked', 'ip'), 'unavailable'],
    [new GeminiError('bad_model', 'no'), 'invalid_request'],
    [Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 'unavailable'],
  ]) {
    const c = [];
    const q = makeProvider({ A: fake('A', c, fails(err)), B: fake('B', c, reply(['x'])) });
    assert.equal(await kindOf(run(q, [msg('user', 'q')])), kind, String(err.kind ?? err.code));
    assert.deepEqual(c.map((x) => x.mode), ['A'], 'must not switch modes');
    assert.equal(q.switcher.describe('gemini:default').mode, 'A');
  }
  ok('rate limit / blocked IP / bad model / network errors map to the right API error and never switch modes');
}

// 6 ------------------------------------------------------------------
{
  const calls = [];
  const p = makeProvider({ A: fake('A', calls, (req, i) => (i === 1 ? fails(new GeminiError('rate_limit', 'x'))() : reply(['fine'])())) });
  assert.equal(await kindOf(run(p, [msg('user', 'q')])), 'rate_limit');
  assert.equal((await run(p, [msg('user', 'q')])).text, 'fine');
  ok('the account queue is released after an error (next request is not stuck)');
}

// 7 ------------------------------------------------------------------
{
  const calls = [];
  const p = makeProvider({ A: fake('A', calls, reply([''])) });
  assert.equal(await kindOf(run(p, [msg('user', 'q')])), 'provider');
  assert.equal(p.switcher.describe('gemini:default').mode, 'A');
  ok('an empty reply is an error but does not blame the transport');

  const c2 = [];
  const forced = makeProvider({ A: fake('A', c2, fails(new GeminiError('protocol', 'x'))), B: fake('B', c2, reply(['B only'])) }, { mode: 'B' });
  assert.equal((await run(forced, [msg('user', 'q')])).text, 'B only');
  assert.deepEqual(c2.map((x) => x.mode), ['B']);
  ok('mode: B in the config forces that transport');
}

// 8 auth -------------------------------------------------------------
{
  const calls = [];
  const p = makeProvider({ A: fake('A', calls, (req, i) => (i === 1 ? fails(new GeminiError('auth', 'tokens'))() : reply(['recovered'])())) });
  sessions.refresh = async () => ({ ok: true, rotated: false, verified: true, detail: '', ms: 1 });
  assert.equal((await run(p, [msg('user', 'q')])).text, 'recovered');
  assert.equal(calls.length, 2);
  ok('auth error but the session is fine (stale tokens) -> retried once and answered');

  const calls2 = [];
  const p2 = makeProvider({ A: fake('A', calls2, fails(new GeminiError('auth', 'redirect'))) });
  sessions.refresh = async () => ({ ok: false, rotated: false, verified: true, detail: '', ms: 1 });
  let err;
  try { await run(p2, [msg('user', 'q')]); } catch (e) { err = e; }
  assert.equal(err.kind, 'authentication');
  assert.match(err.message, /bridge login gemini --force/);
  ok('Google rejects the session -> clear "log in again" error with the exact command');

  const miss = makeProvider({ A: fake('A', [], reply(['x'])) });
  let e2; try { await run(miss, [msg('user', 'q')], { account: 'work' }); } catch (e) { e2 = e; }
  assert.match(e2.message, /bridge login gemini --account work/);
  ok('an account without a login gets a message that names the account');
}

// Gemini's canned failure message -> API error, nothing leaks to the client, nothing is remembered
{
  const calls = [];
  const canned = 'Sorry, something went wrong. Please try your request again.';
  const p = makeProvider({ A: fake('A', calls, reply(['Sorry, some', canned])) });
  const events = [];
  let err = null;
  try { for await (const e of p.chat({ model: 'pro', messages: [msg('user', 'hey chat')], stream: true }, new AbortController().signal)) events.push(e); } catch (e) { err = e; }
  assert.ok(err instanceof BridgeError); assert.equal(err.status, 502);
  assert.match(err.message, /generic error message \("Sorry, something went wrong/);
  assert.equal(events.filter((e) => e.type === 'text').length, 0);
  assert.equal(calls.length, 1);
  // the failed chat is not continued next time
  p.transports.set('A', fake('A', calls, reply(['Hi there'])));
  await run(p, [msg('user', 'hey chat'), msg('assistant', 'x'), msg('user', 'again')], { model: 'pro' });
  assert.equal(calls[1].conv, null);
  ok("Gemini's canned failure message becomes a 502 error, is never streamed and is not remembered");

  const calls2 = [];
  const p2 = makeProvider({ A: fake('A', calls2, reply(['I', 'I encountered', 'I encountered a bug in your code: line 3.'])) });
  const r = await run(p2, [msg('user', 'q')]);
  assert.equal(r.text, 'I encountered a bug in your code: line 3.');
  const p3 = makeProvider({ A: fake('A', calls2, reply(['Sorry'])) });
  assert.equal((await run(p3, [msg('user', 'q')])).text, 'Sorry');
  ok('a real answer that starts like a failure message is passed through whole');
}

// Gemini's internal error (code 13) is reported, but never switches the transport
{
  const calls = [];
  const p = makeProvider({
    A: fake('A', calls, fails(new GeminiError('failed', 'Gemini failed while answering (internal error, code 13).', 13))),
    B: fake('B', calls, reply(['from B'])),
  });
  const err = await run(p, [msg('user', 'q')]).then(() => null, (e) => e);
  assert.ok(err instanceof BridgeError); assert.equal(err.status, 502); assert.match(err.message, /code 13/);
  assert.deepEqual(calls.map((c) => c.mode), ['A']);
  assert.equal(p.switcher.describe('gemini:default').mode, 'A');
  ok('internal error code 13 -> 502, no retry in another mode, no mode switch');
}

// A model marked unavailable fails at once with 503 and its reason, never reaches Gemini, and is not listed
{
  const calls = [];
  const p = makeProvider({ A: fake('A', calls, reply(['should not be used'])) });
  const err = await run(p, [msg('user', 'hey chat')], { model: 'flash' }).then(() => null, (e) => e);
  assert.ok(err instanceof BridgeError); assert.equal(err.status, 503); assert.match(err.message, /not available through the gateway/);
  assert.equal(calls.length, 0);
  const { ProviderRegistry } = await import(base + 'providers/registry.js');
  const reg = new ProviderRegistry(); reg.add(p);
  assert.ok(!reg.models().some((m) => m.id === 'gemini/flash'));
  assert.ok(reg.models().some((m) => m.id === 'gemini/flash-lite'));
  assert.equal(reg.resolve('gemini/flash').localId, 'flash');
  ok('unavailable model (flash): 503 with the reason at once, hidden from /v1/models, still resolvable');
}

console.log(`\nall ${n} checks passed`);
