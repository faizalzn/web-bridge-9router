import { setTimeout as sleep } from 'node:timers/promises';
import { BrowserManager } from '../../browser/manager.ts';
import type { SessionService } from '../../auth/session-service.ts';
import { DEFAULT_ACCOUNT, sessionState } from '../../auth/session-store.ts';
import { AUTH_SPECS } from '../../auth/specs.ts';
import type { ProviderConfig } from '../../core/config.ts';
import { ConversationCache } from '../../core/conversation-cache.ts';
import { BridgeError } from '../../core/errors.ts';
import { logger } from '../../core/logger.ts';
import { ModeSwitcher } from '../../core/mode-switcher.ts';
import { buildContinuationPrompt, buildFreshPrompt } from '../../core/prompt.ts';
import { AccountQueue } from '../../core/queue.ts';
import type { StreamEvent } from '../../core/types.ts';
import type { ModelInfo, Provider, ProviderDeps, ProviderRequest, ProviderStatus } from '../base.ts';
import { BUNDLED_MANIFEST, type GeminiManifest, type GeminiModel } from './manifest.ts';
import { GeminiError, type ConvRef, type GenUpdate } from './protocol.ts';
import { couldBeFailureReply, DeltaEmitter, isFailureReply } from './text.ts';
import type { AccountContext, GeminiTransport, Mode } from './transport.ts';
import { DomTransport } from './transport-dom.ts';
import { HttpTransport } from './transport-http.ts';
import { PageTransport } from './transport-page.ts';

const MODES: Mode[] = ['A', 'B', 'C'];
const NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ECONNABORTED',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

const isNetworkError = (e: unknown): boolean =>
  NETWORK_CODES.has((e as { code?: string })?.code ?? '') || /timed out/i.test((e as Error)?.message ?? '');

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);
const accountFlag = (a: string) => (a === DEFAULT_ACCOUNT ? '' : ` --account ${a}`);

interface CachedChat extends ConvRef { account: string }

/**
 * Google Gemini through its web app, using the login saved by `bridge login gemini`.
 * Transports (tried lightest first, switched automatically when one stops working):
 *   A  plain HTTP with cookies, no browser
 *   B  the same request sent from inside a real browser page
 *   C  typing into the web UI
 */
/** Where the time of one request went (written to the log when it ends). */
interface RequestTiming { acquiredAt: number; queuedMs: number; firstMs: number | null; mode: Mode | null; ok: boolean }
const sec = (ms: number): string => (ms / 1000).toFixed(1) + 's';

export class GeminiProvider implements Provider {
  readonly id = 'gemini';
  readonly name = 'Google Gemini (web)';

  private readonly manifest: GeminiManifest;
  private readonly sessions: SessionService;
  private readonly spec = AUTH_SPECS.gemini!;
  private readonly transports = new Map<Mode, GeminiTransport>();
  private readonly switcher: ModeSwitcher<Mode>;
  private readonly queue: AccountQueue;
  private readonly cache: ConversationCache<CachedChat>;
  /** Web chats this gateway created and may delete later (auto_delete_chats). */
  private readonly chats = new Map<string, { account: string; cid: string; lastUsed: number }>();
  private sweeper: NodeJS.Timeout | undefined;
  private readonly opts: {
    forced: Mode | null; reuseChats: boolean; autoDelete: boolean; chatTtlMs: number;
  };

