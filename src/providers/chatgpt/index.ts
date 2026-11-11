import { setTimeout as sleep } from 'node:timers/promises';
import { BrowserManager } from '../../browser/manager.ts';
import type { SessionService } from '../../auth/session-service.ts';
import { DEFAULT_ACCOUNT, sessionState, type StoredSession } from '../../auth/session-store.ts';
import { AUTH_SPECS } from '../../auth/specs.ts';
import type { ProviderConfig } from '../../core/config.ts';
import { BridgeError } from '../../core/errors.ts';
import { logger } from '../../core/logger.ts';
import { buildFreshPrompt } from '../../core/prompt.ts';
import { AccountQueue } from '../../core/queue.ts';
import type { StreamEvent } from '../../core/types.ts';
import type { ModelInfo, Provider, ProviderDeps, ProviderRequest, ProviderStatus } from '../base.ts';
import { ChatGPTDomTransport, ChatGPTError } from './dom.ts';

/** What the page sends as the model is picked in its own UI; the gateway uses whatever the web app is set to. */
const MODELS: ModelInfo[] = [{ id: 'auto', name: 'ChatGPT (web, current model)' }];

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);
const accountFlag = (a: string) => (a === DEFAULT_ACCOUNT ? '' : ` --account ${a}`);
const sec = (ms: number): string => (ms / 1000).toFixed(1) + 's';
const clock = (ms: number): string => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export interface ChatGPTTransport {
  send(session: StoredSession, input: { prompt: string; signal: AbortSignal }): AsyncGenerator<{ text: string }>;
  close?(): Promise<void>;
}

/**
 * ChatGPT through chatgpt.com, driven as a person would (mode C): the prompt is typed into the real page and the
 * answer is read from it. There is no request mode: chatgpt.com protects /backend-api/f/conversation with a
 * page-generated proof-of-work (sentinel) on top of Cloudflare, which the gateway will not forge. Each request is
 * a fresh chat. Tool calling is emulated by the gateway, as for the other providers.
 */
export class ChatGPTProvider implements Provider {
  readonly id = 'chatgpt';
  readonly name = 'ChatGPT (web)';

  private readonly sessions: SessionService;
  private readonly spec = AUTH_SPECS.chatgpt!;
  private readonly transport: ChatGPTTransport;
  private readonly queue: AccountQueue;
  private readonly pauseMs: number;
  private readonly paused = new Map<string, { until: number; streak: number; at: number }>();

  constructor(cfg: ProviderConfig, deps: ProviderDeps, transport?: ChatGPTTransport) {
    this.sessions = deps.sessions;
    this.transport = transport ?? new ChatGPTDomTransport(deps.browser ?? new BrowserManager(deps.config));
    this.pauseMs = num(cfg.bot_check_pause, 600) * 1000;
    this.queue = new AccountQueue({
      minGapMs: num(cfg.min_interval, 3) * 1000,
      jitterMs: num(cfg.jitter, 2) * 1000,
      maxWaiting: num(cfg.max_waiting, 6),
      maxWaitMs: num(cfg.max_wait, 300) * 1000,
    });
  }

  listModels(): ModelInfo[] { return MODELS; }

  accounts(): string[] {
    return this.sessions.store.list('chatgpt').map((s) => s.account)
      .sort((a, b) => (a === DEFAULT_ACCOUNT ? -1 : b === DEFAULT_ACCOUNT ? 1 : a.localeCompare(b)));
  }

  async status(): Promise<ProviderStatus> {
    const accounts = this.accounts();
    if (accounts.length === 0) return { loggedIn: false, detail: 'no login yet: run "bridge login chatgpt"' };
    const parts: string[] = [];
    let anyUsable = false;
    for (const a of accounts) {
      let state = 'unreadable';
      try {
        const s = this.sessions.get('chatgpt', a);
        if (s) {
          const st = sessionState(this.spec, s);
          state = st === 'ok' ? 'works' : st === 'dead' ? 'EXPIRED' : st === 'unverified' ? 'unverified' : 'logged out';
          anyUsable ||= (st === 'ok' || st === 'unverified') && s.held === true;
          if (!s.held) state += ', NOT held by a browser profile (log in again with session.hold_in_browser on)';
        }
      } catch { /* undecryptable */ }
      const p = this.paused.get(a);
      if (p && Date.now() < p.until) state += `, PAUSED after a Cloudflare bot check until ${clock(p.until)}`;
      parts.push(`${a}: ${state}, mode C`);
    }
    return { loggedIn: anyUsable, mode: 'C', detail: parts.join('; ') };
  }

