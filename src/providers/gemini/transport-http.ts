import { httpRequest, httpStream } from '../../core/http.ts';
import {
  buildDeleteRequest, buildStreamRequest, GeminiError, parseBootstrap, StreamParser,
  type GeminiTokens, type GenUpdate,
} from './protocol.ts';
import {
  browserHeaders, GEMINI_ORIGIN, type AccountContext, type GenerateRequest, type GeminiTransport,
} from './transport.ts';

const IDLE_TIMEOUT_MS = 300_000; // reasoning models can stay silent for a long time

const isAuthStatus = (s: number) => s === 401 || s === 403 || (s >= 300 && s < 400);

/** Mode A: talks to Gemini over plain HTTP with the saved cookies. No browser is started. */
export class HttpTransport implements GeminiTransport {
  readonly mode = 'A' as const;
  private readonly tokens = new Map<string, GeminiTokens>();
  private readonly inflight = new Map<string, Promise<GeminiTokens>>();

  /** Page tokens (`at`, `bl`, `sid`) are cached per account and refreshed when they get old or are rejected. */
  async getTokens(ctx: AccountContext, force = false): Promise<GeminiTokens> {
    const hit = this.tokens.get(ctx.account);
    if (hit && !force && Date.now() - hit.fetchedAt < ctx.manifest.bootstrap.ttlSeconds * 1000) return hit;
    let pending = this.inflight.get(ctx.account);
    if (!pending) {
      pending = this.fetchTokens(ctx).finally(() => this.inflight.delete(ctx.account));
      this.inflight.set(ctx.account, pending);
    }
    const t = await pending;
    this.tokens.set(ctx.account, t);
    return t;
  }

  private async fetchTokens(ctx: AccountContext): Promise<GeminiTokens> {
    const url = ctx.manifest.bootstrap.url;
    const res = await httpRequest(url, {
      compress: true,
      timeoutMs: 30_000,
      headers: { ...browserHeaders(ctx.session(), url), accept: 'text/html,application/xhtml+xml' },
    });
    void ctx.service.applySetCookies(ctx.spec, ctx.account, res.setCookie, url).catch(() => {});
    if (isAuthStatus(res.status)) throw new GeminiError('auth', 'Google redirected to the login page');
    if (res.status !== 200) throw new GeminiError('protocol', `Gemini page answered HTTP ${res.status}`);
    const tokens = parseBootstrap(res.text(), ctx.manifest);
    if (!tokens) throw new GeminiError('auth', 'Gemini shows the logged-out page for this session');
    return tokens;
  }

  async *generate(ctx: AccountContext, req: GenerateRequest): AsyncGenerator<GenUpdate> {
    let tokens = await this.getTokens(ctx);

    for (let attempt = 0; ; attempt++) {
      const built = buildStreamRequest(ctx.manifest, tokens, { modelId: req.modelId, prompt: req.prompt, conv: req.conv });
      const res = await httpStream(built.url, {
        method: 'POST',
        body: built.body,
        signal: req.signal,
        timeoutMs: IDLE_TIMEOUT_MS,
        headers: {
          ...browserHeaders(ctx.session(), built.url),
          ...built.headers,
          origin: GEMINI_ORIGIN,
          referer: `${GEMINI_ORIGIN}/`,
        },
      });

      if (isAuthStatus(res.status)) { res.stream.destroy(); this.tokens.delete(ctx.account); throw new GeminiError('auth', `Gemini answered HTTP ${res.status}`); }
      if (res.status === 400 && attempt === 0) {
        // Most likely stale page tokens: fetch fresh ones and try once more.
        res.stream.destroy();
        tokens = await this.getTokens(ctx, true);
        continue;
      }
      if (res.status === 429) { res.stream.destroy(); throw new GeminiError('rate_limit', 'Gemini is rate limiting this account (HTTP 429)'); }
      if (res.status !== 200) { res.stream.destroy(); throw new GeminiError('protocol', `Gemini answered HTTP ${res.status}`); }

      res.stream.setEncoding('utf8');
      const parser = new StreamParser(ctx.manifest);
      let produced = false;
      try {
        for await (const chunk of res.stream) {
          for (const update of parser.push(chunk as string)) { produced = true; yield update; }
        }
        for (const update of parser.end()) { produced = true; yield update; }
      } finally {
        res.stream.destroy();
      }
      void ctx.service.applySetCookies(ctx.spec, ctx.account, res.setCookie, built.url).catch(() => {});
      if (!produced) {
        throw new GeminiError('protocol', parser.sawFrame ? 'Gemini returned an empty reply' : 'Unrecognized response format from Gemini');
      }
      return;
    }
  }

  async deleteConversation(ctx: AccountContext, cid: string): Promise<void> {
    const tokens = await this.getTokens(ctx);
    const built = buildDeleteRequest(ctx.manifest, tokens, cid);
    const res = await httpRequest(built.url, {
      method: 'POST',
      body: built.body,
      timeoutMs: 30_000,
      headers: { ...browserHeaders(ctx.session(), built.url), ...built.headers, origin: GEMINI_ORIGIN, referer: `${GEMINI_ORIGIN}/` },
    });
    if (res.status !== 200) throw new GeminiError('protocol', `Deleting the chat answered HTTP ${res.status}`);
    // batchexecute answers 200 even when the call failed; success looks like ["wrb.fr","<rpc>","[]",...].
    if (!res.text().includes(`"wrb.fr","${ctx.manifest.batchexecute.deleteChatRpc}","[]"`)) {
      throw new GeminiError('protocol', 'Gemini did not confirm that the chat was deleted');
    }
  }
}
