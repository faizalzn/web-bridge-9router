import type { ChatRequest, ContentPart, Message, StreamEvent, ToolChoice, ToolDef } from './types.ts';
import { newId } from './ids.ts';
import { logger } from './logger.ts';
import { CALL_CLOSE, CALL_OPEN, renderToolCall, renderToolResult } from './tool-format.ts';

// Tool calling for providers that only speak text (web chats). The request is rewritten so the model is told how
// to write a tool call and sees earlier calls/results as text; its reply is scanned for those calls and turned back
// into real `tool_call` events. Everything is provider independent: providers never see `tools`.

const BACKSLASH = String.fromCharCode(92);
const FENCE_AT_END = /```[A-Za-z]*[ \t]*\r?\n?[ \t]*$/;
const FENCE_EDGES = /^\s*```[A-Za-z]*\s*|\s*```\s*$/g;

// ---------------------------------------------------------------------------------------------------------------
// request side
// ---------------------------------------------------------------------------------------------------------------

/** Replaces tool calls and results by their text form, so that a text-only chat can carry them. */
export function textifyToolParts(messages: Message[]): Message[] {
  const names = new Map<string, string>();
  for (const m of messages) for (const p of m.content) if (p.type === 'tool_call') names.set(p.id, p.name);

  return messages.map((m) => {
    const content = m.content.map((p): ContentPart => {
      if (p.type === 'tool_call') return { type: 'text', text: renderToolCall(p.name, p.arguments) };
      if (p.type === 'tool_result') return { type: 'text', text: renderToolResult(names.get(p.toolCallId), p.content, p.isError) };
      return p;
    });
    // Anthropic puts tool results in user messages; treat a message of only results as the tool's turn.
    const onlyResults = m.role !== 'assistant' && m.content.length > 0 && m.content.every((p) => p.type === 'tool_result');
    return { role: onlyResults ? 'tool' : m.role, content };
  });
}

const NOISE_KEYS = new Set(['$schema', 'additionalProperties']);

/** Drops schema keys that cost tokens without helping the model. */
function slim(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(slim);
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema)) if (!NOISE_KEYS.has(k)) out[k] = slim(v);
    return out;
  }
  return schema;
}

/** The text that teaches the model how to call the tools of this request. */
export function toolInstructions(tools: ToolDef[], choice: ToolChoice | undefined): string {
  const must = choice === 'required'
    ? '\n9. In your next reply you MUST call at least one tool.'
    : choice && typeof choice === 'object' && tools.some((t) => t.name === choice.name)
      ? `\n9. In your next reply you MUST call the tool "${choice.name}".`
      : '';
  const list = tools.map((t) => JSON.stringify({ name: t.name, description: t.description, parameters: slim(t.parameters) }));
  return [
    '## Tool use',
    '',
    'You can act through tools. Each tool is listed below as JSON: its name, what it does, and the JSON schema of its arguments.',
    '',
    'To use a tool, write a block in exactly this form:',
    '',
    `${CALL_OPEN}{"name": "TOOL_NAME", "arguments": {"ARGUMENT": "VALUE"}}${CALL_CLOSE}`,
    '',
    'Rules:',
    '1. Write valid JSON: double quotes, no comments, and line breaks inside strings written as ' + BACKSLASH + 'n.',
    '2. Use only the listed tools and only the arguments in their schema. Never invent a tool.',
    '3. You may write a short sentence before the block. Write nothing after it: stop right after the closing tag.',
    '   The system runs the tool and sends the result in the next message as <tool_result name="TOOL_NAME">...</tool_result>.',
    '4. Never write a <tool_result> yourself and never guess what a tool would return.',
    `5. To run several independent tools at once, write several ${CALL_OPEN} blocks one after another.`,
    '6. If you do not need a tool, answer in plain text without any block.',
    '7. Do not put the block inside a code fence.',
    '8. You cannot run code, browse the web or create files yourself. To act on anything, always use a listed tool.' + must,
    '',
    'Available tools:',
    '<tools>',
    ...list,
    '</tools>',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// reply side
// ---------------------------------------------------------------------------------------------------------------

interface ParsedCall { name: string; arguments: string }
export type Piece = { type: 'text'; text: string } | ({ type: 'call' } & ParsedCall);

function resolveName(raw: string, tools: ToolDef[]): string | null {
  const exact = tools.find((t) => t.name === raw);
  if (exact) return exact.name;
  const lower = raw.replace(/^(?:functions|default_api|tools)[.:]/i, '').trim().toLowerCase();
  return tools.find((t) => t.name.toLowerCase() === lower)?.name ?? null;
}

/** Models often write a real line break inside a JSON string; JSON needs it escaped. */
function escapeControlsInStrings(json: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
    } else if (escaped) {
      escaped = false;
      out += ch;
    } else if (ch === BACKSLASH) {
      escaped = true;
      out += ch;
    } else if (ch === '"') {
      inString = false;
      out += ch;
    } else if (ch === '\n') {
      out += BACKSLASH + 'n';
    } else if (ch === '\r') {
      out += BACKSLASH + 'r';
    } else if (ch === '\t') {
      out += BACKSLASH + 't';
    } else {
      out += ch;
    }
  }
  return out;
}

function lenientJson(text: string): unknown {
  const s = text.replace(FENCE_EDGES, '').trim();
  try { return JSON.parse(s); } catch { /* repair below */ }
  return JSON.parse(escapeControlsInStrings(s).replace(/,\s*([}\]])/g, '$1'));
}

function parseCall(body: string, tools: ToolDef[]): ParsedCall | null {
  let v: any;
  try { v = lenientJson(body); } catch { return null; }
  if (!v || typeof v !== 'object' || typeof v.name !== 'string') return null;
  const name = resolveName(v.name, tools);
  if (!name) return null;
  let args: any = v.arguments ?? v.parameters ?? v.args ?? v.input ?? {};
  if (typeof args === 'string') { try { args = lenientJson(args); } catch { return null; } }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  return { name, arguments: JSON.stringify(args) };
}

/** Length of the longest suffix of `buf` that is a proper prefix of the opening tag. */
function partialTagAtEnd(buf: string): number {
  for (let n = Math.min(CALL_OPEN.length - 1, buf.length); n > 0; n--) {
    if (CALL_OPEN.startsWith(buf.slice(buf.length - n))) return n;
  }
  return 0;
}

/**
 * Start of a code-fence opener that may still be followed by a tool call: the opener (with its language and
 * whitespace) plus nothing, or plus only the beginning of the opening tag. -1 when there is none.
 */
function fenceStart(buf: string): number {
  const i = buf.lastIndexOf('```');
  if (i < 0) return -1;
  const opener = /^```[A-Za-z]*[ \t]*\r?\n?[ \t]*/.exec(buf.slice(i));
  if (!opener) return -1;
  return CALL_OPEN.startsWith(buf.slice(i + opener[0].length)) ? i : -1;
}

/** Index from which the end of `buf` must be held back: a partial tag, a fence opener, or trailing whitespace. */
function holdFrom(buf: string): number {
  let from = buf.length - partialTagAtEnd(buf);
  const fence = fenceStart(buf);
  if (fence >= 0 && fence < from) from = fence;
  const ticks = /`{1,2}$/.exec(buf); // the start of a fence that has not fully arrived
  if (ticks && ticks.index < from) from = ticks.index;
  while (from > 0 && /\s/.test(buf[from - 1]!)) from--;
  return from;
}

