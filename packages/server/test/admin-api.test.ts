import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, makeTestApp } from './helpers.js';

type TestApp = Awaited<ReturnType<typeof makeTestApp>>;
let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
});
afterEach(async () => {
  await t.close();
});

const exists = (p: string) => access(p).then(() => true, () => false);
const bearer = (key: string) => ({ apikey: key });

describe('admin authentication', () => {
  it('rejects missing, wrong and wrongly-formatted credentials', async () => {
    expect((await t.admin('GET', '/projects', undefined, null)).status).toBe(401);
    expect((await t.admin('GET', '/projects', undefined, 'wrong-token')).status).toBe(401);
    expect((await t.admin('GET', '/projects', undefined, ADMIN_TOKEN.slice(0, -1))).status).toBe(401);
    const basic = await t.call('GET', '/admin/projects', { headers: { authorization: `Basic ${ADMIN_TOKEN}` } });
    expect(basic.status).toBe(401);
    // the token must not be accepted from the query string or from the apikey header
    expect((await t.call('GET', `/admin/projects?token=${ADMIN_TOKEN}`)).status).toBe(401);
    expect((await t.call('GET', '/admin/projects', { headers: { apikey: ADMIN_TOKEN } })).status).toBe(401);
  });

  it('protects every admin route, not just the list', async () => {
    const p = await t.createProject();
    const routes: [string, string][] = [
      ['GET', `/projects/${p.id}`],
      ['DELETE', `/projects/${p.id}?confirm=${p.name}`],
      ['POST', `/projects/${p.id}/rotate-keys`],
      ['GET', `/projects/${p.id}/tables`],
      ['POST', `/projects/${p.id}/tables`],
      ['GET', `/projects/${p.id}/tables/x`],
      ['PATCH', `/projects/${p.id}/tables/x`],
      ['DELETE', `/projects/${p.id}/tables/x`],
    ];
    for (const [method, path] of routes) {
      expect((await t.admin(method, path, undefined, null)).status, `${method} ${path}`).toBe(401);
    }
    // the unauthenticated attempts must not have changed anything
    expect((await t.admin('GET', `/projects/${p.id}`)).status).toBe(200);
  });

  it('does not accept a project service key as admin credentials', async () => {
    const p = await t.createProject();
    expect((await t.admin('GET', '/projects', undefined, p.keys.service_role)).status).toBe(401);
  });

  it('never caches responses that contain keys', async () => {
    const p = await t.createProject();
    expect((await t.admin('GET', `/projects/${p.id}`)).headers.get('cache-control')).toBe('no-store');
  });
});

describe('projects', () => {
  it('creates a project with an id, keys and its own database file', async () => {
    const p = await t.createProject('My App');
    expect(p.id).toMatch(/^[a-z0-9]{16}$/);
    expect(p.name).toBe('My App');
    expect(p.keys.anon).toBeTruthy();
    expect(p.keys.service_role).not.toBe(p.keys.anon);
    expect(await exists(join(t.dataDir, 'projects', p.id, 'db.sqlite'))).toBe(true);
  });

  it('lists projects without exposing keys, and returns keys on detail', async () => {
    const a = await t.createProject('alpha');
    await t.createProject('beta');
    const list = await t.admin('GET', '/projects');
    expect(list.status).toBe(200);
    expect(list.json.projects.map((p: { name: string }) => p.name)).toEqual(['alpha', 'beta']);
    expect(list.text).not.toContain('keys');
    expect(list.text).not.toContain(a.keys.service_role);

    const detail = await t.admin('GET', `/projects/${a.id}`);
    expect(detail.json.keys).toEqual(a.keys);
  });

  it('rejects duplicate names (case-insensitive) with 409', async () => {
    await t.createProject('Demo');
    const dup = await t.admin('POST', '/projects', { name: 'dEMo' });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe('project_exists');
    expect((await t.admin('GET', '/projects')).json.projects).toHaveLength(1);
  });

  it('validates input', async () => {
    for (const body of [{}, { name: '' }, { name: '   ' }, { name: 5 }, { name: 'x', admin: true }, { name: 'x'.repeat(65) }]) {
      const res = await t.admin('POST', '/projects', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json.error.code).toBe('validation_error');
    }
    const badJson = await t.admin('POST', '/projects', '{not json');
    expect(badJson.status).toBe(400);
    expect(badJson.json.error.code).toBe('invalid_json');
  });

  it('answers 404 for unknown or malformed project ids (no path traversal)', async () => {
    for (const id of ['nope', 'AAAAAAAAAAAAAAAA', 'aaaaaaaaaaaaaaaa', '..%2F..%2Fetc', '%2e%2e', 'a'.repeat(17)]) {
      expect((await t.admin('GET', `/projects/${id}`)).status, id).toBe(404);
      expect((await t.admin('GET', `/projects/${id}/tables`)).status, id).toBe(404);
      expect((await t.admin('DELETE', `/projects/${id}?confirm=x`)).status, id).toBe(404);
    }
  });

  it('rotating keys revokes the old ones and issues working new ones', async () => {
    const p = await t.createProject();
    expect((await t.call('GET', '/whoami', { headers: bearer(p.keys.anon) })).status).toBe(200);

    const rotated = await t.admin('POST', `/projects/${p.id}/rotate-keys`);
    expect(rotated.status).toBe(200);
    expect(rotated.json.keys.anon).not.toBe(p.keys.anon);
    expect(rotated.json.key_version).toBe(2);

    expect((await t.call('GET', '/whoami', { headers: bearer(p.keys.anon) })).status).toBe(401);
    expect((await t.call('GET', '/whoami', { headers: bearer(p.keys.service_role) })).status).toBe(401);
    expect((await t.call('GET', '/whoami', { headers: bearer(rotated.json.keys.anon) })).status).toBe(200);
  });

  it('delete requires the project name as confirmation', async () => {
    const p = await t.createProject('precious');
    const dir = join(t.dataDir, 'projects', p.id);

    for (const q of ['', '?confirm=', '?confirm=wrong', '?confirm=PRECIOUS ']) {
      const res = await t.admin('DELETE', `/projects/${p.id}${q}`);
      expect(res.status, q).toBe(400);
      expect(res.json.error.code).toBe('confirmation_required');
    }
    expect(await exists(dir)).toBe(true);

    expect((await t.admin('DELETE', `/projects/${p.id}?confirm=precious`)).status).toBe(204);
    expect(await exists(dir)).toBe(false);
    expect((await t.admin('GET', `/projects/${p.id}`)).status).toBe(404);
    expect((await t.admin('GET', '/projects')).json.projects).toEqual([]);
    // its keys stop working
    expect((await t.call('GET', '/whoami', { headers: bearer(p.keys.service_role) })).status).toBe(401);
  });
});