  async *chat(req: ProviderRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const account = req.account ?? DEFAULT_ACCOUNT;
    if (req.model !== 'auto') throw new BridgeError('not_found', `Unknown ChatGPT model "${req.model}" (only chatgpt/auto is available)`);
    await this.ensureLogin(account);
    const pause = this.paused.get(account);
    if (pause && Date.now() < pause.until) {
      throw new BridgeError('unavailable', `chatgpt.com showed a Cloudflare bot check for account "${account}" at ${clock(pause.at)}; `
        + `requests are paused until ${clock(pause.until)} instead of being retried (the gateway does not try to get past the check)`);
    }

    const prompt = buildFreshPrompt(req.system, req.messages);
    if (!prompt.trim()) throw new BridgeError('invalid_request', 'The request has no text to send');

    const asked = Date.now();
    const release = await this.queue.acquire(`chatgpt:${account}`, signal);
    const started = Date.now();
    let firstMs: number | null = null;
    let ok = false;
    try {
      let emitted = '';
      try {
        for await (const u of this.transport.send(this.session(account), { prompt, signal })) {
          if (!u.text.startsWith(emitted)) { emitted = ''; } // the page rewrote earlier text: resync
          const delta = u.text.slice(emitted.length);
          emitted = u.text;
          if (!delta) continue;
          if (firstMs === null) firstMs = Date.now() - started;
          yield { type: 'text', text: delta };
        }
      } catch (err) {
        if (signal.aborted || err instanceof BridgeError) throw err;
        const ce = err instanceof ChatGPTError ? err : new ChatGPTError('protocol', (err as Error)?.message ?? String(err));
        if (ce.kind === 'blocked') throw this.pauseAccount(account, ce.message, emitted !== '');
        if (ce.kind === 'auth') throw this.authError(account);
        if (ce.kind === 'temporary') throw new BridgeError('unavailable', ce.message);
        throw new BridgeError('provider', emitted ? `The chatgpt.com answer was interrupted: ${ce.message}` : ce.message);
      }
      if (!emitted) throw new BridgeError('provider', 'chatgpt.com returned no answer text');
      yield { type: 'done', stopReason: 'stop' };
      ok = true;
      this.paused.delete(account);
    } finally {
      release();
      const outcome = ok ? 'ok' : signal.aborted ? 'client gave up' : 'failed';
      logger.info(`chatgpt auto: new chat, prompt ${prompt.length} chars, waited ${sec(started - asked)}, `
        + `first reply ${firstMs === null ? 'never' : sec(firstMs)}, total ${sec(Date.now() - started)}, mode C, ${outcome}`);
    }
  }

  private pauseAccount(account: string, message: string, streamed: boolean): BridgeError {
    const streak = (this.paused.get(account)?.streak ?? 0) + 1;
    const now = Date.now();
    const until = now + Math.min(this.pauseMs * 2 ** (streak - 1), Math.max(this.pauseMs, 3_600_000));
    this.paused.set(account, { until, streak, at: now });
    logger.warn(`chatgpt ${account}: Cloudflare bot check; requests for this account paused until ${clock(until)}`);
    const msg = `${message}. Requests for this account are paused until ${clock(until)}`;
    return new BridgeError(streamed ? 'provider' : 'unavailable', msg);
  }

  private session(account: string): StoredSession {
    const s = this.sessions.get('chatgpt', account);
    if (!s) throw new BridgeError('authentication', `No ChatGPT login for account "${account}". Run: bridge login chatgpt${accountFlag(account)}`);
    return s;
  }

  private authError(account: string): BridgeError {
    return new BridgeError('authentication',
      `chatgpt.com no longer accepts the saved login for account "${account}". Run: bridge login chatgpt${accountFlag(account)} --force`);
  }

  private async ensureLogin(account: string): Promise<void> {
    const s = this.session(account);
    if (!s.held) {
      throw new BridgeError('authentication', 'The ChatGPT login must be held by its browser profile (the page is driven directly). '
        + `Set session.hold_in_browser to true and run: bridge login chatgpt${accountFlag(account)} --force`);
    }
    const st = sessionState(this.spec, s);
    if (st === 'no-cookies') throw this.authError(account);
    if (st === 'dead') {
      const r = await this.sessions.refresh(this.spec, account, { rotate: false, verify: true });
      if (r.ok !== true) throw this.authError(account);
    }
    void sleep; // (kept for symmetry with other providers' retry paths)
  }

  async close(): Promise<void> { await this.transport.close?.(); }
}
