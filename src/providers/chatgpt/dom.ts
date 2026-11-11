import type { Page } from 'playwright-core';
import type { StoredSession } from '../../auth/session-store.ts';
import type { BrowserManager } from '../../browser/manager.ts';
import { Channel } from '../../core/channel.ts';

// chatgpt.com mode C, as observed from the page on 11 Nov 2026 ("codex browser" shell). The page is driven the way
// a person drives it: the prompt is typed into the composer and the answer is read from the page. The page runs its
// own Cloudflare and sentinel (proof-of-work) machinery itself, so the gateway never forges any anti-bot token.
export const CHATGPT_URL = 'https://chatgpt.com/';
const SEL = {
  composer: 'div.ProseMirror[contenteditable="true"]',
  send: 'button[aria-label="Send"]',
  turn: '[data-turn-key]',
  turnState: '[data-talvt-turn-state]',        // "complete" when the turn is done
  assistant: '[data-dil-response]',            // the assistant reply text, without the "ChatGPT said:" label
};
const CF_CHALLENGE = /<title>\s*Just a moment\.\.\.\s*<\/title>|window\._cf_chl_opt|id="challenge-form"/i;

const START_TIMEOUT_MS = 60_000;
const TOTAL_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 250;
const STABLE_POLLS = 3;

export type ChatGPTErrorKind = 'auth' | 'blocked' | 'temporary' | 'protocol';
export class ChatGPTError extends Error {
  readonly kind: ChatGPTErrorKind;
  constructor(kind: ChatGPTErrorKind, message: string) { super(message); this.name = 'ChatGPTError'; this.kind = kind; }
}

export interface ChatGPTSendInput { prompt: string; signal: AbortSignal }

/** Reads the newest assistant reply and whether the page is still generating. Runs inside the browser. */
function readReply(sel: typeof SEL): { turns: number; replies: number; text: string; complete: boolean } {
  const replies = document.querySelectorAll(sel.assistant);
  const last = replies[replies.length - 1] as HTMLElement | undefined;
  const turnEls = document.querySelectorAll(sel.turnState);
  const lastTurn = turnEls[turnEls.length - 1];
  return {
    turns: document.querySelectorAll(sel.turn).length,
    replies: replies.length,
    text: (last?.innerText ?? '').trim(),
    complete: (lastTurn?.getAttribute('data-talvt-turn-state') ?? '') === 'complete',
  };
}

export class ChatGPTDomTransport {
  private readonly browser: BrowserManager;
  constructor(browser: BrowserManager) { this.browser = browser; }

  /** Yields the cumulative reply text as it grows. Every request is a fresh chat (like Gemini mode C). */
  async *send(session: StoredSession, input: ChatGPTSendInput): AsyncGenerator<{ text: string }> {
    const out = new Channel<{ text: string }>();
    let page: Page | null = null;
    let stop = false;

    const job = this.browser.withPage(session, async (p) => {
      page = p;
      if (stop) return;
      const res = await p.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      const html = await p.content().catch(() => '');
      if (CF_CHALLENGE.test(html)) throw new ChatGPTError('blocked', `chatgpt.com answered with a Cloudflare bot check (HTTP ${res?.status() ?? 0}); the gateway does not try to get past it`);
      if (new URL(p.url()).pathname.startsWith('/auth')) throw new ChatGPTError('auth', 'chatgpt.com shows its login page in the browser');

      const box = p.locator(SEL.composer).first();
      try { await box.waitFor({ timeout: 30_000 }); }
      catch { throw new ChatGPTError('protocol', 'the chatgpt.com composer did not appear (page layout changed, or a bot check is shown)'); }
      await p.waitForTimeout(1200);

      const before = await p.evaluate(readReply, SEL);
      await this.type(p, input.prompt);
      await this.collect(p, out, () => stop || input.signal.aborted, before.replies);
    });
    job.then(() => out.close(), (err) => out.fail(err));

    const onAbort = () => { stop = true; void (page as Page | null)?.close().catch(() => {}); };
    input.signal.addEventListener('abort', onAbort, { once: true });
    try { yield* out; }
    finally { input.signal.removeEventListener('abort', onAbort); stop = true; await job.catch(() => {}); }
  }

  private async type(p: Page, prompt: string): Promise<void> {
    const box = p.locator(SEL.composer).first();
    await box.click();
    const lines = prompt.split('\n');
    for (const [i, line] of lines.entries()) {
      if (i > 0) await p.keyboard.press('Shift+Enter');
      if (line) await p.keyboard.insertText(line);
    }
    // Click Send rather than Enter: the page enables it only once its sentinel/proof-of-work is ready.
    const send = p.locator(SEL.send).first();
    try { await send.click({ timeout: 15_000 }); }
    catch { await p.keyboard.press('Enter'); }
  }

  private async collect(p: Page, out: Channel<{ text: string }>, stopped: () => boolean, before: number): Promise<void> {
    const started = Date.now();
    let last = '';
    let stable = 0;
    let began = false;
    for (;;) {
      if (stopped() || p.isClosed()) return;
      await p.waitForTimeout(POLL_MS);
      const html = await p.content().catch(() => '');
      if (CF_CHALLENGE.test(html)) throw new ChatGPTError('blocked', 'chatgpt.com showed a Cloudflare bot check while answering; the gateway does not try to get past it');
      const s = await p.evaluate(readReply, SEL);
      if (s.replies <= before) {
        if (Date.now() - started > START_TIMEOUT_MS) throw new ChatGPTError('protocol', 'the page did not start answering');
        continue;
      }
      began = true;
      if (s.text !== last) { last = s.text; stable = 0; if (s.text) out.push({ text: s.text }); }
      else if (s.complete && s.text) { if (++stable >= STABLE_POLLS) break; }
      if (Date.now() - started > TOTAL_TIMEOUT_MS) throw new ChatGPTError('protocol', 'the page took too long to answer');
    }
    if (!began || !last) throw new ChatGPTError('protocol', 'the page produced no answer text');
  }

  async close(): Promise<void> { await this.browser.close(); }
}
