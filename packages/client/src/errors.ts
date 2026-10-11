/**
 * Every failure the SDK reports. Server errors carry the server's `code`
 * (e.g. `forbidden`, `unique_violation`, `invalid_credentials`); problems that never
 * reached the server use `network_error` (status 0) or `invalid_response`.
 */
export class SbbError extends Error {
  readonly code: string;
  /** HTTP status, or 0 when there was no response. */
  readonly status: number;
  readonly details?: unknown;
  /** Server-side id of the request, useful when reading the server log. */
  readonly requestId?: string;

  constructor(message: string, code: string, status: number, details?: unknown, requestId?: string) {
    super(message);
    this.name = 'SbbError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.requestId = requestId;
  }
}

/** The shape every SDK call resolves to; calls do not throw for expected failures. */
export type Result<T> = { data: T; error: null } | { data: null; error: SbbError };

export function toError(err: unknown): SbbError {
  if (err instanceof SbbError) return err;
  return new SbbError(err instanceof Error ? err.message : String(err), 'unexpected_error', 0);
}

/** Runs `fn` and turns a thrown SbbError into `{ data: null, error }`. */
export async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { data: await fn(), error: null };
  } catch (err) {
    return { data: null, error: toError(err) };
  }
}
