import assert from 'node:assert/strict';

const base = new URL('../dist/', import.meta.url).href;
const { DeltaEmitter, cleanReply } = await import(base + 'providers/gemini/text.js');
const { ConversationCache } = await import(base + 'core/conversation-cache.js');
const { ModeSwitcher } = await import(base + 'core/mode-switcher.js');
const { AccountQueue } = await import(base + 'core/queue.js');
const { StreamParser, GeminiError, buildStreamRequest } = await import(base + 'providers/gemini/protocol.js');
const { BUNDLED_MANIFEST: M } = await import(base + 'providers/gemini/manifest.js');
const { buildFreshPrompt, buildContinuationPrompt } = await import(base + 'core/prompt.js');

const msg = (role, text) => ({ role, content: [{ type: 'text', text }] });
let n = 0;
const ok = (name) => console.log(`  ok ${++n}. ${name}`);

// --- text cleaning -------------------------------------------------------
{
  const e = new DeltaEmitter();
  const seq = ['po', 'pong\n\n', 'pong\n\nhttp://goo', 'pong\n\nhttp://googleusercontent.com/lmdx_content/abc'];
  let out = '';
  for (const s of seq) out += e.push(s);
  out += e.push(seq.at(-1), true);
  assert.equal(out, 'pong');
  ok('placeholder link and trailing whitespace never reach the client');

  const e2 = new DeltaEmitter();
  let o2 = '';
  for (const s of ['See htt', 'See https://exam', 'See https://example.com/page now']) o2 += e2.push(s);
  o2 += e2.push('See https://example.com/page now', true);
  assert.equal(o2, 'See https://example.com/page now');
  ok('a normal link in the answer is kept');

  assert.equal(cleanReply('Here:\n\nhttps://googleusercontent.com/image_generation_content/0', true), 'Here:');
  ok('image placeholders are removed');

  const e3 = new DeltaEmitter();
  e3.push('Hello wor'); assert.equal(e3.push('Hello world'), 'ld');
  ok('deltas are only the new characters');
}

// --- conversation cache --------------------------------------------------
{
  const c = new ConversationCache({ max: 10, ttlMs: 60_000 });
  const u1 = msg('user', 'hi'), a1 = msg('assistant', 'hello'), u2 = msg('user', 'more'), a2 = msg('assistant', 'sure'), u3 = msg('user', 'again');
  c.put('s', undefined, [u1, a1], { id: 1 });
  assert.deepEqual(c.find('s', undefined, [u1, a1, u2]), { ref: { id: 1 }, consumed: 2 });
  ok('continues a chat when the history only grew');
  c.put('s', undefined, [u1, a1, u2, a2], { id: 2 });
  assert.equal(c.find('s', undefined, [u1, a1, u2, a2, u3]).ref.id, 2);
  assert.equal(c.find('s', undefined, [u1, a1, u2, a2, u3]).consumed, 4);
  ok('picks the longest known prefix');
  assert.equal(c.find('s', undefined, [u1, msg('assistant', 'edited'), u2]), null);
  ok('edited history starts a new chat');
  assert.equal(c.find('other', undefined, [u1, a1, u2]), null);
  assert.equal(c.find('s', 'a system prompt', [u1, a1, u2]), null);
  ok('different account/model or system prompt never reuses a chat');
  assert.equal(c.find('s', undefined, [u1, msg('assistant', 'hello\n'), u2]).ref.id, 1);
  ok('trailing whitespace differences do not matter');
  assert.equal(c.find('s', undefined, [u1, a1]), null);
  ok('nothing new to send means no reuse');
  const gone = [];
  const c2 = new ConversationCache({ max: 2, ttlMs: 60_000, onExpire: (r) => gone.push(r.id) });
  c2.put('s', undefined, [msg('user', '1'), msg('assistant', 'a')], { id: 'x1' });
  c2.put('s', undefined, [msg('user', '2'), msg('assistant', 'a')], { id: 'x2' });
  c2.put('s', undefined, [msg('user', '3'), msg('assistant', 'a')], { id: 'x3' });
  assert.deepEqual(gone, ['x1']); assert.equal(c2.size, 2);
  ok('cache size is bounded (oldest dropped)');
}

// --- mode switcher -------------------------------------------------------
{
  const s = new ModeSwitcher(['A', 'B', 'C'], 1000);
  assert.deepEqual(s.plan('k', 0), ['A', 'B', 'C']);
  s.failed('k', 'A', 'broke', 0);
  assert.deepEqual(s.plan('k', 10), ['B', 'C']);
  assert.equal(s.current('k'), 'B');
  assert.deepEqual(s.plan('k', 1500), ['A', 'B', 'C']); // probe the lighter mode again
  assert.deepEqual(s.plan('k', 1600), ['B', 'C']);
  s.succeeded('k', 'A');
  assert.deepEqual(s.plan('k', 1700), ['A', 'B', 'C']); assert.equal(s.current('k'), 'A');
  ok('falls back A->B, probes A again later, returns to A when it works');
  s.failed('k', 'A', 'x', 0); s.failed('k', 'B', 'y', 0);
  assert.deepEqual(s.plan('k', 10), ['C']);
  s.failed('k', 'C', 'z', 0);
  assert.deepEqual(s.plan('k', 20), ['C']);
  ok('the last mode stays available');
}

