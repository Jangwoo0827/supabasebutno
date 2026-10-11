import type { RealtimeOptions, Row } from './types.js';

export type RealtimeStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED';
export type ChangeEvent = 'INSERT' | 'UPDATE' | 'DELETE';

export interface ChangeFilter {
  /** Which changes to receive. */
  event: ChangeEvent | '*';
  /** Accepted for compatibility with supabase-js; there is only one schema. */
  schema?: string;
  table: string;
  /** Only rows matching a REST-style filter, e.g. `mode=eq.rush` or `level=gte.5&done=eq.false` (AND). */
  filter?: string;
}

export interface ChangePayload<T extends Row = Row> {
  schema: 'public';
  table: string;
  commit_timestamp: string;
  eventType: ChangeEvent;
  /** The row after the change (INSERT, UPDATE); `{}` for DELETE. */
  new: T | Record<string, never>;
  /** The row before the change (UPDATE, DELETE) when you are allowed to see it; otherwise `{}`. */
  old: Partial<T> | Record<string, never>;
  errors: null;
}

type StatusCallback = (status: RealtimeStatus, error?: Error) => void;
type ChangeCallback<T extends Row> = (payload: ChangePayload<T>) => void;

interface Binding {
  id: string;
  filter: ChangeFilter;
  callback: ChangeCallback<any>;
  state: 'idle' | 'pending' | 'subscribed' | 'error';
  timeout?: ReturnType<typeof setTimeout>;
  error?: string;
}

const unref = (t: unknown) => (t as { unref?: () => void }).unref?.();

/**
 * A group of subscriptions with one status callback.
 *
 *   const channel = client.channel('board')
 *     .on('postgres_changes', { event: 'INSERT', table: 'scores', filter: 'mode=eq.rush' }, (p) => console.log(p.new))
 *     .subscribe((status) => { if (status === 'SUBSCRIBED') reloadScores(); })
 *
 * `SUBSCRIBED` is reported again after every reconnect. Changes made while the connection
 * was down are NOT replayed, so reload the current state when you see it.
 */
export class RealtimeChannel {
  /** @internal */ readonly bindings: Binding[] = [];
  /** @internal */ statusCallback: StatusCallback | undefined;
  /** @internal */ lastStatus: RealtimeStatus | null = null;
  /** @internal */ joined = false;

  /** @internal */
  constructor(
    readonly topic: string,
    private readonly client: RealtimeClient,
  ) {}

  on<T extends Row = Row>(type: 'postgres_changes', filter: ChangeFilter, callback: ChangeCallback<T>): this {
    if (type !== 'postgres_changes') throw new Error(`Unsupported channel event type "${String(type)}"; only 'postgres_changes' exists`);
    if (this.joined) throw new Error('Add all .on() listeners before calling .subscribe()');
    this.bindings.push({ id: this.client.nextId(), filter, callback, state: 'idle' });
    return this;
  }

  subscribe(callback?: StatusCallback): this {
    this.statusCallback = callback;
    this.client.join(this);
    return this;
  }

  /** Stops receiving events. Resolves when done. When the last channel goes, the connection is closed. */
  unsubscribe(): Promise<'ok'> {
    return this.client.leave(this);
  }
}

/** One WebSocket shared by all channels, with automatic re-authentication, re-subscription and reconnection. */
export class RealtimeClient {
  private ws: WebSocket | null = null;
  private state: 'closed' | 'connecting' | 'authenticating' | 'ready' = 'closed';
  private readonly channels = new Set<RealtimeChannel>();
  private seq = 0;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivity = 0;
  private fatal = false;
  private readonly opts: Required<Omit<RealtimeOptions, 'WebSocket'>>;

  constructor(
    private readonly cfg: {
      url: string;
      apikey: string;
      getToken: () => Promise<string | null>;
      /** Called when the server rejected our token; should renew the session. */
      renewSession: () => Promise<unknown>;
      options: RealtimeOptions;
    },
  ) {
    this.opts = {
      reconnectDelayMs: cfg.options.reconnectDelayMs ?? 1000,
      maxReconnectDelayMs: cfg.options.maxReconnectDelayMs ?? 30_000,
      heartbeatMs: cfg.options.heartbeatMs ?? 25_000,
      subscribeTimeoutMs: cfg.options.subscribeTimeoutMs ?? 10_000,
    };
  }

