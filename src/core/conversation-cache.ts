import { createHash, type Hash } from 'node:crypto';
import { messageText } from './prompt.ts';
import type { Message } from './types.ts';

// Hybrid conversation strategy. 9router resends the whole history on every request. When the
// history only grows by new messages, the web chat already knows everything before them and
// only the new part needs to be sent. This cache remembers which web conversation belongs to
// which history. Anything it does not recognise (edited history, new chat) starts a new chat.

export interface Entry<T> { ref: T; touched: number }

export class ConversationCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly onExpire?: (ref: T) => void;

  constructor(opts: { max: number; ttlMs: number; onExpire?: (ref: T) => void }) {
    this.max = opts.max;
    this.ttlMs = opts.ttlMs;
    this.onExpire = opts.onExpire;
  }

  get size(): number { return this.entries.size; }

  private static line(system: string | undefined, m: Message): string {
    return `${m.role}\u0000${messageText(m)}\u0001`;
  }

  /** Fingerprint of every prefix that ends with an assistant message, from short to long. */
  private prefixes(scope: string, system: string | undefined, messages: Message[]): { count: number; key: string }[] {
    const h: Hash = createHash('sha1').update(`${scope}\u0002${system ?? ''}\u0002`);
    const out: { count: number; key: string }[] = [];
    messages.forEach((m, i) => {
      h.update(ConversationCache.line(system, m));
      if (m.role === 'assistant') out.push({ count: i + 1, key: h.copy().digest('hex') });
    });
    return out;
  }

  /** Remember that `messages` (ending with the assistant's reply) is the content of `ref`. */
  put(scope: string, system: string | undefined, messages: Message[], ref: T): void {
    const last = this.prefixes(scope, system, messages).at(-1);
    if (!last || last.count !== messages.length) return;
    this.remember(scope, system, messages);
    this.entries.delete(last.key);
    this.entries.set(last.key, { ref, touched: Date.now() });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value!;
      this.expire(oldest);
    }
  }

  /** Longest known prefix of `messages`; `consumed` is how many messages the chat already has. */
  find(scope: string, system: string | undefined, messages: Message[]): { ref: T; consumed: number } | null {
    const now = Date.now();
    for (const { count, key } of this.prefixes(scope, system, messages).reverse()) {
      const hit = this.entries.get(key);
      if (!hit) continue;
      if (now - hit.touched > this.ttlMs) { this.expire(key); continue; }
      if (count >= messages.length) continue; // nothing new to send
      hit.touched = now;
      return { ref: hit.ref, consumed: count };
    }
    return null;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Why a history that looks like a continuation was not continued (for the log). Only the last few histories per
  // scope are kept, as text, in memory.

  private readonly recent = new Map<string, { system: string; lines: string[] }[]>();

  private remember(scope: string, system: string | undefined, messages: Message[]): void {
    const list = this.recent.get(scope) ?? [];
    list.unshift({ system: system ?? '', lines: messages.map((m) => ConversationCache.line(system, m)) });
    this.recent.set(scope, list.slice(0, 20));
  }

  /**
   * For a request that carries earlier assistant turns but matched no chat: what differs from the closest history
   * this cache remembered. `reason` is safe for the info log; `detail` quotes the text around the difference.
   * Null when nothing related is remembered (a different conversation) or the history only expired.
   */
  explainMiss(scope: string, system: string | undefined, messages: Message[]): { reason: string; detail: string } | null {
    if (!messages.some((m) => m.role === 'assistant')) return null;
    const sys = system ?? '';
    const lines = messages.map((m) => ConversationCache.line(system, m));
    let best: { system: string; lines: string[] } | null = null;
    let bestCommon = 0;
    for (const h of this.recent.get(scope) ?? []) {
      let i = 0;
      while (i < lines.length && i < h.lines.length && lines[i] === h.lines[i]) i++;
      if (i > bestCommon || (i === bestCommon && best && best.system !== sys && h.system === sys)) { best = h; bestCommon = i; }
    }
    if (!best || bestCommon === 0) return null; // not even the first message is known: another conversation
    const around = (a: string, b: string): string => {
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      const cut = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 60), i + 60));
      return `at character ${i}: before ${cut(a)}, now ${cut(b)}`;
    };
    if (best.system !== sys) {
      return { reason: `the system prompt changed (${best.system.length} -> ${sys.length} chars)`, detail: around(best.system, sys) };
    }
    if (bestCommon >= best.lines.length) return null; // the remembered chat would match: it expired or was dropped
    const m = messages[bestCommon];
    return {
      reason: m ? `message ${bestCommon + 1} (${m.role}) differs from the remembered chat` : 'the history is shorter than the remembered chat',
      detail: m ? around(best.lines[bestCommon]!, lines[bestCommon]!) : '',
    };
  }

  /** Drops entries idle for longer than the TTL (and reports them, e.g. to delete the web chat). */
  sweep(now = Date.now()): void {
    for (const [key, e] of this.entries) if (now - e.touched > this.ttlMs) this.expire(key);
  }

  /** Reports and drops everything (used on shutdown). */
  clear(): void {
    for (const key of [...this.entries.keys()]) this.expire(key);
  }

  private expire(key: string): void {
    const e = this.entries.get(key);
    this.entries.delete(key);
    if (e) this.onExpire?.(e.ref);
  }
}
