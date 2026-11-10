import { randomInt, randomUUID } from 'node:crypto';
import type { GeminiManifest } from './manifest.ts';

// Pure functions for the Gemini web protocol (StreamGenerate): no network, no state.

export interface GeminiTokens { at: string; bl: string; sid: string; fetchedAt: number }

/** Identifies a conversation turn so the next message can continue the same chat. */
export interface ConvRef { cid: string; rid: string; rcid: string }

export interface GenUpdate {
  /** Full reply text so far (the server sends it cumulatively, not as deltas). */
  text: string;
  conv?: ConvRef;
}

export type GeminiErrorKind = 'auth' | 'rate_limit' | 'blocked' | 'bad_model' | 'temporary' | 'failed' | 'protocol';

/** Failure of one request. `protocol` means "the transport/format no longer works" and triggers a mode switch. */
export class GeminiError extends Error {
  readonly kind: GeminiErrorKind;
  readonly code: number | null;
  constructor(kind: GeminiErrorKind, message: string, code: number | null = null) {
    super(message);
    this.name = 'GeminiError';
    this.kind = kind;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Bootstrap page
// ---------------------------------------------------------------------------
const pick = (html: string, key: string) => new RegExp(`"${key}":"([^"]*)"`).exec(html)?.[1];

/** Reads the request tokens embedded in the app page. Returns null when the page is the logged-out version. */
export function parseBootstrap(html: string, m: GeminiManifest): GeminiTokens | null {
  const at = pick(html, m.bootstrap.atKey);
  const bl = pick(html, m.bootstrap.blKey);
  const sid = pick(html, m.bootstrap.sidKey);
  return at && bl && sid ? { at, bl, sid, fetchedAt: Date.now() } : null;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------
export interface BuildOptions {
  modelId: string;
  prompt: string;
  conv?: ConvRef | null;
}

export interface BuiltRequest { url: string; headers: Record<string, string>; body: string }

/** Value of the model header: it carries the model id and mode, the build label and the client's time zone. */
export function modelHeader(m: GeminiManifest, t: GeminiTokens, modelId: string, clientId: string): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  // Unknown model (or none, as for deleting a chat): null leaves the choice to the account instead of silently picking one.
  const mode = m.models.find((x) => x.modelId === modelId)?.mode ?? null;
  return JSON.stringify([
    1, null, null, null, modelId, null, m.stream.lang, null, m.headers.capabilities,
    null, null, null, null, null, mode, null, clientId, [t.bl], null,
    [[null, 100000], [Math.floor(Date.now() / 1000), 0], tz],
  ]);
}

export function buildStreamRequest(m: GeminiManifest, t: GeminiTokens, o: BuildOptions, clientId: string = randomUUID().toUpperCase()): BuiltRequest {
  const inner = [
    [o.prompt, 0, null, null, null, null, 0],
    [m.stream.lang],
    o.conv ? [o.conv.cid, o.conv.rid, o.conv.rcid] : ['', '', ''],
    null, null, null, [1], 1, null, null, 1, 0, null, null, null, null, null, [[0]], 0,
  ];
  const query = new URLSearchParams({ bl: t.bl, 'f.sid': t.sid, hl: m.stream.hl, _reqid: String(randomInt(100000, 999999)), rt: 'c' });
  return {
    url: `${m.stream.url}?${query}`,
    headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
      'x-same-domain': '1',
      [m.headers.model]: modelHeader(m, t, o.modelId, clientId),
      [m.headers.flags]: m.headers.flagsValue,
    },
    body: new URLSearchParams({ 'f.req': JSON.stringify([null, JSON.stringify(inner)]), at: t.at }).toString(),
  };
}

/** Request that deletes a conversation from the account's history. */
export function buildDeleteRequest(m: GeminiManifest, t: GeminiTokens, cid: string, clientId: string = randomUUID().toUpperCase()): BuiltRequest {
  const query = new URLSearchParams({
    rpcids: m.batchexecute.deleteChatRpc, 'source-path': '/app', bl: t.bl, 'f.sid': t.sid,
    hl: m.stream.hl, _reqid: String(randomInt(100000, 999999)), rt: 'c',
  });
  return {
    url: `${m.batchexecute.url}?${query}`,
    headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
      'x-same-domain': '1',
      [m.headers.model]: modelHeader(m, t, '', clientId).replace('""', 'null'),
      [m.headers.flags]: m.headers.flagsValue,
    },
    body: new URLSearchParams({
      'f.req': JSON.stringify([[[m.batchexecute.deleteChatRpc, JSON.stringify([cid]), null, 'generic']]]),
      at: t.at,
    }).toString(),
  };
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * Incremental parser for the `rt=c` stream: `)]}'`, then groups of "<length>\n<json>\n".
 * The JSON of one group is always a single line (newlines inside strings are escaped), so
 * parsing line by line is enough and does not depend on how the length is counted.
 */
export class StreamParser {
  private readonly m: GeminiManifest;
  private buf = '';
  private lastText = '';
  private lastConv: ConvRef | undefined;
  /** True once any frame was understood; an empty stream means the format changed. */
  sawFrame = false;

