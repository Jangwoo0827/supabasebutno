import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers.js';

type TestApp = Awaited<ReturnType<typeof makeTestApp>>;
let t: TestApp;
let project: Awaited<ReturnType<TestApp['createProject']>>;

beforeEach(async () => {
  t = await makeTestApp();
  project = await t.createProject('shop');
  const res = await t.admin('POST', `/projects/${project.id}/tables`, {
    name: 'todos',
    columns: [
      { name: 'id', type: 'integer', primary_key: true },
      { name: 'title', type: 'text', not_null: true },
      { name: 'done', type: 'boolean', not_null: true, default: false },
      { name: 'priority', type: 'integer', default: 0 },
      { name: 'email', type: 'text', unique: true },
      { name: 'meta', type: 'json' },
    ],
  });
  expect(res.status).toBe(201);
});
afterEach(async () => {
  await t.close();
});

const svc = () => ({ apikey: project.keys.service_role });
const rest = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  t.call(method, `/rest${path}`, { body, headers: { ...svc(), ...headers } });
const seed = async () => {
  const res = await rest('POST', '/todos', [
    { title: 'buy milk', priority: 2, email: 'a@x.io' },
    { title: 'write code', done: true, priority: 5, meta: { tags: ['work'] } },
    { title: 'sleep', priority: 1 },
    { title: '100% done_deal', priority: 3 },
  ]);
  expect(res.status).toBe(201);
};
const titles = (res: { json: any }) => res.json.map((r: { title: string }) => r.title);

describe('access', () => {
  it('needs an apikey', async () => {
    expect((await t.call('GET', '/rest/todos')).status).toBe(401);
  });

  it('does not let anon use the REST API until a policy allows it, and hides whether the table exists', async () => {
    await seed();
    const anon = { apikey: project.keys.anon };
    const existing = await t.call('GET', '/rest/todos', { headers: anon });
    const missing = await t.call('GET', '/rest/no_such_table', { headers: anon });
    for (const res of [existing, missing]) {
      expect(res.status).toBe(403);
      expect(res.json.error.code).toBe('forbidden');
    }
    expect(existing.json.error.message).toBe(missing.json.error.message);
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      expect((await t.call(method, '/rest/todos?id=eq.1', { headers: anon, body: { title: 'x' } })).status, method).toBe(403);
    }
  });

  it('is project-scoped: a key only sees its own project tables', async () => {
    const other = await t.createProject('other');
    const res = await t.call('GET', '/rest/todos', { headers: { apikey: other.keys.service_role } });
    expect(res.status).toBe(404);
  });

  it('sends no-store', async () => {
    expect((await rest('GET', '/todos')).headers.get('cache-control')).toBe('no-store');
  });
});

describe('insert', () => {
  it('returns nothing by default and rows with Prefer: return=representation', async () => {
    const minimal = await rest('POST', '/todos', { title: 'a' });
    expect(minimal.status).toBe(201);
    expect(minimal.text).toBe('');

    const rep = await rest('POST', '/todos', { title: 'b' }, { prefer: 'return=representation' });
    expect(rep.status).toBe(201);
    expect(rep.json).toEqual([{ id: 2, title: 'b', done: false, priority: 0, email: null, meta: null }]);
  });

  it('inserts many rows and honours select for the returned columns', async () => {
    const res = await rest('POST', '/todos?select=id,title', [{ title: 'a' }, { title: 'b' }], { prefer: 'return=representation' });
    expect(res.json).toEqual([{ id: 1, title: 'a' }, { id: 2, title: 'b' }]);
  });

  it('stores booleans and JSON faithfully', async () => {
    await rest('POST', '/todos', { title: 'j', done: true, meta: { a: [1, { b: null }], s: "it's" } });
    const row = (await rest('GET', '/todos')).json[0];
    expect(row.done).toBe(true);
    expect(row.meta).toEqual({ a: [1, { b: null }], s: "it's" });
  });

  it('accepts an empty object (all defaults) and a null integer id', async () => {
    const res = await rest('POST', '/todos', { id: null, title: 't' }, { prefer: 'return=representation' });
    expect(res.json[0].id).toBe(1);
  });

  it('is strictly typed', async () => {
    const bad: unknown[] = [
      { title: 5 },
      { title: 'x', done: 'yes' },
      { title: 'x', priority: '1' },
      { title: 'x', priority: 1.5 },
      { title: null },
      { priority: 1 }, // title missing -> NOT NULL
      { title: 'x', ghost: 1 },
      { title: 'x', ['__proto__']: 1 },
      'just a string',
      [],
      [{ title: 'ok' }, 5],
    ];
    for (const body of bad) {
      const res = await rest('POST', '/todos', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await rest('GET', '/todos')).json).toEqual([]);
  });

  it('rejects invalid JSON and oversized batches', async () => {
    expect((await rest('POST', '/todos', '{nope')).json.error.code).toBe('invalid_json');
    const many = Array.from({ length: 1001 }, (_, i) => ({ title: `t${i}` }));
    expect((await rest('POST', '/todos', many)).status).toBe(400);
  });

  it('maps constraint violations to 409 / 400', async () => {
    await rest('POST', '/todos', { title: 'a', email: 'dup@x.io' });
    const dup = await rest('POST', '/todos', { title: 'b', email: 'dup@x.io' });
    expect(dup.status).toBe(409);
    expect(dup.json.error).toMatchObject({ code: 'unique_violation', details: { column: 'email' } });
    expect(dup.text).not.toMatch(/sqlite|constraint failed/i);
  });

  it('is atomic: if one row of a batch fails, none are inserted', async () => {
    await rest('POST', '/todos', { title: 'seed', email: 'taken@x.io' });
    const res = await rest('POST', '/todos', [
      { title: 'ok-1', email: 'free@x.io' },
      { title: 'ok-2', email: 'taken@x.io' }, // fails at the database
    ]);
    expect(res.status).toBe(409);
    expect(titles(await rest('GET', '/todos'))).toEqual(['seed']);
  });
});

