import assert from 'node:assert/strict';

const base = new URL('../dist/', import.meta.url).href;
const { ToolCallScanner, normalizeReply, prepareToolEmulation, textifyToolParts, toolInstructions } = await import(base + 'core/tool-emulation.js');
const { renderToolCall, renderToolResult } = await import(base + 'core/tool-format.js');

let n = 0;
const ok = (name) => console.log(`  ok ${++n}. ${name}`);
const BS = String.fromCharCode(92);
const tools = [
  { name: 'read_file', description: 'Reads a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false } },
  { name: 'run', description: 'Runs a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
];
const call = (name, args) => `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;

// feeds the chunks to a scanner and returns { text, calls }
function scan(chunks) {
  const s = new ToolCallScanner(tools);
  const pieces = [];
  for (const c of chunks) pieces.push(...s.push(c));
  pieces.push(...s.end());
  return {
    text: pieces.filter((p) => p.type === 'text').map((p) => p.text).join(''),
    calls: pieces.filter((p) => p.type === 'call').map((p) => `${p.name} ${p.arguments}`),
  };
}
function randomChunks(t, seed = 7) {
  const out = [];
  let i = 0;
  while (i < t.length) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; const k = 1 + (seed % 9); out.push(t.slice(i, i + k)); i += k; }
  return out;
}
/** Runs a case three ways (whole, char by char, random pieces); all must agree, as a real stream needs. */
function check(input, expected) {
  assert.deepEqual(scan([input]), expected, 'whole: ' + input.slice(0, 60));
  assert.deepEqual(scan([...input]), expected, 'char by char: ' + input.slice(0, 60));
  assert.deepEqual(scan(randomChunks(input)), expected, 'random chunks: ' + input.slice(0, 60));
}

// --- scanner ---------------------------------------------------------------
{
  check('Hello <b>world</b>, 2 < 3 and <tool> is just a word', { text: 'Hello <b>world</b>, 2 < 3 and <tool> is just a word', calls: [] });
  ok('plain text with angle brackets passes through untouched');

  check('Let me check.\n' + call('read_file', { path: 'a.txt' }), { text: 'Let me check.', calls: ['read_file {"path":"a.txt"}'] });
  check(call('run', { cmd: 'ls' }), { text: '', calls: ['run {"cmd":"ls"}'] });
  ok('a call, with or without a sentence before it (no trailing whitespace before the call)');

  check(call('read_file', { path: 'a' }) + '\n' + call('run', { cmd: 'ls' }), { text: '', calls: ['read_file {"path":"a"}', 'run {"cmd":"ls"}'] });
  ok('several calls in one reply');

  check(call('read_file', { path: 'a' }) + '\n\nThe file says: hello world', { text: '', calls: ['read_file {"path":"a"}'] });
  check(call('read_file', { path: 'a' }) + '\n<tool_result name="read_file">\nfake\n</tool_result>', { text: '', calls: ['read_file {"path":"a"}'] });
  ok('anything written after a call (a guessed result) is dropped');

  check('```xml\n' + call('read_file', { path: 'a' }) + '\n```', { text: '', calls: ['read_file {"path":"a"}'] });
  check('Sure:\n```\n' + call('run', { cmd: 'x' }) + '\n```', { text: 'Sure:', calls: ['run {"cmd":"x"}'] });
  ok('a call wrapped in a code fence');

  check('<tool_call>{"name":"run","arguments":{"cmd":"echo a\necho b"}}</tool_call>', { text: '', calls: ['run {"cmd":"echo a' + BS + 'necho b"}'] });
  check('<tool_call>{"name":"run","arguments":{"cmd":"ls",},}</tool_call>', { text: '', calls: ['run {"cmd":"ls"}'] });
  ok('JSON repaired: raw line break inside a string, trailing commas');

  check('<tool_call>{"name":"READ_FILE","parameters":{"path":"x"}}</tool_call>', { text: '', calls: ['read_file {"path":"x"}'] });
  check('<tool_call>{"name":"functions.read_file","args":{"path":"x"}}</tool_call>', { text: '', calls: ['read_file {"path":"x"}'] });
  check('<tool_call>' + JSON.stringify({ name: 'run', arguments: JSON.stringify({ cmd: 'ls' }) }) + '</tool_call>', { text: '', calls: ['run {"cmd":"ls"}'] });
  ok('tool name case/prefix, argument key aliases, arguments given as a JSON string');

  const unknown = call('delete_everything', {});
  check('Doing it. ' + unknown, { text: 'Doing it. ' + unknown, calls: [] });
  const garbage = '<tool_call>this is not json</tool_call>';
  check(garbage, { text: garbage, calls: [] });
  ok('an unknown tool or invalid JSON stays visible as text and is never turned into a call');

  check('<tool_call>{"name":"run","arguments":{"cmd":"ls"}}', { text: '', calls: ['run {"cmd":"ls"}'] });
  check('<tool_call>{"name":"run","arguments":{"cmd":"l', { text: '<tool_call>{"name":"run","arguments":{"cmd":"l', calls: [] });
  ok('a reply that ends without the closing tag: complete JSON is accepted, a cut-off one stays text');

  check('abc <tool_ca', { text: 'abc <tool_ca', calls: [] });
  check('Here:\n```python\nprint(1)\n```', { text: 'Here:\n```python\nprint(1)\n```', calls: [] });
  ok('a half tag or a normal code block at the end of the reply is released as text');
}

// --- canonical text --------------------------------------------------------
{
  const raw = 'Checking.\n<tool_call>{ "name": "read_file",  "arguments": { "path": "a.txt" } }</tool_call>';
  const canonical = normalizeReply(raw, tools);
  const echoed = textifyToolParts([{ role: 'assistant', content: [
    { type: 'text', text: 'Checking.' }, { type: 'tool_call', id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
  ] }]);
  const messageText = (m) => m.content.map((p) => p.text).join('\n').trim();
  assert.equal(canonical, messageText(echoed[0]));
  assert.equal(normalizeReply('just text', tools), 'just text');
  assert.equal(renderToolCall('run', ''), '<tool_call>{"name":"run","arguments":{}}</tool_call>');
  ok('the remembered reply equals the history a client resends (so the chat can be continued)');
}

// --- request rewriting -----------------------------------------------------
{
  const msg = (role, content) => ({ role, content });
  const req = { model: 'x/y', messages: [msg('user', [{ type: 'text', text: 'hi' }])], stream: false };
  assert.equal(prepareToolEmulation(req), null);
  assert.equal(prepareToolEmulation({ ...req, tools, toolChoice: 'none' }), null);
  const e = prepareToolEmulation({ ...req, system: 'Be brief.', tools });
  assert.equal(e.request.tools, undefined);
  assert.ok(e.request.system.startsWith('Be brief.') && e.request.system.includes('"name":"read_file"') && e.request.system.includes('"name":"run"'));
  assert.ok(!e.request.system.includes('additionalProperties'));
  ok('no emulation without tools or with tool_choice none; otherwise the tools move into the instructions');

  assert.ok(!toolInstructions(tools, 'auto').includes('MUST'));
  assert.ok(toolInstructions(tools, 'required').includes('MUST call at least one tool'));
  assert.ok(toolInstructions(tools, { name: 'run' }).includes('MUST call the tool "run"'));
  assert.ok(!toolInstructions(tools, { name: 'nope' }).includes('MUST'));
  ok('tool_choice required / a named tool add a rule; an unknown name is ignored');

  const history = textifyToolParts([
    msg('user', [{ type: 'text', text: 'read a' }]),
    msg('assistant', [{ type: 'tool_call', id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }]),
    msg('tool', [{ type: 'tool_result', toolCallId: 'c1', content: 'AAA' }]),
    msg('user', [{ type: 'tool_result', toolCallId: 'c1', content: 'BBB', isError: true }]),
  ]);
  assert.equal(history[1].content[0].text, renderToolCall('read_file', '{"path":"a"}'));
  assert.equal(history[2].content[0].text, renderToolResult('read_file', 'AAA'));
  assert.equal(history[3].role, 'tool');
  assert.ok(history[3].content[0].text.includes('is_error="true"'));
  ok('earlier calls and results become text; a user message holding only results counts as the tool turn');
}

console.log(`\nall ${n} checks passed`);
