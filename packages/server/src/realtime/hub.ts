import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { z, ZodError } from 'zod';
import { isSessionActive } from '../auth/service.js';
import type { Config } from '../config.js';
import { AppError, notFound } from '../core/errors.js';
import type { ProjectRegistry } from '../db/registry.js';
import { pickClientIp } from '../http/client-ip.js';
import { resolveIdentity, type Identity } from '../http/identity.js';
import { forbidden } from '../policy/plan.js';
import { matches } from '../policy/eval.js';
import type { PolicyStore } from '../policy/store.js';
import type { Policy, PolicyRole } from '../policy/types.js';
import { parseFilterString, type Filter } from '../rest/parse.js';
import { decodeRow } from '../rest/values.js';
import type { SchemaCache } from '../schema/cache.js';
import { matchesFilters } from './filter.js';
import type { ChangeType, RowChange } from './types.js';

export interface HubDeps {
  config: Config;
  registry: ProjectRegistry;
  schemas: SchemaCache;
  policies: PolicyStore;
  /** Current time in ms. */
  now: () => number;
}

export interface HubOptions {
  /** How long a new connection may stay silent before it must have sent `auth`. */
  authTimeoutMs: number;
  /** Interval of the housekeeping timer (token expiry, revoked sessions, dead peers). */
  sweepIntervalMs: number;
  /** Connections accepted in total. */
  maxConnections: number;
  maxConnectionsPerIp: number;
  maxSubscriptionsPerConnection: number;
  /** Largest message a client may send. */
  maxMessageBytes: number;
  /** A client whose unsent backlog exceeds this is disconnected instead of buffering without bound. */
  maxBufferedBytes: number;
}

export const DEFAULT_HUB_OPTIONS: HubOptions = {
  authTimeoutMs: 5_000,
  sweepIntervalMs: 15_000,
  maxConnections: 500,
  maxConnectionsPerIp: 20,
  maxSubscriptionsPerConnection: 20,
  maxMessageBytes: 16 * 1024,
  maxBufferedBytes: 1024 * 1024,
};

const SESSION_RECHECK_MS = 60_000;
const MESSAGE_WINDOW_MS = 10_000;
const MAX_MESSAGES_PER_WINDOW = 100;
const PATH = '/realtime';

// WebSocket close codes in the 4000 range are free for applications.
const CLOSE_BAD_REQUEST = 4400;
const CLOSE_UNAUTHORIZED = 4401;

const eventName = z.enum(['INSERT', 'UPDATE', 'DELETE', '*']);
const authMsg = z.strictObject({ type: z.literal('auth'), apikey: z.string().min(1).max(2000), access_token: z.string().max(4000).optional() });
const subscribeMsg = z.strictObject({
  type: z.literal('subscribe'),
  id: z.string().min(1).max(64),
  table: z.string().max(64),
  events: z.array(eventName).min(1).max(4).optional(),
  filter: z.string().max(512).optional(),
});
const unsubscribeMsg = z.strictObject({ type: z.literal('unsubscribe'), id: z.string().min(1).max(64) });

interface Subscription {
  id: string;
  table: string;
  events: ReadonlySet<ChangeType>;
  filters: Filter[];
}

class Connection {
  identity: Identity | null = null;
  readonly subs = new Map<string, Subscription>();
  isAlive = true;
  lastSessionCheck: number;
  recent: number[] = [];
  authTimer: NodeJS.Timeout | undefined;
  closing = false;

  constructor(
    readonly ws: WebSocket,
    readonly ip: string,
    now: number,
  ) {
    this.lastSessionCheck = now;
  }
}

/**
 * Pushes committed row changes to WebSocket subscribers.
 *
 * Protocol (JSON text frames, endpoint `/realtime`):
 *   client -> {type:"auth", apikey, access_token?}     must be the first message
 *            {type:"subscribe", id, table, events?, filter?}   events: INSERT|UPDATE|DELETE|*, filter: "col=eq.value&..."
 *            {type:"unsubscribe", id}
 *   server -> {type:"auth_ok", role, user_id, expires_at}
 *            {type:"subscribed"|"unsubscribed", id}
 *            {type:"event", subscription, event, table, new?, old?, commit_timestamp}
 *            {type:"error", id?, code, message}
 *
 * Credentials travel in the first message, never in the URL (URLs end up in logs).
 * Every event is checked against the subscriber's SELECT policy at delivery time, so a
 * policy change or a lost session takes effect immediately.
 */