describe('select', () => {
  beforeEach(seed);

  it('filters with every operator', async () => {
    const q = async (qs: string) => titles(await rest('GET', `/todos?${qs}&order=id`));
    expect(await q('priority=eq.2')).toEqual(['buy milk']);
    expect(await q('priority=neq.2')).toEqual(['write code', 'sleep', '100% done_deal']);
    expect(await q('priority=gt.2')).toEqual(['write code', '100% done_deal']);
    expect(await q('priority=gte.3')).toEqual(['write code', '100% done_deal']);
    expect(await q('priority=lt.2')).toEqual(['sleep']);
    expect(await q('priority=lte.2')).toEqual(['buy milk', 'sleep']);
    expect(await q('priority=in.(1,3)')).toEqual(['sleep', '100% done_deal']);
    expect(await q('priority=not.in.(1,3)')).toEqual(['buy milk', 'write code']);
    expect(await q('done=is.true')).toEqual(['write code']);
    expect(await q('done=eq.false')).toEqual(['buy milk', 'sleep', '100% done_deal']);
    expect(await q('email=is.null')).toEqual(['write code', 'sleep', '100% done_deal']);
    expect(await q('email=not.is.null')).toEqual(['buy milk']);
    expect(await q('title=like.*MILK*')).toEqual(['buy milk']); // SQLite LIKE is ASCII case-insensitive
    expect(await q('title=like.s*')).toEqual(['sleep']);
    expect(await q('priority=gte.2&priority=lt.5')).toEqual(['buy milk', '100% done_deal']);
  });

  it('treats LIKE wildcards in user input literally', async () => {
    const q = async (pattern: string) => titles(await rest('GET', `/todos?title=like.${encodeURIComponent(pattern)}`));
    expect(await q('100% done*')).toEqual(['100% done_deal']);
    expect(await q('*done_deal')).toEqual(['100% done_deal']);
    expect(await q('*done-deal')).toEqual([]); // "_" must not match "-"
    expect(await q('%')).toEqual([]); // a bare % is the literal character, not "match everything"
  });

  it('orders, pages and projects columns', async () => {
    expect(titles(await rest('GET', '/todos?order=priority.desc'))).toEqual(['write code', '100% done_deal', 'buy milk', 'sleep']);
    expect(titles(await rest('GET', '/todos?order=priority.desc&limit=2&offset=1'))).toEqual(['100% done_deal', 'buy milk']);
    expect((await rest('GET', '/todos?select=id,title&limit=1')).json).toEqual([{ id: 1, title: 'buy milk' }]);
    expect(titles(await rest('GET', '/todos'))).toEqual(['buy milk', 'write code', 'sleep', '100% done_deal']); // pk order
  });

  it('reports ranges and exact counts via Content-Range', async () => {
    const page = await rest('GET', '/todos?limit=2&offset=1', undefined, { prefer: 'count=exact' });
    expect(page.headers.get('content-range')).toBe('1-2/4');
    const filtered = await rest('GET', '/todos?done=eq.false&limit=1', undefined, { prefer: 'count=exact' });
    expect(filtered.headers.get('content-range')).toBe('0-0/3');
    const empty = await rest('GET', '/todos?priority=gt.100', undefined, { prefer: 'count=exact' });
    expect(empty.headers.get('content-range')).toBe('*/0');
    expect((await rest('GET', '/todos')).headers.get('content-range')).toBe('0-3/*');
  });
});

