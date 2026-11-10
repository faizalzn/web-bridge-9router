export type ErrorKind =
  | 'invalid_request' | 'authentication' | 'not_found'
  | 'rate_limit' | 'provider' | 'unavailable' | 'internal';

const STATUS: Record<ErrorKind, number> = {
  invalid_request: 400, authentication: 401, not_found: 404,
  rate_limit: 429, provider: 502, unavailable: 503, internal: 500,
};

export class BridgeError extends Error {
  readonly kind: ErrorKind;
  readonly status: number;
  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.name = 'BridgeError';
    this.kind = kind;
    this.status = STATUS[kind];
  }
}

export function toBridgeError(err: unknown): BridgeError {
  if (err instanceof BridgeError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new BridgeError('internal', msg);
}
