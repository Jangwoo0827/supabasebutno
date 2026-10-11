import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers.js';

type TestApp = Awaited<ReturnType<typeof makeTestApp>>;
let t: TestApp;
let project: Awaited<ReturnType<TestApp['createProject']>>;
let alice: { id: string; token: string };
let bob: { id: string; token: string };

const PASSWORD = 'correct horse battery';

beforeEach(async () => {
  t = await makeTestApp();
  project = await t.createProject('notes-app');
  const make = async (email: string) => {
    const res = await t.call('POST', '/auth/signup', { body: { email, password: PASSWORD }, headers: { apikey: project.keys.anon } });
    return { id: res.json.user.id as string, token: res.json.access_token as string };
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
    ],
  });
  expect(created.status).toBe(201);
});
afterEach(async () => {
  await t.close();
});

type Who = 'anon' | 'service' | typeof alice;
function rest(method: string, path: string, who: Who, body?: unknown, prefer?: string) {
  const headers: Record<string, string> = {};
  if (who === 'service') headers.apikey = project.keys.service_role;
  else {
    headers.apikey = project.keys.anon;
    if (who !== 'anon') headers.authorization = `Bearer ${who.token}`;
  }
  if (prefer) headers.prefer = prefer;
  return t.call(method, `/rest${path}`, { body, headers });
}
const setPolicy = async (policy: unknown, table = 'notes') => {
  const res = await t.admin('PUT', `/projects/${project.id}/policies/${table}`, policy);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
};
const bodies = (res: { json: any }) => res.json.map((r: { body: string }) => r.body).sort();

/** Notes are private to their owner unless shared; anyone may read shared ones. */
const OWNER_POLICY = {
  select: { roles: ['anon', 'authenticated'], where: { or: [{ shared: true }, { owner: '$uid' }] } },
  insert: { roles: ['authenticated'], set: { owner: '$uid' } },
  update: { roles: ['authenticated'], where: { owner: '$uid' } },
  delete: { roles: ['authenticated'], where: { owner: '$uid' } },
};

describe('deny by default', () => {
  it('refuses everything for anon and authenticated until a policy exists; service_role is unaffected', async () => {
    await rest('POST', '/notes', 'service', { body: 'secret', owner: alice.id });
    for (const who of ['anon', alice] as const) {
      for (const [method, path, body] of [
        ['GET', '/notes', undefined],
        ['POST', '/notes', { body: 'x' }],
        ['PATCH', '/notes?id=gt.0', { body: 'x' }],
        ['DELETE', '/notes?id=gt.0', undefined],
      ] as const) {
        const res = await rest(method, path, who, body);
        expect(res.status, `${who === 'anon' ? 'anon' : 'user'} ${method}`).toBe(403);
        expect(res.json.error.code).toBe('forbidden');
      }
    }
    expect((await rest('GET', '/notes', 'service')).json).toHaveLength(1);
  });

  it('only grants the operations and roles a policy lists', async () => {
    await setPolicy({ select: { roles: ['authenticated'], where: true } });
    expect((await rest('GET', '/notes', alice)).status).toBe(200);
    expect((await rest('GET', '/notes', 'anon')).status).toBe(403); // wrong role
    expect((await rest('POST', '/notes', alice, { body: 'x' })).status).toBe(403); // no insert rule
    expect((await rest('PATCH', '/notes?id=gt.0', alice, { body: 'x' })).status).toBe(403);
    expect((await rest('DELETE', '/notes?id=gt.0', alice)).status).toBe(403);
  });

  it('answers a missing table and an unprotected table with the same 403', async () => {
    await setPolicy(OWNER_POLICY);
    const missing = await rest('GET', '/ghost', alice);
    expect(missing.status).toBe(403);
    expect(missing.json.error.message).toBe((await rest('POST', '/ghost', 'anon', {})).json.error.message);
  });

  it('keeps the policy table itself out of reach', async () => {
    await setPolicy(OWNER_POLICY);
    for (const who of ['anon', alice, 'service'] as const) {
      const res = await rest('GET', '/_policies', who);
      expect([403, 404]).toContain(res.status);
    }
    expect((await t.admin('GET', `/projects/${project.id}/tables/_policies`)).status).toBe(404);
  });
});

