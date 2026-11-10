import type { ChatRequest, StreamEvent, StopReason, Usage } from './types.ts';
import { BridgeError } from './errors.ts';
import { estimateRequestTokens, estimateTokens } from './tokens.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { prepareToolEmulation, textifyToolParts } from './tool-emulation.ts';
import { logger } from './logger.ts';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}... (${s.length} chars)` : s);

/** What the client receives, so a client-side failure can be traced: a summary at INFO, the content at DEBUG. */
function logReply(model: string, text: string, calls: { name: string; arguments: string }[], stop: StopReason): void {
  const tools = calls.length ? calls.map((c) => c.name).join(', ') : 'none';
  logger.info(`reply ${model}: text ${text.length} chars, tool calls: ${tools}, stop ${stop}`);
  if (text) logger.debug(`  reply text: ${clip(text, 2000)}`);
  for (const c of calls) logger.debug(`  tool call ${c.name}: ${clip(c.arguments, 2000)}`);
}

export interface PreparedChat {
  inputTokens: number;
  /** Event stream that always ends with exactly one `done` event carrying usage. */
  events: AsyncGenerator<StreamEvent>;
}

/**
 * Resolves the provider and starts the chat. The first event is awaited before
 * returning, so early failures (unknown model, logged out, ...) surface as a
 * normal HTTP error instead of a broken stream.
 */
export async function startChat(registry: ProviderRegistry, req: ChatRequest, signal: AbortSignal): Promise<PreparedChat> {
  const { provider, localId, account } = registry.resolve(req.model);
  const inputTokens = estimateRequestTokens(req);
  // Providers that only speak text get tool calling emulated; the rest is passed through untouched.
  const emulation = provider.nativeTools ? null : prepareToolEmulation(req);
  const providerReq = provider.nativeTools
    ? req
    : emulation?.request ?? { ...req, tools: undefined, toolChoice: undefined, messages: textifyToolParts(req.messages) };
  const raw = provider.chat({ ...providerReq, model: localId, account, normalizeReply: emulation?.normalizeReply }, signal);
  const source = (emulation ? emulation.parse(raw) : raw)[Symbol.asyncIterator]();
  const first = await source.next();

  async function* run(): AsyncGenerator<StreamEvent> {
    let output = '';
    let text = '';
    const calls: { name: string; arguments: string }[] = [];
    let pending = first;
    let finished = false;
    try {
      while (!pending.done) {
        const ev = pending.value;
        if (ev.type === 'done') {
          logReply(req.model, text, calls, ev.stopReason);
          yield { ...ev, usage: ev.usage ?? { inputTokens, outputTokens: estimateTokens(output) } };
          // Let the adapter finish: whatever it does after `done` (saving state, releasing its
          // queue slot) only runs when its generator is driven to the end.
          while (!(await source.next()).done) { /* ignore anything after done */ }
          finished = true;
          return;
        }
        output += ev.type === 'text' ? ev.text : ev.arguments;
        if (ev.type === 'text') text += ev.text;
        else calls.push({ name: ev.name, arguments: ev.arguments });
        yield ev;
        pending = await source.next();
      }
      finished = true;
      // Adapter ended without a `done` event: close the stream cleanly.
      logReply(req.model, text, calls, 'stop');
      yield { type: 'done', stopReason: 'stop', usage: { inputTokens, outputTokens: estimateTokens(output) } };
    } finally {
      // Consumer stopped early (client disconnected) or something failed: run the adapter's cleanup.
      if (!finished) await Promise.resolve(source.return?.(undefined)).catch(() => {});
    }
  }

  return { inputTokens, events: run() };
}

export interface Collected {
  text: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  stopReason: StopReason;
  usage: Usage;
}

export async function collect(events: AsyncIterable<StreamEvent>): Promise<Collected> {
  const out: Collected = { text: '', toolCalls: [], stopReason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } };
  for await (const ev of events) {
    if (ev.type === 'text') out.text += ev.text;
    else if (ev.type === 'tool_call') out.toolCalls.push({ id: ev.id, name: ev.name, arguments: ev.arguments });
    else { out.stopReason = ev.stopReason; if (ev.usage) out.usage = ev.usage; }
  }
  return out;
}

export function requireString(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v) throw new BridgeError('invalid_request', `"${field}" must be a non-empty string`);
  return v;
}