describe('SQL injection attempts', () => {
  beforeEach(seed);

  const intact = async () => expect((await rest('GET', '/todos')).json).toHaveLength(4);

  it('hostile VALUES are inert', async () => {
    for (const evil of [`' OR '1'='1`, `x'; DROP TABLE todos; --`, `") OR 1=1 --`, '\\', '%', "''"]) {
      const enc = encodeURIComponent(evil);
      const quoted = `"${evil.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`; // a valid quoted list item
      for (const qs of [`title=eq.${enc}`, `title=neq.${enc}`, `title=like.${enc}`, `title=in.(${encodeURIComponent(quoted)})`]) {
        const res = await rest('GET', `/todos?${qs}`);
        expect(res.status, qs).toBe(200);
        expect(res.json.length, qs).toBeLessThanOrEqual(4);
      }
      expect((await rest('GET', `/todos?title=eq.${enc}`)).json).toEqual([]);
    }
    await intact();
  });

  it('hostile IDENTIFIERS are rejected', async () => {
    for (const evil of ['title"; DROP TABLE todos;--', 'id) OR (1=1', '1=1', '_meta', 'sqlite_master', 'title--']) {
      const enc = encodeURIComponent(evil);
      for (const qs of [`${enc}=eq.1`, `select=${enc}`, `order=${enc}`]) {
        const res = await rest('GET', `/todos?${qs}`);
        expect(res.status, qs).toBe(400);
      }
    }
    // `*` is only valid on its own as a select list
    expect((await rest('GET', '/todos?order=*')).status).toBe(400);
    expect((await rest('GET', '/todos?*=eq.1')).status).toBe(400);
    expect((await rest('GET', '/todos?select=*,id')).status).toBe(400);
    await intact();
  });

  it('hostile TABLE names are 404', async () => {
    for (const evil of ['todos;DROP TABLE todos', 'todos%22', '_meta', '_migrations', 'sqlite_master', 'sqlite_sequence', '..%2F..%2Fadmin', 'TODOS', '%00']) {
      const res = await rest('GET', `/${evil}`);
      expect(res.status, evil).toBe(404);
    }
    await intact();
  });

  it('hostile body KEYS are rejected', async () => {
    for (const key of ['title"); DROP TABLE todos;--', 'id" = 1, "title', '_meta']) {
      expect((await rest('POST', '/todos', { title: 'x', [key]: 1 })).status).toBe(400);
      expect((await rest('PATCH', '/todos?id=eq.1', { [key]: 1 })).status).toBe(400);
    }
    await intact();
  });

  it('hostile body VALUES are stored verbatim', async () => {
    const evil = `Robert'); DROP TABLE todos;--`;
    await rest('POST', '/todos', { title: evil });
    const res = await rest('GET', `/todos?title=eq.${encodeURIComponent(evil)}`);
    expect(res.json).toHaveLength(1);
    expect(res.json[0].title).toBe(evil);
    expect((await rest('GET', '/todos')).json).toHaveLength(5);
  });
});