describe('API key resolution (/whoami)', () => {
  it('resolves project and role from the apikey header', async () => {
    const a = await t.createProject('a');
    const b = await t.createProject('b');
    const anon = await t.call('GET', '/whoami', { headers: bearer(a.keys.anon) });
    expect(anon.json).toEqual({ project: { id: a.id, name: 'a' }, role: 'anon' });
    const svc = await t.call('GET', '/whoami', { headers: bearer(b.keys.service_role) });
    expect(svc.json).toEqual({ project: { id: b.id, name: 'b' }, role: 'service_role' });
  });

  it('rejects missing and invalid keys, and does not read the key from the URL', async () => {
    const p = await t.createProject();
    const missing = await t.call('GET', '/whoami');
    expect(missing.status).toBe(401);
    expect(missing.json.error.code).toBe('missing_apikey');
    expect((await t.call('GET', '/whoami', { headers: bearer('garbage') })).json.error.code).toBe('invalid_apikey');
    expect((await t.call('GET', `/whoami?apikey=${p.keys.anon}`)).status).toBe(401);
    expect((await t.call('GET', '/whoami', { headers: { authorization: `Bearer ${p.keys.anon}` } })).status).toBe(401);
  });
});

describe('tables', () => {
  const todos = {
    name: 'todos',
    columns: [
      { name: 'id', type: 'integer', primary_key: true },
      { name: 'title', type: 'text', not_null: true },
      { name: 'done', type: 'boolean', not_null: true, default: false },
    ],
  };

  it('creates, reads, lists, alters and drops a table', async () => {
    const p = await t.createProject();
    const base = `/projects/${p.id}/tables`;

    const created = await t.admin('POST', base, todos);
    expect(created.status).toBe(201);
    expect(created.json.columns[2]).toMatchObject({ name: 'done', type: 'boolean', default: false, not_null: true });

    expect((await t.admin('GET', `${base}/todos`)).json.name).toBe('todos');
    expect((await t.admin('GET', base)).json.tables.map((x: { name: string }) => x.name)).toEqual(['todos']);

    const altered = await t.admin('PATCH', `${base}/todos`, {
      add_columns: [{ name: 'note', type: 'text' }],
      rename_to: 'tasks',
    });
    expect(altered.status).toBe(200);
    expect(altered.json.name).toBe('tasks');
    expect(altered.json.columns.map((c: { name: string }) => c.name)).toContain('note');
    expect((await t.admin('GET', `${base}/todos`)).status).toBe(404);

    expect((await t.admin('DELETE', `${base}/tasks`)).status).toBe(204);
    expect((await t.admin('GET', base)).json.tables).toEqual([]);
  });

  it('answers 409 for a duplicate table and 404 for a missing one', async () => {
    const p = await t.createProject();
    const base = `/projects/${p.id}/tables`;
    await t.admin('POST', base, todos);
    const dup = await t.admin('POST', base, todos);
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe('table_exists');
    expect((await t.admin('DELETE', `${base}/nope`)).status).toBe(404);
    expect((await t.admin('PATCH', `${base}/nope`, { drop_columns: ['x'] })).status).toBe(404);
  });

  it('rejects SQL-injection style and reserved names with 400', async () => {
    const p = await t.createProject();
    const base = `/projects/${p.id}/tables`;
    const bad = [
      'todos; DROP TABLE _meta',
      'todos"',
      "todos'--",
      '_meta',
      '_migrations',
      'sqlite_master',
      'sqlite_sequence',
      'Todos',
      '',
      'a b',
    ];
    for (const name of bad) {
      const res = await t.admin('POST', base, { ...todos, name });
      expect(res.status, name).toBe(400);
    }
    const badCol = await t.admin('POST', base, { ...todos, columns: [{ name: 'id"; DROP TABLE x;--', type: 'integer', primary_key: true }] });
    expect(badCol.status).toBe(400);
    expect((await t.admin('GET', base)).json.tables).toEqual([]);
  });

  it('cannot read, alter or drop internal tables by name', async () => {
    const p = await t.createProject();
    const base = `/projects/${p.id}/tables`;
    for (const name of ['_meta', '_migrations', 'sqlite_master']) {
      expect((await t.admin('GET', `${base}/${name}`)).status, name).toBe(404);
      expect((await t.admin('PATCH', `${base}/${name}`, { rename_to: 'stolen' })).status, name).toBe(404);
      expect((await t.admin('DELETE', `${base}/${name}`)).status, name).toBe(404);
    }
    // project database still healthy
    expect((await t.admin('POST', base, todos)).status).toBe(201);
  });

  it('reports engine-level alter failures as 422 without internals', async () => {
    const p = await t.createProject();
    const base = `/projects/${p.id}/tables`;
    await t.admin('POST', base, todos);
    const res = await t.admin('PATCH', `${base}/todos`, { drop_columns: ['id'] });
    expect(res.status).toBe(422);
    expect(res.json.error.code).toBe('column_in_use');
  });

  it('isolates projects completely', async () => {
    const a = await t.createProject('a');
    const b = await t.createProject('b');
    await t.admin('POST', `/projects/${a.id}/tables`, todos);

    expect((await t.admin('GET', `/projects/${b.id}/tables`)).json.tables).toEqual([]);
    expect((await t.admin('GET', `/projects/${b.id}/tables/todos`)).status).toBe(404);
    // same table name can exist independently in both
    expect((await t.admin('POST', `/projects/${b.id}/tables`, todos)).status).toBe(201);
    await t.admin('DELETE', `/projects/${a.id}/tables/todos`);
    expect((await t.admin('GET', `/projects/${b.id}/tables/todos`)).status).toBe(200);

    expect(await exists(join(t.dataDir, 'projects', a.id, 'db.sqlite'))).toBe(true);
    expect(await exists(join(t.dataDir, 'projects', b.id, 'db.sqlite'))).toBe(true);
  });

  it('keeps table data when other projects are deleted', async () => {
    const a = await t.createProject('a');
    const b = await t.createProject('b');
    await t.admin('POST', `/projects/${b.id}/tables`, todos);
    await t.admin('DELETE', `/projects/${a.id}?confirm=a`);
    expect((await t.admin('GET', `/projects/${b.id}/tables/todos`)).status).toBe(200);
  });
});

