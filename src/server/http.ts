import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { SessionService } from '../auth/session-service.ts';
import type { Config } from '../core/config.ts';
import { BridgeError, toBridgeError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import { collect, startChat, type PreparedChat } from '../core/pipeline.ts';
import { estimateRequestTokens } from '../core/tokens.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { anthropicError, anthropicResponse, anthropicStream, anthropicStreamError, parseAnthropicRequest } from '../translate/anthropic.ts';
import { openAIError, openAIResponse, openAIStream, openAIStreamError, parseOpenAIRequest } from '../translate/openai.ts';
import {
  newResponseId, parseResponsesRequest, responsesResponse, responsesStream, responsesStreamError, saveResponse,
} from '../translate/responses.ts';
import { VERSION } from '../version.ts';

const MAX_BODY_BYTES = 32 * 1024 * 1024; // images can be large

type Format = 'openai' | 'responses' | 'anthropic';

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  path: string;
  format: Format;
  signal: AbortSignal;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function sendError(ctx: Ctx, err: BridgeError): void {
  if (ctx.res.headersSent) {
    if (!ctx.res.writableEnded) {
      const encode = { anthropic: anthropicStreamError, responses: responsesStreamError, openai: openAIStreamError }[ctx.format];
      ctx.res.end(encode(err));
    }
    return;
  }
  sendJson(ctx.res, err.status, ctx.format === 'anthropic' ? anthropicError(err) : openAIError(err));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BridgeError('invalid_request', 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  logger.debug(`  body: ${text.length > 2000 ? `${text.slice(0, 2000)}... (${text.length} bytes)` : text}`);
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new BridgeError('invalid_request', 'Request body is not valid JSON');
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function checkAuth(req: IncomingMessage, apiKey: string): void {
  if (!apiKey) return; // auth disabled (localhost-only use)
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
  const key = bearer ?? (req.headers['x-api-key'] as string | undefined) ?? '';
  if (!safeEqual(key.trim(), apiKey)) throw new BridgeError('authentication', 'Invalid API key');
}

function openStream(ctx: Ctx): void {
  if (ctx.res.headersSent) return;
  ctx.res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  ctx.res.flushHeaders();
}

// A web chat can think for a minute before its first word. Some clients (9router waits 60 s for the response
// headers, then gives up and sends the very same request again) must not be left in silence that long. So a slow
// start opens the stream early and keeps it alive with SSE comments, which every SSE parser ignores. A failure
// before that point is still answered with a proper HTTP status; after it, errors travel as stream events.
const EARLY_OPEN_MS = 20_000;
const KEEP_ALIVE_MS = 15_000;

interface StreamTiming { earlyOpenMs: number; keepAliveMs: number }

async function openWhenSlow(ctx: Ctx, pending: Promise<PreparedChat>, stream: boolean | undefined, t: StreamTiming): Promise<PreparedChat> {
  if (!stream) return pending;
  let timer: NodeJS.Timeout | undefined;
  const slow = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), t.earlyOpenMs); });
  let started: PreparedChat | null;
  try { started = await Promise.race([pending, slow]); } finally { clearTimeout(timer); }
  if (started) return started;
  if (ctx.signal.aborted) return pending;
  openStream(ctx);
  const beat = setInterval(() => {
    if (!ctx.res.writableEnded && !ctx.signal.aborted) ctx.res.write(': keep-alive\n\n');
  }, t.keepAliveMs);
  try { return await pending; } finally { clearInterval(beat); }
}

async function writeStream(ctx: Ctx, chunks: AsyncIterable<string>): Promise<void> {
  openStream(ctx);
  for await (const chunk of chunks) {
    if (ctx.signal.aborted) return;
    ctx.res.write(chunk);
  }
  ctx.res.end();
}

/** Accept base URLs configured with or without "/v1" (e.g. ".../v1/v1/messages" or "/messages"). */
function normalizePath(url: string): string {
  let path = (url.split('?')[0] ?? '/').replace(/\/+$/, '') || '/';
  path = path.replace(/^(\/v1)+(?=\/|$)/, '/v1');
  if (/^\/(chat\/completions|responses|messages(\/count_tokens)?|models)$/.test(path)) path = `/v1${path}`;
  return path;
}

