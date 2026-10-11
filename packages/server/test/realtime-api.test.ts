import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers.js';
import { TestSocket } from './ws-client.js';

type TestApp = Awaited<ReturnType<typeof makeTestApp>>;
type Listening = Awaited<ReturnType<TestApp['listen']>>;
type User = { id: string; token: string; refresh: string; email: string };

let t: TestApp;
let net: Listening;
let project: Awaited<ReturnType<TestApp['createProject']>>;
let alice: User;
let bob: User;
let sockets: TestSocket[];

const PASSWORD = 'correct horse battery';

async function setup(config: Parameters<typeof makeTestApp>[0] = {}, hub: NonNullable<Parameters<typeof makeTestApp>[1]>['realtime'] = {}) {
  t = await makeTestApp(config, { realtime: { authTimeoutMs: 400, ...hub } });
  net = await t.listen();
  project = await t.createProject('live');
  const make = async (email: string): Promise<User> => {
    const res = await t.call('POST', '/auth/signup', { body: { email, password: PASSWORD }, headers: { apikey: project.keys.anon } });
    return { id: res.json.user.id, token: res.json.access_token, refresh: res.json.refresh_token, email };
  };
  alice = await make('alice@example.com');
  bob = await make('bob@example.com');
  const created = await t.admin('POST', `/projects/${project.id}/tables`, {
    name: 'notes',
    columns: [
      { name: 'id', type: 'integer', primary_key: true },
      { name: 'owner', type: 'text' },
      { name: 'body', type: 'text', not_null: true },
      { name: 'shared', type: 'boolean', not_null: true, default: false },
      { name: 'level', type: 'integer', not_null: true, default: 1 },
      { name: 'meta', type: 'json' },
      { name: 'email', type: 'text', unique: true },
    ],
  });
  expect(created.status).toBe(201);
  sockets = [];
}
beforeEach(() => setup());
afterEach(async () => {
  for (const s of sockets) s.close();
  await t.close();
});

type Who = 'anon' | 'service' | User;
const credentials = (who: Who) =>
  who === 'service' ? { apikey: project.keys.service_role } : who === 'anon' ? { apikey: project.keys.anon } : { apikey: project.keys.anon, access_token: who.token };

/** Opens a socket and completes the auth handshake. */
async function connect(who: Who): Promise<TestSocket> {
  const s = await TestSocket.connect(net.wsUrl);
  sockets.push(s);
  s.send({ type: 'auth', ...credentials(who) });
  await s.next((m) => m.type === 'auth_ok');
  return s;
}
async function subscribe(s: TestSocket, table = 'notes', extra: Record<string, unknown> = {}, id = 'sub1') {
  s.send({ type: 'subscribe', id, table, ...extra });
  return s.next((m) => (m.type === 'subscribed' || m.type === 'error') && (m.id === id || m.type === 'subscribed'));
}
const subscribed = async (s: TestSocket, table?: string, extra?: Record<string, unknown>, id?: string) => {
  const reply = await subscribe(s, table, extra, id);
  expect(reply.type, JSON.stringify(reply)).toBe('subscribed');
};

const rest = (method: string, path: string, who: Who, body?: unknown, prefer?: string) => {
  const headers: Record<string, string> = who === 'service' ? { apikey: project.keys.service_role } : { apikey: project.keys.anon };
  if (who !== 'service' && who !== 'anon') headers.authorization = `Bearer ${who.token}`;
  if (prefer) headers.prefer = prefer;
  return t.call(method, `/rest${path}`, { body, headers });
};
const setPolicy = async (policy: unknown) => {
  const res = await t.admin('PUT', `/projects/${project.id}/policies/notes`, policy);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
};
/** Waits until every change published so far has been delivered. */
const flush = () => t.realtime.idle();

