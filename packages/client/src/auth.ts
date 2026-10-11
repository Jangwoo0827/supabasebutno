import { SbbError, attempt, type Result } from './errors.js';
import type { Http } from './http.js';
import type { AuthChangeEvent, Session, StorageAdapter, User } from './types.js';

export interface AuthConfig {
  storage: StorageAdapter;
  storageKey: string;
  persistSession: boolean;
  autoRefreshToken: boolean;
  refreshMarginSeconds: number;
  now: () => number;
  /** True when `storage` is the page's localStorage, so other tabs' changes arrive as `storage` events. */
  syncAcrossTabs: boolean;
}

type Listener = (event: AuthChangeEvent, session: Session | null) => void;

const MAX_TIMER_MS = 2_147_483_647;

function isSession(v: any): v is Session {
  return v && typeof v.access_token === 'string' && typeof v.refresh_token === 'string' && typeof v.expires_at === 'number' && typeof v.user?.id === 'string';
}

/**
 * Sign-up / sign-in / sign-out and the lifecycle of the session: it is persisted, kept
 * fresh (on demand, in the background, and after a 401), and shared across tabs.
 */
export class AuthClient {
  private session: Session | null = null;
  private loading: Promise<void> | null = null;
  private refreshing: Promise<Session | null> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private autoRefresh: boolean;
  private disposed = false;
  private readonly listeners = new Set<Listener>();
  private storageListener: ((e: { key: string | null }) => void) | null = null;

  constructor(
    private readonly http: Http,
    private readonly cfg: AuthConfig,
  ) {
    this.autoRefresh = cfg.autoRefreshToken;
    http.getToken = () => this.getAccessToken();
    http.refreshAfterRejection = () => this.refreshAfterRejection();
    this.attachTabSync();
  }

  // ---- public API ----------------------------------------------------------

  signUp(input: { email: string; password: string; data?: Record<string, unknown> }): Promise<Result<{ user: User; session: Session }>> {
    return attempt(async () => {
      const { data } = await this.http.request<Session>({ method: 'POST', path: '/auth/signup', json: input, auth: 'none' });
      await this.setSession(data, 'SIGNED_IN');
      return { user: data.user, session: data };
    });
  }

  signInWithPassword(input: { email: string; password: string }): Promise<Result<{ user: User; session: Session }>> {
    return attempt(async () => {
      const { data } = await this.http.request<Session>({ method: 'POST', path: '/auth/login', json: input, auth: 'none' });
      await this.setSession(data, 'SIGNED_IN');
      return { user: data.user, session: data };
    });
  }

  /**
   * Ends the session. The local session is ALWAYS removed, even if the server could not be
   * reached; `scope: 'global'` also signs out every other device.
   */
  async signOut(opts: { scope?: 'local' | 'global' } = {}): Promise<{ error: SbbError | null }> {
    await this.ensureLoaded();
    const session = this.session;
    let error: SbbError | null = null;
    if (session) {
      const res = await attempt(() =>
        this.http.request({ method: 'POST', path: '/auth/logout', json: { scope: opts.scope ?? 'local' }, token: session.access_token, responseType: 'none' }),
      );
      // 401 means the server already considers the session over: that is what we wanted.
      if (res.error && res.error.status !== 401) error = res.error;
    }
    await this.clear('SIGNED_OUT');
    return { error };
  }

  /** The current session, renewed first if it is about to expire. */
  async getSession(): Promise<Result<{ session: Session | null }>> {
    return attempt(async () => {
      await this.ensureLoaded();
      if (this.session && this.needsRefresh(this.session)) await this.refreshSession().catch(() => undefined);
      return { session: this.session };
    });
  }

  /** Fetches the user from the server (verifies the session is still valid). */
  getUser(): Promise<Result<{ user: User }>> {
    return attempt(async () => {
      try {
        const { data } = await this.http.request<User>({ method: 'GET', path: '/auth/user' });
        return { user: data };
      } catch (err) {
        if (err instanceof SbbError && err.status === 401 && this.session) await this.clear('SIGNED_OUT');
        throw err;
      }
    });
  }