  constructor(m: GeminiManifest) { this.m = m; }

  push(chunk: string): GenUpdate[] {
    this.buf += chunk;
    const out: GenUpdate[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line.startsWith('[')) this.readLine(line, out);
    }
    return out;
  }

  /** Call after the last chunk: a final line may lack its trailing newline. */
  end(): GenUpdate[] {
    return this.push('\n');
  }

  private readLine(line: string, out: GenUpdate[]): void {
    let frame: unknown;
    try { frame = JSON.parse(line); } catch { return; }
    if (!Array.isArray(frame)) return;
    for (const entry of frame) {
      if (!Array.isArray(entry)) continue;
      if (entry[0] === 'er') throw this.errorFor(Array.isArray(entry[5]) ? Number(entry[5][0]) : Number(entry[5]), 'Gemini reported an error');
      if (entry[0] !== 'wrb.fr') continue;
      this.sawFrame = true;
      if (typeof entry[2] !== 'string') {
        // wrb.fr without payload and with an error descriptor: [code, ...]
        const code = Array.isArray(entry[5]) ? Number(entry[5][0]) : NaN;
        if (Number.isFinite(code)) throw this.errorFor(code, `Gemini returned error code ${code}`);
        continue;
      }
      let inner: any;
      try { inner = JSON.parse(entry[2]); } catch { continue; }
      const update = this.extract(inner);
      if (update && (update.text !== this.lastText || update.conv?.rcid !== this.lastConv?.rcid)) {
        this.lastText = update.text;
        this.lastConv = update.conv ?? this.lastConv;
        out.push(update);
      }
    }
  }

  private extract(inner: any): GenUpdate | null {
    const ids = inner?.[1];
    const cand = inner?.[4]?.[0];
    if (!Array.isArray(cand)) return null;
    const text = cand[1]?.[0];
    if (typeof text !== 'string') return null;
    const cid = ids?.[0], rid = ids?.[1], rcid = cand[0];
    const conv = typeof cid === 'string' && typeof rid === 'string' && typeof rcid === 'string' ? { cid, rid, rcid } : undefined;
    return { text, conv };
  }

  private errorFor(code: number, message: string): GeminiError {
    const e = this.m.errors;
    if (e.usageLimit.includes(code)) return new GeminiError('rate_limit', 'Gemini usage limit reached for this account/model', code);
    if (e.blocked.includes(code)) return new GeminiError('blocked', 'Google temporarily blocked requests from this IP address', code);
    if (e.badModel.includes(code)) return new GeminiError('bad_model', 'This account cannot use the selected Gemini model', code);
    if (e.temporary.includes(code)) return new GeminiError('temporary', 'Gemini had a temporary problem, try again', code);
    // Gemini understood the request but failed while answering it: another transport would fail the same way.
    if ((e.failed ?? []).includes(code)) return new GeminiError('failed', `Gemini failed while answering (internal error, code ${code}). Try again, start a new conversation, or use another model.`, code);
    return new GeminiError('protocol', `${message} (code ${Number.isFinite(code) ? code : '?'})`, Number.isFinite(code) ? code : null);
  }
}
