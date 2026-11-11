import type { Page } from 'playwright-core';
import type { StoredSession } from '../../auth/session-store.ts';
import type { BrowserManager } from '../../browser/manager.ts';
import { Channel } from '../../core/channel.ts';
import {
  buildCompletion, CF_CHALLENGE, CLAUDE_ORIGIN, ClaudeError, ClaudeStreamParser, errorFromBody,
  type ClaudeConv, type ClaudeUpdate,
} from './protocol.ts';

export interface ClaudeSendInput { model: string; effort?: string; prompt: string; conv: ClaudeConv | null; signal: AbortSignal }

/** Sends one turn and yields what comes back. The first update is always `{type:'chat'}` with the chat id. */
export interface ClaudeTransport {
  send(session: StoredSession, input: ClaudeSendInput): AsyncGenerator<ClaudeUpdate | { type: 'chat'; chat: string }>;
  close?(): Promise<void>;
}

const CHUNK_FN = '__bridgeClaudeChunk';

/**
 * The page navigated while a request ran in it. Cloudflare does that when it replaces the page with its bot check,
 * so look at what the page shows now before calling it a protocol error.
 */
async function afterNavigation(p: Page, err: unknown): Promise<never> {
  const msg = (err as Error)?.message ?? String(err);
  if (!/Execution context was destroyed|navigat/i.test(msg)) throw err;
  await p.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
  const html = await p.content().catch(() => '');
  if (CF_CHALLENGE.test(html)) throw errorFromBody(403, html);
  let where = '';
  try { const u = new URL(p.url()); where = ` (now at ${u.host}${u.pathname})`; } catch { /* closed */ }
  throw new ClaudeError('protocol', `the claude.ai page navigated away during the request${where}`);
}
const HOME = `${CLAUDE_ORIGIN}/new`;

/**
 * Mode B for claude.ai: the completion request is sent with `fetch` from inside a real claude.ai page in the
 * account's own browser profile, the way the page's own scripts send it. claude.ai sits behind Cloudflare, so
 * there is no plain-HTTP mode; when Cloudflare shows a bot check the request fails with a clear error.
 */
export class ClaudePageTransport implements ClaudeTransport {
  private readonly browser: BrowserManager;
  /** account key -> organization uuid (found once per run). */
  private readonly orgs = new Map<string, string>();

  constructor(browser: BrowserManager) { this.browser = browser; }

  async *send(session: StoredSession, input: ClaudeSendInput): AsyncGenerator<ClaudeUpdate | { type: 'chat'; chat: string }> {
    const out = new Channel<ClaudeUpdate | { type: 'chat'; chat: string }>();
    let page: Page | null = null;
    let stop = false;
    const key = `${session.provider}:${session.account}`;

    const job = this.browser.withPage(session, async (p) => {
      page = p;
      if (stop) return;
      const res = await p.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      const html = await p.content().catch(() => '');
      if (CF_CHALLENGE.test(html)) throw errorFromBody(res?.status() ?? 0, html);
      if (new URL(p.url()).pathname.startsWith('/login')) throw new ClaudeError('auth', 'claude.ai shows its login page in the browser');

      let org = this.orgs.get(key);
      if (!org) {
        const r = await p.evaluate(async () => {
          const res = await fetch('/api/organizations', { credentials: 'include', headers: { accept: 'application/json' } });
          return { status: res.status, text: await res.text() };
        });
        if (r.status !== 200) throw errorFromBody(r.status, r.text);
        let list: { uuid?: string; capabilities?: string[] }[] = [];
        try { list = JSON.parse(r.text); } catch { /* handled below */ }
        org = (list.find((o) => o.capabilities?.includes('chat')) ?? list[0])?.uuid;
        if (!org) throw new ClaudeError('protocol', 'claude.ai lists no organization for this account');
        this.orgs.set(key, org);
      }

      const built = buildCompletion(org, { prompt: input.prompt, model: input.model, effort: input.effort, conv: input.conv });
      out.push({ type: 'chat', chat: built.chat });
      const parser = new ClaudeStreamParser();
      await p.exposeFunction(CHUNK_FN, (chunk: string) => {
        try { for (const u of parser.push(chunk)) out.push(u); } catch (err) { out.fail(err); }
      });
      const r = await p.evaluate(async ({ url, body, fn }) => {
        const res = await fetch(url, {
          method: 'POST', body, credentials: 'include',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        });
        if (!res.ok || !res.body) return { status: res.status, text: await res.text().catch(() => '') };
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await (window as unknown as Record<string, (s: string) => Promise<void>>)[fn]!(decoder.decode(value, { stream: true }));
        }
        return { status: res.status, text: '' };
      }, { url: built.url, body: built.body, fn: CHUNK_FN }).catch((err: unknown) => afterNavigation(p, err));

      if (r.status !== 200) throw errorFromBody(r.status, r.text);
      for (const u of parser.end()) out.push(u);
      if (!parser.sawEvent) throw new ClaudeError('protocol', 'claude.ai returned an empty stream');
    });
    job.then(() => out.close(), (err) => out.fail(err));

    const onAbort = () => { stop = true; void (page as Page | null)?.close().catch(() => {}); };
    input.signal.addEventListener('abort', onAbort, { once: true });
    try {
      yield* out;
    } finally {
      input.signal.removeEventListener('abort', onAbort);
      onAbort();
      await job.catch(() => {});
    }
  }

  /** Forgets the organization of an account (after a login problem). */
  forget(session: StoredSession): void { this.orgs.delete(`${session.provider}:${session.account}`); }

  async close(): Promise<void> { await this.browser.close(); }
}