describe('owner-only policy', () => {
  beforeEach(() => setPolicy(OWNER_POLICY));

  async function seed() {
    const a = await rest('POST', '/notes', alice, [{ body: 'alice private' }, { body: 'alice shared', shared: true }], 'return=representation');
    const b = await rest('POST', '/notes', bob, [{ body: 'bob private' }], 'return=representation');
    return { a: a.json, b: b.json };
  }

  it('forces the owner on insert, ignoring what the client sends', async () => {
    const res = await rest('POST', '/notes', alice, { body: 'mine', owner: bob.id }, 'return=representation');
    expect(res.status).toBe(201);
    expect(res.json[0].owner).toBe(alice.id);
  });

  it('shows each reader only what the select rule allows', async () => {
    await seed();
    expect(bodies(await rest('GET', '/notes', alice))).toEqual(['alice private', 'alice shared']);
    expect(bodies(await rest('GET', '/notes', bob))).toEqual(['alice shared', 'bob private']);
    expect(bodies(await rest('GET', '/notes', 'anon'))).toEqual(['alice shared']);
    expect(await rest('GET', '/notes', 'service').then((r) => r.json)).toHaveLength(3);
  });

  it('filters can narrow but never widen what a user sees', async () => {
    await seed();
    expect(bodies(await rest('GET', `/notes?owner=eq.${alice.id}`, bob))).toEqual(['alice shared']);
    expect((await rest('GET', `/notes?body=eq.${encodeURIComponent('alice private')}`, bob)).json).toEqual([]);
    expect((await rest('GET', `/notes?shared=eq.false&owner=neq.${bob.id}`, bob)).json).toEqual([]);
    expect(bodies(await rest('GET', '/notes?select=body&order=body.desc&limit=1', bob))).toHaveLength(1);
  });

  it('counts only visible rows', async () => {
    await seed();
    const res = await rest('GET', '/notes?limit=1', bob, undefined, 'count=exact');
    expect(res.headers.get('content-range')).toBe('0-0/2');
    expect((await rest('GET', '/notes', 'anon', undefined, 'count=exact')).headers.get('content-range')).toBe('0-0/1');
  });

  it('lets users change and delete only their own rows; foreign rows are simply not matched', async () => {
    const { a } = await seed();
    const aliceNote = a[0].id;

    const hijack = await rest('PATCH', `/notes?id=eq.${aliceNote}`, bob, { body: 'pwned' }, 'return=representation');
    expect(hijack.status).toBe(200);
    expect(hijack.json).toEqual([]); // matched nothing
    expect((await rest('DELETE', `/notes?id=eq.${aliceNote}`, bob, undefined, 'return=representation')).json).toEqual([]);
    expect((await rest('PATCH', '/notes?id=not.is.null', bob, { body: 'mass' })).status).toBe(204);
    expect(bodies(await rest('GET', '/notes', 'service'))).toEqual(['alice private', 'alice shared', 'mass']); // only bob's own row changed

    const own = await rest('PATCH', `/notes?id=eq.${aliceNote}`, alice, { body: 'edited' }, 'return=representation');
    expect(own.json[0].body).toBe('edited');
    expect((await rest('DELETE', `/notes?id=eq.${aliceNote}`, alice)).status).toBe(204);
    expect(bodies(await rest('GET', '/notes', 'service'))).toEqual(['alice shared', 'mass']);
  });

  it('refuses to hand a row to someone else (update check defaults to the where clause) and rolls back', async () => {
    const { a } = await seed();
    const res = await rest('PATCH', `/notes?id=eq.${a[0].id}`, alice, { owner: bob.id });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('policy_violation');
    const row = (await rest('GET', `/notes?id=eq.${a[0].id}`, 'service')).json[0];
    expect(row.owner).toBe(alice.id);
  });

  it('rolls a whole multi-row update back if any resulting row violates the policy', async () => {
    await rest('POST', '/notes', alice, [{ body: 'one' }, { body: 'two' }]);
    const res = await rest('PATCH', '/notes?id=not.is.null', alice, { owner: null });
    expect(res.status).toBe(403);
    expect((await rest('GET', `/notes?owner=eq.${alice.id}`, 'service')).json).toHaveLength(2);
  });

  it('anon cannot write at all', async () => {
    expect((await rest('POST', '/notes', 'anon', { body: 'x' })).status).toBe(403);
    expect((await rest('PATCH', '/notes?id=gt.0', 'anon', { body: 'x' })).status).toBe(403);
    expect((await rest('DELETE', '/notes?id=gt.0', 'anon')).status).toBe(403);
  });

  it('a NULL user id never matches NULL owners (anon must not see ownerless rows)', async () => {
    await rest('POST', '/notes', 'service', { body: 'orphan' }); // owner = NULL
    await setPolicy({ select: { roles: ['anon', 'authenticated'], where: { owner: '$uid' } } });
    expect((await rest('GET', '/notes', 'anon')).json).toEqual([]);
    expect((await rest('GET', '/notes', alice)).json).toEqual([]);
  });

  it('a service key with a user token keeps its full access', async () => {
    await seed();
    const res = await t.call('GET', '/rest/notes', { headers: { apikey: project.keys.service_role, authorization: `Bearer ${alice.token}` } });
    expect(res.json).toHaveLength(3);
  });
});