// --- queue ---------------------------------------------------------------
{
  const q = new AccountQueue({ minGapMs: 30, jitterMs: 0, maxWaiting: 2, maxWaitMs: 2000 });
  const order = [];
  const job = async (name, ms) => { const r = await q.acquire('a'); order.push('start ' + name); await new Promise((x) => setTimeout(x, ms)); order.push('end ' + name); r(); };
  const t0 = Date.now();
  await Promise.all([job('1', 40), job('2', 10), job('3', 10)]);
  assert.deepEqual(order, ['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
  assert.ok(Date.now() - t0 >= 40 + 10 + 10 + 60, 'minimum gap between requests is respected');
  ok('one request at a time per account, with a pause between them');

  const r1 = await q.acquire('b');
  const w = [q.acquire('b'), q.acquire('b')];
  await assert.rejects(q.acquire('b'), /Too many requests/);
  r1(); (await w[0])(); (await w[1])();
  ok('too many waiting requests are rejected');

  const r2 = await q.acquire('c'); const ac = new AbortController();
  const waiting = q.acquire('c', ac.signal); ac.abort();
  await assert.rejects(waiting, /aborted/);
  r2();
  const r3 = await q.acquire('c'); r3();
  ok('a client that disconnects while waiting gives up its place');
}

// --- stream parser -------------------------------------------------------
{
  const frame = (cum, ids = ['c_1', 'r_1'], rc = 'rc_1') => {
    const inner = JSON.stringify([null, ids, null, null, [[rc, [cum], null]]]);
    const line = JSON.stringify([['wrb.fr', null, inner], ['di', 12]]);
    return `${line.length}\n${line}\n`;
  };
  const raw = ")]}'\n\n" + frame('He') + frame('Hello') + frame('Hello, wor') + frame('Hello, world');
  const p = new StreamParser(M);
  const got = [];
  for (let i = 0; i < raw.length; i += 17) got.push(...p.push(raw.slice(i, i + 17))); // arbitrary chunk boundaries
  got.push(...p.end());
  assert.deepEqual(got.map((u) => u.text), ['He', 'Hello', 'Hello, wor', 'Hello, world']);
  assert.deepEqual(got.at(-1).conv, { cid: 'c_1', rid: 'r_1', rcid: 'rc_1' });
  ok('parses frames split at arbitrary points, with conversation ids');

  const pe = new StreamParser(M);
  assert.throws(() => pe.push(`10\n${JSON.stringify([['wrb.fr', null, null, null, null, [1037]]])}\n`), (e) => e instanceof GeminiError && e.kind === 'rate_limit');
  assert.throws(() => new StreamParser(M).push(`10\n${JSON.stringify([['er', null, null, null, null, 1052]])}\n`), (e) => e.kind === 'bad_model');
  ok('error codes map to rate limit / bad model');
  const empty = new StreamParser(M); empty.push(")]}'\n\n"); empty.end();
  assert.equal(empty.sawFrame, false);
  ok('an empty/unknown stream is detectable');
}

// --- request + prompts ---------------------------------------------------
{
  const t = { at: 'AT', bl: 'boq_x', sid: '123', fetchedAt: 0 };
  const r = buildStreamRequest(M, t, { modelId: 'abc', prompt: 'hi "there"\nline2', conv: { cid: 'c', rid: 'r', rcid: 'rc' } }, 'UUID');
  const form = new URLSearchParams(r.body);
  const inner = JSON.parse(JSON.parse(form.get('f.req'))[1]);
  assert.equal(inner[0][0], 'hi "there"\nline2');
  assert.deepEqual(inner[2], ['c', 'r', 'rc']);
  assert.equal(form.get('at'), 'AT');
  assert.ok(JSON.parse(r.headers[M.headers.model])[4] === 'abc');
  assert.ok(r.url.includes('bl=boq_x') && r.url.includes('rt=c'));
  const fresh = buildStreamRequest(M, t, { modelId: 'abc', prompt: 'x' }, 'U');
  assert.deepEqual(JSON.parse(JSON.parse(new URLSearchParams(fresh.body).get('f.req'))[1])[2], ['', '', '']);
  ok('request encoding (prompt escaping, model header, new vs continued chat)');

  assert.equal(buildFreshPrompt(undefined, [msg('user', 'What is 2+2?')]), 'What is 2+2?');
  ok('a plain question is sent untouched');
  const p2 = buildFreshPrompt('Be brief.', [msg('user', 'a'), msg('assistant', 'b'), msg('user', 'c')]);
  assert.ok(p2.includes('Be brief.') && p2.includes('User: a') && p2.includes('Assistant: b') && p2.trim().endsWith('c'));
  assert.equal(buildContinuationPrompt([msg('user', 'next')]), 'next');
  ok('system prompt and history are folded into one prompt');
}

// --- model selection ----------------------------------------------------
// Regression: the header once carried a fixed mode (6 = Flash-Lite), so Pro/Flash/Argon requests were all answered by
// Flash-Lite. The server picks the model from the mode at header index 14, not from the model id at index 4.
{
  const t = { at: 'AT', bl: 'boq_x', sid: '123', fetchedAt: 0 };
  const header = (modelId) => JSON.parse(buildStreamRequest(M, t, { modelId, prompt: 'x' }, 'U').headers[M.headers.model]);
  const expected = { 'flash-lite': 6, flash: 1, pro: 3, argon: 8 };
  assert.deepEqual(M.models.map((m) => m.id).sort(), Object.keys(expected).sort());
  for (const m of M.models) {
    const h = header(m.modelId);
    assert.equal(h[4], m.modelId);
    assert.equal(h[14], expected[m.id], m.id + ' must send its own mode');
  }
  assert.equal(new Set(M.models.map((m) => header(m.modelId)[14])).size, M.models.length);
  assert.equal(header('not-a-known-model')[14], null);
  ok('every model sends its own mode at header index 14; an unknown model sends none');
}

console.log(`\nall ${n} checks passed`);