  /** @internal */
  nextId(): string {
    return `sub${++this.seq}`;
  }

  channel(name: string): RealtimeChannel {
    return new RealtimeChannel(name, this);
  }

  removeChannel(channel: RealtimeChannel): Promise<'ok'> {
    return channel.unsubscribe();
  }

  async removeAllChannels(): Promise<void> {
    await Promise.all([...this.channels].map((c) => c.unsubscribe()));
  }

  /** Closes the connection and forgets all channels. */
  disconnect(): void {
    for (const ch of [...this.channels]) this.notify(ch, 'CLOSED');
    this.channels.clear();
    this.closeSocket(1000, 'client disconnect');
  }

  /** Sends the current access token to the server (call after sign-in, sign-out or token renewal). */
  updateAuth(): void {
    if (this.state === 'ready') void this.sendAuth();
  }

  // ---- channel membership -----------------------------------------------------

  /** @internal */
  join(channel: RealtimeChannel): void {
    channel.joined = true;
    channel.lastStatus = null;
    this.channels.add(channel);
    if (channel.bindings.length === 0) return this.notify(channel, 'SUBSCRIBED');
    this.fatal = false;
    if (this.state === 'ready') this.subscribePending();
    else this.connect();
  }

  /** @internal */
  async leave(channel: RealtimeChannel): Promise<'ok'> {
    if (!this.channels.delete(channel)) return 'ok';
    for (const b of channel.bindings) {
      clearTimeout(b.timeout);
      if (b.state === 'subscribed' || b.state === 'pending') this.send({ type: 'unsubscribe', id: b.id });
      b.state = 'idle';
    }
    this.notify(channel, 'CLOSED');
    if (this.channels.size === 0) this.closeSocket(1000, 'no channels');
    return 'ok';
  }

  // ---- connection ---------------------------------------------------------------