describe('insert checks', () => {
  it('verifies the stored row (defaults included) and rejects the whole batch if one row fails', async () => {
    await setPolicy({
      select: { roles: ['authenticated'], where: true },
      insert: { roles: ['authenticated'], check: { and: [{ shared: false }, { column: 'level', op: 'lte', value: 5 }] }, set: { owner: '$uid' } },
    });
    expect((await rest('POST', '/notes', alice, { body: 'ok' })).status).toBe(201);
    expect((await rest('POST', '/notes', alice, { body: 'no', shared: true })).status).toBe(403);
    expect((await rest('POST', '/notes', alice, { body: 'no', level: 6 })).status).toBe(403);

    const batch = await rest('POST', '/notes', alice, [{ body: 'fine' }, { body: 'bad', level: 9 }]);
    expect(batch.status).toBe(403);
    expect(batch.json.error.code).toBe('policy_violation');
    expect(bodies(await rest('GET', '/notes', alice))).toEqual(['ok']);
  });

  it('a column default that breaks the check is caught (check sees the stored row)', async () => {
    await setPolicy({
      select: { roles: ['authenticated'], where: true },
      insert: { roles: ['authenticated'], check: { column: 'level', op: 'gt', value: 1 } }, // default level is 1
    });
    expect((await rest('POST', '/notes', alice, { body: 'x' })).status).toBe(403);
    expect((await rest('POST', '/notes', alice, { body: 'x', level: 2 })).status).toBe(201);
  });
});

describe('rows returned from writes', () => {
  it('require a select rule, and are filtered through it', async () => {
    await setPolicy({ insert: { roles: ['authenticated'], set: { owner: '$uid' } } });
    // no select rule: writing is fine, asking for the rows back is not
    expect((await rest('POST', '/notes', alice, { body: 'a' })).status).toBe(201);
    const denied = await rest('POST', '/notes', alice, { body: 'b' }, 'return=representation');
    expect(denied.status).toBe(403);
    expect((await rest('GET', '/notes', 'service')).json).toHaveLength(1); // and the denied insert was not applied

    await setPolicy({
      select: { roles: ['authenticated'], where: { shared: true } },
      insert: { roles: ['authenticated'], set: { owner: '$uid' } },
    });
    const res = await rest('POST', '/notes', alice, [{ body: 'hidden' }, { body: 'visible', shared: true }], 'return=representation');
    expect(res.status).toBe(201);
    expect(bodies(res)).toEqual(['visible']); // inserted rows the caller could not read are not echoed back
    expect((await rest('GET', '/notes', 'service')).json).toHaveLength(3);
  });

  it('cannot be used to read other users rows through PATCH or DELETE', async () => {
    await setPolicy({
      select: { roles: ['authenticated'], where: { owner: '$uid' } },
      update: { roles: ['authenticated'], where: true },
      delete: { roles: ['authenticated'], where: true },
    });
    await rest('POST', '/notes', 'service', { body: 'bobs', owner: bob.id });
    const upd = await rest('PATCH', '/notes?id=not.is.null', alice, { level: 7 }, 'return=representation');
    expect(upd.status).toBe(200);
    expect(upd.json).toEqual([]); // updated, but the caller may not read it
    expect((await rest('GET', '/notes', 'service')).json[0].level).toBe(7);
    const del = await rest('DELETE', '/notes?id=not.is.null', alice, undefined, 'return=representation');
    expect(del.json).toEqual([]);
  });
});

