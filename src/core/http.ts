import http from 'node:http';
import https from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { Readable, Transform } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

// Thin HTTP client on node:http(s). Node's built-in fetch cannot be used for provider
// traffic: Google answers with >16 KB of headers (a huge CSP), which fetch rejects with
// HeadersOverflowError.

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Socket idle timeout. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Ask for gzip/br; the body is decoded transparently. Off by default (best for streams). */
  compress?: boolean;
}

export interface HttpHead {
  status: number;
  headers: IncomingHttpHeaders;
  setCookie: string[];
}
export interface HttpResponse extends HttpHead { body: Buffer; text(): string }
export interface HttpStream extends HttpHead { stream: Readable }

const MAX_HEADER_SIZE = 256 * 1024;

function connect(url: string, opts: HttpOptions): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const headers: Record<string, string> = {
      'accept-encoding': opts.compress ? 'gzip, br' : 'identity',
      ...opts.headers,
    };
    if (opts.body !== undefined) headers['content-length'] = String(Buffer.byteLength(opts.body));
    const req = lib.request(
      u,
      { method: opts.method ?? 'GET', headers, maxHeaderSize: MAX_HEADER_SIZE, signal: opts.signal },
      resolve,
    );
    req.on('error', reject);
    if (opts.timeoutMs) req.setTimeout(opts.timeoutMs, () => req.destroy(new Error(`Request to ${u.host} timed out`)));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function decode(res: IncomingMessage): Readable {
  const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
  const t: Transform | null =
    enc === 'gzip' ? createGunzip() : enc === 'br' ? createBrotliDecompress() : enc === 'deflate' ? createInflate() : null;
  if (!t) return res;
  res.on('error', (e) => t.destroy(e));
  return res.pipe(t);
}

const head = (res: IncomingMessage): HttpHead => ({
  status: res.statusCode ?? 0,
  headers: res.headers,
  setCookie: res.headers['set-cookie'] ?? [],
});

export async function httpRequest(url: string, opts: HttpOptions = {}): Promise<HttpResponse> {
  const res = await connect(url, opts);
  const chunks: Buffer[] = [];
  for await (const chunk of decode(res)) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  return { ...head(res), body, text: () => body.toString('utf8') };
}

export async function httpStream(url: string, opts: HttpOptions = {}): Promise<HttpStream> {
  const res = await connect(url, opts);
  return { ...head(res), stream: decode(res) };
}