  constructor(cfg: ProviderConfig, deps: ProviderDeps) {
    this.sessions = deps.sessions;
    this.manifest = BUNDLED_MANIFEST;
    this.opts = {
      forced: MODES.includes(cfg.mode as Mode) ? (cfg.mode as Mode) : null,
      reuseChats: cfg.reuse_chats !== false,
      autoDelete: cfg.auto_delete_chats === true,
      chatTtlMs: num(cfg.chat_ttl, 600) * 1000,
    };

    // One background browser serves modes B and C; it only starts when one of them is used.
    const browser = deps.browser ?? new BrowserManager(deps.config);
    this.transports.set('A', new HttpTransport());
    this.transports.set('B', new PageTransport(browser));
    this.transports.set('C', new DomTransport(browser));
    this.switcher = new ModeSwitcher<Mode>(MODES.filter((m) => this.transports.has(m)));
    this.queue = new AccountQueue({
      minGapMs: num(cfg.min_interval, 1.5) * 1000,
      jitterMs: num(cfg.jitter, 1.5) * 1000,
      maxWaiting: num(cfg.max_waiting, 10),
      maxWaitMs: num(cfg.max_wait, 180) * 1000,
    });
    this.cache = new ConversationCache<CachedChat>({
      max: 300,
      ttlMs: this.opts.autoDelete ? this.opts.chatTtlMs : 6 * 3_600_000,
    });
    if (this.opts.autoDelete) {
      this.sweeper = setInterval(() => void this.sweep(), 60_000);
      this.sweeper.unref();
    }
  }

  listModels(): ModelInfo[] {
    return this.manifest.models.map((m) => ({ id: m.id, name: m.name, ...(m.unavailable ? { unavailable: m.unavailable } : {}) }));
  }

  accounts(): string[] {
    const found = this.sessions.store.list('gemini').map((s) => s.account);
    return found.sort((a, b) => (a === DEFAULT_ACCOUNT ? -1 : b === DEFAULT_ACCOUNT ? 1 : a.localeCompare(b)));
  }

  async status(): Promise<ProviderStatus> {
    const accounts = this.accounts();
    if (accounts.length === 0) return { loggedIn: false, detail: 'no login yet: run "bridge login gemini"' };
    const parts: string[] = [];
    let anyUsable = false;
    for (const a of accounts) {
      let state = 'unreadable';
      try {
        const s = this.sessions.get('gemini', a);
        if (s) {
          const st = sessionState(this.spec, s);
          state = st === 'ok' ? 'works' : st === 'dead' ? 'EXPIRED' : st === 'unverified' ? 'unverified' : 'logged out';
          anyUsable ||= st === 'ok' || st === 'unverified';
          if (s.held) state += ', held by its browser profile';
        }
      } catch { /* undecryptable */ }
      const m = this.switcher.describe(`gemini:${a}`);
      parts.push(`${a}: ${state}, mode ${m.mode}${m.reason ? ` (${m.reason})` : ''}`);
    }
    return { loggedIn: anyUsable, mode: this.switcher.current('gemini:default'), detail: parts.join('; ') };
  }

  // -------------------------------------------------------------------------
  // chat
  // -------------------------------------------------------------------------
  async *chat(req: ProviderRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const account = req.account ?? DEFAULT_ACCOUNT;
    const model = this.manifest.models.find((m) => m.id === req.model);
    if (!model) throw new BridgeError('not_found', `Unknown Gemini model "${req.model}"`);
    if (model.unavailable) throw new BridgeError('unavailable', `${model.name} is not available through the gateway: ${model.unavailable}`);
    const accKey = `gemini:${account}`;
    await this.ensureLogin(account);
    const ctx = this.context(account);

    // Hybrid: continue the web chat when the history only grew, otherwise start a new chat.
    const scope = `${account}|${model.modelId}`;
    const hit = this.opts.reuseChats ? this.cache.find(scope, req.system, req.messages) : null;
    const conv: ConvRef | null = hit ? { cid: hit.ref.cid, rid: hit.ref.rid, rcid: hit.ref.rcid } : null;
    const prompt = hit
      ? buildContinuationPrompt(req.messages.slice(hit.consumed))
      : buildFreshPrompt(req.system, req.messages);
    if (!prompt.trim()) throw new BridgeError('invalid_request', 'The request has no text to send');
    logger.debug(`gemini ${account}/${model.id}: ${hit ? `continuing chat (${hit.consumed} earlier messages known)` : 'new chat'}`);

    const asked = Date.now();
    const release = await this.queue.acquire(accKey, signal);
    const timing: RequestTiming = { acquiredAt: Date.now(), queuedMs: Date.now() - asked, firstMs: null, mode: null, ok: false };
    try {
      const reply = yield* this.run(ctx, model, prompt, conv, accKey, signal, timing);
      if (reply.conv) this.remember(account, scope, req, reply.text, reply.conv);
      timing.ok = true;
    } finally {
      release();
      const outcome = timing.ok ? 'ok' : signal.aborted ? 'client gave up' : 'failed';
      logger.info('gemini ' + model.id + ': ' + (hit ? 'continued chat' : 'new chat') + ', prompt ' + prompt.length + ' chars, waited ' + sec(timing.queuedMs)
        + ', first reply ' + (timing.firstMs === null ? 'never' : sec(timing.firstMs)) + ', total ' + sec(Date.now() - timing.acquiredAt)
        + ', mode ' + (timing.mode ?? '-') + ', ' + outcome);
    }
  }