  updateUser(input: { data?: Record<string, unknown>; password?: string; currentPassword?: string }): Promise<Result<{ user: User }>> {
    return attempt(async () => {
      const { data } = await this.http.request<User>({
        method: 'PUT',
        path: '/auth/user',
        json: { data: input.data, password: input.password, current_password: input.currentPassword },
      });
      if (this.session) {
        this.session = { ...this.session, user: data };
        await this.persist();
        this.emit('USER_UPDATED');
      }
      return { user: data };
    });
  }

  /** Asks the server to mail a password-reset token. Always succeeds, whether or not the address is registered. */
  resetPasswordForEmail(email: string): Promise<Result<null>> {
    return attempt(async () => {
      await this.http.request({ method: 'POST', path: '/auth/recover', json: { email }, auth: 'none', responseType: 'none' });
      return null;
    });
  }

  /** Sets a new password using the token from the reset message. All sessions are ended; sign in again afterwards. */
  resetPassword(input: { token: string; password: string }): Promise<Result<null>> {
    return attempt(async () => {
      await this.http.request({ method: 'POST', path: '/auth/reset', json: input, auth: 'none', responseType: 'none' });
      await this.clear('SIGNED_OUT');
      return null;
    });
  }

  /** Forces a token renewal now. */
  refreshSessionNow(): Promise<Result<{ session: Session | null }>> {
    return attempt(async () => ({ session: await this.refreshSession() }));
  }

  /**
   * Subscribes to sign-in / sign-out / token changes. The callback is also called once,
   * asynchronously, with `INITIAL_SESSION` and the restored session (or null).
   */
  onAuthStateChange(callback: Listener): { data: { subscription: { unsubscribe: () => void } } } {
    this.listeners.add(callback);
    void this.ensureLoaded().then(() => {
      if (this.listeners.has(callback)) this.safeCall(callback, 'INITIAL_SESSION', this.session);
    });
    return { data: { subscription: { unsubscribe: () => void this.listeners.delete(callback) } } };
  }

  startAutoRefresh(): void {
    this.autoRefresh = true;
    this.schedule();
  }

  stopAutoRefresh(): void {
    this.autoRefresh = false;
    this.cancelTimer();
  }

