import { AuthClient } from './auth.js';
import { Http } from './http.js';
import { TableClient } from './query.js';
import { RealtimeClient, type RealtimeChannel } from './realtime.js';
import { browserStorage, memoryStorage } from './session-storage.js';
import { StorageClient } from './storage.js';
import type { ClientOptions, Row } from './types.js';

/** The project id is public: it is the `ref` claim of the API key (which the server uses to find the project). */
function projectRefOf(apiKey: string): string {
  try {
    const payload = apiKey.split('.')[1] ?? '';
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const ref = JSON.parse(json).ref;
    if (typeof ref === 'string' && /^[a-z0-9]{16}$/.test(ref)) return ref;
  } catch {
    /* fall through */
  }
  throw new Error('Invalid API key: pass the anon (or service_role) key of your project, as shown by the admin API');
}

/**
 * Everything for one project:
 *   client.from('todos')        database (REST)
 *   client.auth                  sign-up / sign-in / session
 *   client.storage               files
 *   client.channel('x')          realtime changes
 */
export class SupabaseButNoClient {
  readonly auth: AuthClient;
  readonly storage: StorageClient;
  private readonly http: Http;
  private readonly realtime: RealtimeClient;
  /** Id of the project this client talks to. */
  readonly projectRef: string;

  constructor(url: string, apiKey: string, options: ClientOptions = {}) {
    let base: URL;
    try {
      base = new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }
    if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('The URL must start with http:// or https://');
    const cleanUrl = url.replace(/\/+$/, '');
    this.projectRef = projectRefOf(apiKey);

    const fetchFn = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
    this.http = new Http({ url: cleanUrl, apikey: apiKey, fetch: fetchFn });

    const a = options.auth ?? {};
    const defaultStorage = a.storage ? null : browserStorage();
    this.auth = new AuthClient(this.http, {
      storage: a.storage ?? defaultStorage ?? memoryStorage(),
      storageKey: a.storageKey ?? `sbb.auth.${this.projectRef}`,
      persistSession: a.persistSession ?? true,
      autoRefreshToken: a.autoRefreshToken ?? true,
      refreshMarginSeconds: a.refreshMarginSeconds ?? 60,
      now: options.now ?? Date.now,
      syncAcrossTabs: defaultStorage !== null,
    });

    this.storage = new StorageClient(this.http, this.projectRef);
    this.realtime = new RealtimeClient({
      url: cleanUrl,
      apikey: apiKey,
      getToken: () => this.auth.getAccessToken(),
      renewSession: () => this.auth.refreshSessionNow(),
      options: options.realtime ?? {},
    });
    // Tell the realtime connection whenever the user signs in, out, or gets a new token.
    this.auth.onAuthStateChange((event) => {
      if (event !== 'INITIAL_SESSION') this.realtime.updateAuth();
    });
  }

  /** Start a query on a table: `await client.from('todos').select('*').eq('done', false)`. */
  from<T extends Row = Row>(table: string): TableClient<T> {
    return new TableClient<T>(this.http, table);
  }

  channel(name: string): RealtimeChannel {
    return this.realtime.channel(name);
  }

  removeChannel(channel: RealtimeChannel): Promise<'ok'> {
    return this.realtime.removeChannel(channel);
  }

  removeAllChannels(): Promise<void> {
    return this.realtime.removeAllChannels();
  }

  /** Stops background work (token refresh timer, realtime connection). Call it when you are done with the client. */
  dispose(): void {
    this.realtime.disconnect();
    this.auth.dispose();
  }
}

export function createClient(url: string, apiKey: string, options: ClientOptions = {}): SupabaseButNoClient {
  return new SupabaseButNoClient(url, apiKey, options);
}
