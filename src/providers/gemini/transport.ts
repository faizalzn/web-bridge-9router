import type { SessionService } from '../../auth/session-service.ts';
import { userAgentFor } from '../../auth/session-service.ts';
import { cookieHeader, type StoredSession } from '../../auth/session-store.ts';
import type { AuthSpec } from '../../auth/specs.ts';
import type { GeminiManifest } from './manifest.ts';
import type { ConvRef, GenUpdate } from './protocol.ts';

/** A = plain HTTP with cookies (no browser), B = the same request sent from inside a real page, C = typing into the web UI. */
export type Mode = 'A' | 'B' | 'C';

export interface AccountContext {
  account: string;
  spec: AuthSpec;
  service: SessionService;
  manifest: GeminiManifest;
  /** Latest saved session; throws an authentication error when the account is not logged in. */
  session(): StoredSession;
}

export interface GenerateRequest {
  modelId: string;
  prompt: string;
  conv: ConvRef | null;
  signal: AbortSignal;
}

export interface GeminiTransport {
  readonly mode: Mode;
  /** Yields the cumulative reply text as it grows. Throws GeminiError. */
  generate(ctx: AccountContext, req: GenerateRequest): AsyncGenerator<GenUpdate>;
  deleteConversation?(ctx: AccountContext, cid: string): Promise<void>;
  close?(): Promise<void>;
}

export const GEMINI_ORIGIN = 'https://gemini.google.com';

/** Headers a normal browser tab would send, using the saved session's cookies and User-Agent. */
export function browserHeaders(s: StoredSession, url: string): Record<string, string> {
  return {
    cookie: cookieHeader(s.cookies, url),
    'user-agent': userAgentFor(s),
    'accept-language': 'en-US,en;q=0.9',
  };
}