describe('update / delete', () => {
  beforeEach(seed);

  it('PATCH changes only matching rows', async () => {
    const res = await rest('PATCH', '/todos?priority=gte.3', { done: true }, { prefer: 'return=representation' });
    expect(res.status).toBe(200);
    expect(titles(res)).toEqual(['write code', '100% done_deal']);
    expect(res.json.every((r: { done: boolean }) => r.done)).toBe(true);
    expect((await rest('GET', '/todos?done=eq.true')).json).toHaveLength(2);
  });

  it('PATCH without return=representation answers 204 and no body', async () => {
    const res = await rest('PATCH', '/todos?id=eq.1', { title: 'changed' });
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect((await rest('GET', '/todos?id=eq.1')).json[0].title).toBe('changed');
  });

  it('PATCH can set values to null and uses typed values', async () => {
    await rest('PATCH', '/todos?id=eq.1', { email: null, meta: { x: 1 } });
    const row = (await rest('GET', '/todos?id=eq.1')).json[0];
    expect(row.email).toBeNull();
    expect(row.meta).toEqual({ x: 1 });
    expect((await rest('PATCH', '/todos?id=eq.1', { title: null })).status).toBe(400);
    expect((await rest('PATCH', '/todos?id=eq.1', {})).status).toBe(400);
    expect((await rest('PATCH', '/todos?id=eq.1', { email: 'taken@x.io' })).status).toBe(204);
    expect((await rest('PATCH', '/todos?id=eq.2', { email: 'taken@x.io' })).status).toBe(409);
  });

  it('requires a filter: a forgotten WHERE must never touch every row', async () => {
    for (const method of ['PATCH', 'DELETE']) {
      const res = await rest(method, '/todos', { title: 'oops' });
      expect(res.status, method).toBe(400);
      expect(res.json.error.code).toBe('filter_required');
    }
    expect((await rest('GET', '/todos')).json).toHaveLength(4);
    expect(titles(await rest('GET', '/todos'))).not.toContain('oops');
  });

  it('allows deliberate mass operations with an explicit filter', async () => {
    expect((await rest('PATCH', '/todos?id=not.is.null', { priority: 9 })).status).toBe(204);
    expect((await rest('GET', '/todos?priority=eq.9')).json).toHaveLength(4);
    expect((await rest('DELETE', '/todos?id=not.is.null')).status).toBe(204);
    expect((await rest('GET', '/todos')).json).toEqual([]);
  });

  it('rejects limit / order / offset on writes instead of ignoring them', async () => {
    for (const qs of ['limit=1', 'order=id', 'offset=1']) {
      expect((await rest('PATCH', `/todos?id=gt.0&${qs}`, { priority: 7 })).status, qs).toBe(400);
      expect((await rest('DELETE', `/todos?id=gt.0&${qs}`)).status, qs).toBe(400);
    }
    expect((await rest('GET', '/todos?priority=eq.7')).json).toEqual([]);
    expect((await rest('GET', '/todos')).json).toHaveLength(4);
  });

  it('DELETE removes matching rows and can return them', async () => {
    const res = await rest('DELETE', '/todos?done=eq.false&select=id,title', undefined, { prefer: 'return=representation' });
    expect(res.json).toEqual([{ id: 1, title: 'buy milk' }, { id: 3, title: 'sleep' }, { id: 4, title: '100% done_deal' }]);
    expect(titles(await rest('GET', '/todos'))).toEqual(['write code']);
    expect((await rest('DELETE', '/todos?id=eq.999')).status).toBe(204);
  });
});

describe('upsert', () => {
  it('merges on the primary key by default and on a unique column when asked', async () => {
    await rest('POST', '/todos', { id: 1, title: 'first', priority: 1 });
    await rest('POST', '/todos', { id: 1, title: 'second' }, { prefer: 'resolution=merge-duplicates' });
    let rows = (await rest('GET', '/todos')).json;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 1, title: 'second', priority: 1 }); // untouched columns survive

    await rest('POST', '/todos', { title: 'mail', email: 'u@x.io' });
    const res = await rest('POST', '/todos?on_conflict=email', { title: 'mail v2', email: 'u@x.io' }, { prefer: 'resolution=merge-duplicates,return=representation' });
    expect(res.json).toHaveLength(1);
    rows = (await rest('GET', '/todos?email=eq.u@x.io')).json;
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('mail v2');
  });

  it('can ignore duplicates', async () => {
    await rest('POST', '/todos', { id: 1, title: 'keep' });
    const res = await rest('POST', '/todos', [{ id: 1, title: 'ignored' }, { id: 2, title: 'new' }], { prefer: 'resolution=ignore-duplicates,return=representation' });
    expect(res.json.map((r: { title: string }) => r.title)).toEqual(['new']);
    expect(titles(await rest('GET', '/todos'))).toEqual(['keep', 'new']);
  });

  it('on_conflict needs a Prefer resolution and a unique column', async () => {
    expect((await rest('POST', '/todos?on_conflict=email', { title: 'x' })).status).toBe(400);
    expect((await rest('POST', '/todos?on_conflict=title', { title: 'x' }, { prefer: 'resolution=merge-duplicates' })).status).toBe(400);
  });
});

describe('schema changes are visible immediately', () => {
  it('sees added columns, and loses dropped tables', async () => {
    await rest('POST', '/todos', { title: 'a' });
    expect((await rest('POST', '/todos', { title: 'b', note: 'x' })).status).toBe(400);

    await t.admin('PATCH', `/projects/${project.id}/tables/todos`, { add_columns: [{ name: 'note', type: 'text' }] });
    expect((await rest('POST', '/todos', { title: 'b', note: 'x' })).status).toBe(201);
    expect((await rest('GET', '/todos?note=eq.x')).json).toHaveLength(1);

    await t.admin('PATCH', `/projects/${project.id}/tables/todos`, { rename_to: 'tasks' });
    expect((await rest('GET', '/todos')).status).toBe(404);
    expect((await rest('GET', '/tasks')).json).toHaveLength(2);

    await t.admin('DELETE', `/projects/${project.id}/tables/tasks`);
    expect((await rest('GET', '/tasks')).status).toBe(404);
  });
});
