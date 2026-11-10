import type { Page } from 'playwright-core';
import type { BrowserManager } from '../../browser/manager.ts';
import { Channel } from '../../core/channel.ts';
import {
  buildStreamRequest, GeminiError, parseBootstrap, StreamParser,
  type GenUpdate,
} from './protocol.ts';
import { GEMINI_ORIGIN, type AccountContext, type GenerateRequest, type GeminiTransport } from './transport.ts';

const CHUNK_FN = '__bridgeChunk';

/**
 * Mode B: the same StreamGenerate request as mode A, but sent with `fetch` from inside a real
 * Gemini page of a background browser. Cookies, TLS fingerprint and headers are the browser's own,
 * so it keeps working when plain HTTP gets treated as a bot. Costs a browser (closed when idle).
 */
export class PageTransport implements GeminiTransport {
  readonly mode = 'B' as const;
  private readonly browser: BrowserManager;

  constructor(browser: BrowserManager) { this.browser = browser; }

  async *generate(ctx: AccountContext, req: GenerateRequest): AsyncGenerator<GenUpdate> {
    const out = new Channel<GenUpdate>();
    let page: Page | null = null;
    let stop = false;

    const job = this.browser.withPage(
      ctx.session(),
      async (p) => {
        page = p;
        if (stop) return;
        await p.goto(ctx.manifest.bootstrap.url, { waitUntil: 'domcontentloaded' });
        const tokens = parseBootstrap(await p.content(), ctx.manifest);
        if (!tokens) throw new GeminiError('auth', 'Gemini shows the logged-out page in the browser');

        const built = buildStreamRequest(ctx.manifest, tokens, { modelId: req.modelId, prompt: req.prompt, conv: req.conv });
        const parser = new StreamParser(ctx.manifest);
        let produced = false;
        await p.exposeFunction(CHUNK_FN, (chunk: string) => {
          try {
            for (const u of parser.push(chunk)) { produced = true; out.push(u); }
          } catch (err) { out.fail(err); }
        });

        const status = await p.evaluate(async ({ url, headers, body, fn }) => {
          const res = await fetch(url, { method: 'POST', headers, body, credentials: 'include' });
          if (!res.ok || !res.body) return res.status;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            await (window as unknown as Record<string, (s: string) => Promise<void>>)[fn]!(decoder.decode(value, { stream: true }));
          }
          return res.status;
        }, { url: built.url, headers: built.headers, body: built.body, fn: CHUNK_FN });

        if (status === 401 || status === 403) throw new GeminiError('auth', `Gemini answered HTTP ${status} in the browser`);
        if (status === 429) throw new GeminiError('rate_limit', 'Gemini is rate limiting this account (HTTP 429)');
        if (status !== 200) throw new GeminiError('protocol', `Gemini answered HTTP ${status} in the browser`);
        for (const u of parser.end()) { produced = true; out.push(u); }
        if (!produced) throw new GeminiError('protocol', parser.sawFrame ? 'Gemini returned an empty reply' : 'Unrecognized response format from Gemini');
      },
      // Page scripts rotate cookies; keep the saved copy current.
      (cookies) => ctx.service.saveBrowserCookies(ctx.spec, ctx.account, cookies),
    );
    job.then(() => out.close(), (err) => out.fail(err));

    const onAbort = () => { stop = true; void (page as Page | null)?.close().catch(() => {}); };
    req.signal.addEventListener('abort', onAbort, { once: true });
    try {
      yield* out;
    } finally {
      req.signal.removeEventListener('abort', onAbort);
      onAbort();
      await job.catch(() => {});
    }
  }

  async close(): Promise<void> { await this.browser.close(); }
}

// Re-exported for tests.
export { GEMINI_ORIGIN };
