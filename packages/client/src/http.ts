import { SbbError } from './errors.js';

export const CLIENT_INFO = 'supabasebutno-js/0.1.0';

export interface RequestOptions {
  method: string;
  path: string;
  query?: URLSearchParams;
  headers?: Record<string, string>;
  /** JSON body (sets Content-Type). */
  json?: unknown;
  /** Raw body (uploads). */
  body?: BodyInit | null;
  /** 'none' = never send the user's token (login, refresh, ...). Default 'user'. */
  auth?: 'user' | 'none';
  /** Use this exact token instead of asking the session manager. */
  token?: string;
  /** How to read a successful response. Default 'json'. */
  responseType?: 'json' | 'blob' | 'none';
}

export interface HttpResponse<T = any> {
  status: number;
  headers: Headers;
  data: T;
}

interface HttpConfig {
  url: string;
  apikey: string;
  fetch: typeof fetch;
}

/** A body that can be sent a second time (a stream cannot). */
const replayable = (body: BodyInit | null | undefined) => !(typeof ReadableStream !== 'undefined' && body instanceof ReadableStream);

/**
 * Thin fetch wrapper: adds the API key and the user's token, turns error responses
 * into SbbError, and — when the server says the token has expired — asks the session
 * manager for a fresh one and retries once.
 */
export class Http {
  /** Supplied by the auth client once it exists. */
  getToken: () => Promise<string | null> = async () => null;
  /** Called after a 401 about the token; resolves true if a different token is now available. */
  refreshAfterRejection: () => Promise<boolean> = async () => false;

  constructor(private readonly cfg: HttpConfig) {}

  get url(): string {
    return this.cfg.url;
  }

  async request<T = any>(opts: RequestOptions): Promise<HttpResponse<T>> {
    const useUserToken = opts.auth !== 'none';
    let token = useUserToken ? (opts.token ?? (await this.getToken())) : null;

    let result = await this.send(opts, token);
    const tokenProblem = result.error && result.status === 401 && ['token_expired', 'invalid_token'].includes(result.error.code);
    if (tokenProblem && token && opts.token === undefined) {
      // Renew the session even if this request cannot be replayed (a consumed stream), so the caller's next attempt works.
      const renewed = await this.refreshAfterRejection();
      if (renewed && replayable(opts.body)) {
        token = await this.getToken();
        result = await this.send(opts, token);
      }
    }
    if (result.error) throw result.error;
    return { status: result.status, headers: result.headers, data: result.data as T };
  }

  private async send(opts: RequestOptions, token: string | null) {
    const headers: Record<string, string> = { apikey: this.cfg.apikey, 'X-Client-Info': CLIENT_INFO, ...opts.headers };
    if (token) headers.Authorization = `Bearer ${token}`;
    let body = opts.body;
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }
    const query = opts.query?.toString();
    const init: RequestInit & { duplex?: 'half' } = { method: opts.method, headers, body };
    // Node's fetch requires this flag to send a stream.
    if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) init.duplex = 'half';

    let res: Response;
    try {
      res = await this.cfg.fetch(`${this.cfg.url}${opts.path}${query ? `?${query}` : ''}`, init);
    } catch (err) {
      const error = new SbbError(`Network request failed: ${err instanceof Error ? err.message : String(err)}`, 'network_error', 0);
      return { status: 0, headers: new Headers(), data: null, error };
    }

    if (!res.ok) return { status: res.status, headers: res.headers, data: null, error: await readError(res) };
    try {
      if (opts.responseType === 'blob') return { status: res.status, headers: res.headers, data: await res.blob(), error: null };
      const text = opts.responseType === 'none' ? '' : await res.text();
      return { status: res.status, headers: res.headers, data: text ? JSON.parse(text) : null, error: null };
    } catch {
      return { status: res.status, headers: res.headers, data: null, error: new SbbError('The server sent an unreadable response', 'invalid_response', res.status) };
    }
  }
}

async function readError(res: Response): Promise<SbbError> {
  let body: any = null;
  try {
    body = JSON.parse(await res.text());
  } catch {
    /* not JSON (e.g. a proxy error page) */
  }
  const e = body?.error;
  if (e && typeof e.code === 'string') return new SbbError(String(e.message ?? res.statusText), e.code, res.status, e.details, e.request_id);
  return new SbbError(res.statusText || `HTTP ${res.status}`, 'http_error', res.status);
}
