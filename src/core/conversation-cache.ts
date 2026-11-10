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