/**
 * Finds tool-call blocks in a reply that arrives in arbitrary pieces. Text before the first call is passed on as
 * soon as it is safe, a call is reported once its closing tag has arrived, and whatever the model writes after a
 * call is dropped (it can only be a guessed result). A block that is not a usable call stays visible as text.
 */
export class ToolCallScanner {
  private buf = '';
  private state: 'text' | 'call' | 'after' = 'text';
  private seenCall = false;
  /** Whitespace/fence removed in front of the call being read; given back if that block turns out not to be a call. */
  private stripped = '';
  private readonly tools: ToolDef[];

  constructor(tools: ToolDef[]) { this.tools = tools; }

  push(delta: string): Piece[] {
    this.buf += delta;
    const out: Piece[] = [];
    const text = (t: string) => {
      if (!t) return;
      const last = out.at(-1);
      if (last?.type === 'text') last.text += t; else out.push({ type: 'text', text: t });
    };

    for (;;) {
      if (this.state === 'text') {
        const i = this.buf.indexOf(CALL_OPEN);
        if (i >= 0) {
          const before = this.buf.slice(0, i);
          const kept = before.replace(FENCE_AT_END, '').trimEnd();
          text(kept);
          this.stripped = before.slice(kept.length);
          this.buf = this.buf.slice(i + CALL_OPEN.length);
          this.state = 'call';
          continue;
        }
        const from = holdFrom(this.buf);
        text(this.buf.slice(0, from));
        this.buf = this.buf.slice(from);
        return out;
      }
      if (this.state === 'call') {
        const i = this.buf.indexOf(CALL_CLOSE);
        if (i < 0) return out;
        const body = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + CALL_CLOSE.length);
        const call = parseCall(body, this.tools);
        const stripped = this.stripped;
        this.stripped = '';
        if (call) {
          out.push({ type: 'call', ...call });
          this.seenCall = true;
          this.state = 'after';
        } else {
          logger.warn(`tool call ignored (not valid JSON or unknown tool): ${body.trim().slice(0, 120)}`);
          text(stripped + CALL_OPEN + body + CALL_CLOSE);
          this.state = this.seenCall ? 'after' : 'text';
        }
        continue;
      }
      // after a call: only further calls matter
      const i = this.buf.indexOf(CALL_OPEN);
      if (i >= 0) { this.buf = this.buf.slice(i + CALL_OPEN.length); this.state = 'call'; continue; }
      this.buf = this.buf.slice(this.buf.length - partialTagAtEnd(this.buf));
      return out;
    }
  }

  /** The reply is complete: releases what was held back. */
  end(): Piece[] {
    const out: Piece[] = [];
    if (this.state === 'text') {
      const t = this.buf.trimEnd();
      if (t) out.push({ type: 'text', text: t });
    } else if (this.state === 'call') {
      // The closing tag never came (reply cut short, or the model forgot it): accept it only if it is complete JSON.
      const call = parseCall(this.buf, this.tools);
      if (call) out.push({ type: 'call', ...call });
      else out.push({ type: 'text', text: (this.stripped + CALL_OPEN + this.buf).trimEnd() });
    }
    this.buf = '';
    this.state = 'after';
    return out;
  }
}