  private connect(): void {
    if (this.state !== 'closed' || this.reconnectTimer || this.channels.size === 0) return;
    const WS = this.cfg.options.WebSocket ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!WS) {
      this.failAll(new Error("No WebSocket available in this environment. Pass { realtime: { WebSocket } } (e.g. from the 'ws' package)."));
      return;
    }
    this.state = 'connecting';
    let ws: WebSocket;
    try {
      ws = new WS(`${this.cfg.url.replace(/^http/, 'ws')}/realtime`);
    } catch (err) {
      this.state = 'closed';
      this.failAll(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.state = 'authenticating';
      this.lastActivity = Date.now();
      void this.sendAuth();
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws === ws) this.onMessage(ev.data);
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws === ws) this.onClose(ev.code, ev.reason);
    };
    ws.onerror = () => undefined; // a close event always follows
  }

  private async sendAuth(): Promise<void> {
    const token = await this.cfg.getToken().catch(() => null);
    this.send({ type: 'auth', apikey: this.cfg.apikey, access_token: token ?? undefined });
  }

  private send(message: unknown): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(message));
  }

  private closeSocket(code: number, reason: string): void {
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    this.state = 'closed';
    this.attempts = 0;
    for (const ch of this.channels) for (const b of ch.bindings) b.state = 'idle';
    try {
      ws?.close(code, reason);
    } catch {
      /* already closed */
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = this.heartbeatTimer = null;
    for (const ch of this.channels) for (const b of ch.bindings) clearTimeout(b.timeout);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      // No sign of life for two intervals (not even a pong): the connection is dead, so drop it and reconnect.
      if (Date.now() - this.lastActivity > this.opts.heartbeatMs * 2) {
        this.ws?.close(4000, 'heartbeat timeout');
        return;
      }
      this.send({ type: 'ping' });
    }, this.opts.heartbeatMs);
    unref(this.heartbeatTimer);
  }

  private onMessage(raw: unknown): void {
    this.lastActivity = Date.now();
    let m: any;
    try {
      m = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    switch (m.type) {
      case 'auth_ok':
        this.state = 'ready';
        this.attempts = 0;
        this.startHeartbeat();
        this.subscribePending();
        break;
      case 'subscribed':
        this.markBinding(m.id, 'subscribed');
        break;
      case 'event':
        this.dispatch(m);
        break;
      case 'error':
        if (m.id) this.markBinding(m.id, 'error', m.message);
        break; // errors without an id are followed by a close, handled in onClose
    }
  }

  private findBinding(id: string): { channel: RealtimeChannel; binding: Binding } | undefined {
    for (const channel of this.channels) {
      const binding = channel.bindings.find((b) => b.id === id);
      if (binding) return { channel, binding };
    }
    return undefined;
  }

  private dispatch(m: any): void {
    const hit = this.findBinding(m.subscription);
    if (!hit) return;
    const payload: ChangePayload = {
      schema: 'public',
      table: m.table,
      commit_timestamp: m.commit_timestamp,
      eventType: m.event,
      new: m.new ?? {},
      old: m.old ?? {},
      errors: null,
    };
    try {
      hit.binding.callback(payload);
    } catch (err) {
      console.error('realtime listener failed:', err);
    }
  }

  private subscribePending(): void {
    for (const channel of this.channels) {
      for (const b of channel.bindings) {
        if (b.state === 'subscribed' || b.state === 'pending') continue;
        b.state = 'pending';
        b.error = undefined;
        clearTimeout(b.timeout);
        b.timeout = setTimeout(() => {
          if (b.state === 'pending') this.notify(channel, 'TIMED_OUT');
        }, this.opts.subscribeTimeoutMs);
        unref(b.timeout);
        const f = b.filter;
        this.send({ type: 'subscribe', id: b.id, table: f.table, events: [f.event], ...(f.filter ? { filter: f.filter } : {}) });
      }
    }
  }

  private markBinding(id: string, state: 'subscribed' | 'error', error?: string): void {
    const hit = this.findBinding(id);
    if (!hit) return;
    clearTimeout(hit.binding.timeout);
    hit.binding.state = state;
    hit.binding.error = error;
    const bs = hit.channel.bindings;
    const failed = bs.find((b) => b.state === 'error');
    if (failed) this.notify(hit.channel, 'CHANNEL_ERROR', new Error(failed.error ?? 'subscription failed'));
    else if (bs.every((b) => b.state === 'subscribed')) this.notify(hit.channel, 'SUBSCRIBED');
  }

  private notify(channel: RealtimeChannel, status: RealtimeStatus, error?: Error): void {
    if (channel.lastStatus === status) return;
    channel.lastStatus = status;
    try {
      channel.statusCallback?.(status, error);
    } catch (err) {
      console.error('realtime status callback failed:', err);
    }
  }

  private failAll(error: Error): void {
    this.fatal = true;
    for (const ch of this.channels) this.notify(ch, 'CHANNEL_ERROR', error);
  }

  private onClose(code: number, reason: string): void {
    this.clearTimers();
    this.ws = null;
    this.state = 'closed';
    for (const ch of this.channels) {
      for (const b of ch.bindings) b.state = 'idle';
      ch.lastStatus = null;
      this.notify(ch, 'CLOSED');
    }
    if (this.channels.size === 0 || this.fatal) return;

    if (code === 4401) {
      if (reason === 'invalid_apikey' || reason === 'project_mismatch') return this.failAll(new Error(`Realtime connection refused: ${reason}`));
      // The server no longer accepts our token (expired, session revoked...): renew it, then reconnect right away.
      // If the session really ended, renewal signs us out and the reconnect continues as anon.
      void this.cfg.renewSession().catch(() => undefined).finally(() => this.connect());
      return;
    }
    const delay = Math.min(this.opts.reconnectDelayMs * 2 ** this.attempts, this.opts.maxReconnectDelayMs);
    this.attempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay * (0.75 + Math.random() * 0.25)); // jitter, so many clients do not reconnect in lockstep
    unref(this.reconnectTimer);
  }
}