describe('http hardening', () => {
  it('answers unknown routes with a JSON 404', async () => {
    const res = await t.call('GET', '/nope');
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe('not_found');
  });

  it('sets security headers', async () => {
    const res = await t.call('GET', '/health');
    expect(res.json).toEqual({ status: 'ok' });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('rejects oversized bodies with 413', async () => {
    const res = await t.admin('POST', '/projects', { name: 'x'.repeat(200_000) });
    expect(res.status).toBe(413);
    expect(res.json.error.code).toBe('payload_too_large');
  });

  it('turns unexpected failures into a generic 500 without leaking internals', async () => {
    const p = await t.createProject();
    await t.registry.close(); // every database call now throws a driver error
    const res = await t.admin('GET', `/projects/${p.id}`);
    expect(res.status).toBe(500);
    expect(res.json.error.code).toBe('internal_error');
    expect(res.json.error.request_id).toBeTruthy();
    expect(res.text).not.toMatch(/sqlite|database|connection|\.js|\.ts|node_modules|sbb-test/i);
  });
});

describe('CORS', () => {
  it('is off by default', async () => {
    const res = await t.call('GET', '/health', { headers: { origin: 'https://evil.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows only configured origins on data routes, and never on /admin', async () => {
    const cors = await makeTestApp({ corsOrigins: ['https://app.example'] });
    try {
      const allowed = await cors.call('OPTIONS', '/whoami', {
        headers: { origin: 'https://app.example', 'access-control-request-method': 'GET', 'access-control-request-headers': 'apikey' },
      });
      expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example');
      expect(allowed.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('apikey');

      const denied = await cors.call('GET', '/health', { headers: { origin: 'https://evil.example' } });
      expect(denied.headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
      expect(denied.headers.get('access-control-allow-origin')).not.toBe('*');

      const admin = await cors.admin('GET', '/projects');
      expect(admin.status).toBe(200);
      const adminWithOrigin = await cors.call('GET', '/admin/projects', {
        headers: { origin: 'https://app.example', authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(adminWithOrigin.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await cors.close();
    }
  });
});
