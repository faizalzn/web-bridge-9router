import type { ChatRequest, ContentPart, Message, StopReason, StreamEvent, ToolChoice } from '../core/types.ts';
import { BridgeError } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { requireString, type Collected } from '../core/pipeline.ts';

const STOP: Record<StopReason, string> = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use' };

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n');
  }
  return '';
}

function toParts(content: unknown): ContentPart[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) throw new BridgeError('invalid_request', 'message content must be a string or an array');
  const parts: ContentPart[] = [];
  for (const b of content) {
    switch (b?.type) {
      case 'text':
        parts.push({ type: 'text', text: String(b.text ?? '') });
        break;
      case 'image':
        parts.push(
          b.source?.type === 'base64'
            ? { type: 'image', mediaType: b.source.media_type, data: b.source.data }
            : { type: 'image', url: b.source?.url },
        );
        break;
      case 'tool_use':
        parts.push({ type: 'tool_call', id: String(b.id), name: String(b.name), arguments: JSON.stringify(b.input ?? {}) });
        break;
      case 'tool_result':
        parts.push({
          type: 'tool_result',
          toolCallId: String(b.tool_use_id),
          content: textOf(b.content),
          isError: b.is_error === true,
        });
        break;
      // thinking, redacted_thinking and document blocks are ignored for now.
    }
  }
  return parts;
}

function parseToolChoice(tc: any): ToolChoice | undefined {
  switch (tc?.type) {
    case 'auto': return 'auto';
    case 'any': return 'required';
    case 'none': return 'none';
    case 'tool': return { name: String(tc.name) };
    default: return undefined;
  }
}

export function parseAnthropicRequest(body: any): ChatRequest {
  const model = requireString(body?.model, 'model');
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new BridgeError('invalid_request', '"messages" must be a non-empty array');
  }
  const messages: Message[] = body.messages.map((m: any) => {
    if (m?.role !== 'user' && m?.role !== 'assistant') {
      throw new BridgeError('invalid_request', `Unsupported message role: ${m?.role}`);
    }
    return { role: m.role, content: toParts(m.content) };
  });
  const tools = Array.isArray(body.tools)
    ? body.tools
        .filter((t: any) => t?.name && t.input_schema)
        .map((t: any) => ({ name: String(t.name), description: t.description, parameters: t.input_schema }))
    : undefined;

  return {
    model,
    system: textOf(body.system) || undefined,
    messages,
    tools: tools?.length ? tools : undefined,
    toolChoice: parseToolChoice(body.tool_choice),
    maxTokens: body.max_tokens,
    temperature: body.temperature,
    stream: body.stream === true,
  };
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

export function anthropicResponse(c: Collected, model: string) {
  const content: object[] = [];
  if (c.text || c.toolCalls.length === 0) content.push({ type: 'text', text: c.text });
  for (const t of c.toolCalls) content.push({ type: 'tool_use', id: t.id, name: t.name, input: safeJson(t.arguments) });
  return {
    id: newId.message(),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: STOP[c.stopReason],
    stop_sequence: null,
    usage: { input_tokens: c.usage.inputTokens, output_tokens: c.usage.outputTokens },
  };
}

const sse = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;

export async function* anthropicStream(
  events: AsyncIterable<StreamEvent>,
  model: string,
  inputTokens: number,
): AsyncGenerator<string> {
  yield sse('message_start', {
    message: {
      id: newId.message(), type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });
  yield sse('ping', {});

  let index = -1;
  let textOpen = false;

  for await (const ev of events) {
    if (ev.type === 'text') {
      if (!textOpen) {
        index++;
        textOpen = true;
        yield sse('content_block_start', { index, content_block: { type: 'text', text: '' } });
      }
      yield sse('content_block_delta', { index, delta: { type: 'text_delta', text: ev.text } });
      continue;
    }

    if (textOpen) {
      yield sse('content_block_stop', { index });
      textOpen = false;
    }

    if (ev.type === 'tool_call') {
      index++;
      yield sse('content_block_start', { index, content_block: { type: 'tool_use', id: ev.id, name: ev.name, input: {} } });
      yield sse('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: ev.arguments } });
      yield sse('content_block_stop', { index });
    } else {
      yield sse('message_delta', {
        delta: { stop_reason: STOP[ev.stopReason], stop_sequence: null },
        usage: { output_tokens: ev.usage?.outputTokens ?? 0 },
      });
      yield sse('message_stop', {});
    }
  }
}

const ERROR_TYPE: Record<BridgeError['kind'], string> = {
  invalid_request: 'invalid_request_error',
  authentication: 'authentication_error',
  not_found: 'not_found_error',
  rate_limit: 'rate_limit_error',
  provider: 'api_error',
  unavailable: 'overloaded_error',
  internal: 'api_error',
};

export function anthropicError(err: BridgeError) {
  return { type: 'error', error: { type: ERROR_TYPE[err.kind], message: err.message } };
}

export const anthropicStreamError = (err: BridgeError) => `event: error\ndata: ${JSON.stringify(anthropicError(err))}\n\n`;
