// Claude (claude.ai web) adapter: protocol parsing and the provider, with a fake page transport (no account used).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = new URL('../dist/', import.meta.url).href;
const { buildCompletion, ClaudeStreamParser, errorFromBody, uuidv7, ClaudeError } = await import(base + 'providers/claude/protocol.js');
const { ClaudeProvider } = await import(base + 'providers/claude/index.js');
const { SessionStore, scopeToProvider } = await import(base + 'auth/session-store.js');
const { SessionService } = await import(base + 'auth/session-service.js');
const { AUTH_SPECS } = await import(base + 'auth/specs.js');
const { BridgeError } = await import(base + 'core/errors.js');
const { ProviderRegistry } = await import(base + 'providers/registry.js');

const dir = mkdtempSync(join(tmpdir(), 'wb-claude-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const ok = (name) => console.log(`  ok ${++n}. ${name}`);
const spec = AUTH_SPECS.claude;

const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const STREAM = [
  ev('ping', {}),
  ev('conversation_ready', { is_temporary: false }),
  ev('message_start', { message: { uuid: 'asst-1', parent_uuid: 'human-1', model: 'claude-sonnet-5-5' } }),
  ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
  ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'secret plan' } }),
  ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
  ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Hey!' } }),
  ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: " What's on your mind?" } }),
  ev('content_block_stop', { index: 1 }),
  ev('message_delta', { delta: { stop_reason: 'end_turn' } }),
  ev('message_limit', { message_limit: { type: 'within_limit', windows: { '5h': { utilization: 0.07 }, '7d': { utilization: 0 } }, resolved: { limit: { resets_at: '2026-11-10T19:10:00+00:00' } } } }),
  ev('message_stop', {}),
].join('');

// 1: the stream gives text deltas, the assistant message id, the stop reason and the quota; thinking is left out
{
  const p = new ClaudeStreamParser();
  const all = [];
  for (let i = 0; i < STREAM.length; i += 37) all.push(...p.push(STREAM.slice(i, i + 37))); // arbitrary chunk borders
  all.push(...p.end());
  assert.equal(all.filter((u) => u.type === 'text').map((u) => u.text).join(''), "Hey! What's on your mind?");
  assert.deepEqual(all.find((u) => u.type === 'message'), { type: 'message', uuid: 'asst-1' });
  assert.deepEqual(all.find((u) => u.type === 'stop'), { type: 'stop', reason: 'end_turn' });
  const l = all.find((u) => u.type === 'limit').limit;
  assert.equal(l.fiveHour, 0.07); assert.equal(l.sevenDay, 0); assert.equal(l.resetsAt, '2026-11-10T19:10:00+00:00');
  assert.ok(!all.some((u) => u.type === 'text' && u.text.includes('secret')));
  ok('stream: text deltas across chunk borders, message id, stop reason, quota; thinking left out');
}

// 2: an error event inside the stream becomes an error
{
  const p = new ClaudeStreamParser();
  assert.throws(() => p.push(ev('error', { error: { type: 'overloaded_error', message: 'Overloaded' } })), (e) => e instanceof ClaudeError && e.kind === 'temporary');
  ok('stream: an error event is raised (overloaded -> temporary)');
}