describe('upsert', () => {
  beforeEach(() =>
    setPolicy({
      select: { roles: ['authenticated'], where: { owner: '$uid' } },
      insert: { roles: ['authenticated'], set: { owner: '$uid' } },
      update: { roles: ['authenticated'], where: { owner: '$uid' } },
    }),
  );
  const merge = 'resolution=merge-duplicates,return=representation';

  it('creates, then updates, the caller own row', async () => {
    const first = await rest('POST', '/notes', alice, { id: 10, body: 'v1' }, merge);
    expect(first.status).toBe(201);
    const second = await rest('POST', '/notes', alice, { id: 10, body: 'v2' }, merge);
    expect(second.json[0]).toMatchObject({ id: 10, body: 'v2', owner: alice.id });
  });

  it('cannot take over or overwrite a row owned by someone else', async () => {
    await rest('POST', '/notes', alice, { id: 10, body: 'alice' }, merge);
    const res = await rest('POST', '/notes', bob, { id: 10, body: 'stolen' }, merge);
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('policy_violation');
    expect((await rest('GET', '/notes?id=eq.10', 'service')).json[0]).toMatchObject({ body: 'alice', owner: alice.id });
  });

  it('needs both an insert and an update rule', async () => {
    await setPolicy({ select: { roles: ['authenticated'], where: true }, insert: { roles: ['authenticated'] } });
    expect((await rest('POST', '/notes', alice, { id: 1, body: 'x' }, 'resolution=merge-duplicates')).status).toBe(403);
    expect((await rest('POST', '/notes', alice, { id: 1, body: 'x' })).status).toBe(201); // a plain insert is fine
  });
});

describe('changing policies and schemas', () => {
  it('takes effect on the very next request', async () => {
    await setPolicy({ select: { roles: ['anon'], where: true } });
    await rest('POST', '/notes', 'service', { body: 'n' });
    expect((await rest('GET', '/notes', 'anon')).status).toBe(200);
    await setPolicy({ select: { roles: ['authenticated'], where: true } });
    expect((await rest('GET', '/notes', 'anon')).status).toBe(403);
    expect((await t.admin('DELETE', `/projects/${project.id}/policies/notes`)).status).toBe(204);
    expect((await rest('GET', '/notes', alice)).status).toBe(403);
  });

  it('refuses to drop or rename a column the policy relies on', async () => {
    await setPolicy(OWNER_POLICY);
    const base = `/projects/${project.id}/tables/notes`;
    for (const body of [{ drop_columns: ['owner'] }, { rename_columns: [{ from: 'owner', to: 'author' }] }, { drop_columns: ['shared'] }]) {
      const res = await t.admin('PATCH', base, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.json.error.code).toBe('column_in_use_by_policy');
    }
    expect((await t.admin('PATCH', base, { drop_columns: ['level'] })).status).toBe(200); // unrelated column
    expect(bodies(await rest('GET', '/notes', 'anon'))).toEqual([]); // policy still in force
  });

  it('moves the policy with a renamed table and deletes it with a dropped one', async () => {
    await setPolicy({ select: { roles: ['anon'], where: true } });
    await rest('POST', '/notes', 'service', { body: 'n' });
    await t.admin('PATCH', `/projects/${project.id}/tables/notes`, { rename_to: 'memos' });
    expect((await rest('GET', '/memos', 'anon')).json).toHaveLength(1);
    expect((await t.admin('GET', `/projects/${project.id}/policies/memos`)).status).toBe(200);
    expect((await t.admin('GET', `/projects/${project.id}/policies/notes`)).status).toBe(404);

    await t.admin('DELETE', `/projects/${project.id}/tables/memos`);
    expect((await t.admin('GET', `/projects/${project.id}/policies`)).json.policies).toEqual([]);
    // a new table reusing the name must NOT inherit the old (public) policy
    await t.admin('POST', `/projects/${project.id}/tables`, { name: 'memos', columns: [{ name: 'id', type: 'integer', primary_key: true }] });
    expect((await rest('GET', '/memos', 'anon')).status).toBe(403);
  });
});

