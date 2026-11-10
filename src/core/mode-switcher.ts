import { logger } from './logger.ts';

/**
 * Remembers which transport works for each account and decides the order to try them in.
 * Modes are ordered from lightest to heaviest. When a mode breaks (the web app changed), the next
 * one takes over; every `retryLighterMs` the lighter modes get another chance, so the gateway
 * returns to the cheap mode by itself once the problem is fixed (for example by a manifest update).
 */
export class ModeSwitcher<M extends string> {
  private readonly order: M[];
  private readonly retryLighterMs: number;
  private readonly state = new Map<string, { index: number; reason: string; since: number; lastProbe: number }>();

  constructor(order: M[], retryLighterMs = 10 * 60_000) {
    this.order = order;
    this.retryLighterMs = retryLighterMs;
  }

  /** Modes to try for the next request, best first. */
  plan(key: string, now = Date.now()): M[] {
    const st = this.state.get(key);
    if (!st || st.index === 0) return [...this.order];
    // Time to give the lighter modes another chance? Then they go first, with the others as backup.
    if (now - st.lastProbe >= this.retryLighterMs) { st.lastProbe = now; return [...this.order]; }
    return this.order.slice(st.index);
  }

  /** The mode that is currently preferred. */
  current(key: string): M {
    return this.order[this.state.get(key)?.index ?? 0]!;
  }

  succeeded(key: string, mode: M): void {
    const idx = this.order.indexOf(mode);
    const st = this.state.get(key);
    if (!st) return;
    if (idx < st.index) {
      logger.info(`${key}: mode ${mode} works again, switching back`);
      this.state.delete(key);
    }
  }

  failed(key: string, mode: M, reason: string, now = Date.now()): void {
    const idx = this.order.indexOf(mode);
    const st = this.state.get(key);
    if (!st) {
      if (idx + 1 < this.order.length) {
        logger.warn(`${key}: mode ${mode} failed (${reason}); falling back to ${this.order[idx + 1]}`);
        this.state.set(key, { index: idx + 1, reason: `${mode}: ${reason}`, since: now, lastProbe: now });
      }
    } else if (idx >= st.index && idx + 1 < this.order.length) {
      logger.warn(`${key}: mode ${mode} failed (${reason}); falling back to ${this.order[idx + 1]}`);
      st.index = idx + 1;
      st.reason = `${mode}: ${reason}`;
      st.since = now;
      st.lastProbe = now;
    }
  }

  describe(key: string): { mode: M; reason?: string; since?: number } {
    const st = this.state.get(key);
    return st ? { mode: this.order[st.index]!, reason: st.reason, since: st.since } : { mode: this.order[0]! };
  }
}