// 3: request bodies for a new chat and for a continued chat
{
  const a = buildCompletion('org-1', { prompt: 'hey chat', model: 'claude-sonnet-5-5', effort: 'medium', conv: null, timezone: 'Asia/Jakarta' });
  const b1 = JSON.parse(a.body);
  assert.match(a.url, /^https:\/\/claude\.ai\/api\/organizations\/org-1\/chat_conversations\/[0-9a-f-]{36}\/completion$/);
  assert.ok(a.url.includes(a.chat));
  assert.equal(b1.prompt, 'hey chat'); assert.equal(b1.model, 'claude-sonnet-5-5'); assert.equal(b1.effort, 'medium');
  assert.deepEqual(b1.tools, []);
  assert.equal(b1.parent_message_uuid, undefined);
  assert.equal(b1.create_conversation_params.model, 'claude-sonnet-5-5');
  assert.equal(b1.rendering_mode, 'messages');
  assert.match(b1.turn_message_uuids.human_message_uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const c = buildCompletion('org-1', { prompt: 'apa kabar?', model: 'claude-sonnet-5-5', conv: { chat: a.chat, parent: 'asst-1' } });
  const b2 = JSON.parse(c.body);
  assert.equal(c.chat, a.chat);
  assert.equal(b2.parent_message_uuid, 'asst-1');
  assert.equal(b2.create_conversation_params, undefined);
  assert.equal(b2.effort, undefined);
  assert.match(uuidv7(), /^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  ok('request: new chat creates the conversation and sends no tools; a continued chat names its parent message');
}

// 4: error answers map to the right kinds
{
  const kind = (s, t) => errorFromBody(s, t).kind;
  assert.equal(kind(429, JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: JSON.stringify({ type: 'exceeded_limit', resetsAt: 1794337800 }) } })), 'rate_limit');
  assert.match(errorFromBody(429, JSON.stringify({ error: { type: 'rate_limit_error', message: JSON.stringify({ resetsAt: 1794337800 }) } })).message, /resets 20/);
  assert.equal(kind(403, '<html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/x"></script></html>'), 'blocked');
  assert.equal(kind(403, JSON.stringify({ error: { type: 'permission_error', message: 'Invalid authorization' } })), 'auth');
  assert.equal(kind(401, '{}'), 'auth');
  assert.equal(kind(400, JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid model: claude-x' } })), 'bad_model');
  assert.equal(kind(529, JSON.stringify({ error: { type: 'overloaded_error', message: 'Overloaded' } })), 'temporary');
  assert.equal(kind(400, JSON.stringify({ error: { type: 'invalid_request_error', message: 'prompt is too long' } })), 'protocol');
  ok('errors: usage limit -> rate_limit (with reset time), Cloudflare check -> blocked, 401/403 -> auth, model, overload');
}

// ---------------------------------------------------------------------------------------------------------------
// provider with a fake transport

const ck = (name, value) => ({ name, value, domain: '.claude.ai', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' });
function deps({ held = true } = {}) {
  const store = new SessionStore(mkdtempSync(join(dir, 's-')));
  const s = scopeToProvider(spec, 'default', { cookies: [ck('sessionKey', 'sk')], origins: [] }, 'UA');
  store.save(held ? { ...s, held: true } : s);
  const sessions = new SessionService(store, { keepAlive: false, keepAliveInterval: 540, retention: null, holdInBrowser: true });
  return { sessions, config: {} };
}

/** Fake page transport: answers from a script, records what it was asked. */
function fake(script) {
  const calls = [];
  return {
    calls,
    async *send(session, input) {
      calls.push({ ...input, signal: undefined, account: session.account });
      const step = script[calls.length - 1];
      if (step instanceof Error) throw step;
      yield { type: 'chat', chat: input.conv?.chat ?? `chat-${calls.length}` };
      yield { type: 'message', uuid: `asst-${calls.length}` };
      for (const t of step.text) yield { type: 'text', text: t };
      yield { type: 'stop', reason: step.stop ?? 'end_turn' };
      yield { type: 'limit', limit: { status: 'within_limit', fiveHour: 0.07, sevenDay: 0 } };
    },
  };
}

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const asst = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });
async function run(provider, req) {
  const events = [];
  for await (const e of provider.chat({ stream: true, model: 'sonnet', ...req }, new AbortController().signal)) events.push(e);
  return events;
}

// 5: answer streams through; the next request with a longer history continues the same chat with only the new turn
{
  const t = fake([{ text: ['Hey!', ' Hi.'] }, { text: ['Baik.'] }]);
  const p = new ClaudeProvider({ enabled: true, min_interval: 0, jitter: 0 }, deps(), t);
  const e1 = await run(p, { system: 'Be brief.', messages: [user('hey chat')] });
  assert.equal(e1.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Hey! Hi.');
  assert.deepEqual(e1.at(-1), { type: 'done', stopReason: 'stop' });
  assert.equal(t.calls[0].conv, null);
  assert.equal(t.calls[0].model, 'claude-sonnet-5-5');
  assert.equal(t.calls[0].effort, 'medium');
  assert.match(t.calls[0].prompt, /Be brief\.[\s\S]*hey chat/);
  await run(p, { system: 'Be brief.', messages: [user('hey chat'), asst('Hey! Hi.'), user('apa kabar?')] });
  assert.deepEqual(t.calls[1].conv, { chat: 'chat-1', parent: 'asst-1' });
  assert.equal(t.calls[1].prompt, 'apa kabar?');
  assert.match((await p.status()).detail, /quota used 5h 7% \/ 7d 0%/);
  ok('provider: streams the reply, continues the same web chat with only the new message, reports quota');
}

// 6: usage limit -> 429, Cloudflare check -> 503, unknown model -> 404, login not held -> 401
{
  const p1 = new ClaudeProvider({ enabled: true, min_interval: 0, jitter: 0 }, deps(), fake([new ClaudeError('rate_limit', 'The claude.ai usage limit of this account is reached')]));
  await assert.rejects(run(p1, { messages: [user('x')] }), (e) => e instanceof BridgeError && e.status === 429);
  const p2 = new ClaudeProvider({ enabled: true, min_interval: 0, jitter: 0 }, deps(), fake([new ClaudeError('blocked', 'Cloudflare bot check')]));
  await assert.rejects(run(p2, { messages: [user('x')] }), (e) => e instanceof BridgeError && e.status === 503 && /Cloudflare/.test(e.message));
  await assert.rejects(run(p2, { model: 'gpt', messages: [user('x')] }), (e) => e instanceof BridgeError && e.status === 404);
  const t3 = fake([{ text: ['never'] }]);
  const p3 = new ClaudeProvider({ enabled: true, min_interval: 0, jitter: 0 }, deps({ held: false }), t3);
  await assert.rejects(run(p3, { messages: [user('x')] }), (e) => e instanceof BridgeError && e.status === 401 && /hold_in_browser/.test(e.message));
  assert.equal(t3.calls.length, 0);
  ok('provider: usage limit -> 429, bot check -> 503 (no retry), unknown model -> 404, copied login -> 401');
}

// 7: an auth error triggers one login check in the browser; when the login is fine the request is retried once
{
  const t = fake([new ClaudeError('auth', 'claude.ai answered HTTP 403'), { text: ['ok'] }]);
  const d = deps();
  let checks = 0;
  d.sessions.setBrowserCheck(async () => { checks++; return { ok: true, why: 'marker found', cookies: [ck('sessionKey', 'sk')] }; });
  const p = new ClaudeProvider({ enabled: true, min_interval: 0, jitter: 0 }, d, t);
  const e = await run(p, { messages: [user('x')] });
  assert.equal(checks, 1); assert.equal(t.calls.length, 2);
  assert.equal(e.filter((x) => x.type === 'text').map((x) => x.text).join(''), 'ok');
  const t2 = fake([new ClaudeError('auth', 'claude.ai answered HTTP 403')]);
  const d2 = deps();
  d2.sessions.setBrowserCheck(async () => ({ ok: false, why: '/api/organizations HTTP 403', cookies: [ck('sessionKey', 'sk')] }));
  await assert.rejects(run(new ClaudeProvider({ enabled: true, min_interval: 0, jitter: 0 }, d2, t2), { messages: [user('x')] }),
    (err) => err instanceof BridgeError && err.status === 401 && /bridge login claude --force/.test(err.message));
  ok('provider: auth error -> one browser login check; fine -> retried once, logged out -> 401 with the fix');
}

// 8: the registry lists claude models
{
  const r = new ProviderRegistry();
  r.add(new ClaudeProvider({ enabled: true }, deps(), fake([])));
  assert.deepEqual(r.models().map((m) => m.id), ['claude/sonnet', 'claude/opus', 'claude/haiku']);
  assert.equal(r.resolve('claude').localId, 'sonnet');
  assert.throws(() => new ClaudeProvider({ enabled: true, effort: 'max' }, deps(), fake([])), /effort/);
  ok('registry: claude/sonnet, claude/opus, claude/haiku; sonnet is the default; bad effort is refused');
}

console.log(`claude-test: ${n} passed`);