  /** Runs the request through the transports; returns the final text and chat reference. */
  private async *run(
    ctx: AccountContext, model: GeminiModel, prompt: string, conv: ConvRef | null, accKey: string, signal: AbortSignal, timing: RequestTiming,
  ): AsyncGenerator<StreamEvent, { text: string; conv?: ConvRef }> {
    const emitter = new DeltaEmitter();
    // A held login lives in its browser profile; plain HTTP with a copy of its cookies would compete with it.
    const held = ctx.session().held === true;
    const modes = (this.opts.forced ? [this.opts.forced] : this.switcher.plan(accKey))
      .filter((m) => this.transports.has(m) && !(held && m === 'A'));
    if (modes.length === 0) {
      throw new BridgeError('unavailable', held && this.opts.forced === 'A'
        ? 'Gemini mode A cannot use a login held by its browser profile: set mode to auto or B'
        : `Gemini mode ${this.opts.forced} is not available yet`);
    }

    let streamed = false;
    let authRetried = false;
    let tempRetried = false;
    let lastError: Error | null = null;

    for (let i = 0; i < modes.length; i++) {
      const mode = modes[i]!;
      const transport = this.transports.get(mode)!;
      let latest: GenUpdate | null = null;
      let held = ''; // withheld while the reply could still be a canned failure message
      timing.mode = mode;
      try {
        for await (const u of transport.generate(ctx, { modelId: model.modelId, prompt, conv, signal })) {
          if (timing.firstMs === null) timing.firstMs = Date.now() - timing.acquiredAt;
          latest = u;
          const delta = emitter.push(u.text);
          if (!delta) continue;
          if (!streamed && couldBeFailureReply(emitter.text)) { held += delta; continue; }
          streamed = true;
          yield { type: 'text', text: held + delta };
          held = '';
        }
        const tail = emitter.push(latest?.text ?? '', true);
        if (!streamed && isFailureReply(emitter.text)) {
          throw new BridgeError('provider', `Gemini could not answer and sent its generic error message ("${emitter.text.trim()}"). `
            + 'This usually depends on the conversation: try again, start a new conversation, or use another model.');
        }
        if (held || tail) yield { type: 'text', text: held + tail };
        if (!emitter.text) throw new BridgeError('provider', 'Gemini returned an empty reply (it may have declined or produced non-text content)');
        this.switcher.succeeded(accKey, mode);
        yield { type: 'done', stopReason: 'stop' };
        return { text: emitter.text, conv: latest?.conv };
      } catch (err) {
        if (signal.aborted) throw err;
        if (err instanceof BridgeError) throw err;
        if (isNetworkError(err)) throw new BridgeError('unavailable', `Cannot reach Google: ${(err as Error).message}`);

        const ge = err instanceof GeminiError ? err : new GeminiError('protocol', (err as Error)?.message ?? String(err));
        switch (ge.kind) {
          case 'auth': {
            if (authRetried) throw this.authError(ctx.account);
            authRetried = true;
            const r = await this.sessions.refresh(ctx.spec, ctx.account, { rotate: true, verify: true });
            if (r.ok === false) throw this.authError(ctx.account);
            i--; // the session is fine (tokens were stale): retry the same mode once
            continue;
          }
          case 'temporary':
            if (tempRetried || streamed) throw new BridgeError('unavailable', ge.message);
            tempRetried = true;
            await sleep(2000, undefined, { signal });
            i--;
            continue;
          case 'rate_limit': throw new BridgeError('rate_limit', ge.message);
          case 'failed': throw new BridgeError('provider', ge.message); // never a reason to switch modes
          case 'blocked': throw new BridgeError('unavailable', ge.message);
          case 'bad_model': throw new BridgeError('invalid_request', `${ge.message} (${model.name})`);
          case 'protocol':
            if (streamed) throw new BridgeError('provider', `The Gemini stream was interrupted: ${ge.message}`);
            lastError = ge;
            if (!this.opts.forced) this.switcher.failed(accKey, mode, ge.message);
            continue;
        }
      }
    }
    throw new BridgeError('provider', `Gemini did not answer in any mode: ${lastError?.message ?? 'unknown error'}`);
  }

