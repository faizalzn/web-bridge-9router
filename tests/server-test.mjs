// HTTP-level tests of the stream that is opened early when a web chat is slow to answer.
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';

const base = new URL('../dist/', import.meta.url).href;
const { createApp } = await import(base + 'server/http.js');
const { BridgeError } = await import(base + 'core/errors.js');

setTimeout(() => { console.error('FAIL: the test hung (a timer was left running?)'); process.exit(1); }, 20_000).unref();

let n = 0;
const ok = (name) => console.log(`  ok ${++n}. ${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const abortableSleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
});

function fakeRegistry(chat) {
  const provider = { id: 'fake', name: 'fake', nativeTools: true, listModels: () => [{ id: 'm' }], chat };
  return { resolve: () => ({ provider, localId: 'm' }), models: () => [], list: () => [] };
}

async function serve(chat, timing) {
  const server = createServer(createApp({ server: { apiKey: '' } }, fakeRegistry(chat), undefined, timing));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

/** Sends one request and records when the headers and each piece of the body arrived. */
function send(port, { stream = true, abortAt } = {}) {
  const t0 = Date.now();
  const out = { status: 0, type: '', headersAt: null, body: '', chunks: [], endedAt: null, abort: null };
  out.done = new Promise((resolve) => {
    const body = JSON.stringify({ model: 'fake/m', max_tokens: 50, stream, messages: [{ role: 'user', content: 'hi' }] });
    const req = request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      out.status = res.statusCode; out.type = String(res.headers['content-type']); out.headersAt = Date.now() - t0;
      res.setEncoding('utf8');
      res.on('data', (d) => { out.body += d; out.chunks.push({ at: Date.now() - t0, text: d }); });
      res.on('end', () => { out.endedAt = Date.now() - t0; resolve(out); });
      res.on('close', () => resolve(out));
    });
    req.on('error', () => resolve(out));
    out.abort = () => req.destroy();
    req.end(body);
    if (abortAt) setTimeout(() => req.destroy(), abortAt);
  });
  return out;
}

const answer = (text, delayMs = 0) => async function* (_req, signal) {
  if (delayMs) await abortableSleep(delayMs, signal);
  yield { type: 'text', text };
  yield { type: 'done', stopReason: 'stop' };
};

// 1) a fast first reply: nothing changes -------------------------------------------------------------------------
{
  const s = await serve(answer('hello fast'), { earlyOpenMs: 200, keepAliveMs: 50 });
  const r = await send(s.port).done;
  assert.equal(r.status, 200);
  assert.ok(r.body.includes('message_start') && r.body.includes('hello fast') && r.body.includes('message_stop'));
  assert.ok(!r.body.includes('keep-alive'));
  await s.close();
  ok('a reply that starts quickly is streamed as before, without any keep-alive comment');
}

// 2) a slow first reply: headers come first, then keep-alive comments, then the real stream ------------------------
{
  const s = await serve(answer('late text', 500), { earlyOpenMs: 100, keepAliveMs: 60 });
  const r = await send(s.port).done;
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/event-stream/);
  assert.ok(r.headersAt < 350, 'headers arrived after ' + r.headersAt + ' ms, the first reply only after 500 ms');
  assert.ok(r.body.includes(': keep-alive'));
  assert.ok(r.body.indexOf(': keep-alive') < r.body.indexOf('message_start'));
  assert.ok(r.body.includes('late text') && r.body.includes('message_stop'));
  await s.close();
  ok('a slow start opens the stream early, keep-alive comments precede the real events, the answer is complete');
}

// 3) an error before the early opening keeps its real HTTP status (9router decides its fallback on it) -------------
{
  const s = await serve(async function* () { await sleep(20); throw new BridgeError('authentication', 'login expired'); }, { earlyOpenMs: 300, keepAliveMs: 50 });
  const r = await send(s.port).done;
  assert.equal(r.status, 401);
  assert.match(r.type, /application\/json/);
  assert.ok(r.body.includes('login expired'));
  await s.close();
  ok('a failure within the grace time is still answered with a normal HTTP status (401)');
}

// 4) an error after the early opening can only travel inside the stream ------------------------------------------
{
  const s = await serve(async function* (_req, signal) { await abortableSleep(300, signal); throw new BridgeError('unavailable', 'Cannot reach Google'); }, { earlyOpenMs: 100, keepAliveMs: 50 });
  const r = await send(s.port).done;
  assert.equal(r.status, 200);
  assert.ok(r.body.includes('Cannot reach Google'), r.body);
  assert.ok(r.body.includes('error'));
  await s.close();
  ok('a failure after the stream was opened is delivered as an error event inside the stream');
}

// 5) the client gives up while the chat is still thinking: the provider is stopped and no timer is left ------------
{
  let cleaned = false;
  const chat = async function* (_req, signal) {
    try { await abortableSleep(5000, signal); yield { type: 'text', text: 'never seen' }; yield { type: 'done', stopReason: 'stop' }; }
    finally { cleaned = true; }
  };
  const s = await serve(chat, { earlyOpenMs: 100, keepAliveMs: 40 });
  const r = send(s.port, { abortAt: 300 });
  await r.done;
  await sleep(150);
  assert.ok(r.headersAt !== null && r.headersAt < 250, 'the stream should already have been open when the client left');
  assert.equal(cleaned, true);
  await s.close();
  ok('when the client leaves during the wait the provider is cancelled (nothing keeps running)');
}

// 6) without streaming there is nothing to open early ------------------------------------------------------------
{
  const s = await serve(answer('whole answer', 350), { earlyOpenMs: 100, keepAliveMs: 50 });
  const r = await send(s.port, { stream: false }).done;
  assert.equal(r.status, 200);
  assert.match(r.type, /application\/json/);
  assert.ok(r.headersAt >= 300, 'a non-streaming answer must come as one response, got headers at ' + r.headersAt + ' ms');
  assert.ok(r.body.includes('whole answer') && !r.body.includes('keep-alive'));
  await s.close();
  ok('a request without streaming still gets one normal JSON answer');
}

console.log(`\nall ${n} checks passed`);
