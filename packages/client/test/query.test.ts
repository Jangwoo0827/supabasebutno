import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SbbError, createClient } from '../src/index.js';
import { PASSWORD, fakeKey, json, mockFetch, startServer, type Harness } from './support.js';

const offline = (respond?: Parameters<typeof mockFetch>[0]) => {
  const m = mockFetch(respond);
  const client = createClient('http://sbb.test', fakeKey(), { fetch: m.fn });
  return { client, ...m };
};
const params = (m: ReturnType<typeof offline>) => [...m.last().url.searchParams.entries()];

describe('building requests', () => {
  it('sends the API key and client info, and no token when signed out', async () => {
    const m = offline();
    await m.client.from('todos').select();
    expect(m.last().method).toBe('GET');
    expect(m.last().url.pathname).toBe('/rest/todos');
    expect(m.last().url.search).toBe('');
    expect(m.last().headers.apikey).toBe(fakeKey());
    expect(m.last().headers['X-Client-Info']).toMatch(/^supabasebutno-js\//);
    expect(m.last().headers.Authorization).toBeUndefined();
  });

  it('encodes table names and projects columns', async () => {
    const m = offline();
    await m.client.from('my table').select('id, title ,done');
    expect(m.last().url.pathname).toBe('/rest/my%20table');
    expect(params(m)).toEqual([['select', 'id,title,done']]);
  });

  it('serialises every filter operator', async () => {
    const m = offline();
    await m.client
      .from('t')
      .select()
      .eq('a', 1)
      .neq('b', 'x')
      .gt('c', 2.5)
      .gte('d', 3)
      .lt('e', 4)
      .lte('f', 5)
      .like('g', '%milk%')
      .ilike('h', 'Ab%')
      .is('i', null)
      .is('j', true)
      .in('k', [1, 2, 3])
      .not('l', 'eq', 'z')
      .not('m', 'is', null)
      .not('n', 'in', ['a', 'b'])
      .not('o', 'like', '%x')
      .filter('p', 'gte', 9)
      .match({ q: 'r', s: false });
    expect(params(m)).toEqual([
      ['a', 'eq.1'],
      ['b', 'neq.x'],
      ['c', 'gt.2.5'],
      ['d', 'gte.3'],
      ['e', 'lt.4'],
      ['f', 'lte.5'],
      ['g', 'like.*milk*'],
      ['h', 'ilike.Ab*'],
      ['i', 'is.null'],
      ['j', 'is.true'],
      ['k', 'in.(1,2,3)'],
      ['l', 'not.eq.z'],
      ['m', 'not.is.null'],
      ['n', 'not.in.(a,b)'],
      ['o', 'not.like.*x'],
      ['p', 'gte.9'],
      ['q', 'eq.r'],
      ['s', 'eq.false'],
    ]);
  });

  it('repeats a column to express ranges, and keeps awkward characters intact', async () => {
    const m = offline();
    await m.client.from('t').select().gte('age', 18).lt('age', 30).eq('name', 'a&b=c d%');
    expect(params(m)).toEqual([['age', 'gte.18'], ['age', 'lt.30'], ['name', 'eq.a&b=c d%']]);
  });

  it('quotes list items that contain separators', async () => {
    const m = offline();
    await m.client.from('t').select().in('a', ['plain', 'with,comma', 'with space', 'q"uote', 'back\\slash', '(paren)', '']);
    expect(params(m)).toEqual([['a', 'in.(plain,"with,comma","with space","q\\"uote","back\\\\slash","(paren)","")']]);
    await m.client.from('t').select().in('a', []);
    expect(params(m)).toEqual([['a', 'in.()']]);
  });

  it('serialises dates as ISO-8601', async () => {
    const m = offline();
    await m.client.from('t').select().gte('at', new Date('2026-01-02T03:04:05.000Z'));
    expect(params(m)).toEqual([['at', 'gte.2026-01-02T03:04:05.000Z']]);
  });

  it('orders, limits and pages', async () => {
    const m = offline();
    await m.client.from('t').select().order('score', { ascending: false, nullsFirst: false }).order('id').limit(10);
    expect(params(m)).toEqual([['order', 'score.desc.nullslast,id.asc'], ['limit', '10']]);
    await m.client.from('t').select().range(20, 29);
    expect(params(m)).toEqual([['limit', '10'], ['offset', '20']]);
  });

  it('asks for a count and reads it from Content-Range', async () => {
    const m = offline(() => json([{ id: 1 }], 200, { 'content-range': '0-0/42' }));
    const res = await m.client.from('t').select('*', { count: 'exact' });
    expect(m.last().headers.Prefer).toBe('count=exact');
    expect(res.count).toBe(42);
    expect(res.data).toEqual([{ id: 1 }]);
  });

  it('single() and maybeSingle() read at most two rows and check the number', async () => {
    const rows = (n: number) => () => json(Array.from({ length: n }, (_, i) => ({ id: i })));
    let m = offline(rows(1));
    expect((await m.client.from('t').select().single()).data).toEqual({ id: 0 });
    expect(params(m)).toEqual([['limit', '2']]);

    m = offline(rows(0));
    const none = await m.client.from('t').select().single();
    expect(none.data).toBeNull();
    expect(none.error).toMatchObject({ code: 'not_single' });
    expect((await m.client.from('t').select().maybeSingle()).error).toBeNull();
    expect((await m.client.from('t').select().maybeSingle()).data).toBeNull();

    m = offline(rows(2));
    expect((await m.client.from('t').select().single()).error?.code).toBe('not_single');
    expect((await m.client.from('t').select().maybeSingle()).error?.code).toBe('not_single');
  });

  it('inserts: one row or many, returning rows only when asked', async () => {
    const m = offline(() => new Response(null, { status: 201 }));
    const plain = await m.client.from('t').insert({ a: 1 });
    expect(m.last()).toMatchObject({ method: 'POST', body: '{"a":1}' });
    expect(m.last().headers.Prefer).toBeUndefined();
    expect(m.last().headers['Content-Type']).toBe('application/json');
    expect(plain).toMatchObject({ data: null, error: null, status: 201 });

    const m2 = offline(() => json([{ id: 5, a: 1 }], 201));
    const withRows = await m2.client.from('t').insert([{ a: 1 }, { a: 2 }]).select('id,a');
    expect(m2.last().body).toBe('[{"a":1},{"a":2}]');
    expect(m2.last().headers.Prefer).toBe('return=representation');
    expect(params(m2)).toEqual([['select', 'id,a']]);
    expect(withRows.data).toEqual([{ id: 5, a: 1 }]);
  });

  it('upserts with merge or ignore semantics', async () => {
    const m = offline(() => new Response(null, { status: 201 }));
    await m.client.from('t').upsert({ id: 1 });
    expect(m.last().headers.Prefer).toBe('resolution=merge-duplicates');
    expect(m.last().url.search).toBe('');
    await m.client.from('t').upsert({ email: 'a' }, { onConflict: 'email' }).select();
    expect(m.last().headers.Prefer).toBe('return=representation,resolution=merge-duplicates');
    expect(params(m)).toEqual([['on_conflict', 'email']]);
    await m.client.from('t').upsert({ id: 1 }, { ignoreDuplicates: true });
    expect(m.last().headers.Prefer).toBe('resolution=ignore-duplicates');
  });

  it('updates and deletes with filters', async () => {
    const m = offline(() => new Response(null, { status: 204 }));
    await m.client.from('t').update({ done: true }).eq('id', 3);
    expect(m.last()).toMatchObject({ method: 'PATCH', body: '{"done":true}' });
    expect(params(m)).toEqual([['id', 'eq.3']]);
    await m.client.from('t').delete().in('id', [1, 2]);
    expect(m.last().method).toBe('DELETE');
    expect(params(m)).toEqual([['id', 'in.(1,2)']]);
  });

  it('refuses limit/range/order on writes instead of silently turning a one-row update into a mass update', async () => {
    const m = offline(() => new Response(null, { status: 204 }));
    const attempts = [
      m.client.from('t').update({ done: true }).eq('id', 3).limit(1),
      m.client.from('t').update({ done: true }).eq('id', 3).range(0, 0),
      m.client.from('t').delete().eq('id', 3).order('id'),
      m.client.from('t').insert({ a: 1 }).limit(1),
    ];
    for (const q of attempts) expect((await q).error).toMatchObject({ code: 'unsupported_modifier' });
    expect(m.calls).toHaveLength(0); // nothing was sent
  });
});

describe('reporting failures', () => {
  it('never throws: server errors come back as { error } with the server code', async () => {
    const m = offline(() => json({ error: { code: 'forbidden', message: 'No access policy allows this request', request_id: 'r1' } }, 403));
    const res = await m.client.from('t').select();
    expect(res.data).toBeNull();
    expect(res.error).toBeInstanceOf(SbbError);
    expect(res.error).toMatchObject({ code: 'forbidden', status: 403, requestId: 'r1', message: 'No access policy allows this request' });
    expect(res.status).toBe(403);
  });

  it('reports unreachable servers as network_error with status 0', async () => {
    const m = offline(() => {
      throw new TypeError('fetch failed');
    });
    const res = await m.client.from('t').select();
    expect(res.error).toMatchObject({ code: 'network_error', status: 0 });
    expect(res.error?.message).toContain('fetch failed');
  });

  it('reports non-JSON replies (a proxy error page) sensibly', async () => {
    const m = offline(() => new Response('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }));
    expect((await m.client.from('t').select()).error).toMatchObject({ code: 'http_error', status: 502 });
    const m2 = offline(() => new Response('not json', { status: 200 }));
    expect((await m2.client.from('t').select()).error).toMatchObject({ code: 'invalid_response' });
  });

  it('reports bad arguments as errors too, instead of throwing', async () => {
    const m = offline();
    const res = await m.client.from('t').select().eq('a', null as never);
    expect(res.error?.message).toMatch(/null/);
    expect(m.calls).toHaveLength(0); // nothing was sent
  });

  it('can be awaited more than once and used with .then()', async () => {
    const m = offline(() => json([{ id: 1 }]));
    const q = m.client.from('t').select();
    const [a, b] = await Promise.all([q, q]);
    expect(a.data).toEqual(b.data);
    await expect(q.then((r) => r.data?.length)).resolves.toBe(1);
  });
});

describe('creating a client', () => {
  it('validates the URL and the key', () => {
    expect(() => createClient('not a url', fakeKey())).toThrow(/Invalid URL/);
    expect(() => createClient('ftp://x.test', fakeKey())).toThrow(/http/);
    expect(() => createClient('http://x.test', 'garbage')).toThrow(/Invalid API key/);
    expect(() => createClient('http://x.test', fakeKey('SHORT'))).toThrow(/Invalid API key/);
  });

  it('exposes the project id found in the key and ignores trailing slashes', async () => {
    const m = mockFetch();
    const client = createClient('http://sbb.test/base///', fakeKey('zzzzzzzzzz000000'), { fetch: m.fn });
    expect(client.projectRef).toBe('zzzzzzzzzz000000');
    await client.from('t').select();
    expect(m.last().url.pathname).toBe('/base/rest/t');
  });
});

describe('against a real server', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startServer();
    await h.table('todos', [
      { name: 'id', type: 'integer', primary_key: true },
      { name: 'title', type: 'text', not_null: true },
      { name: 'done', type: 'boolean', not_null: true, default: false },
      { name: 'priority', type: 'integer', default: 0 },
      { name: 'email', type: 'text', unique: true },
      { name: 'meta', type: 'json' },
    ]);
  });
  afterAll(async () => {
    await h.t.close();
  });

  it('does the full CRUD cycle with typed values', async () => {
    const db = h.client('service');
    const inserted = await db.from('todos').insert([{ title: 'buy milk', priority: 2 }, { title: 'write code', done: true, priority: 5, meta: { tags: ['a'] } }, { title: 'sleep', priority: 1 }]).select();
    expect(inserted.error).toBeNull();
    expect(inserted.data).toHaveLength(3);
    expect(inserted.data![1]).toMatchObject({ title: 'write code', done: true, meta: { tags: ['a'] } });

    const open = await db.from('todos').select('id,title').eq('done', false).order('priority', { ascending: false });
    expect(open.data).toEqual([{ id: 1, title: 'buy milk' }, { id: 3, title: 'sleep' }]);

    const page = await db.from('todos').select('title', { count: 'exact' }).order('id').range(1, 2);
    expect(page.data!.map((r) => r.title)).toEqual(['write code', 'sleep']);
    expect(page.count).toBe(3);

    const upd = await db.from('todos').update({ done: true }).in('id', [1, 3]).select('id,done');
    expect(upd.data).toEqual([{ id: 1, done: true }, { id: 3, done: true }]);

    const one = await db.from('todos').select().eq('id', 1).single();
    expect(one.data).toMatchObject({ id: 1, title: 'buy milk', done: true });

    const del = await db.from('todos').delete().eq('done', true);
    expect(del).toMatchObject({ error: null, status: 204 });
    expect((await db.from('todos').select()).data).toEqual([]);
    db.dispose();
  });

  it('handles upsert and server-side errors', async () => {
    const db = h.client('service');
    await db.from('todos').upsert({ id: 50, title: 'v1', email: 'a@x.io' });
    const merged = await db.from('todos').upsert({ id: 50, title: 'v2' }).select().single();
    expect(merged.data).toMatchObject({ id: 50, title: 'v2', email: 'a@x.io' });

    const dup = await db.from('todos').insert({ title: 'dup', email: 'a@x.io' });
    expect(dup.error).toMatchObject({ code: 'unique_violation', status: 409 });
    const bad = await db.from('todos').insert({ title: 5 as never });
    expect(bad.error).toMatchObject({ code: 'invalid_value', status: 400 });
    const noFilter = await db.from('todos').delete();
    expect(noFilter.error?.code).toBe('filter_required');
    expect((await db.from('ghost').select()).error?.code).toBe('not_found');
    db.dispose();
  });

  it('is refused for anon without a policy, and works once a policy allows it', async () => {
    const anon = h.client('anon');
    expect((await anon.from('todos').select()).error).toMatchObject({ code: 'forbidden', status: 403 });
    await h.policy('todos', { select: { roles: ['anon'], where: { done: false } } });
    const seen = await anon.from('todos').select('title');
    expect(seen.error).toBeNull();
    expect(seen.data!.every((r) => typeof r.title === 'string')).toBe(true);
    anon.dispose();
  });

  it('returns network_error when the server is down', async () => {
    const dead = createClient('http://127.0.0.1:1', h.project.keys.anon);
    const res = await dead.from('todos').select();
    expect(res.error).toMatchObject({ code: 'network_error', status: 0 });
    dead.dispose();
  });

  it('signed-in users read with their own identity', async () => {
    await h.policy('todos', {
      select: { roles: ['authenticated'], where: { title: 'visible' } },
      insert: { roles: ['authenticated'] },
    });
    const c = h.client('anon');
    await c.auth.signUp({ email: 'sdk-query@example.com', password: PASSWORD });
    expect((await c.from('todos').insert({ title: 'visible' })).error).toBeNull();
    expect((await c.from('todos').insert({ title: 'hidden' })).error).toBeNull();
    expect((await c.from('todos').select('title').eq('title', 'visible')).data).toEqual([{ title: 'visible' }]);
    expect((await c.from('todos').select('title').eq('title', 'hidden')).data).toEqual([]);
    c.dispose();
  });
});
