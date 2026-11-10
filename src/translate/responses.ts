// OpenAI Responses API (POST /v1/responses) <-> internal format.
import type { ChatRequest, ContentPart, Message, StreamEvent, ToolChoice } from '../core/types.ts';
import { BridgeError } from '../core/errors.ts';
import { randomBytes } from 'node:crypto';
import { requireString, type Collected } from '../core/pipeline.ts';

const rid = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`;

// ---------------------------------------------------------------------------
// previous_response_id support: keep recent conversations in memory.
// ---------------------------------------------------------------------------
const MAX_STORED = 200;
const store = new Map<string, Message[]>();

function remember(id: string, history: Message[]): void {
  store.set(id, history);
  if (store.size > MAX_STORED) store.delete(store.keys().next().value!);
}

export function saveResponse(id: string, req: ChatRequest, c: Collected): void {
  const reply: ContentPart[] = [];
  if (c.text) reply.push({ type: 'text', text: c.text });
  for (const t of c.toolCalls) reply.push({ type: 'tool_call', ...t });
  remember(id, [...req.messages, { role: 'assistant', content: reply }]);
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------
function contentToParts(content: unknown): ContentPart[] {
  if (content == null) return [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) throw new BridgeError('invalid_request', 'input content must be a string or an array');
  const parts: ContentPart[] = [];
  for (const p of content) {
    switch (p?.type) {
      case 'input_text':
      case 'output_text':
      case 'text':
        parts.push({ type: 'text', text: String(p.text ?? '') });
        break;
      case 'input_image': {
        const url = String(p.image_url ?? '');
        const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
        parts.push(m ? { type: 'image', mediaType: m[1], data: m[2] } : { type: 'image', url });
        break;
      }
      case 'refusal':
        parts.push({ type: 'text', text: String(p.refusal ?? '') });
        break;
      // input_file / input_audio are not supported by web chats yet.
    }
  }
  return parts;
}

const textOnly = (parts: ContentPart[]) => parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n');

function outputToText(output: unknown): string {
  if (typeof output === 'string') return output;
  return textOnly(contentToParts(output));
}

function parseToolChoice(tc: any): ToolChoice | undefined {
  if (tc === 'auto' || tc === 'none' || tc === 'required') return tc;
  if (tc?.type === 'function' && tc.name) return { name: String(tc.name) };
  return undefined;
}

export function parseResponsesRequest(body: any): ChatRequest {
  const model = requireString(body?.model, 'model');
  const system: string[] = [];
  if (typeof body.instructions === 'string' && body.instructions) system.push(body.instructions);

  const messages: Message[] = [];
  if (body.previous_response_id) {
    const prior = store.get(String(body.previous_response_id));
    if (!prior) throw new BridgeError('invalid_request', `Previous response '${body.previous_response_id}' not found`);
    messages.push(...prior);
  }

  const push = (role: Message['role'], content: ContentPart[]) => {
    // Merge consecutive assistant items (text + function calls) into one message.
    const last = messages.at(-1);
    if (role === 'assistant' && last?.role === 'assistant') last.content.push(...content);
    else messages.push({ role, content });
  };

  const items = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input;
  if (!Array.isArray(items) || items.length === 0) {
    throw new BridgeError('invalid_request', '"input" must be a non-empty string or array');
  }

  for (const item of items) {
    const type = item?.type ?? (item?.role ? 'message' : undefined);
    switch (type) {
      case 'message':
        if (item.role === 'system' || item.role === 'developer') system.push(textOnly(contentToParts(item.content)));
        else if (item.role === 'user' || item.role === 'assistant') push(item.role, contentToParts(item.content));
        else throw new BridgeError('invalid_request', `Unsupported input role: ${item.role}`);
        break;
      case 'function_call':
        push('assistant', [{
          type: 'tool_call',
          id: String(item.call_id ?? item.id),
          name: String(item.name ?? ''),
          arguments: String(item.arguments ?? '{}'),
        }]);
        break;
      case 'function_call_output':
        push('tool', [{ type: 'tool_result', toolCallId: String(item.call_id), content: outputToText(item.output) }]);
        break;
      // reasoning, item_reference and built-in tool items are ignored.
    }
  }

  const tools = Array.isArray(body.tools)
    ? body.tools
        .filter((t: any) => t?.type === 'function' && t.name)
        .map((t: any) => ({
          name: String(t.name),
          description: t.description,
          parameters: t.parameters ?? { type: 'object', properties: {} },
        }))
    : undefined;

  return {
    model,
    system: system.length ? system.join('\n\n') : undefined,
    messages,
    tools: tools?.length ? tools : undefined,
    toolChoice: parseToolChoice(body.tool_choice),
    maxTokens: body.max_output_tokens,
    temperature: body.temperature,
    stream: body.stream === true,
  };
}

// ---------------------------------------------------------------------------
// Response building
// ---------------------------------------------------------------------------
interface OutputText { type: 'output_text'; text: string; annotations: [] }

function baseResponse(id: string, createdAt: number, body: any, model: string) {
  return {
    id,
    object: 'response',
    created_at: createdAt,
    status: 'in_progress' as string,
    error: null,
    incomplete_details: null as null | { reason: string },
    instructions: body.instructions ?? null,
    max_output_tokens: body.max_output_tokens ?? null,
    model,
    output: [] as object[],
    parallel_tool_calls: body.parallel_tool_calls ?? true,
    previous_response_id: body.previous_response_id ?? null,
    temperature: body.temperature ?? 1,
    text: body.text ?? { format: { type: 'text' } },
    tool_choice: body.tool_choice ?? 'auto',
    tools: body.tools ?? [],
    top_p: body.top_p ?? 1,
    truncation: body.truncation ?? 'disabled',
    usage: null as null | object,
    metadata: body.metadata ?? {},
    store: body.store ?? true,
  };
}

const usageOf = (u: { inputTokens: number; outputTokens: number }) => ({
  input_tokens: u.inputTokens,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: u.outputTokens,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: u.inputTokens + u.outputTokens,
});

function finish(resp: ReturnType<typeof baseResponse>, c: Collected) {
  resp.status = c.stopReason === 'length' ? 'incomplete' : 'completed';
  resp.incomplete_details = c.stopReason === 'length' ? { reason: 'max_output_tokens' } : null;
  resp.usage = usageOf(c.usage);
  return resp;
}

export function newResponseId(): string { return rid('resp'); }

export function responsesResponse(id: string, c: Collected, body: any, model: string) {
  const resp = baseResponse(id, Math.floor(Date.now() / 1000), body, model);
  if (c.text) {
    resp.output.push({
      type: 'message', id: rid('msg'), status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: c.text, annotations: [] } satisfies OutputText],
    });
  }
  for (const t of c.toolCalls) {
    resp.output.push({ type: 'function_call', id: rid('fc'), call_id: t.id, name: t.name, arguments: t.arguments, status: 'completed' });
  }
  return { ...finish(resp, c), output_text: c.text };
}

export async function* responsesStream(
  id: string,
  events: AsyncIterable<StreamEvent>,
  body: any,
  model: string,
  onDone: (c: Collected) => void,
): AsyncGenerator<string> {
  let seq = 0;
  const sse = (type: string, data: object) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`;

  const resp = baseResponse(id, Math.floor(Date.now() / 1000), body, model);
  const collected: Collected = { text: '', toolCalls: [], stopReason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } };

  yield sse('response.created', { response: resp });
  yield sse('response.in_progress', { response: resp });

  // Currently open text message item, if any.
  let msg: { id: string; index: number; text: string } | null = null;

  function* closeMessage() {
    if (!msg) return;
    const part: OutputText = { type: 'output_text', text: msg.text, annotations: [] };
    const item = { type: 'message', id: msg.id, status: 'completed', role: 'assistant', content: [part] };
    yield sse('response.output_text.done', { item_id: msg.id, output_index: msg.index, content_index: 0, text: msg.text });
    yield sse('response.content_part.done', { item_id: msg.id, output_index: msg.index, content_index: 0, part });
    yield sse('response.output_item.done', { output_index: msg.index, item });
    resp.output[msg.index] = item;
    msg = null;
  }

  for await (const ev of events) {
    if (ev.type === 'text') {
      if (!msg) {
        msg = { id: rid('msg'), index: resp.output.length, text: '' };
        const item = { type: 'message', id: msg.id, status: 'in_progress', role: 'assistant', content: [] };
        resp.output.push(item);
        yield sse('response.output_item.added', { output_index: msg.index, item });
        yield sse('response.content_part.added', {
          item_id: msg.id, output_index: msg.index, content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        });
      }
      msg.text += ev.text;
      collected.text += ev.text;
      yield sse('response.output_text.delta', { item_id: msg.id, output_index: msg.index, content_index: 0, delta: ev.text });
    } else if (ev.type === 'tool_call') {
      yield* closeMessage();
      collected.toolCalls.push({ id: ev.id, name: ev.name, arguments: ev.arguments });
      const index = resp.output.length;
      const itemId = rid('fc');
      const item = { type: 'function_call', id: itemId, call_id: ev.id, name: ev.name, arguments: '', status: 'in_progress' };
      resp.output.push(item);
      yield sse('response.output_item.added', { output_index: index, item });
      yield sse('response.function_call_arguments.delta', { item_id: itemId, output_index: index, delta: ev.arguments });
      yield sse('response.function_call_arguments.done', { item_id: itemId, output_index: index, arguments: ev.arguments });
      const done = { ...item, arguments: ev.arguments, status: 'completed' };
      resp.output[index] = done;
      yield sse('response.output_item.done', { output_index: index, item: done });
    } else {
      yield* closeMessage();
      collected.stopReason = ev.stopReason;
      if (ev.usage) collected.usage = ev.usage;
      finish(resp, collected);
      onDone(collected);
      yield sse(resp.status === 'incomplete' ? 'response.incomplete' : 'response.completed', { response: resp });
    }
  }
}

export const responsesStreamError = (err: BridgeError) =>
  `event: error\ndata: ${JSON.stringify({ type: 'error', code: err.kind, message: err.message, param: null })}\n\n`;