export function createApp(config: Config, registry: ProviderRegistry, sessions?: SessionService, timing: Partial<StreamTiming> = {}) {
  const t: StreamTiming = { earlyOpenMs: timing.earlyOpenMs ?? EARLY_OPEN_MS, keepAliveMs: timing.keepAliveMs ?? KEEP_ALIVE_MS };
  async function chatCompletions(ctx: Ctx) {
    const body = await readJson(ctx.req);
    const chatReq = parseOpenAIRequest(body);
    const chat = await openWhenSlow(ctx, startChat(registry, chatReq, ctx.signal), chatReq.stream, t);
    if (chatReq.stream) {
      await writeStream(ctx, openAIStream(chat.events, chatReq.model, body.stream_options?.include_usage === true));
    } else {
      sendJson(ctx.res, 200, openAIResponse(await collect(chat.events), chatReq.model));
    }
  }

  async function responses(ctx: Ctx) {
    const body = await readJson(ctx.req);
    const chatReq = parseResponsesRequest(body);
    const chat = await openWhenSlow(ctx, startChat(registry, chatReq, ctx.signal), chatReq.stream, t);
    const id = newResponseId();
    if (chatReq.stream) {
      await writeStream(ctx, responsesStream(id, chat.events, body, chatReq.model, (c) => saveResponse(id, chatReq, c)));
    } else {
      const c = await collect(chat.events);
      saveResponse(id, chatReq, c);
      sendJson(ctx.res, 200, responsesResponse(id, c, body, chatReq.model));
    }
  }

  async function messages(ctx: Ctx) {
    const chatReq = parseAnthropicRequest(await readJson(ctx.req));
    const chat = await openWhenSlow(ctx, startChat(registry, chatReq, ctx.signal), chatReq.stream, t);
    if (chatReq.stream) {
      await writeStream(ctx, anthropicStream(chat.events, chatReq.model, chat.inputTokens));
    } else {
      sendJson(ctx.res, 200, anthropicResponse(await collect(chat.events), chatReq.model));
    }
  }

  async function countTokens(ctx: Ctx) {
    const body = await readJson(ctx.req);
    sendJson(ctx.res, 200, { input_tokens: estimateRequestTokens(parseAnthropicRequest({ ...body, max_tokens: 1 })) });
  }

  function models(ctx: Ctx) {
    const list = registry.models();
    if (ctx.req.headers['anthropic-version']) {
      const data = list.map((m) => ({
        type: 'model', id: m.id, display_name: `${m.provider.name} – ${m.name ?? m.localId}`, created_at: '2026-01-01T00:00:00Z',
      }));
      sendJson(ctx.res, 200, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
    } else {
      sendJson(ctx.res, 200, {
        object: 'list',
        data: list.map((m) => ({ id: m.id, object: 'model', created: 0, owned_by: m.provider.id })),
      });
    }
  }

  async function health(ctx: Ctx) {
    const providers = await Promise.all(
      registry.list().map(async (p) => ({ id: p.id, name: p.name, ...(await p.status().catch((e) => ({ loggedIn: false, detail: String(e) }))) })),
    );
    const logins = (sessions?.states() ?? []).map((s) => ({
      provider: s.provider, account: s.account, state: s.state, lastCheck: s.lastCheck?.checkedAt ?? null,
    }));
    sendJson(ctx.res, 200, { status: 'ok', version: VERSION, providers, logins });
  }

  const routes: Record<string, (ctx: Ctx) => unknown> = {
    'POST /v1/chat/completions': chatCompletions,
    'POST /v1/responses': responses,
    'POST /v1/messages': messages,
    'POST /v1/messages/count_tokens': countTokens,
    'GET /v1/models': models,
    'GET /health': health,
    'GET /': health,
  };

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const path = normalizePath(req.url ?? '/');
    const controller = new AbortController();
    // Client disconnected before we finished: stop the provider work.
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });

    const format: Format = path.startsWith('/v1/messages') ? 'anthropic' : path === '/v1/responses' ? 'responses' : 'openai';
    const ctx: Ctx = { req, res, path, format, signal: controller.signal };

    // CORS: lets browser-based clients (web UIs, extensions) call the API. Auth still applies.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');

    try {
      if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
      const route = routes[`${req.method} ${path}`];
      if (!route) throw new BridgeError('not_found', `No route for ${req.method} ${path}`);
      if (path.startsWith('/v1/')) checkAuth(req, config.server.apiKey);
      await route(ctx);
    } catch (err) {
      if (controller.signal.aborted) return;
      const e = toBridgeError(err);
      if (e.status >= 500) logger.error(`${req.method} ${req.url} -> ${e.status}: ${e.message}`);
      else logger.warn(`${req.method} ${req.url} -> ${e.status}: ${e.message}`);
      sendError(ctx, e);
    } finally {
      logger.info(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms${controller.signal.aborted ? ' (aborted)' : ''}`);
    }
  };
}

export function startServer(config: Config, registry: ProviderRegistry, sessions?: SessionService): Promise<Server> {
  const server = createServer(createApp(config, registry, sessions));
  server.requestTimeout = 0; // long generations must not be cut off
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.server.port, config.server.host, () => resolve(server));
  });
}
