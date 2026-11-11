import { setTimeout as sleep } from 'node:timers/promises';
import { BrowserManager } from '../../browser/manager.ts';
import type { SessionService } from '../../auth/session-service.ts';
import { DEFAULT_ACCOUNT, sessionState, type StoredSession } from '../../auth/session-store.ts';
import { AUTH_SPECS } from '../../auth/specs.ts';
import type { ProviderConfig } from '../../core/config.ts';
import { ConversationCache } from '../../core/conversation-cache.ts';
import { BridgeError } from '../../core/errors.ts';
import { logger } from '../../core/logger.ts';
import { buildContinuationPrompt, buildFreshPrompt } from '../../core/prompt.ts';
import { AccountQueue } from '../../core/queue.ts';
import type { StreamEvent } from '../../core/types.ts';
import type { ModelInfo, Provider, ProviderDeps, ProviderRequest, ProviderStatus } from '../base.ts';
import { ClaudeError, type ClaudeConv, type ClaudeLimit } from './protocol.ts';
import { ClaudePageTransport, type ClaudeTransport } from './transport.ts';

export interface ClaudeModel { id: string; name: string; modelId: string; unavailable?: string }

/** Model ids as the claude.ai page sends them. Only Sonnet 5.5 has been seen on the wire so far (10 Nov 2026). */
export const CLAUDE_MODELS: ClaudeModel[] = [
  { id: 'sonnet', name: 'Claude Sonnet 5.5', modelId: 'claude-sonnet-5-5' },
  { id: 'opus', name: 'Claude Opus 5.5', modelId: 'claude-opus-5-5' },
  { id: 'haiku', name: 'Claude Haiku 5.5', modelId: 'claude-haiku-5-5' },
];

const EFFORTS = ['low', 'medium', 'high', 'extra'];
/** Effort a caller may pin per request via the model suffix, plus "auto" (let Claude decide, send no effort field). */
const REQUEST_EFFORTS = ['auto', ...EFFORTS];

/** Splits "opus:high" into its base model id and an optional per-request effort. "opus" -> no effort override. */
function splitEffort(localId: string): { base: string; effort?: string } {
  const i = localId.indexOf(':');
  return i === -1 ? { base: localId } : { base: localId.slice(0, i), effort: localId.slice(i + 1).toLowerCase() };
}

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);
const accountFlag = (a: string) => (a === DEFAULT_ACCOUNT ? '' : ` --account ${a}`);
const sec = (ms: number): string => (ms / 1000).toFixed(1) + 's';
const clock = (ms: number): string => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const pct = (v?: number): string => (v === undefined ? '?' : `${Math.round(v * 100)}%`);

interface CachedChat extends ClaudeConv { account: string }

/**
 * Claude through claude.ai, using the login held by `bridge login claude`. One mode only (B): the request is sent
 * from inside a real claude.ai page in the account's own browser profile. No connector or server tools are sent;
 * tool calling is emulated by the gateway like for Gemini.
 */
export class ClaudeProvider implements Provider {
  readonly id = 'claude';
  readonly name = 'Claude (claude.ai web)';

  private readonly sessions: SessionService;
  private readonly spec = AUTH_SPECS.claude!;
  private readonly transport: ClaudeTransport;
  private readonly queue: AccountQueue;
  private readonly cache: ConversationCache<CachedChat>;
  private readonly opts: { effort?: string; reuseChats: boolean };
  /**
   * Accounts that met a Cloudflare bot check: no request opens claude.ai for them until `until`. Retrying at once
   * (9router and Hermes retry every few seconds) would only hit the check again and again.
   */
  private readonly paused = new Map<string, { until: number; streak: number; at: number }>();
  private readonly pauseMs: number;
  /** Last quota report per account, shown in the status. */
  private readonly limits = new Map<string, ClaudeLimit>();

  constructor(cfg: ProviderConfig, deps: ProviderDeps, transport?: ClaudeTransport) {
    this.sessions = deps.sessions;
    const effort = typeof cfg.effort === 'string' ? cfg.effort : 'medium';
    if (effort !== 'default' && !EFFORTS.includes(effort)) throw new Error(`Invalid providers.claude.effort: ${effort} (low | medium | high | extra | default)`);
    this.opts = { effort: effort === 'default' ? undefined : effort, reuseChats: cfg.reuse_chats !== false };
    this.pauseMs = num(cfg.bot_check_pause, 600) * 1000;
    this.transport = transport ?? new ClaudePageTransport(deps.browser ?? new BrowserManager(deps.config));
    this.queue = new AccountQueue({
      minGapMs: num(cfg.min_interval, 2) * 1000,
      jitterMs: num(cfg.jitter, 1.5) * 1000,
      maxWaiting: num(cfg.max_waiting, 10),
      maxWaitMs: num(cfg.max_wait, 180) * 1000,
    });
    this.cache = new ConversationCache<CachedChat>({ max: 300, ttlMs: 6 * 3_600_000 });
  }

