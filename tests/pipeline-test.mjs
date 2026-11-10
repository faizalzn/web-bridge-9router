import assert from 'node:assert/strict';
const base = new URL('../dist/', import.meta.url).href;
const { startChat, collect } = await import(base + 'core/pipeline.js');

let log = [];
const provider = {
  id: 'fake', name: 'fake', listModels: () => [{ id: 'm' }],
  async *chat() {
    try { yield { type: 'text', text: 'hi' }; yield { type: 'done', stopReason: 'stop' }; log.push('after done'); }
    finally { log.push('finally'); }
  },
};
const registry = { resolve: () => ({ provider, localId: 'm' }) };
const req = { model: 'fake/m', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], stream: false };

// 1) normal completion: code after `done` and the finally block must run
const c = await collect((await startChat(registry, req, new AbortController().signal)).events);
assert.equal(c.text, 'hi');
assert.deepEqual(log, ['after done', 'finally']);
console.log('ok: adapter cleanup runs after a normal reply');

// 2) client disconnects mid-stream: finally must still run
log = [];
const chat = await startChat(registry, req, new AbortController().signal);
for await (const ev of chat.events) { if (ev.type === 'text') break; }
assert.deepEqual(log, ['finally']);
console.log('ok: adapter cleanup runs when the consumer stops early');
