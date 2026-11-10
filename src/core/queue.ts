import { setTimeout as sleep } from 'node:timers/promises';
import { BridgeError } from './errors.ts';

export interface QueueOptions {
  /** Minimum pause between the end of one request and the start of the next, in ms. */
  minGapMs: number;
  /** Extra random pause (0..jitterMs) so requests are not evenly spaced. */
  jitterMs: number;
  /** Requests allowed to wait per key; more are rejected with 429. */
  maxWaiting: number;
  /** Longest a request may wait for its turn, in ms. */
  maxWaitMs: number;
}

interface KeyState { busy: boolean; waiting: (() => void)[]; lastEnd: number }

/**
 * One request at a time per account, like a person using one chat window. Without this, 9router
 * (or several clients) could fire many parallel requests at one account, which both looks like
 * automation and trips provider limits.
 */
export class AccountQueue {
  private readonly opts: QueueOptions;
  private readonly keys = new Map<string, KeyState>();

  constructor(opts: QueueOptions) { this.opts = opts; }

  waiting(key: string): number { return this.keys.get(key)?.waiting.length ?? 0; }

  /** Resolves with a `release` function once it is this request's turn. */
  async acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    const st = this.keys.get(key) ?? { busy: false, waiting: [], lastEnd: 0 };
    this.keys.set(key, st);

    if (st.busy) {
      if (st.waiting.length >= this.opts.maxWaiting) {
        throw new BridgeError('rate_limit', `Too many requests are waiting for this account (${st.waiting.length}). Slow down or add accounts.`);
      }
      await new Promise<void>((resolve, reject) => {
        const turn = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(); };
        const leave = () => { const i = st.waiting.indexOf(turn); if (i !== -1) st.waiting.splice(i, 1); };
        const timer = setTimeout(() => { leave(); reject(new BridgeError('rate_limit', 'Waited too long for this account to become free')); }, this.opts.maxWaitMs);
        const onAbort = () => { clearTimeout(timer); leave(); reject(new Error('aborted')); };
        signal?.addEventListener('abort', onAbort, { once: true });
        st.waiting.push(turn);
      });
    } else {
      st.busy = true;
    }

    // `busy` stays true while we pause, so nobody can overtake us.
    const gap = Math.max(0, st.lastEnd + this.opts.minGapMs + Math.random() * this.opts.jitterMs - Date.now());
    if (gap > 0) {
      try { await sleep(gap, undefined, { signal }); } catch (err) { this.handOver(st); throw err; }
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      st.lastEnd = Date.now();
      this.handOver(st);
    };
  }

  private handOver(st: KeyState): void {
    const next = st.waiting.shift();
    if (next) next(); else st.busy = false;
  }
}