  listModels(): ModelInfo[] {
    return CLAUDE_MODELS.map((m) => ({ id: m.id, name: m.name, ...(m.unavailable ? { unavailable: m.unavailable } : {}) }));
  }

  /** Accepts the effort suffix form kept out of listModels: "opus:high", "sonnet:auto", etc. */
  acceptsModel(localId: string): boolean {
    const { base, effort } = splitEffort(localId);
    return CLAUDE_MODELS.some((m) => m.id === base) && (effort === undefined || REQUEST_EFFORTS.includes(effort));
  }

  accounts(): string[] {
    const found = this.sessions.store.list('claude').map((s) => s.account);
    return found.sort((a, b) => (a === DEFAULT_ACCOUNT ? -1 : b === DEFAULT_ACCOUNT ? 1 : a.localeCompare(b)));
  }

  async status(): Promise<ProviderStatus> {
    const accounts = this.accounts();
    if (accounts.length === 0) return { loggedIn: false, detail: 'no login yet: run "bridge login claude"' };
    const parts: string[] = [];
    let anyUsable = false;
    for (const a of accounts) {
      let state = 'unreadable';
      try {
        const s = this.sessions.get('claude', a);
        if (s) {
          const st = sessionState(this.spec, s);
          state = st === 'ok' ? 'works' : st === 'dead' ? 'EXPIRED' : st === 'unverified' ? 'unverified' : 'logged out';
          anyUsable ||= (st === 'ok' || st === 'unverified') && s.held === true;
          if (!s.held) state += ', NOT held by a browser profile (log in again with session.hold_in_browser on)';
        }
      } catch { /* undecryptable */ }
      const l = this.limits.get(a);
      const p = this.paused.get(a);
      if (p && Date.now() < p.until) state += `, PAUSED after a Cloudflare bot check until ${clock(p.until)}`;
      parts.push(`${a}: ${state}, mode B${l ? `, quota used 5h ${pct(l.fiveHour)} / 7d ${pct(l.sevenDay)}` : ''}`);
    }
    return { loggedIn: anyUsable, mode: 'B', detail: parts.join('; ') };
  }

