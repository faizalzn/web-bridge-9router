import type { Page } from 'playwright-core';
import type { BrowserManager } from '../../browser/manager.ts';
import { Channel } from '../../core/channel.ts';
import { logger } from '../../core/logger.ts';
import { GeminiError, parseBootstrap, type GenUpdate } from './protocol.ts';
import type { GeminiDomSelectors, GeminiManifest } from './manifest.ts';
import type { AccountContext, GenerateRequest, GeminiTransport } from './transport.ts';

const POLL_MS = 250;
const START_TIMEOUT_MS = 60_000;     // time for the page to start answering
const TOTAL_TIMEOUT_MS = 15 * 60_000; // reasoning models can think for a long time
const STABLE_POLLS = 3;               // finished = not busy and unchanged for this many polls

interface ReplyState { count: number; busy: boolean; text: string }

/** Reads the newest reply from the page. Runs inside the browser. */
function readReply(sel: GeminiDomSelectors): ReplyState {
  const all = document.querySelectorAll(sel.response);
  const last = all[all.length - 1];
  if (!last) return { count: 0, busy: false, text: '' };
  const body = last.querySelector(sel.responseText) ?? last;
  const clone = body.cloneNode(true) as Element;
  clone.querySelectorAll(sel.ignore).forEach((n) => n.remove());
  // innerText of a detached node ignores layout, so line breaks come from block elements via textContent fallbacks.
  const text = ((body as HTMLElement).innerText ?? '') || clone.textContent || '';
  const ignored = [...body.querySelectorAll(sel.ignore)].map((n) => (n as HTMLElement).innerText || '').filter(Boolean);
  let clean = text;
  for (const part of ignored) clean = clean.replace(part, '');
  return {
    count: all.length,
    busy: (body.getAttribute(sel.busyAttr) ?? last.getAttribute(sel.busyAttr)) === 'true',
    text: clean.trim(),
  };
}

/**
 * Mode C: last resort. Types the prompt into the Gemini web page and reads the answer from the
 * page. It is the slowest and the most fragile mode, but it only depends on what a person sees,
 * so it still works when both request-based modes break. Every request starts a new chat; the
 * model picker is put back afterwards because Gemini remembers the choice for the account.
 */
export class DomTransport implements GeminiTransport {
  readonly mode = 'C' as const;
  private readonly browser: BrowserManager;

  constructor(browser: BrowserManager) { this.browser = browser; }

  async *generate(ctx: AccountContext, req: GenerateRequest): AsyncGenerator<GenUpdate> {
    const out = new Channel<GenUpdate>();
    let page: Page | null = null;
    let stop = false;
    const sel = ctx.manifest.dom;

    const job = this.browser.withPage(
      ctx.session(),
      async (p) => {
        page = p;
        await p.goto(ctx.manifest.bootstrap.url, { waitUntil: 'domcontentloaded' });
        const box = p.locator(sel.textbox).first();
        try {
          await box.waitFor({ timeout: 30_000 });
        } catch {
          throw new GeminiError('protocol', 'The Gemini page has no message box (page layout changed?)');
        }
        if (!parseBootstrap(await p.content(), ctx.manifest)) throw new GeminiError('auth', 'Gemini shows the logged-out page in the browser');
        await p.waitForTimeout(1500); // let the page finish wiring up its controls

        // Gemini remembers the picker choice for the whole account, so remember the user's model
        // and put it back afterwards.
        const original = await this.chooseModel(p, sel, req.modelId);

        try {
          await this.sendPrompt(p, sel, req.prompt);
          await this.collect(p, sel, out, req, () => stop);
        } finally {
          if (original && original !== req.modelId && !p.isClosed()) {
            await this.chooseModel(p, sel, original).catch((e) => {
              logger.warn(`Could not restore the Gemini model picker: ${(e as Error).message}`);
            });
          }
        }
      },
      (cookies) => ctx.service.saveBrowserCookies(ctx.spec, ctx.account, cookies),
    );
    job.then(() => out.close(), (err) => out.fail(err));

    const onAbort = () => { stop = true; };
    req.signal.addEventListener('abort', onAbort, { once: true });
    try {
      yield* out;
    } finally {
      req.signal.removeEventListener('abort', onAbort);
      stop = true;
      await job.catch(() => {});
    }
  }

  /**
   * Makes `modelId` the selected model of the picker and returns the one that was selected before
   * (null when it could not be read). Picker items carry the model id, so no UI text is involved.
   */
  private async chooseModel(p: Page, sel: GeminiDomSelectors, modelId: string): Promise<string | null> {
    await p.locator(sel.modelPicker).first().click({ timeout: 15_000 });
    const checked = p.locator(sel.modelChecked).first();
    await checked.waitFor({ timeout: 15_000 });
    const before = await checked.getAttribute('data-mode-id');
    if (before === modelId) {
      await p.keyboard.press('Escape'); // already selected: just close the picker
    } else {
      // The page saves the choice with a few RPCs. Sending before they finish makes Gemini fail the request.
      const settled = Promise.all(sel.modelSwitchRpcs.map((rpc) =>
        p.waitForResponse((r) => r.url().includes(`rpcids=${rpc}`), { timeout: 8000 }).catch(() => null)));
      await p.locator(sel.modelItem.replace('{id}', modelId)).first().click({ timeout: 15_000 });
      await settled;
    }
    await p.waitForTimeout(1000);
    return before;
  }

  private async sendPrompt(p: Page, sel: GeminiDomSelectors, prompt: string): Promise<void> {
    const box = p.locator(sel.textbox).first();
    await box.click();
    const lines = prompt.split('\n');
    for (const [i, line] of lines.entries()) {
      if (i > 0) await p.keyboard.press('Shift+Enter');
      if (line) await p.keyboard.insertText(line);
    }
    await p.keyboard.press('Enter');
  }

  private async collect(p: Page, sel: GeminiDomSelectors, out: Channel<GenUpdate>, req: GenerateRequest, stopped: () => boolean): Promise<void> {
    const before = (await p.evaluate(readReply, sel)).count;
    const started = Date.now();
    let last = '';
    let stable = 0;
    let started_ = false;

    for (;;) {
      if (stopped() || p.isClosed()) return;
      await p.waitForTimeout(POLL_MS);
      const s = await p.evaluate(readReply, sel);
      const isNew = s.count > before;

      if (!isNew) {
        if (Date.now() - started > START_TIMEOUT_MS) throw new GeminiError('protocol', 'The page did not start answering');
        continue;
      }
      started_ = true;
      if (s.text !== last) {
        last = s.text;
        stable = 0;
        if (s.text) out.push({ text: s.text });
      } else if (!s.busy && s.text) {
        if (++stable >= STABLE_POLLS) break;
      }
      if (Date.now() - started > TOTAL_TIMEOUT_MS) throw new GeminiError('protocol', 'The page took too long to answer');
    }
    if (!started_ || !last) throw new GeminiError('protocol', 'The page produced no answer text');
    void req;
  }

  async close(): Promise<void> { await this.browser.close(); }
}
