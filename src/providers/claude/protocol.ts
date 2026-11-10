// claude.ai web protocol, as observed from the page itself (10 Nov 2026):
//   POST /api/organizations/{org}/chat_conversations/{chat}/completion   (Accept: text/event-stream)
// A new chat is created by its first completion (body carries `create_conversation_params`); later turns name the
// previous assistant message in `parent_message_uuid`. The stream uses the Messages API event names.

import { randomUUID } from 'node:crypto';

export const CLAUDE_ORIGIN = 'https://claude.ai';

export type ClaudeErrorKind = 'auth' | 'rate_limit' | 'blocked' | 'bad_model' | 'temporary' | 'protocol';

export class ClaudeError extends Error {
  readonly kind: ClaudeErrorKind;
  constructor(kind: ClaudeErrorKind, message: string) {
    super(message);
    this.name = 'ClaudeError';
    this.kind = kind;
  }
}

/** Where a web chat stands: its id and the assistant message the next turn answers to. */
export interface ClaudeConv { chat: string; parent: string }

export interface CompletionInput {
  prompt: string;
  model: string;
  effort?: string;
  conv: ClaudeConv | null;
  timezone?: string;
}

/** UUID v7 (time-ordered), the form the page uses for message ids. */
export function uuidv7(now = Date.now()): string {
  const hex = now.toString(16).padStart(12, '0').slice(-12);
  const rnd = randomUUID().replace(/-/g, '');
  const variant = ((parseInt(rnd[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${rnd.slice(13, 16)}-${variant}${rnd.slice(17, 20)}-${rnd.slice(20, 32)}`;
}

/**
 * Body of one completion. The page also sends the account's connector tools (documents, web search, widgets);
 * the gateway sends none, so the model can never act on the user's account by itself.
 */
export function buildCompletion(org: string, input: CompletionInput): { url: string; chat: string; body: string } {
  const chat = input.conv?.chat ?? randomUUID();
  const body: Record<string, unknown> = {
    prompt: input.prompt,
    ...(input.conv ? { parent_message_uuid: input.conv.parent } : {}),
    timezone: input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: 'en-US',
    model: input.model,
    ...(input.effort ? { effort: input.effort } : {}),
    thinking_mode: 'auto',
    tools: [],
    turn_message_uuids: { human_message_uuid: uuidv7(), assistant_message_uuid: uuidv7() },
    attachments: [],
    files: [],
    sync_sources: [],
    completion_request_id: randomUUID(),
    rendering_mode: 'messages',
    ...(input.conv ? {} : {
      create_conversation_params: {
        name: '', model: input.model, include_conversation_preferences: true,
        paprika_mode: null, compass_mode: null, tool_search_mode: 'auto', is_temporary: false, enabled_imagine: false,
      },
    }),
  };
  return { url: `${CLAUDE_ORIGIN}/api/organizations/${org}/chat_conversations/${chat}/completion`, chat, body: JSON.stringify(body) };
}

/** Quota state the page reports after each answer. */
export interface ClaudeLimit { status: string; fiveHour?: number; sevenDay?: number; resetsAt?: string }

export type ClaudeUpdate =
  | { type: 'text'; text: string }
  | { type: 'message'; uuid: string }
  | { type: 'stop'; reason: string }
  | { type: 'limit'; limit: ClaudeLimit };

/** Turns the event stream into text deltas and bookkeeping. Thinking and tool blocks are left out. */
export class ClaudeStreamParser {
  private buf = '';
  private readonly textBlocks = new Set<number>();
  sawEvent = false;

  push(chunk: string): ClaudeUpdate[] {
    this.buf += chunk.replace(/\r\n/g, '\n');
    const out: ClaudeUpdate[] = [];
    let cut: number;
    while ((cut = this.buf.indexOf('\n\n')) !== -1) {
      const raw = this.buf.slice(0, cut);
      this.buf = this.buf.slice(cut + 2);
      this.event(raw, out);
    }
    return out;
  }

  end(): ClaudeUpdate[] {
    const out: ClaudeUpdate[] = [];
    if (this.buf.trim()) this.event(this.buf, out);
    this.buf = '';
    return out;
  }

  private event(raw: string, out: ClaudeUpdate[]): void {
    const data = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!data) return;
    let e: any;
    try { e = JSON.parse(data); } catch { throw new ClaudeError('protocol', `Unreadable event from claude.ai: ${data.slice(0, 120)}`); }
    this.sawEvent = true;
    switch (e?.type) {
      case 'message_start':
        if (typeof e.message?.uuid === 'string') out.push({ type: 'message', uuid: e.message.uuid });
        break;
      case 'content_block_start':
        if (e.content_block?.type === 'text') {
          this.textBlocks.add(e.index);
          if (e.content_block.text) out.push({ type: 'text', text: e.content_block.text });
        }
        break;
      case 'content_block_delta':
        if (e.delta?.type === 'text_delta' && this.textBlocks.has(e.index) && e.delta.text) out.push({ type: 'text', text: e.delta.text });
        break;
      case 'message_delta':
        if (e.delta?.stop_reason) out.push({ type: 'stop', reason: e.delta.stop_reason });
        break;
      case 'message_limit': {
        const m = e.message_limit ?? {};
        const w = m.windows ?? {};
        const limit: ClaudeLimit = { status: String(m.type ?? m.resolved?.status ?? 'unknown') };
        if (typeof w['5h']?.utilization === 'number') limit.fiveHour = w['5h'].utilization;
        if (typeof w['7d']?.utilization === 'number') limit.sevenDay = w['7d'].utilization;
        const resets = m.resolved?.limit?.resets_at ?? (typeof m.resetsAt === 'number' ? new Date(m.resetsAt * 1000).toISOString() : undefined);
        if (resets) limit.resetsAt = String(resets);
        out.push({ type: 'limit', limit });
        break;
      }
      case 'error':
        throw errorFromBody(0, JSON.stringify(e));
      default:
        break; // ping, conversation_ready, content_block_stop, message_stop, ...
    }
  }
}

/** Maps a non-200 answer (or an error event) of the completion endpoint to an error kind. */
export function errorFromBody(status: number, text: string): ClaudeError {
  if (/cf-chl|challenge-platform|Just a moment\.\.\./i.test(text)) {
    return new ClaudeError('blocked', `claude.ai answered with a Cloudflare bot check (HTTP ${status}); the gateway does not try to get past it`);
  }
  let type = '';
  let message = '';
  try {
    const j = JSON.parse(text);
    type = String(j?.error?.type ?? j?.type ?? '');
    message = String(j?.error?.message ?? j?.message ?? '');
  } catch { message = text.slice(0, 200); }
  const detail = message ? `: ${message.slice(0, 300)}` : '';
  if (status === 429 || /rate_limit|exceeded_limit/.test(type + message)) {
    let when = '';
    try { const inner = JSON.parse(message); if (inner?.resetsAt) when = ` (resets ${new Date(inner.resetsAt * 1000).toISOString()})`; } catch { /* plain text */ }
    return new ClaudeError('rate_limit', `The claude.ai usage limit of this account is reached${when}`);
  }
  if (status === 401 || (status === 403 && /permission|session|auth|account/i.test(type + message) && !/model/i.test(message))) {
    return new ClaudeError('auth', `claude.ai answered HTTP ${status}${detail}`);
  }
  if ((status === 400 || status === 403 || status === 404) && /model/i.test(message)) return new ClaudeError('bad_model', `claude.ai refused the model${detail}`);
  if (status >= 500 || /overloaded/.test(type)) return new ClaudeError('temporary', `claude.ai answered HTTP ${status || 'error'}${detail}`);
  return new ClaudeError('protocol', `claude.ai answered HTTP ${status || 'error'}${type ? ' ' + type : ''}${detail}`);
}