  // -------------------------------------------------------------------------
  // accounts and sessions
  // -------------------------------------------------------------------------
  private authError(account: string): BridgeError {
    return new BridgeError(
      'authentication',
      `Gemini no longer accepts the saved login for account "${account}". Run: bridge login gemini${accountFlag(account)} --force`,
    );
  }

  /** Fails fast, with a useful message, when the account is missing or known to be logged out. */
  private async ensureLogin(account: string): Promise<void> {
    const s = this.sessions.get('gemini', account);
    if (!s) {
      throw new BridgeError('authentication', `No Gemini login for account "${account}". Run: bridge login gemini${accountFlag(account)}`);
    }
    const st = sessionState(this.spec, s);
    if (st === 'no-cookies') throw this.authError(account);
    if (st === 'dead') {
      // Maybe it was a one-off: ask Google again before giving up.
      const r = await this.sessions.refresh(this.spec, account, { rotate: true, verify: true });
      if (r.ok !== true) throw this.authError(account);
    }
  }

  private context(account: string): AccountContext {
    return {
      account,
      spec: this.spec,
      service: this.sessions,
      manifest: this.manifest,
      session: () => {
        const s = this.sessions.get('gemini', account);
        if (!s) throw new GeminiError('auth', `No Gemini login for account "${account}"`);
        return s;
      },
    };
  }

  // -------------------------------------------------------------------------
  // chat bookkeeping (conversation reuse and optional cleanup of the web history)
  // -------------------------------------------------------------------------
  private remember(account: string, scope: string, req: ProviderRequest, reply: string, conv: ConvRef): void {
    if (this.opts.reuseChats) {
      this.cache.put(
        scope, req.system,
        [...req.messages, { role: 'assistant', content: [{ type: 'text', text: req.normalizeReply?.(reply) ?? reply }] }],
        { ...conv, account },
      );
    }
    if (this.opts.autoDelete) {
      this.chats.set(`${account}|${conv.cid}`, { account, cid: conv.cid, lastUsed: this.opts.reuseChats ? Date.now() : 0 });
      if (!this.opts.reuseChats) void this.sweep();
    }
  }

  /** Deletes web chats that were idle for longer than `chat_ttl`. */
  private async sweep(now = Date.now(), all = false): Promise<void> {
    this.cache.sweep(now);
    for (const [key, chat] of [...this.chats]) {
      if (!all && now - chat.lastUsed < this.opts.chatTtlMs) continue;
      this.chats.delete(key);
      // Deleting goes over plain HTTP, which a login held by its browser profile must not use.
      if (this.sessions.get('gemini', chat.account)?.held) { logger.debug('gemini: chat ' + chat.cid + ' kept (login held by browser)'); continue; }
      try {
        const t = this.transports.get('A');
        if (t?.deleteConversation) await t.deleteConversation(this.context(chat.account), chat.cid);
        logger.debug(`gemini: deleted chat ${chat.cid}`);
      } catch (err) {
        logger.debug(`gemini: could not delete chat ${chat.cid}: ${(err as Error).message}`);
      }
    }
  }

  async close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    if (this.opts.autoDelete) {
      await Promise.race([this.sweep(Date.now(), true), sleep(5000)]).catch(() => {});
    }
    await Promise.allSettled([...this.transports.values()].map((t) => t.close?.()));
  }
}
