import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = new URL('../dist/', import.meta.url).href;
const { startChat, collect } = await import(base + 'core/pipeline.js');
const { openAIResponse } = await import(base + 'translate/openai.js');
const { anthropicResponse } = await import(base + 'translate/anthropic.js');
const { SessionStore, scopeToProvider } = await import(base + 'auth/session-store.js');
const { SessionService } = await import(base + 'auth/session-service.js');
const { AUTH_SPECS } = await import(base + 'auth/specs.js');
const { GeminiProvider } = await import(base + 'providers/gemini/index.js');

let n = 0;
const ok = (name) => console.log(`  ok ${++n}. ${name}`);
const msg = (role, text) => ({ role, content: [{ type: 'text', text }] });
const tools = [{ name: 'read_file', description: 'Reads a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
const abort = () => new AbortController().signal;
const rawCall = '<tool_call>{ "name": "read_file", "arguments": { "path": "a.txt" } }</tool_call>';

// 1) a text-only provider: it must not see `tools`, and its text must come back as a real tool call ---------------
{
  let seen;
  const provider = {
    id: 'fake', name: 'fake', listModels: () => [{ id: 'm' }],
    async *chat(req) {
      seen = req;
      yield { type: 'text', text: 'Let me look.\n<tool_' };
      yield { type: 'text', text: 'call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call> and a guess' };
      yield { type: 'done', stopReason: 'stop' };
    },
  };
  const registry = { resolve: () => ({ provider, localId: 'm' }) };
  const req = { model: 'fake/m', system: 'Be brief.', messages: [msg('user', 'read a.txt')], tools, stream: false };
  const c = await collect((await startChat(registry, req, abort())).events);
  assert.equal(seen.tools, undefined);
  assert.ok(seen.system.startsWith('Be brief.') && seen.system.includes('read_file'));
  assert.equal(typeof seen.normalizeReply, 'function');
  assert.equal(c.text, 'Let me look.');
  assert.equal(c.toolCalls.length, 1);
  assert.equal(c.toolCalls[0].name, 'read_file');
  assert.equal(c.toolCalls[0].arguments, '{"path":"a.txt"}');
  assert.match(c.toolCalls[0].id, /^call_/);
  assert.equal(c.stopReason, 'tool_calls');
  ok('a text-only provider gets instructions instead of tools, and its reply becomes a tool call (stop reason tool_calls)');

  const o = openAIResponse(c, 'fake/m');
  assert.equal(o.choices[0].finish_reason, 'tool_calls');
  assert.equal(o.choices[0].message.tool_calls[0].function.name, 'read_file');
  const a = anthropicResponse(c, 'fake/m');
  assert.equal(a.stop_reason, 'tool_use');
  assert.equal(a.content.find((b) => b.type === 'tool_use').name, 'read_file');
  ok('the OpenAI and Anthropic answers carry the call (tool_calls / tool_use)');
}

// 2) a provider with native tool calling is left alone ---------------------------------------------------------------
{
  let seen;
  const provider = {
    id: 'native', name: 'native', nativeTools: true, listModels: () => [{ id: 'm' }],
    async *chat(req) { seen = req; yield { type: 'text', text: 'ok' }; yield { type: 'done', stopReason: 'stop' }; },
  };
  const registry = { resolve: () => ({ provider, localId: 'm' }) };
  await collect((await startChat(registry, { model: 'n/m', messages: [msg('user', 'x')], tools, stream: false }, abort())).events);
  assert.deepEqual(seen.tools, tools);
  assert.equal(seen.normalizeReply, undefined);
  ok('a provider with nativeTools receives the request untouched');
}

// 3) tool_choice none: tools are dropped, earlier calls/results are shown as text -----------------------------------
{
  let seen;
  const provider = { id: 'f', name: 'f', listModels: () => [{ id: 'm' }], async *chat(req) { seen = req; yield { type: 'text', text: 'done' }; yield { type: 'done', stopReason: 'stop' }; } };
  const registry = { resolve: () => ({ provider, localId: 'm' }) };
  const messages = [
    msg('user', 'read it'),
    { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }] },
    { role: 'tool', content: [{ type: 'tool_result', toolCallId: 'c1', content: 'HELLO' }] },
  ];
  const c = await collect((await startChat(registry, { model: 'f/m', messages, tools, toolChoice: 'none', stream: false }, abort())).events);
  assert.equal(seen.tools, undefined);
  assert.ok(!seen.system);
  assert.ok(seen.messages.every((m) => m.content.every((p) => p.type === 'text')));
  assert.equal(c.toolCalls.length, 0);
  ok('tool_choice none: no instructions, history kept as text, a plain answer comes back');
}