const OWNER_POLICY = {
  select: { roles: ['anon', 'authenticated'], where: { or: [{ shared: true }, { owner: '$uid' }] } },
  insert: { roles: ['authenticated'], set: { owner: '$uid' } },
  update: { roles: ['authenticated'], where: { owner: '$uid' } },
  delete: { roles: ['authenticated'], where: { owner: '$uid' } },
};

describe('connecting and authenticating', () => {
  it('accepts anon, service and signed-in credentials and reports who you are', async () => {
    const anon = await TestSocket.connect(net.wsUrl);
    sockets.push(anon);
    anon.send({ type: 'auth', ...credentials('anon') });
    expect(await anon.next()).toMatchObject({ type: 'auth_ok', role: 'anon', user_id: null, expires_at: null });

    const svc = await TestSocket.connect(net.wsUrl);
    sockets.push(svc);
    svc.send({ type: 'auth', ...credentials('service') });
    expect(await svc.next()).toMatchObject({ type: 'auth_ok', role: 'service_role' });

    const user = await TestSocket.connect(net.wsUrl);
    sockets.push(user);
    user.send({ type: 'auth', ...credentials(alice) });
    expect(await user.next()).toMatchObject({ type: 'auth_ok', role: 'authenticated', user_id: alice.id, expires_at: expect.any(Number) });
  });

  it('closes on a bad API key, a bad token, or an expired token', async () => {
    for (const [creds, code] of [
      [{ apikey: 'nope' }, 'invalid_apikey'],
      [{ apikey: project.keys.anon, access_token: 'garbage' }, 'invalid_token'],
    ] as const) {
      const s = await TestSocket.connect(net.wsUrl);
      s.send({ type: 'auth', ...creds });
      expect(await s.next((m) => m.type === 'error')).toMatchObject({ code });
      expect((await s.waitClose()).code).toBe(4401);
    }
    t.clock.advanceSeconds(1000);
    const s = await TestSocket.connect(net.wsUrl);
    s.send({ type: 'auth', ...credentials(alice) });
    expect(await s.next((m) => m.type === 'error')).toMatchObject({ code: 'token_expired' });
    expect((await s.waitClose()).code).toBe(4401);
  });

  it('requires auth first, and does not wait forever for it', async () => {
    const early = await TestSocket.connect(net.wsUrl);
    early.send({ type: 'subscribe', id: 'x', table: 'notes' });
    expect(await early.next((m) => m.type === 'error')).toMatchObject({ code: 'unauthenticated' });
    expect((await early.waitClose()).code).toBe(4401);

    const silent = await TestSocket.connect(net.wsUrl);
    expect(await silent.next((m) => m.type === 'error', 3000)).toMatchObject({ code: 'auth_timeout' });
    expect((await silent.waitClose()).code).toBe(4401);
  });

  it('rejects malformed traffic: bad JSON, binary frames, oversized messages', async () => {
    const bad = await TestSocket.connect(net.wsUrl);
    bad.send('{not json');
    expect((await bad.waitClose()).code).toBe(4400);

    const binary = await TestSocket.connect(net.wsUrl);
    binary.sendBinary(Buffer.from([1, 2, 3]));
    expect((await binary.waitClose()).code).toBe(4400);

    const big = await TestSocket.connect(net.wsUrl);
    big.send(JSON.stringify({ type: 'auth', apikey: 'x'.repeat(40_000) }));
    expect((await big.waitClose()).code).toBe(1009);
  });

  it('answers unknown messages with an error and stays open; supports ping', async () => {
    const s = await connect('anon');
    s.send({ type: 'dance' });
    expect(await s.next((m) => m.type === 'error')).toMatchObject({ code: 'unknown_type' });
    s.send({ type: 'subscribe', id: 'a', table: 'notes', surprise: true });
    expect(await s.next((m) => m.type === 'error')).toMatchObject({ code: 'invalid_message', id: 'a' });
    s.send({ type: 'ping' });
    expect(await s.next()).toEqual({ type: 'pong' });
  });

  it('throttles message floods', async () => {
    const s = await connect('anon');
    for (let i = 0; i < 120; i++) s.send({ type: 'ping' });
    expect((await s.waitClose()).code).toBe(1008);
  });

  it('only serves /realtime and turns away other paths', async () => {
    await expect(TestSocket.connect(`ws://127.0.0.1:${net.port}/elsewhere`)).rejects.toThrow('HTTP 404');
  });

  it('keeps unknown browser origins out when specific origins are configured', async () => {
    await t.close();
    await setup({ corsOrigins: ['https://app.example'] });
    await expect(TestSocket.connect(net.wsUrl, { origin: 'https://evil.example' })).rejects.toThrow('HTTP 403');
    sockets.push(await TestSocket.connect(net.wsUrl, { origin: 'https://app.example' }));
    sockets.push(await TestSocket.connect(net.wsUrl)); // non-browser clients send no Origin
  });

  it('enforces the connection cap', async () => {
    await t.close();
    await setup({ realtimeMaxConnections: 2 });
    sockets.push(await TestSocket.connect(net.wsUrl), await TestSocket.connect(net.wsUrl));
    await expect(TestSocket.connect(net.wsUrl)).rejects.toThrow('HTTP 503');
  });

  it('tells clients when the server shuts down (close code 1001)', async () => {
    const s = await connect('service');
    await subscribed(s);
    await t.realtime.close();
    expect((await s.waitClose()).code).toBe(1001);
  });

  it('cleans up after a disconnect', async () => {
    const s = await connect('service');
    await subscribed(s);
    expect(t.realtime.stats()).toEqual({ connections: 1, subscriptions: 1 });
    expect(t.realtime.hasSubscribers(project.id, 'notes')).toBe(true);
    s.close();
    await s.closed;
    await new Promise((r) => setTimeout(r, 50));
    expect(t.realtime.stats()).toEqual({ connections: 0, subscriptions: 0 });
    expect(t.realtime.hasSubscribers(project.id, 'notes')).toBe(false);
  });
});