  async *chat(req: ProviderRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const account = req.account ?? DEFAULT_ACCOUNT;
    const { base, effort: override } = splitEffort(req.model);
    const model = CLAUDE_MODELS.find((m) => m.id === base);
    if (!model) throw new BridgeError('not_found', `Unknown Claude model "${req.model}"`);
    if (override !== undefined && !REQUEST_EFFORTS.includes(override)) {
      throw new BridgeError('not_found', `Unknown effort "${override}" for Claude. Use ${base}:${REQUEST_EFFORTS.join(` | ${base}:`)}, or ${base} for the configured default`);
    }
    if (model.unavailable) throw new BridgeError('unavailable', `${model.name} is not available through the gateway: ${model.unavailable}`);
    // No suffix -> the configured default effort. ":auto" -> send no effort (Claude decides). Else the pinned effort.
    const effort = override === undefined ? this.opts.effort : override === 'auto' ? undefined : override;
    await this.ensureLogin(account);
    const pause = this.paused.get(account);
    if (pause && Date.now() < pause.until) {
      throw new BridgeError('unavailable', `claude.ai showed a Cloudflare bot check for account "${account}" at ${clock(pause.at)}; `
        + `Claude requests are paused until ${clock(pause.until)} instead of being retried (the gateway does not try to get past the check)`);
    }

    const scope = `${account}|${model.modelId}`;
    const hit = this.opts.reuseChats ? this.cache.find(scope, req.system, req.messages) : null;
    const conv: ClaudeConv | null = hit ? { chat: hit.ref.chat, parent: hit.ref.parent } : null;
    const prompt = hit ? buildContinuationPrompt(req.messages.slice(hit.consumed)) : buildFreshPrompt(req.system, req.messages);
    if (!prompt.trim()) throw new BridgeError('invalid_request', 'The request has no text to send');
    if (!hit && this.opts.reuseChats) {
      const why = this.cache.explainMiss(scope, req.system, req.messages);
      if (why) {
        logger.info(`claude ${model.id}: earlier chat not continued: ${why.reason}`);
        if (why.detail) logger.debug(`claude ${model.id}: difference ${why.detail}`);
      }
    }

    const asked = Date.now();
    const release = await this.queue.acquire(`claude:${account}`, signal);
    const started = Date.now();
    let firstMs: number | null = null;
    let ok = false;
    let limit: ClaudeLimit | undefined;
    try {
      let authRetried = false;
      let tempRetried = false;
      for (;;) {
        let streamed = false;
        let text = '';
        let chat = '';
        let parent = '';
        let stop = '';
        try {
          for await (const u of this.transport.send(this.session(account), { model: model.modelId, effort, prompt, conv, signal })) {
            if (u.type === 'chat') chat = u.chat;
            else if (u.type === 'message') parent = u.uuid;
            else if (u.type === 'stop') stop = u.reason;
            else if (u.type === 'limit') limit = u.limit;
            else if (u.type === 'text') {
              if (firstMs === null) firstMs = Date.now() - started;
              streamed = true;
              text += u.text;
              yield { type: 'text', text: u.text };
            }
          }
          if (!text) throw new BridgeError('provider', `claude.ai returned no text (stop reason: ${stop || 'none'})`);
          if (stop === 'refusal') logger.info(`claude ${model.id}: claude.ai marked the reply as a refusal`);
          yield { type: 'done', stopReason: stop === 'max_tokens' ? 'length' : 'stop' };
          if (chat && parent && this.opts.reuseChats) {
            this.cache.put(scope, req.system,
              [...req.messages, { role: 'assistant', content: [{ type: 'text', text: req.normalizeReply?.(text) ?? text }] }],
              { chat, parent, account });
          }
          ok = true;
          this.paused.delete(account);
          return;
        } catch (err) {
          if (signal.aborted || err instanceof BridgeError) throw err;
          const ce = err instanceof ClaudeError ? err : new ClaudeError('protocol', (err as Error)?.message ?? String(err));
          switch (ce.kind) {
            case 'auth': {
              if (authRetried || streamed) throw this.authError(account);
              authRetried = true;
              const s = this.session(account);
              if (this.transport instanceof ClaudePageTransport) this.transport.forget(s);
              const r = await this.sessions.refresh(this.spec, account, { rotate: false, verify: true });
              if (r.ok === false) throw this.authError(account);
              continue;
            }
            case 'temporary':
              if (tempRetried || streamed) throw new BridgeError('unavailable', ce.message);
              tempRetried = true;
              await sleep(3000, undefined, { signal });
              continue;
            case 'rate_limit': throw new BridgeError('rate_limit', ce.message);
            case 'blocked': {
              const streak = (this.paused.get(account)?.streak ?? 0) + 1;
              const now = Date.now();
              const until = now + Math.min(this.pauseMs * 2 ** (streak - 1), Math.max(this.pauseMs, 3_600_000));
              this.paused.set(account, { until, streak, at: now });
              logger.warn(`claude ${account}: Cloudflare bot check; Claude requests for this account paused until ${clock(until)}`);
              throw new BridgeError('unavailable', `${ce.message}. Claude requests for this account are paused until ${clock(until)}`);
            }
            case 'bad_model': throw new BridgeError('invalid_request', `${ce.message} (${model.name})`);
            case 'protocol':
              throw new BridgeError('provider', streamed ? `The claude.ai stream was interrupted: ${ce.message}` : ce.message);
          }
        }
      }
    } finally {
      release();
      if (limit) this.limits.set(account, limit);
      const outcome = ok ? 'ok' : signal.aborted ? 'client gave up' : 'failed';
      logger.info(`claude ${model.id} (effort ${effort ?? (override === 'auto' ? 'auto' : 'default')}): ${hit ? 'continued chat' : 'new chat'}, prompt ${prompt.length} chars, waited ${sec(started - asked)}, `
        + `first reply ${firstMs === null ? 'never' : sec(firstMs)}, total ${sec(Date.now() - started)}, mode B, ${outcome}`
        + (limit ? `, quota used 5h ${pct(limit.fiveHour)} / 7d ${pct(limit.sevenDay)}` : ''));
    }
  }

  private session(account: string): StoredSession {
    const s = this.sessions.get('claude', account);
    if (!s) throw new BridgeError('authentication', `No Claude login for account "${account}". Run: bridge login claude${accountFlag(account)}`);
    return s;
  }

  private authError(account: string): BridgeError {
    return new BridgeError('authentication',
      `claude.ai no longer accepts the saved login for account "${account}". Run: bridge login claude${accountFlag(account)} --force`);
  }

  private async ensureLogin(account: string): Promise<void> {
    const s = this.session(account);
    if (!s.held) {
      throw new BridgeError('authentication', 'The Claude login must be held by its browser profile (claude.ai sits behind Cloudflare). '
        + `Set session.hold_in_browser to true and run: bridge login claude${accountFlag(account)} --force`);
    }
    const st = sessionState(this.spec, s);
    if (st === 'no-cookies') throw this.authError(account);
    if (st === 'dead') {
      const r = await this.sessions.refresh(this.spec, account, { rotate: false, verify: true });
      if (r.ok !== true) throw this.authError(account);
    }
  }

  async close(): Promise<void> {
    await this.transport.close?.();
  }
}