// 4) the agent loop through the real Gemini provider (fake transport): the chat must be continued -------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'wb-tools-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  const store = new SessionStore(dir);
  const cookie = { name: '__Secure-1PSID', value: 'x', domain: '.google.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'None' };
  store.save(scopeToProvider(AUTH_SPECS.gemini, 'default', { cookies: [cookie], origins: [] }, ''));
  const sessions = new SessionService(store, { keepAlive: false, keepAliveInterval: 540, retention: null });
  const config = { browser: { channel: 'auto', executablePath: '', idleTimeout: 10, blockResources: [] } };

  const calls = [];
  const replies = [
    { text: 'Looking.\n' + rawCall, conv: { cid: 'c_1', rid: 'r_1', rcid: 'rc_1' } },
    { text: 'The file says HELLO.', conv: { cid: 'c_1', rid: 'r_2', rcid: 'rc_2' } },
    { text: 'The file says HELLO.', conv: { cid: 'c_1', rid: 'r_3', rcid: 'rc_3' } },
    { text: 'You are welcome.', conv: { cid: 'c_1', rid: 'r_4', rcid: 'rc_4' } },
    { text: 'Fresh chat answer.', conv: { cid: 'c_9', rid: 'r_9', rcid: 'rc_9' } },
  ];
  let i = 0;
  const makeProvider = () => {
    const p = new GeminiProvider({ enabled: true, min_interval: 0, jitter: 0 }, { config, sessions });
    p.transports.set('A', { mode: 'A', async *generate(ctx, req) { calls.push({ prompt: req.prompt, conv: req.conv }); yield replies[i++]; } });
    return p;
  };
  const provider = makeProvider();
  const registry = { resolve: () => ({ provider, localId: 'flash-lite' }) };
  const ask = async (messages) => collect((await startChat(registry, { model: 'gemini/flash-lite', system: 'Be brief.', messages, tools, stream: false }, abort())).events);

  // step 1: a new chat; the prompt carries the instructions, the tool list and the question
  const first = await ask([msg('user', 'read a.txt')]);
  assert.equal(calls[0].conv, null);
  assert.ok(calls[0].prompt.includes('Be brief.') && calls[0].prompt.includes('<tools>') && calls[0].prompt.includes('read a.txt'));
  assert.equal(first.text, 'Looking.');
  assert.equal(first.toolCalls.length, 1);

  // step 2: the client sends back exactly what the gateway gave it, plus the tool result
  const echo = { role: 'assistant', content: [
    { type: 'text', text: first.text },
    { type: 'tool_call', id: first.toolCalls[0].id, name: first.toolCalls[0].name, arguments: first.toolCalls[0].arguments },
  ] };
  const result = { role: 'tool', content: [{ type: 'tool_result', toolCallId: first.toolCalls[0].id, content: 'HELLO' }] };
  const history = [msg('user', 'read a.txt'), echo, result];
  const second = await ask(history);
  assert.deepEqual(calls[1].conv, { cid: 'c_1', rid: 'r_1', rcid: 'rc_1' });
  assert.equal(calls[1].prompt, '<tool_result name="read_file">\nHELLO\n</tool_result>');
  assert.equal(second.text, 'The file says HELLO.');
  assert.equal(second.stopReason, 'stop');
  ok('the second step of the loop continues the same chat and sends only the tool result');

  // Anthropic clients put the result in a user message: same continuation
  await ask([msg('user', 'read a.txt'), echo, { role: 'user', content: result.content }]);
  assert.deepEqual(calls[2].conv, { cid: 'c_1', rid: 'r_1', rcid: 'rc_1' });
  assert.equal(calls[2].prompt, calls[1].prompt);
  ok('a tool result sent in a user message (Anthropic style) continues the chat the same way');

  // step 3: the loop ends and the user talks on
  await ask([...history, msg('assistant', 'The file says HELLO.'), msg('user', 'thanks')]);
  // steps 2 and 2b share one fingerprint, so the newest of the two answers is the chat state to continue from
  assert.deepEqual(calls[3].conv, { cid: 'c_1', rid: 'r_3', rcid: 'rc_3' });
  assert.equal(calls[3].prompt, 'thanks');
  ok('the conversation goes on in the same chat after the loop');

  // a gateway that has forgotten the chat starts over with the whole history, in the canonical text form
  const lost = makeProvider();
  registry.resolve = () => ({ provider: lost, localId: 'flash-lite' });
  await ask(history);
  assert.equal(calls[4].conv, null);
  const p = calls[4].prompt;
  assert.ok(p.includes('Assistant: Looking.\n<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>'));
  assert.ok(p.includes('Latest tool results') && p.includes('<tool_result name="read_file">\nHELLO\n</tool_result>'));
  ok('without a known chat the whole history is sent, with calls and results in the canonical form');
}

// 5) the adapter is still driven to its end after `done`, also when tool calls are emulated -------------------------
{
  const log = [];
  const provider = {
    id: 'f', name: 'f', listModels: () => [{ id: 'm' }],
    async *chat() {
      try { yield { type: 'text', text: 'hi' }; yield { type: 'done', stopReason: 'stop' }; log.push('after done'); }
      finally { log.push('finally'); }
    },
  };
  const registry = { resolve: () => ({ provider, localId: 'm' }) };
  const req = { model: 'f/m', messages: [msg('user', 'x')], tools, stream: false };
  await collect((await startChat(registry, req, abort())).events);
  assert.deepEqual(log, ['after done', 'finally']);
  log.length = 0;
  const chat = await startChat(registry, req, abort());
  for await (const ev of chat.events) { if (ev.type === 'text') break; }
  assert.deepEqual(log, ['finally']);
  ok('cleanup of the adapter runs after done and when the client disconnects (with emulation on)');
}

console.log(`\nall ${n} checks passed`);
