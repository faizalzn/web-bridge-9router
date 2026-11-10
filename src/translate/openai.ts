import type { ChatRequest, ContentPart, Message, StopReason, StreamEvent, ToolChoice } from '../core/types.ts';
import { BridgeError } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { requireString, type Collected } from '../core/pipeline.ts';

const FINISH: Record<StopReason, string> = { stop: 'stop', length: 'length', tool_calls: 'tool_calls' };

function parseDataUrl(url: string): { mediaType?: string; data?: string; url?: string } {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return m ? { mediaType: m[1], data: m[2] } : { url };
}

function toParts(content: unknown): ContentPart[] {
  if (content == null) return [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) throw new BridgeError('invalid_request', 'message content must be a string or an array');
  const parts: ContentPart[] = [];
  for (const p of content) {
    if (p?.type === 'text') parts.push({ type: 'text', text: String(p.text ?? '') });
    else if (p?.type === 'image_url') parts.push({ type: 'image', ...parseDataUrl(String(p.image_url?.url ?? '')) });
  }
  return parts;
}

const textOnly = (parts: ContentPart[]) => parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n');

function parseToolChoice(tc: any): ToolChoice | undefined {
  if (tc == null) return undefined;
  if (tc === 'auto' || tc === 'none' || tc === 'required') return tc;
  if (tc?.type === 'function' && tc.function?.name) return { name: String(tc.function.name) };
  return undefined;
}

export function parseOpenAIRequest(body: any): ChatRequest {
  const model = requireString(body?.model, 'model');
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new BridgeError('invalid_request', '"messages" must be a non-empty array');
  }

  const system: string[] = [];
  const messages: Message[] = [];
  for (const m of body.messages) {
    switch (m?.role) {
      case 'system':
      case 'developer':
        system.push(textOnly(toParts(m.content)));
        break;
      case 'user':
        messages.push({ role: 'user', content: toParts(m.content) });
        break;
      case 'assistant': {
        const content = toParts(m.content);
        for (const tc of m.tool_calls ?? []) {
          content.push({
            type: 'tool_call',
            id: String(tc.id ?? newId.toolCall()),
            name: String(tc.function?.name ?? ''),
            arguments: String(tc.function?.arguments ?? '{}'),
          });
        }
        messages.push({ role: 'assistant', content });
        break;
      }
      case 'tool':
        messages.push({
          role: 'tool',
          content: [{ type: 'tool_result', toolCallId: String(m.tool_call_id ?? ''), content: textOnly(toParts(m.content)) }],
        });
        break;
      default:
        throw new BridgeError('invalid_request', `Unsupported message role: ${m?.role}`);
    }
  }

  const tools = Array.isArray(body.tools)
    ? body.tools
        .filter((t: any) => t?.type === 'function' && t.function?.name)
        .map((t: any) => ({
          name: String(t.function.name),
          description: t.function.description,
          parameters: t.function.parameters ?? { type: 'object', properties: {} },
        }))
    : undefined;

  return {
    model,
    system: system.length ? system.join('\n\n') : undefined,
    messages,
    tools: tools?.length ? tools : undefined,
    toolChoice: parseToolChoice(body.tool_choice),
    maxTokens: body.max_completion_tokens ?? body.max_tokens,
    temperature: body.temperature,
    stream: body.stream === true,
  };
}

const usageOf = (c: { inputTokens: number; outputTokens: number }) => ({
  prompt_tokens: c.inputTokens,
  completion_tokens: c.outputTokens,
  total_tokens: c.inputTokens + c.outputTokens,
});

export function openAIResponse(c: Collected, model: string) {
  return {
    id: newId.chatCompletion(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: c.text || (c.toolCalls.length ? null : ''),
          ...(c.toolCalls.length > 0 && {
            tool_calls: c.toolCalls.map((t) => ({
              id: t.id,
              type: 'function',
              function: { name: t.name, arguments: t.arguments },
            })),
          }),
        },
        finish_reason: FINISH[c.stopReason],
      },
    ],
    usage: usageOf(c.usage),
  };
}

export async function* openAIStream(
  events: AsyncIterable<StreamEvent>,
  model: string,
  includeUsage: boolean,
): AsyncGenerator<string> {
  const base = { id: newId.chatCompletion(), object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model };
  const chunk = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

  yield chunk({ role: 'assistant', content: '' });
  let toolIndex = 0;
  for await (const ev of events) {
    if (ev.type === 'text') {
      yield chunk({ content: ev.text });
    } else if (ev.type === 'tool_call') {
      yield chunk({
        tool_calls: [{ index: toolIndex++, id: ev.id, type: 'function', function: { name: ev.name, arguments: ev.arguments } }],
      });
    } else {
      yield chunk({}, FINISH[ev.stopReason]);
      if (includeUsage && ev.usage) {
        yield `data: ${JSON.stringify({ ...base, choices: [], usage: usageOf(ev.usage) })}\n\n`;
      }
    }
  }
  yield 'data: [DONE]\n\n';
}

const ERROR_TYPE: Record<BridgeError['kind'], string> = {
  invalid_request: 'invalid_request_error',
  authentication: 'authentication_error',
  not_found: 'invalid_request_error',
  rate_limit: 'rate_limit_error',
  provider: 'api_error',
  unavailable: 'api_error',
  internal: 'api_error',
};

export function openAIError(err: BridgeError) {
  return {
    error: { message: err.message, type: ERROR_TYPE[err.kind], code: err.kind === 'not_found' ? 'model_not_found' : err.kind },
  };
}

export const openAIStreamError = (err: BridgeError) => `data: ${JSON.stringify(openAIError(err))}\n\n`;
