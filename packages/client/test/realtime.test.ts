import { afterEach, describe, expect, it } from 'vitest';
import { createClient, type ChangePayload, type RealtimeStatus } from '../src/index.js';
import { PASSWORD, eventually, fakeKey, sleep, startServer, type Harness } from './support.js';

// ---- protocol, against a scripted fake WebSocket --------------------------------------------------

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: any[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  // test controls
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  say(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop(code = 1006, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  types() {
    return this.sent.map((m) => m.type);
  }
}

const fakeClient = (extra: Record<string, unknown> = {}) => {
  FakeSocket.instances = [];
  return createClient('https://sbb.example', fakeKey(), {
    realtime: { WebSocket: FakeSocket as never, reconnectDelayMs: 20, maxReconnectDelayMs: 80, heartbeatMs: 50, subscribeTimeoutMs: 100, ...extra },
    fetch: (async () => new Response('{}', { status: 401 })) as never,
  });
};
const ws = () => FakeSocket.instances.at(-1)!;
const connected = async (c: ReturnType<typeof fakeClient>) => {
  await eventually(() => FakeSocket.instances.length > 0);
  ws().open();
  await eventually(() => ws().sent.some((m) => m.type === 'auth'));
  ws().say({ type: 'auth_ok', role: 'anon', user_id: null, expires_at: null });
  return ws();
};
const track: { dispose(): void }[] = [];
afterEach(() => track.splice(0).forEach((c) => c.dispose()));

describe('realtime protocol', () => {
  it('connects to wss://…/realtime, authenticates with the key, then subscribes', async () => {
    const c = fakeClient();
    track.push(c);
    const statuses: RealtimeStatus[] = [];
    c.channel('board').on('postgres_changes', { event: 'INSERT', table: 'scores', filter: 'mode=eq.rush' }, () => {}).subscribe((s) => statuses.push(s));

    const sock = await connected(c);
    expect(sock.url).toBe('wss://sbb.example/realtime');
    expect(sock.sent[0]).toEqual({ type: 'auth', apikey: fakeKey() }); // no token when signed out
    await eventually(() => sock.types().includes('subscribe'));
    expect(sock.sent[1]).toEqual({ type: 'subscribe', id: expect.stringMatching(/^sub\d+$/), table: 'scores', events: ['INSERT'], filter: 'mode=eq.rush' });

    sock.say({ type: 'subscribed', id: sock.sent[1].id });
    expect(statuses).toEqual(['SUBSCRIBED']);
  });

  it('uses http:// -> ws://', async () => {
    FakeSocket.instances = [];
    const c = createClient('http://localhost:8787/', fakeKey(), { realtime: { WebSocket: FakeSocket as never } });
    track.push(c);
    c.channel('x').on('postgres_changes', { event: '*', table: 't' }, () => {}).subscribe();
    await eventually(() => FakeSocket.instances.length > 0);
    expect(ws().url).toBe('ws://localhost:8787/realtime');
  });

  it('turns events into supabase-style payloads and routes them to the right listener', async () => {
    const c = fakeClient();
    track.push(c);
    const got: Record<string, ChangePayload[]> = { a: [], b: [] };
    c.channel('x')
      .on('postgres_changes', { event: 'INSERT', table: 't' }, (p) => got.a!.push(p))
      .on('postgres_changes', { event: 'DELETE', table: 't' }, (p) => got.b!.push(p))
      .subscribe();
    const sock = await connected(c);
    await eventually(() => sock.sent.filter((m) => m.type === 'subscribe').length === 2);
    const [subA, subB] = sock.sent.filter((m) => m.type === 'subscribe').map((m) => m.id);

    sock.say({ type: 'event', subscription: subA, event: 'INSERT', table: 't', new: { id: 1 }, commit_timestamp: '2026-01-01T00:00:00Z' });
    sock.say({ type: 'event', subscription: subB, event: 'DELETE', table: 't', old: { id: 1 }, commit_timestamp: '2026-01-01T00:00:01Z' });
    sock.say({ type: 'event', subscription: 'unknown', event: 'INSERT', table: 't', new: {}, commit_timestamp: 'x' });
    expect(got.a).toEqual([{ schema: 'public', table: 't', commit_timestamp: '2026-01-01T00:00:00Z', eventType: 'INSERT', new: { id: 1 }, old: {}, errors: null }]);
    expect(got.b).toEqual([{ schema: 'public', table: 't', commit_timestamp: '2026-01-01T00:00:01Z', eventType: 'DELETE', new: {}, old: { id: 1 }, errors: null }]);
  });

  it('reports a refused subscription as CHANNEL_ERROR with the server message, and keeps the connection', async () => {
    const c = fakeClient();
    track.push(c);
    const statuses: [RealtimeStatus, string | undefined][] = [];
    c.channel('x').on('postgres_changes', { event: '*', table: 'secret' }, () => {}).subscribe((s, e) => statuses.push([s, e?.message]));
    const sock = await connected(c);
    await eventually(() => sock.types().includes('subscribe'));
    sock.say({ type: 'error', id: sock.sent[1].id, code: 'forbidden', message: 'No access policy allows this request' });
    expect(statuses).toEqual([['CHANNEL_ERROR', 'No access policy allows this request']]);
    expect(sock.closed).toBeNull();
  });

  it('reports TIMED_OUT when the server never confirms', async () => {
    const c = fakeClient();
    track.push(c);
    const statuses: RealtimeStatus[] = [];
    c.channel('x').on('postgres_changes', { event: '*', table: 't' }, () => {}).subscribe((s) => statuses.push(s));
    await connected(c);
    await eventually(() => statuses.includes('TIMED_OUT'), 1000);
  });

  it('rejects listeners added after subscribe and unknown event types', () => {
    const c = fakeClient();
    track.push(c);
    const ch = c.channel('x').on('postgres_changes', { event: '*', table: 't' }, () => {}).subscribe();
    expect(() => ch.on('postgres_changes', { event: '*', table: 'u' }, () => {})).toThrow(/before calling .subscribe/);
    expect(() => c.channel('y').on('presence' as never, { event: '*', table: 't' }, () => {})).toThrow(/Unsupported/);
  });

  it('shares one socket between channels, and closes it when the last channel leaves', async () => {
    const c = fakeClient();
    track.push(c);
    const one = c.channel('one').on('postgres_changes', { event: '*', table: 'a' }, () => {}).subscribe();
    const two = c.channel('two').on('postgres_changes', { event: '*', table: 'b' }, () => {}).subscribe();
    const sock = await connected(c);
    await eventually(() => sock.sent.filter((m) => m.type === 'subscribe').length === 2);
    expect(FakeSocket.instances).toHaveLength(1);

    const subs = sock.sent.filter((m) => m.type === 'subscribe').map((m) => m.id);
    await one.unsubscribe();
    expect(sock.sent.filter((m) => m.type === 'unsubscribe')).toEqual([{ type: 'unsubscribe', id: subs[0] }]);
    expect(sock.closed).toBeNull();
    await c.removeChannel(two);
    expect(sock.closed).toEqual({ code: 1000, reason: 'no channels' });
  });

  it('reconnects with backoff and subscribes again, reporting CLOSED then SUBSCRIBED', async () => {
    const c = fakeClient();
    track.push(c);
    const statuses: RealtimeStatus[] = [];
    c.channel('x').on('postgres_changes', { event: '*', table: 't' }, () => {}).subscribe((s) => statuses.push(s));
    const first = await connected(c);
    await eventually(() => first.types().includes('subscribe'));
    first.say({ type: 'subscribed', id: first.sent[1].id });

    first.drop(1006);
    expect(statuses).toEqual(['SUBSCRIBED', 'CLOSED']);
    await eventually(() => FakeSocket.instances.length === 2);
    const second = await connected(c);
    await eventually(() => second.types().includes('subscribe'));
    second.say({ type: 'subscribed', id: second.sent[1].id });
    expect(statuses).toEqual(['SUBSCRIBED', 'CLOSED', 'SUBSCRIBED']);
  });

  it('backs off exponentially when connections keep failing', async () => {
    const c = fakeClient({ reconnectDelayMs: 40, maxReconnectDelayMs: 1000 });
    track.push(c);
    c.channel('x').on('postgres_changes', { event: '*', table: 't' }, () => {}).subscribe();
    const times: number[] = [];
    for (let i = 0; i < 4; i++) {
      await eventually(() => FakeSocket.instances.length === i + 1, 2000);
      times.push(Date.now());
      ws().drop(1006); // never even opens
    }
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    expect(gaps[1]!).toBeGreaterThan(gaps[0]! * 1.2); // 40 -> 80 -> 160, with jitter
    expect(gaps[2]!).toBeGreaterThan(gaps[1]! * 1.2);
  });

  it('gives up on a rejected API key instead of retrying forever, and tells the app', async () => {
    const c = fakeClient();
    track.push(c);
    const statuses: [RealtimeStatus, string | undefined][] = [];
    c.channel('x').on('postgres_changes', { event: '*', table: 't' }, () => {}).subscribe((s, e) => statuses.push([s, e?.message]));
    const sock = await connected(c);
    sock.drop(4401, 'invalid_apikey');
    await sleep(150);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(statuses.at(-1)![0]).toBe('CHANNEL_ERROR');
    expect(statuses.at(-1)![1]).toMatch(/invalid_apikey/);
  });

  it('pings to keep the connection alive, and drops one that has gone silent', async () => {
    const c = fakeClient({ heartbeatMs: 40 });
    track.push(c);
    c.channel('x').on('postgres_changes', { event: '*', table: 't' }, () => {}).subscribe();
    const sock = await connected(c);
    await eventually(() => sock.types().includes('ping'), 500);
    // nobody ever answers: after two silent intervals the client closes the socket itself
    await eventually(() => sock.closed !== null, 1000);
    expect(sock.closed!.code).toBe(4000);
  });

  it('explains when the runtime has no WebSocket', async () => {
    const g = globalThis as { WebSocket?: unknown };
    const saved = g.WebSocket;
    delete g.WebSocket;
    try {
      const c = createClient('http://localhost:8787', fakeKey());
      track.push(c);
      const statuses: [RealtimeStatus, string | undefined][] = [];
      c.channel('x').on('postgres_changes', { event: '*', table: 't' }, () => {}).subscribe((s, e) => statuses.push([s, e?.message]));
      expect(statuses[0]![0]).toBe('CHANNEL_ERROR');
      expect(statuses[0]![1]).toMatch(/No WebSocket available/);
    } finally {
      g.WebSocket = saved;
    }
  });

  it('a throwing listener does not break the connection', async () => {
    const c = fakeClient();
    track.push(c);
    const seen: number[] = [];
    c.channel('x').on('postgres_changes', { event: '*', table: 't' }, (p) => {
      seen.push((p.new as { id: number }).id);
      throw new Error('app bug');
    }).subscribe();
    const sock = await connected(c);
    await eventually(() => sock.types().includes('subscribe'));
    const id = sock.sent[1].id;
    sock.say({ type: 'event', subscription: id, event: 'INSERT', table: 't', new: { id: 1 }, commit_timestamp: 'x' });
    sock.say({ type: 'event', subscription: id, event: 'INSERT', table: 't', new: { id: 2 }, commit_timestamp: 'x' });
    expect(seen).toEqual([1, 2]);
  });
});

// ---- against a real server -----------------------------------------------------------------------------

let h: Harness;
const clients: { dispose(): void }[] = [];
const keep = <T extends { dispose(): void }>(c: T) => (clients.push(c), c);
afterEach(async () => {
  clients.splice(0).forEach((c) => c.dispose());
  await h?.t.close();
});

const NOTES = [
  { name: 'id', type: 'integer', primary_key: true },
  { name: 'owner', type: 'text' },
  { name: 'body', type: 'text', not_null: true },
  { name: 'shared', type: 'boolean', not_null: true, default: false },
  { name: 'level', type: 'integer', not_null: true, default: 1 },
];
const OWNER_POLICY = {
  select: { roles: ['anon', 'authenticated'], where: { or: [{ shared: true }, { owner: '$uid' }] } },
  insert: { roles: ['authenticated'], set: { owner: '$uid' } },
  update: { roles: ['authenticated'], where: { owner: '$uid' } },
  delete: { roles: ['authenticated'], where: { owner: '$uid' } },
};
const RT = { reconnectDelayMs: 30, maxReconnectDelayMs: 100, subscribeTimeoutMs: 3000 };

/** Subscribes and resolves once the server confirmed. */
async function listen(client: ReturnType<Harness['client']>, filter: Partial<{ event: any; filter: string; table: string }> = {}) {
  const events: ChangePayload[] = [];
  const statuses: RealtimeStatus[] = [];
  const channel = client.channel(`ch-${Math.random()}`).on('postgres_changes', { event: '*', table: 'notes', ...filter }, (p) => events.push(p)).subscribe((s) => statuses.push(s));
  await eventually(() => statuses.includes('SUBSCRIBED'));
  return { channel, events, statuses };
}

describe('realtime with a real server', () => {
  async function setup(config: Parameters<typeof startServer>[0] = {}) {
    h = await startServer(config);
    await h.table('notes', NOTES);
    await h.policy('notes', OWNER_POLICY);
  }

  it('delivers INSERT, UPDATE and DELETE as typed payloads', async () => {
    await setup();
    const svc = keep(h.client('service', { realtime: RT }));
    const { events } = await listen(svc);

    await svc.from('notes').insert({ body: 'first', shared: true });
    await svc.from('notes').update({ body: 'second', level: 4 }).eq('id', 1);
    await svc.from('notes').delete().eq('id', 1);
    await eventually(() => events.length === 3);

    expect(events.map((e) => e.eventType)).toEqual(['INSERT', 'UPDATE', 'DELETE']);
    expect(events[0]).toMatchObject({ schema: 'public', table: 'notes', new: { id: 1, body: 'first', shared: true }, old: {}, errors: null });
    expect(events[1]).toMatchObject({ new: { body: 'second', level: 4 }, old: { body: 'first', level: 1 } });
    expect(events[2]).toMatchObject({ new: {}, old: { id: 1, body: 'second' } });
    expect(events[0]!.commit_timestamp).toMatch(/^\d{4}-/);
  });

  it('filters by event type and by row', async () => {
    await setup();
    const svc = keep(h.client('service', { realtime: RT }));
    const inserts = await listen(svc, { event: 'INSERT', filter: 'level=gte.5' });
    await svc.from('notes').insert([{ body: 'low', level: 1 }, { body: 'high', level: 9 }]);
    await svc.from('notes').update({ level: 7 }).eq('body', 'low');
    await eventually(() => inserts.events.length === 1);
    await sleep(100);
    expect(inserts.events.map((e) => (e.new as { body: string }).body)).toEqual(['high']);
  });

  it('shows each subscriber only what the policy allows, across sign-in and sign-out', async () => {
    await setup();
    const writer = keep(h.client('anon'));
    await writer.auth.signUp({ email: 'writer@example.com', password: PASSWORD });

    const watcher = keep(h.client('anon', { realtime: RT }));
    const { events } = await listen(watcher);
    await writer.from('notes').insert({ body: 'private one' });
    await writer.from('notes').insert({ body: 'shared one', shared: true });
    await eventually(() => events.length === 1);
    expect((events[0]!.new as { body: string }).body).toBe('shared one'); // anon cannot see the private note

    // the watcher signs in as the writer: the same open subscription now also sees private notes
    await watcher.auth.signInWithPassword({ email: 'writer@example.com', password: PASSWORD });
    await sleep(150); // let the new credentials reach the server
    await writer.from('notes').insert({ body: 'private two' });
    await eventually(() => events.length === 2);
    expect((events[1]!.new as { body: string }).body).toBe('private two');

    // and after signing out it is back to anon
    await watcher.auth.signOut();
    await sleep(150);
    await writer.from('notes').insert({ body: 'private three' });
    await sleep(200);
    expect(events).toHaveLength(2);
  });

  it('retries a refused subscription once the user signs in', async () => {
    await setup();
    await h.policy('notes', { select: { roles: ['authenticated'], where: true }, insert: { roles: ['authenticated'] } });
    const c = keep(h.client('anon', { realtime: RT }));
    const events: ChangePayload[] = [];
    const statuses: [RealtimeStatus, string | undefined][] = [];
    c.channel('x').on('postgres_changes', { event: '*', table: 'notes' }, (p) => events.push(p)).subscribe((s, e) => statuses.push([s, e?.message]));
    await eventually(() => statuses.some(([s]) => s === 'CHANNEL_ERROR'));
    expect(statuses[0]![1]).toMatch(/No access policy/);

    await c.auth.signUp({ email: 'late@example.com', password: PASSWORD });
    await eventually(() => statuses.some(([s]) => s === 'SUBSCRIBED'));
    await c.from('notes').insert({ body: 'now visible' });
    await eventually(() => events.length === 1);
  });

  it('reconnects after the network drops and keeps delivering', async () => {
    await setup();
    const svc = keep(h.client('service', { realtime: RT }));
    const { events, statuses } = await listen(svc);
    await svc.from('notes').insert({ body: 'before' });
    await eventually(() => events.length === 1);

    h.t.dropConnections();
    await eventually(() => statuses.filter((s) => s === 'SUBSCRIBED').length === 2, 5000); // CLOSED, then SUBSCRIBED again
    expect(statuses).toEqual(['SUBSCRIBED', 'CLOSED', 'SUBSCRIBED']);

    await svc.from('notes').insert({ body: 'after' });
    await eventually(() => events.length === 2);
    expect((events[1]!.new as { body: string }).body).toBe('after');
  });

  it('renews an expired token and reconnects when the server closes the connection', async () => {
    await setup({ accessTokenTtlSeconds: 60 });
    const user = keep(h.client('anon', { realtime: RT, auth: { refreshMarginSeconds: 10 } }));
    await user.auth.signUp({ email: 'ada@example.com', password: PASSWORD });
    const { events, statuses } = await listen(user);

    h.t.clock.advanceSeconds(120); // the server now treats the access token as expired
    await h.t.realtime.sweep(); // closes the connection with 4401 token_expired
    await eventually(() => statuses.filter((s) => s === 'SUBSCRIBED').length === 2, 5000);

    await user.from('notes').insert({ body: 'still connected', shared: true });
    await eventually(() => events.length === 1);
  });

  it('falls back to anon (CHANNEL_ERROR here) when the session was ended elsewhere', async () => {
    await setup({ accessTokenTtlSeconds: 60 });
    await h.policy('notes', { select: { roles: ['authenticated'], where: true } });
    const phone = keep(h.client('anon', { realtime: RT, auth: { refreshMarginSeconds: 10 } }));
    await phone.auth.signUp({ email: 'ada@example.com', password: PASSWORD });
    const { statuses } = await listen(phone);

    const laptop = keep(h.client('anon'));
    await laptop.auth.signInWithPassword({ email: 'ada@example.com', password: PASSWORD });
    await laptop.auth.signOut({ scope: 'global' });
    h.t.clock.advanceSeconds(61);
    await h.t.realtime.sweep(); // notices the revoked session and closes with 4401

    await eventually(() => statuses.includes('CHANNEL_ERROR'), 5000); // reconnected as anon, which the policy refuses
    expect((await phone.auth.getSession()).data!.session).toBeNull();
  });

  it('unsubscribing stops events and closes the connection when nothing is left', async () => {
    await setup();
    const svc = keep(h.client('service', { realtime: RT }));
    const { channel, events, statuses } = await listen(svc);
    expect(h.t.realtime.stats().connections).toBe(1);
    await channel.unsubscribe();
    expect(statuses.at(-1)).toBe('CLOSED');
    await eventually(() => h.t.realtime.stats().connections === 0);
    await svc.from('notes').insert({ body: 'unheard' });
    await sleep(100);
    expect(events).toHaveLength(0);
  });

  it('dispose() closes everything', async () => {
    await setup();
    const svc = h.client('service', { realtime: RT });
    await listen(svc);
    svc.dispose();
    await eventually(() => h.t.realtime.stats().connections === 0);
  });

  it('does not reconnect forever with a key the server rejects', async () => {
    await setup();
    const forged = h.project.keys.anon.slice(0, -4) + 'AAAA';
    const bad = keep(createClient(h.url, forged, { realtime: RT }));
    const statuses: RealtimeStatus[] = [];
    bad.channel('x').on('postgres_changes', { event: '*', table: 'notes' }, () => {}).subscribe((s) => statuses.push(s));
    await eventually(() => statuses.includes('CHANNEL_ERROR'), 3000);
    const seen = h.t.realtime.stats();
    await sleep(300);
    expect(statuses.filter((s) => s === 'CHANNEL_ERROR')).toHaveLength(1);
    expect(h.t.realtime.stats().connections).toBe(seen.connections);
  });
});