/** Turns the text events of a provider into text and tool_call events. */
export async function* parseToolEvents(source: AsyncIterable<StreamEvent>, tools: ToolDef[]): AsyncGenerator<StreamEvent> {
  const scanner = new ToolCallScanner(tools);
  let called = false;
  let ended = false;
  const events = (pieces: Piece[]): StreamEvent[] => pieces.map((p): StreamEvent => {
    if (p.type === 'text') return { type: 'text', text: p.text };
    called = true;
    return { type: 'tool_call', id: newId.toolCall(), name: p.name, arguments: p.arguments };
  });

  for await (const ev of source) {
    if (ev.type === 'text') {
      yield* events(scanner.push(ev.text));
    } else if (ev.type === 'done') {
      if (!ended) { ended = true; yield* events(scanner.end()); }
      yield called ? { ...ev, stopReason: 'tool_calls' } : ev;
    } else {
      yield ev;
    }
  }
  if (!ended) {
    yield* events(scanner.end());
    yield { type: 'done', stopReason: called ? 'tool_calls' : 'stop' };
  }
}

/**
 * Canonical text of a raw reply: tool calls rewritten in the exact form `renderToolCall` gives. The provider
 * remembers this text for its chat, so the history a client resends (text plus tool_call parts) matches it.
 */
export function normalizeReply(raw: string, tools: ToolDef[]): string {
  const scanner = new ToolCallScanner(tools);
  const pieces = [...scanner.push(raw), ...scanner.end()];
  if (!pieces.some((p) => p.type === 'call')) return raw;
  return pieces.map((p) => (p.type === 'text' ? p.text : renderToolCall(p.name, p.arguments))).filter(Boolean).join('\n');
}

export interface ToolEmulation {
  /** The request as a text-only provider should see it. */
  request: ChatRequest;
  parse(source: AsyncIterable<StreamEvent>): AsyncGenerator<StreamEvent>;
  normalizeReply(raw: string): string;
}

/** Null when the request needs no emulation (no tools, or the client forbids tool use). */
export function prepareToolEmulation(req: ChatRequest): ToolEmulation | null {
  const tools = req.tools ?? [];
  if (tools.length === 0 || req.toolChoice === 'none') return null;
  const instructions = toolInstructions(tools, req.toolChoice);
  return {
    request: {
      ...req,
      system: req.system?.trim() ? `${req.system.trim()}\n\n${instructions}` : instructions,
      messages: textifyToolParts(req.messages),
      tools: undefined,
      toolChoice: undefined,
    },
    parse: (source) => parseToolEvents(source, tools),
    normalizeReply: (raw) => normalizeReply(raw, tools),
  };
}