export class RealtimeHub {
  private readonly opts: HubOptions;
  private readonly wss: WebSocketServer;
  private readonly conns = new Set<Connection>();
  private readonly byTable = new Map<string, Set<Connection>>();
  private readonly perIp = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly deps: HubDeps,
    options: Partial<HubOptions> = {},
  ) {
    this.opts = { ...DEFAULT_HUB_OPTIONS, ...options };
    // Compression is off: it costs CPU and memory per connection, and invites decompression-bomb tricks.
    this.wss = new WebSocketServer({ noServer: true, maxPayload: this.opts.maxMessageBytes, perMessageDeflate: false });
  }

  // ---- lifecycle -----------------------------------------------------------

  /** Handles WebSocket upgrades for `/realtime` on the given HTTP server. */
  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => {
      const reject = this.checkUpgrade(req);
      if (reject) return refuse(socket, reject.status, reject.text);
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
    });
    server.on('close', () => void this.close());
    this.timer ??= setInterval(() => void this.housekeeping(), this.opts.sweepIntervalMs).unref();
  }

  private checkUpgrade(req: IncomingMessage): { status: number; text: string } | null {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== PATH) return { status: 404, text: 'Not Found' };
    // Browsers always send Origin. When specific origins are configured, others are turned away.
    // (Credentials are never taken from cookies, so this is hygiene, not the security boundary.)
    const allowed = this.deps.config.corsOrigins;
    const origin = req.headers.origin;
    if (origin && allowed !== 'any' && allowed.length > 0 && !allowed.includes(origin)) return { status: 403, text: 'Forbidden' };
    if (this.conns.size >= this.opts.maxConnections) return { status: 503, text: 'Service Unavailable' };
    if ((this.perIp.get(this.ipOf(req)) ?? 0) >= this.opts.maxConnectionsPerIp) return { status: 429, text: 'Too Many Requests' };
    return null;
  }

  private ipOf(req: IncomingMessage): string {
    const xff = req.headers['x-forwarded-for'];
    return pickClientIp(Array.isArray(xff) ? xff.join(',') : xff, req.socket.remoteAddress, this.deps.config.trustProxyHops);
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const conn of [...this.conns]) conn.ws.close(1001, 'server shutting down');
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  // ---- publishing (called by the REST layer after a transaction commits) ---

  hasSubscribers(projectId: string, table: string): boolean {
    return (this.byTable.get(`${projectId}/${table}`)?.size ?? 0) > 0;
  }

  /** Queues changes for delivery. Order is preserved; never throws into the caller. */
  publish(projectId: string, changes: RowChange[]): void {
    if (changes.length === 0) return;
    this.queue = this.queue.then(() => this.dispatch(projectId, changes)).catch((err) => console.error('realtime dispatch failed:', err));
  }

  /** Resolves when everything published so far has been delivered (for tests and graceful shutdown). */
  idle(): Promise<void> {
    return this.queue;
  }

  stats() {
    let subscriptions = 0;
    for (const c of this.conns) subscriptions += c.subs.size;
    return { connections: this.conns.size, subscriptions };
  }

  private async dispatch(projectId: string, changes: RowChange[]): Promise<void> {
    for (const change of changes) {
      const conns = this.byTable.get(`${projectId}/${change.table.name}`);
      if (!conns?.size) continue;
      const policy = await this.deps.policies.get(projectId, await this.deps.registry.db(projectId), change.table.name);
      const stamp = new Date(this.deps.now()).toISOString();

      for (const conn of [...conns]) {
        const identity = conn.identity;
        if (!identity || conn.closing) continue;
        const canSee = (row: Record<string, unknown>) => visible(identity, policy, row);
        for (const sub of conn.subs.values()) {
          if (sub.table !== change.table.name || !sub.events.has(change.type)) continue;
          const subject = change.type === 'DELETE' ? change.old : change.new;
          if (!subject || !canSee(subject) || !matchesFilters(sub.filters, subject)) continue;
          // The previous row is only revealed to someone who could also have seen it.
          const old = change.type !== 'INSERT' && change.old && canSee(change.old) ? change.old : undefined;
          this.send(conn, {
            type: 'event',
            subscription: sub.id,
            event: change.type,
            table: change.table.name,
            ...(change.new ? { new: decodeRow(change.table, change.new) } : {}),
            ...(old ? { old: decodeRow(change.table, old) } : {}),
            commit_timestamp: stamp,
          });
        }
      }
    }
  }

  // ---- connections ---------------------------------------------------------

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const ip = this.ipOf(req);
    const conn = new Connection(ws, ip, this.deps.now());
    this.conns.add(conn);
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
    conn.authTimer = setTimeout(() => this.fail(conn, CLOSE_UNAUTHORIZED, 'auth_timeout', 'Send an auth message first'), this.opts.authTimeoutMs);

    ws.on('message', (data, isBinary) => void this.onMessage(conn, data, isBinary));
    ws.on('pong', () => (conn.isAlive = true));
    ws.on('close', () => this.drop(conn));
    ws.on('error', () => ws.terminate()); // oversized frame, protocol violation, ...
  }

  private drop(conn: Connection): void {
    if (!this.conns.delete(conn)) return;
    clearTimeout(conn.authTimer);
    const left = (this.perIp.get(conn.ip) ?? 1) - 1;
    if (left <= 0) this.perIp.delete(conn.ip);
    else this.perIp.set(conn.ip, left);
    // Empty the subscription list first: unindex() keeps the connection indexed while any subscription still uses the table.
    const tables = new Set([...conn.subs.values()].map((s) => s.table));
    conn.subs.clear();
    for (const table of tables) this.unindex(conn, table);
  }

  private index(conn: Connection, table: string): void {
    const key = `${conn.identity!.project.id}/${table}`;
    let set = this.byTable.get(key);
    if (!set) this.byTable.set(key, (set = new Set()));
    set.add(conn);
  }

  /** Removes the connection from a table's index once none of its subscriptions use that table. */
  private unindex(conn: Connection, table: string): void {
    if ([...conn.subs.values()].some((s) => s.table === table)) return;
    const key = `${conn.identity!.project.id}/${table}`;
    const set = this.byTable.get(key);
    set?.delete(conn);
    if (set && set.size === 0) this.byTable.delete(key);
  }

  private send(conn: Connection, message: unknown): void {
    const ws = conn.ws;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > this.opts.maxBufferedBytes) {
      ws.close(1013, 'slow consumer'); // would otherwise grow memory without bound
      return;
    }
    ws.send(JSON.stringify(message));
  }

  private error(conn: Connection, code: string, message: string, id?: string): void {
    this.send(conn, { type: 'error', ...(id ? { id } : {}), code, message });
  }

  /** Tells the client why, then closes. */
  private fail(conn: Connection, closeCode: number, code: string, message: string): void {
    if (conn.closing) return;
    conn.closing = true;
    this.error(conn, code, message);
    conn.ws.close(closeCode, code);
  }

  // ---- messages ------------------------------------------------------------

  private async onMessage(conn: Connection, data: RawData, isBinary: boolean): Promise<void> {
    if (conn.closing) return;
    const now = this.deps.now();
    conn.recent = conn.recent.filter((t) => t > now - MESSAGE_WINDOW_MS);
    if (conn.recent.push(now) > MAX_MESSAGES_PER_WINDOW) return this.fail(conn, 1008, 'rate_limited', 'Too many messages');
    if (isBinary) return this.fail(conn, CLOSE_BAD_REQUEST, 'invalid_message', 'Only JSON text frames are supported');

    let msg: unknown;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return this.fail(conn, CLOSE_BAD_REQUEST, 'invalid_json', 'Messages must be valid JSON');
    }
    const type = (msg as { type?: unknown } | null)?.type;
    const id = typeof (msg as { id?: unknown } | null)?.id === 'string' ? (msg as { id: string }).id : undefined;

    try {
      if (type === 'auth') await this.handleAuth(conn, msg);
      else if (!conn.identity) return this.fail(conn, CLOSE_UNAUTHORIZED, 'unauthenticated', 'Send an auth message first');
      else if (type === 'subscribe') await this.handleSubscribe(conn, msg);
      else if (type === 'unsubscribe') this.handleUnsubscribe(conn, msg);
      else if (type === 'ping') this.send(conn, { type: 'pong' });
      else this.error(conn, 'unknown_type', 'Unknown message type', id);
    } catch (err) {
      if (err instanceof ZodError) this.error(conn, 'invalid_message', err.issues[0]?.message ?? 'Invalid message', id);
      else if (err instanceof AppError) this.error(conn, err.code, err.message, id);
      else {
        console.error('realtime message failed:', err);
        this.error(conn, 'internal_error', 'Internal server error', id);
      }
    }
  }

  private async handleAuth(conn: Connection, raw: unknown): Promise<void> {
    const msg = authMsg.parse(raw);
    const identity = await resolveIdentity(this.deps, msg.apikey, msg.access_token);
    if (!identity) return this.fail(conn, CLOSE_UNAUTHORIZED, 'invalid_apikey', 'Invalid API key');
    if (identity.bearer === 'expired') return this.fail(conn, CLOSE_UNAUTHORIZED, 'token_expired', 'The access token has expired');
    if (identity.bearer === 'invalid') return this.fail(conn, CLOSE_UNAUTHORIZED, 'invalid_token', 'Invalid access token');
    if (conn.identity && conn.identity.project.id !== identity.project.id) {
      return this.fail(conn, CLOSE_UNAUTHORIZED, 'project_mismatch', 'A connection cannot switch projects');
    }

    conn.identity = identity; // re-auth (token refresh) keeps existing subscriptions; access is re-evaluated per event
    conn.lastSessionCheck = this.deps.now();
    clearTimeout(conn.authTimer);
    this.send(conn, { type: 'auth_ok', role: identity.role, user_id: identity.userId, expires_at: identity.tokenExpiresAt });
  }

  private async handleSubscribe(conn: Connection, raw: unknown): Promise<void> {
    const msg = subscribeMsg.parse(raw);
    const identity = conn.identity!;
    if (conn.subs.has(msg.id)) throw new AppError(409, 'duplicate_subscription', `Subscription "${msg.id}" already exists`);
    if (conn.subs.size >= this.opts.maxSubscriptionsPerConnection) {
      throw new AppError(429, 'too_many_subscriptions', `At most ${this.opts.maxSubscriptionsPerConnection} subscriptions per connection`);
    }

    // Same order as REST: decide access first, so nobody can probe which tables exist.
    const db = await this.deps.registry.db(identity.project.id);
    if (identity.role !== 'service_role') {
      const rule = (await this.deps.policies.get(identity.project.id, db, msg.table))?.select;
      if (!rule || !rule.roles.includes(identity.role as PolicyRole)) throw forbidden();
    }
    const table = await this.deps.schemas.table(identity.project.id, db, msg.table);
    if (!table) throw notFound('Table');

    const filters = msg.filter ? parseFilterString(msg.filter, table) : [];
    const wanted = msg.events ?? ['*'];
    const events = new Set<ChangeType>(wanted.includes('*') ? ['INSERT', 'UPDATE', 'DELETE'] : (wanted as ChangeType[]));

    conn.subs.set(msg.id, { id: msg.id, table: table.name, events, filters });
    this.index(conn, table.name);
    this.send(conn, { type: 'subscribed', id: msg.id });
  }

  private handleUnsubscribe(conn: Connection, raw: unknown): void {
    const { id } = unsubscribeMsg.parse(raw);
    const sub = conn.subs.get(id);
    if (!sub) throw notFound('Subscription');
    conn.subs.delete(id);
    this.unindex(conn, sub.table);
    this.send(conn, { type: 'unsubscribed', id });
  }

  // ---- housekeeping --------------------------------------------------------

  /** Closes connections whose user token expired or whose session was revoked. Runs on a timer; callable directly. */
  async sweep(): Promise<void> {
    const now = this.deps.now();
    for (const conn of [...this.conns]) {
      const identity = conn.identity;
      if (!identity || conn.closing || !identity.userId) continue;
      if (identity.tokenExpiresAt !== null && now / 1000 >= identity.tokenExpiresAt) {
        this.fail(conn, CLOSE_UNAUTHORIZED, 'token_expired', 'The access token has expired; send a new auth message');
      } else if (now - conn.lastSessionCheck >= SESSION_RECHECK_MS) {
        conn.lastSessionCheck = now;
        const db = await this.deps.registry.db(identity.project.id);
        if (!(await isSessionActive(db, identity.sessionId!, identity.userId))) {
          this.fail(conn, CLOSE_UNAUTHORIZED, 'session_revoked', 'The session has ended');
        }
      }
    }
  }

  /** Pings every client; one that did not answer the previous ping is dropped. */
  private heartbeat(): void {
    for (const conn of this.conns) {
      if (!conn.isAlive) {
        conn.ws.terminate();
        continue;
      }
      conn.isAlive = false;
      conn.ws.ping();
    }
  }

  private async housekeeping(): Promise<void> {
    this.heartbeat();
    await this.sweep().catch((err) => console.error('realtime sweep failed:', err));
  }
}

/** Whether a row may be shown to this identity under the table's SELECT policy. */
function visible(identity: Identity, policy: Policy | undefined, row: Record<string, unknown>): boolean {
  if (identity.role === 'service_role') return true;
  const rule = policy?.select;
  if (!rule || !rule.roles.includes(identity.role as PolicyRole)) return false;
  return matches(rule.where, row, { uid: identity.userId });
}

function refuse(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}
