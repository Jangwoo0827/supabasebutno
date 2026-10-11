/** A database row. Pass your own type to `from<T>()` for typed results. */
export type Row = Record<string, any>;

export interface User {
  id: string;
  email: string;
  /** Free-form data the user may edit themselves: do not use it for permissions. */
  user_metadata: Record<string, any>;
  created_at: string;
  last_sign_in_at: string | null;
}

export interface Session {
  access_token: string;
  refresh_token: string;
  token_type: 'bearer';
  /** Seconds the access token was valid for when issued. */
  expires_in: number;
  /** Unix time (seconds) at which the access token expires. */
  expires_at: number;
  user: User;
}

export type AuthChangeEvent = 'INITIAL_SESSION' | 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED' | 'USER_UPDATED';

/**
 * Where the session is kept. Browsers default to localStorage; use `createChromeStorage()`
 * in extensions, or write your own (methods may be sync or async).
 */
export interface StorageAdapter {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

export interface AuthOptions {
  /** Where to persist the session. Default: localStorage when available, otherwise memory. */
  storage?: StorageAdapter;
  /** Key under which the session is stored. Default `sbb.auth.<project>`. */
  storageKey?: string;
  /** Keep the session between page loads / restarts. Default true. */
  persistSession?: boolean;
  /** Renew the access token in the background shortly before it expires. Default true. */
  autoRefreshToken?: boolean;
  /** Renew when fewer than this many seconds remain. Default 60. */
  refreshMarginSeconds?: number;
}

export interface RealtimeOptions {
  /** WebSocket constructor, for runtimes without a global one (e.g. `import WebSocket from 'ws'` on Node < 22). */
  WebSocket?: typeof WebSocket;
  /** First reconnect delay in ms; doubles up to maxReconnectDelayMs. Default 1000. */
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  /** Interval of keep-alive pings in ms. Default 25000. */
  heartbeatMs?: number;
  /** How long to wait for the server to confirm a subscription. Default 10000. */
  subscribeTimeoutMs?: number;
}

export interface ClientOptions {
  auth?: AuthOptions;
  realtime?: RealtimeOptions;
  /** Custom fetch (tests, polyfills, proxies). */
  fetch?: typeof fetch;
  /** Clock in ms, for tests. */
  now?: () => number;
}