describe('subscribing', () => {
  it('is refused without a SELECT policy for your role (same answer for missing tables)', async () => {
    for (const who of ['anon', alice] as const) {
      const s = await connect(who);
      for (const table of ['notes', 'ghost']) {
        s.send({ type: 'subscribe', id: 'q', table });
        const err = await s.next((m) => m.type === 'error');
        expect(err, table).toMatchObject({ code: 'forbidden', id: 'q' });
      }
      expect(s.isClosed).toBe(false); // a refused subscription does not drop the connection
    }
    const svc = await connect('service');
    svc.send({ type: 'subscribe', id: 'q', table: 'ghost' });
    expect(await svc.next((m) => m.type === 'error')).toMatchObject({ code: 'not_found' });
  });

  it('follows the policy roles', async () => {
    await setPolicy({ select: { roles: ['authenticated'], where: true } });
    const anon = await connect('anon');
    anon.send({ type: 'subscribe', id: 'a', table: 'notes' });
    expect(await anon.next((m) => m.type === 'error')).toMatchObject({ code: 'forbidden' });
    await subscribed(await connect(alice));
  });

  it('validates filters, events and limits', async () => {
    const s = await connect('service');
    const err = async (extra: Record<string, unknown>, id = 'v') => {
      s.send({ type: 'subscribe', id, table: 'notes', ...extra });
      return s.next((m) => m.type === 'error');
    };
    expect(await err({ filter: 'ghost=eq.1' })).toMatchObject({ code: 'unknown_column' });
    expect(await err({ filter: 'level=eq.abc' })).toMatchObject({ code: 'invalid_filter_value' });
    expect(await err({ filter: 'select=body' })).toMatchObject({ code: 'invalid_filter' });
    expect(await err({ events: ['TRUNCATE'] })).toMatchObject({ code: 'invalid_message' });
    expect(await err({ events: [] })).toMatchObject({ code: 'invalid_message' });

    await subscribed(s, 'notes', {}, 'dup');
    s.send({ type: 'subscribe', id: 'dup', table: 'notes' });
    expect(await s.next((m) => m.type === 'error')).toMatchObject({ code: 'duplicate_subscription' });
  });

  it('caps subscriptions per connection and supports unsubscribe', async () => {
    const s = await connect('service');
    for (let i = 0; i < 20; i++) await subscribed(s, 'notes', {}, `s${i}`);
    s.send({ type: 'subscribe', id: 'one-too-many', table: 'notes' });
    expect(await s.next((m) => m.type === 'error')).toMatchObject({ code: 'too_many_subscriptions' });

    s.send({ type: 'unsubscribe', id: 's0' });
    expect(await s.next((m) => m.type === 'unsubscribed')).toMatchObject({ id: 's0' });
    s.send({ type: 'unsubscribe', id: 's0' });
    expect(await s.next((m) => m.type === 'error')).toMatchObject({ code: 'not_found' });
    expect(t.realtime.stats().subscriptions).toBe(19);
  });
});