  /** Stops timers and listeners for good. The stored session is left in place. */
  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
    this.listeners.clear();
    if (this.storageListener) (globalThis as any).removeEventListener?.('storage', this.storageListener);
    this.storageListener = null;
  }

  // ---- used by the other clients -------------------------------------------

  /** A usable access token, or null when signed out. Renews the session first when it is about to expire. */
  async getAccessToken(): Promise<string | null> {
    await this.ensureLoaded();
    const session = this.session;
    if (!session) return null;
    if (!this.needsRefresh(session)) return session.access_token;
    try {
      const fresh = await this.refreshSession();
      return fresh?.access_token ?? null;
    } catch {
      // The server was unreachable. Hand out the old token: it may still work, and if not the server will say so.
      return session.access_token;
    }
  }

  private async refreshAfterRejection(): Promise<boolean> {
    const before = this.session?.access_token;
    const fresh = await this.refreshSession().catch(() => null);
    return !!fresh && fresh.access_token !== before;
  }

  // ---- session lifecycle ---------------------------------------------------

  private ensureLoaded(): Promise<void> {
    this.loading ??= (async () => {
      const stored = await this.readStorage();
      if (stored) {
        this.session = stored;
        this.schedule();
      }
    })();
    return this.loading;
  }

  private needsRefresh(s: Session): boolean {
    return s.expires_at - this.cfg.now() / 1000 <= this.cfg.refreshMarginSeconds;
  }

  /** Renews the token. Concurrent callers share one request. Resolves null if the session has ended. */
  private refreshSession(): Promise<Session | null> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<Session | null> {
    await this.ensureLoaded();
    const current = this.session;
    if (!current) return null;

    // Another tab may have renewed already; the refresh token rotates, so adopt its result instead of racing it.
    const stored = await this.readStorage();
    if (stored && stored.refresh_token !== current.refresh_token && stored.expires_at > current.expires_at) {
      this.session = stored;
      this.schedule();
      this.emit('TOKEN_REFRESHED');
      return stored;
    }

    try {
      const { data } = await this.http.request<Session>({ method: 'POST', path: '/auth/refresh', json: { refresh_token: current.refresh_token }, auth: 'none' });
      await this.setSession(data, 'TOKEN_REFRESHED');
      return data;
    } catch (err) {
      // 4xx (other than rate limiting): the refresh token is dead, so the session is over.
      if (err instanceof SbbError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        await this.clear('SIGNED_OUT');
        return null;
      }
      throw err; // network trouble or server error: keep the session and try again later
    }
  }

  private async setSession(session: Session, event: AuthChangeEvent): Promise<void> {
    this.session = session;
    await this.persist();
    this.schedule();
    this.emit(event);
  }

  private async clear(event: AuthChangeEvent): Promise<void> {
    const had = this.session !== null;
    this.session = null;
    this.cancelTimer();
    if (this.cfg.persistSession) {
      try {
        await this.cfg.storage.removeItem(this.cfg.storageKey); // may throw synchronously (blocked storage) or reject
      } catch {
        /* the in-memory session is gone, which is what matters */
      }
    }
    if (had) this.emit(event);
  }

  private emit(event: AuthChangeEvent): void {
    for (const l of [...this.listeners]) this.safeCall(l, event, this.session);
  }

  private safeCall(l: Listener, event: AuthChangeEvent, session: Session | null): void {
    try {
      l(event, session);
    } catch (err) {
      console.error('onAuthStateChange listener failed:', err);
    }
  }

  // ---- persistence and timers ----------------------------------------------

  private async persist(): Promise<void> {
    if (!this.cfg.persistSession || !this.session) return;
    try {
      await this.cfg.storage.setItem(this.cfg.storageKey, JSON.stringify(this.session));
    } catch {
      /* storage full or unavailable: the session still works for this page */
    }
  }

  private async readStorage(): Promise<Session | null> {
    if (!this.cfg.persistSession) return null;
    try {
      const raw = await this.cfg.storage.getItem(this.cfg.storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return isSession(parsed) ? parsed : null; // ignore corrupted or foreign data
    } catch {
      return null;
    }
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Renews the token in the background shortly before it expires (needed by realtime, which makes no requests). */
  private schedule(): void {
    this.cancelTimer();
    const s = this.session;
    // A refresh that was already running when dispose() was called must not start the cycle again.
    if (this.disposed || !this.autoRefresh || !s) return;
    const delay = Math.min(Math.max((s.expires_at - this.cfg.refreshMarginSeconds) * 1000 - this.cfg.now(), 1000), MAX_TIMER_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refreshSession().catch(() => this.retryLater());
    }, delay);
    (this.timer as { unref?: () => void }).unref?.(); // never keep a Node process alive just for this
  }

  private retryLater(): void {
    if (this.disposed || !this.autoRefresh || !this.session) return;
    this.timer = setTimeout(() => void this.refreshSession().catch(() => this.retryLater()), 15_000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Picks up sign-ins, sign-outs and renewals made in other tabs. */
  private attachTabSync(): void {
    const g = globalThis as any;
    if (!this.cfg.syncAcrossTabs || typeof g.addEventListener !== 'function') return;
    this.storageListener = (e) => {
      if (e.key !== this.cfg.storageKey) return;
      void this.readStorage().then((stored) => {
        const before = this.session;
        this.session = stored;
        this.schedule();
        if (!stored && before) this.emit('SIGNED_OUT');
        else if (stored && !before) this.emit('SIGNED_IN');
        else if (stored && before && stored.access_token !== before.access_token) this.emit('TOKEN_REFRESHED');
      });
    };
    g.addEventListener('storage', this.storageListener);
  }
}
