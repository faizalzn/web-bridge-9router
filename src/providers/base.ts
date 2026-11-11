import type { ChatRequest, StreamEvent } from '../core/types.ts';
import type { Config, ProviderConfig } from '../core/config.ts';
import type { SessionService } from '../auth/session-service.ts';
import type { BrowserManager } from '../browser/manager.ts';

export interface ModelInfo {
  id: string;
  name?: string;
  /** Known but not usable right now: left out of /v1/models, requests get this reason as an error. */
  unavailable?: string;
}

export interface ProviderStatus {
  loggedIn: boolean;
  /** Active transport mode: A = direct HTTP, B = in-page fetch, C = DOM. */
  mode?: 'A' | 'B' | 'C';
  detail?: string;
}

/** Request handed to an adapter: `model` is the provider-local id (e.g. "pro"). */
export type ProviderRequest = ChatRequest & {
  model: string;
  /** Which saved login to use, from "provider@account/model". Undefined = the default account. */
  account?: string;
  /**
   * Set when the gateway emulates tool calls for this request: rewrites a raw reply into the canonical text of the
   * tool calls it contains. A provider that remembers its chats should remember this form, not the raw reply.
   */
  normalizeReply?: (raw: string) => string;
};

export interface Provider {
  readonly id: string;
  readonly name: string;
  /** True when the provider emits `tool_call` events itself; otherwise the gateway emulates tool calling in text. */
  readonly nativeTools?: boolean;
  listModels(): ModelInfo[];
  /**
   * True when the provider accepts a model id that is not in `listModels()` — used for suffix variants kept out of
   * the public list, such as Claude's `opus:high` effort form. The registry falls back to this when the exact id
   * does not match, so these variants resolve without crowding `/v1/models`.
   */
  acceptsModel?(localId: string): boolean;
  /** Saved accounts, when the provider supports several. */
  accounts?(): string[];
  status(): Promise<ProviderStatus>;
  chat(req: ProviderRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
  /** Releases browsers, timers and open chats on shutdown. */
  close?(): Promise<void>;
}

export interface ProviderDeps {
  config: Config;
  sessions: SessionService;
  /** Shared background browser; one per process, because a held login's profile can only be opened once. */
  browser?: BrowserManager;
}

export type ProviderFactory = (config: ProviderConfig, deps: ProviderDeps) => Provider;