describe('events', () => {
  it('delivers INSERT, UPDATE and DELETE with decoded rows and the previous row', async () => {
    const s = await connect('service');
    await subscribed(s);

    await rest('POST', '/notes', 'service', { body: 'first', shared: true, meta: { tags: ['a'] } });
    const insert = await s.event('sub1');
    expect(insert).toMatchObject({ event: 'INSERT', table: 'notes', new: { id: 1, body: 'first', shared: true, level: 1, meta: { tags: ['a'] } } });
    expect(insert.old).toBeUndefined();
    expect(insert.commit_timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await rest('PATCH', '/notes?id=eq.1', 'service', { body: 'second', level: 5 });
    const update = await s.event('sub1');
    expect(update).toMatchObject({ event: 'UPDATE', new: { id: 1, body: 'second', level: 5 }, old: { id: 1, body: 'first', level: 1 } });

    await rest('DELETE', '/notes?id=eq.1', 'service');
    const del = await s.event('sub1');
    expect(del).toMatchObject({ event: 'DELETE', old: { id: 1, body: 'second' } });
    expect(del.new).toBeUndefined();
  });

  it('delivers one event per row for bulk writes, in order', async () => {
    const s = await connect('service');
    await subscribed(s);
    await rest('POST', '/notes', 'service', [{ body: 'a' }, { body: 'b' }, { body: 'c' }]);
    expect([await s.event(), await s.event(), await s.event()].map((e) => e.new.body)).toEqual(['a', 'b', 'c']);

    await rest('PATCH', '/notes?level=eq.1', 'service', { level: 9 });
    const updates = [await s.event(), await s.event(), await s.event()];
    expect(updates.map((e) => [e.new.body, e.old.level, e.new.level])).toEqual([['a', 1, 9], ['b', 1, 9], ['c', 1, 9]]);

    await rest('DELETE', '/notes?id=not.is.null', 'service');
    expect((await Promise.all([s.event(), s.event(), s.event()])).map((e) => e.event)).toEqual(['DELETE', 'DELETE', 'DELETE']);
  });

  it('reports an upsert as INSERT the first time and UPDATE (with the old row) afterwards', async () => {
    const s = await connect('service');
    await subscribed(s);
    const merge = 'resolution=merge-duplicates';
    await rest('POST', '/notes', 'service', { id: 7, body: 'v1' }, merge);
    expect(await s.event()).toMatchObject({ event: 'INSERT', new: { id: 7, body: 'v1' } });
    await rest('POST', '/notes', 'service', { id: 7, body: 'v2' }, merge);
    expect(await s.event()).toMatchObject({ event: 'UPDATE', new: { body: 'v2' }, old: { body: 'v1' } });
    await rest('POST', '/notes', 'service', [{ id: 7, body: 'v3' }, { id: 8, body: 'new' }], merge);
    expect([(await s.event()).event, (await s.event()).event]).toEqual(['UPDATE', 'INSERT']);
  });

  it('only sends the event types that were asked for', async () => {
    const s = await connect('service');
    await subscribed(s, 'notes', { events: ['DELETE'] });
    await rest('POST', '/notes', 'service', { body: 'x' });
    await rest('PATCH', '/notes?id=eq.1', 'service', { body: 'y' });
    await flush();
    await s.expectNoEvent();
    await rest('DELETE', '/notes?id=eq.1', 'service');
    expect(await s.event()).toMatchObject({ event: 'DELETE' });
  });

  it('applies the subscription filter to the new row (or the old row for deletes)', async () => {
    const s = await connect('service');
    await subscribed(s, 'notes', { filter: 'level=gte.5&body=like.hot*' });
    await rest('POST', '/notes', 'service', [{ body: 'hot', level: 9 }, { body: 'hot', level: 1 }, { body: 'cold', level: 9 }]);
    expect((await s.event()).new).toMatchObject({ body: 'hot', level: 9 });
    await flush();
    await s.expectNoEvent();

    await rest('PATCH', '/notes?id=eq.2', 'service', { level: 7 }); // enters the filter
    expect(await s.event()).toMatchObject({ event: 'UPDATE', new: { id: 2, level: 7 } });
    await rest('DELETE', '/notes?id=eq.3', 'service'); // never matched
    await flush();
    await s.expectNoEvent();
    await rest('DELETE', '/notes?id=eq.1', 'service');
    expect(await s.event()).toMatchObject({ event: 'DELETE', old: { id: 1 } });
  });

  it('supports several subscriptions on one connection, each with its own id', async () => {
    const s = await connect('service');
    await subscribed(s, 'notes', { filter: 'level=eq.1' }, 'low');
    await subscribed(s, 'notes', { filter: 'level=eq.2' }, 'mid');
    await subscribed(s, 'notes', {}, 'all');
    await rest('POST', '/notes', 'service', { body: 'x', level: 2 });
    const ids = [(await s.event()).subscription, (await s.event()).subscription].sort();
    expect(ids).toEqual(['all', 'mid']);
    await flush();
    await s.expectNoEvent();
  });

  it('stops after unsubscribe', async () => {
    const s = await connect('service');
    await subscribed(s);
    s.send({ type: 'unsubscribe', id: 'sub1' });
    await s.next((m) => m.type === 'unsubscribed');
    await rest('POST', '/notes', 'service', { body: 'x' });
    await flush();
    await s.expectNoEvent();
  });

  it('never announces writes that were rejected or rolled back', async () => {
    await setPolicy({
      select: { roles: ['authenticated'], where: true },
      insert: { roles: ['authenticated'], check: { column: 'level', op: 'lte', value: 5 } },
    });
    const s = await connect(alice);
    await subscribed(s);
    const batch = await rest('POST', '/notes', alice, [{ body: 'fine', level: 1 }, { body: 'too much', level: 9 }]);
    expect(batch.status).toBe(403);
    await rest('POST', '/notes', 'service', { body: 'dup', email: 'x@y.zz' });
    expect((await rest('POST', '/notes', 'service', { body: 'dup2', email: 'x@y.zz' })).status).toBe(409);
    await flush();
    const events = [];
    for (;;) {
      try {
        events.push(await s.event(undefined, 200));
      } catch {
        break;
      }
    }
    expect(events.map((e) => e.new.body)).toEqual(['dup']); // the rolled-back batch and the failed insert never reached anyone
  });

  it('keeps projects apart', async () => {
    const other = await t.createProject('other');
    await t.admin('POST', `/projects/${other.id}/tables`, { name: 'notes', columns: [{ name: 'id', type: 'integer', primary_key: true }, { name: 'body', type: 'text' }] });
    const mine = await connect('service');
    await subscribed(mine);
    // Somebody listens in the other project too, so its writes ARE captured and dispatched; they must reach only that listener.
    const theirs = await TestSocket.connect(net.wsUrl);
    sockets.push(theirs);
    theirs.send({ type: 'auth', apikey: other.keys.service_role });
    await theirs.next((m) => m.type === 'auth_ok');
    await subscribed(theirs);

    await t.call('POST', '/rest/notes', { body: { body: 'in the other project' }, headers: { apikey: other.keys.service_role } });
    expect((await theirs.event()).new.body).toBe('in the other project');
    await flush();
    await mine.expectNoEvent();

    await rest('POST', '/notes', 'service', { body: 'in my project' });
    expect((await mine.event()).new.body).toBe('in my project');
    await theirs.expectNoEvent();
  });
});

describe('access control on events', () => {
  beforeEach(() => setPolicy(OWNER_POLICY));

  it('only delivers rows the subscriber may SELECT', async () => {
    const [anon, a, b] = [await connect('anon'), await connect(alice), await connect(bob)];
    for (const s of [anon, a, b]) await subscribed(s);

    await rest('POST', '/notes', alice, [{ body: 'alice private' }, { body: 'alice shared', shared: true }]);
    await rest('POST', '/notes', bob, { body: 'bob private' });

    const bodies = async (s: TestSocket, n: number) => (await Promise.all(Array.from({ length: n }, () => s.event()))).map((e) => e.new.body).sort();
    expect(await bodies(a, 2)).toEqual(['alice private', 'alice shared']);
    expect(await bodies(b, 2)).toEqual(['alice shared', 'bob private']);
    expect(await bodies(anon, 1)).toEqual(['alice shared']);
    await flush();
    for (const s of [anon, a, b]) await s.expectNoEvent();
  });

  it('shows the previous row only to someone who could see it', async () => {
    const [anon, a] = [await connect('anon'), await connect(alice)];
    await subscribed(anon);
    await subscribed(a);
    await rest('POST', '/notes', alice, { body: 'draft' });
    await a.event();

    await rest('PATCH', '/notes?id=eq.1', alice, { shared: true }); // private -> shared
    const forAlice = await a.event();
    expect(forAlice).toMatchObject({ event: 'UPDATE', new: { shared: true }, old: { shared: false } });
    const forAnon = await anon.event();
    expect(forAnon.new).toMatchObject({ body: 'draft', shared: true });
    expect(forAnon.old).toBeUndefined(); // anon could not see the private version
  });

  it('does not announce rows that became invisible, nor deletions of rows the subscriber never saw', async () => {
    await rest('POST', '/notes', alice, { body: 'public', shared: true });
    await rest('POST', '/notes', alice, { body: 'secret' });
    const anon = await connect('anon');
    await subscribed(anon);

    await rest('PATCH', '/notes?id=eq.1', alice, { shared: false }); // shared -> private: documented limitation, no event
    await rest('DELETE', '/notes?id=eq.2', alice); // anon never saw it
    await flush();
    await anon.expectNoEvent();

    await rest('PATCH', '/notes?id=eq.1', alice, { shared: true });
    await anon.event();
    await rest('DELETE', '/notes?id=eq.1', alice);
    expect(await anon.event()).toMatchObject({ event: 'DELETE', old: { body: 'public' } });
  });

  it('re-checks the policy for every event, so policy changes apply to live subscriptions', async () => {
    const anon = await connect('anon');
    await subscribed(anon);
    await rest('POST', '/notes', 'service', { body: 'one', shared: true });
    await anon.event();

    await setPolicy({ select: { roles: ['authenticated'], where: true } }); // anon no longer allowed
    await rest('POST', '/notes', 'service', { body: 'two', shared: true });
    await flush();
    await anon.expectNoEvent();

    await t.admin('DELETE', `/projects/${project.id}/policies/notes`); // no policy at all
    const a = await connect(alice);
    a.send({ type: 'subscribe', id: 'z', table: 'notes' });
    expect(await a.next((m) => m.type === 'error')).toMatchObject({ code: 'forbidden' });
  });

  it('treats the anon user id as NULL, which matches nothing', async () => {
    await setPolicy({ select: { roles: ['anon', 'authenticated'], where: { owner: '$uid' } } });
    await rest('POST', '/notes', 'service', { body: 'ownerless' });
    const anon = await connect('anon');
    await subscribed(anon);
    await rest('POST', '/notes', 'service', { body: 'ownerless 2' });
    await flush();
    await anon.expectNoEvent();
  });

  it('upgrades a connection that re-authenticates with a user token', async () => {
    const s = await connect('anon');
    await subscribed(s);
    await rest('POST', '/notes', alice, { body: 'private' });
    await flush();
    await s.expectNoEvent(); // anon cannot see it

    s.send({ type: 'auth', ...credentials(alice) });
    expect(await s.next((m) => m.type === 'auth_ok')).toMatchObject({ role: 'authenticated', user_id: alice.id });
    await rest('POST', '/notes', alice, { body: 'private again' });
    expect((await s.event()).new.body).toBe('private again');
  });

  it('cannot switch to another project', async () => {
    const other = await t.createProject('other');
    const s = await connect('anon');
    s.send({ type: 'auth', apikey: other.keys.anon });
    expect(await s.next((m) => m.type === 'error')).toMatchObject({ code: 'project_mismatch' });
    expect((await s.waitClose()).code).toBe(4401);
  });
});

describe('connection lifetime', () => {
  it('drops a signed-in connection when its access token expires, but not anon ones', async () => {
    const user = await connect(alice);
    const anon = await connect('anon');
    t.clock.advanceSeconds(901);
    await t.realtime.sweep();
    expect(await user.next((m) => m.type === 'error')).toMatchObject({ code: 'token_expired' });
    expect((await user.waitClose()).code).toBe(4401);
    expect(anon.isClosed).toBe(false);
  });

  it('keeps a connection alive when the client sends a fresh token in time', async () => {
    await setPolicy({ select: { roles: ['authenticated'], where: true } });
    const s = await connect(alice);
    await subscribed(s);
    t.clock.advanceSeconds(600);
    const fresh = await t.call('POST', '/auth/refresh', { body: { refresh_token: alice.refresh }, headers: { apikey: project.keys.anon } });
    s.send({ type: 'auth', apikey: project.keys.anon, access_token: fresh.json.access_token });
    await s.next((m) => m.type === 'auth_ok');

    t.clock.advanceSeconds(600); // the old token would be long expired now
    await t.realtime.sweep();
    expect(s.isClosed).toBe(false);
    await rest('POST', '/notes', 'service', { body: 'still here' });
    expect((await s.event()).new.body).toBe('still here');
  });

  it('drops the connection once the session is revoked (logout)', async () => {
    const s = await connect(alice);
    await t.call('POST', '/auth/logout', { headers: { apikey: project.keys.anon, authorization: `Bearer ${alice.token}` } });
    t.clock.advanceSeconds(61); // the session is re-checked about once a minute
    await t.realtime.sweep();
    expect(await s.next((m) => m.type === 'error')).toMatchObject({ code: 'session_revoked' });
    expect((await s.waitClose()).code).toBe(4401);
  });

  it('rejects a revoked session at connect time', async () => {
    await t.call('POST', '/auth/logout', { headers: { apikey: project.keys.anon, authorization: `Bearer ${alice.token}` } });
    const s = await TestSocket.connect(net.wsUrl);
    s.send({ type: 'auth', ...credentials(alice) });
    expect(await s.next((m) => m.type === 'error')).toMatchObject({ code: 'invalid_token' });
  });
});