describe('policy admin API', () => {
  const base = () => `/projects/${project.id}/policies`;

  it('stores, lists, reads and deletes policies', async () => {
    await setPolicy(OWNER_POLICY);
    const one = await t.admin('GET', `${base()}/notes`);
    expect(one.json).toMatchObject({ table: 'notes', policy: OWNER_POLICY });
    expect((await t.admin('GET', base())).json.policies).toHaveLength(1);
    expect((await t.admin('DELETE', `${base()}/notes`)).status).toBe(204);
    expect((await t.admin('GET', `${base()}/notes`)).status).toBe(404);
    expect((await t.admin('DELETE', `${base()}/notes`)).status).toBe(404);
  });

  it('validates against the real table and explains problems', async () => {
    const bad: [unknown, RegExp][] = [
      [{ select: { roles: ['anon'], where: { ghost: 1 } } }, /unknown column/],
      [{ select: { roles: ['anon'], where: { owner: '$me' } } }, /unknown variable/],
      [{ select: { roles: ['service_role'] } }, /unknown role/],
      [{ drop: { roles: ['anon'] } }, /unknown operation/],
      [{}, /at least one operation/],
      [[], /JSON object/],
    ];
    for (const [policy, message] of bad) {
      const res = await t.admin('PUT', `${base()}/notes`, policy);
      expect(res.status, JSON.stringify(policy)).toBe(400);
      expect(res.json.error.code).toBe('invalid_policy');
      expect(res.json.error.message).toMatch(message);
      expect(res.json.error.details[0]).toHaveProperty('path');
    }
    expect((await t.admin('GET', base())).json.policies).toEqual([]);
  });

  it('refuses policies for tables that do not exist or are internal', async () => {
    for (const name of ['ghost', '_policies', '_auth_users', 'sqlite_master']) {
      expect((await t.admin('PUT', `${base()}/${name}`, { select: { roles: ['anon'] } })).status, name).toBe(404);
    }
  });

  it('a rejected update leaves the previous policy in force', async () => {
    await setPolicy({ select: { roles: ['anon'], where: true } });
    expect((await t.admin('PUT', `${base()}/notes`, { select: { roles: ['anon'], where: { ghost: 1 } } })).status).toBe(400);
    expect((await rest('GET', '/notes', 'anon')).status).toBe(200);
  });

  it('is admin-only', async () => {
    expect((await t.admin('PUT', `${base()}/notes`, { select: { roles: ['anon'] } }, null)).status).toBe(401);
    const asUser = await t.call('PUT', `/admin/projects/${project.id}/policies/notes`, {
      body: { select: { roles: ['anon'] } },
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(asUser.status).toBe(401);
  });
});

describe('a leaderboard (public read, authenticated write)', () => {
  it('works with typed comparisons and an immutable owner', async () => {
    await t.admin('POST', `/projects/${project.id}/tables`, {
      name: 'scores',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'user_id', type: 'text', not_null: true },
        { name: 'time_ms', type: 'integer', not_null: true },
        { name: 'mode', type: 'text', not_null: true },
      ],
    });
    await setPolicy(
      {
        select: { roles: ['anon', 'authenticated'], where: true },
        insert: { roles: ['authenticated'], check: { column: 'time_ms', op: 'gte', value: 1000 }, set: { user_id: '$uid' } },
        delete: { roles: ['authenticated'], where: { user_id: '$uid' } },
      },
      'scores',
    );
    expect((await rest('POST', '/scores', alice, { time_ms: 120000, mode: 'rush' })).status).toBe(201);
    expect((await rest('POST', '/scores', bob, { time_ms: 95000, mode: 'rush' })).status).toBe(201);
    expect((await rest('POST', '/scores', bob, { time_ms: 5, mode: 'rush' })).status).toBe(403); // implausible score
    expect((await rest('POST', '/scores', 'anon', { time_ms: 50000, mode: 'rush' })).status).toBe(403);

    const top = await rest('GET', '/scores?mode=eq.rush&order=time_ms.asc&limit=10&select=user_id,time_ms', 'anon');
    expect(top.json).toEqual([{ user_id: bob.id, time_ms: 95000 }, { user_id: alice.id, time_ms: 120000 }]);

    // nobody can edit a score (no update rule) and only the owner can delete theirs
    expect((await rest('PATCH', '/scores?id=gt.0', alice, { time_ms: 1000 })).status).toBe(403);
    await rest('DELETE', '/scores?id=gt.0', alice);
    expect((await rest('GET', '/scores', 'anon')).json).toHaveLength(1);
  });
});
