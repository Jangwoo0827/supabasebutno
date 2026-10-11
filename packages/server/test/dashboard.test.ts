import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, makeTestApp } from './helpers.js';

type TestApp = Awaited<ReturnType<typeof makeTestApp>>;
let t: TestApp;
const PASSWORD = 'correct horse battery';

beforeEach(async () => {
  t = await makeTestApp();
});
afterEach(async () => {
  await t.close();
});

/** Request as the dashboard's own page would send it (cookie + custom header + same Origin). */
function dash(cookie: string | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { host: 'localhost', origin: 'http://localhost', 'x-sbb-csrf': '1', ...extra };
  if (cookie) headers.cookie = cookie;
  return t.call(method, path.startsWith('/admin') ? path : `/admin${path}`, { body, headers });
}
async function login(extra: Record<string, string> = {}) {
  const res = await dash(null, 'POST', '/admin/login', { token: ADMIN_TOKEN }, extra);
  const set = res.headers.get('set-cookie') ?? '';
  return { res, set, cookie: /sbb_admin=[^;]+/.exec(set)?.[0] ?? '' };
}

describe('static files', () => {
  it('serves the app with a strict content security policy', async () => {
    const res = await t.call('GET', '/dashboard/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const csp = res.headers.get('content-security-policy')!;
    for (const part of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "connect-src 'self'"]) expect(csp).toContain(part);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.text).toContain('<div id="app">');
  });

  it('serves scripts and styles with proper types, and redirects /dashboard to /dashboard/', async () => {
    expect((await t.call('GET', '/dashboard/js/main.js')).headers.get('content-type')).toContain('text/javascript');
    expect((await t.call('GET', '/dashboard/style.css')).headers.get('content-type')).toContain('text/css');
    expect((await t.call('GET', '/dashboard/js/views/tables.js')).status).toBe(200);
    const redirect = await t.app.request('/dashboard');
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('/dashboard/');
  });

  it('serves only the files that exist in the dashboard directory', async () => {
    for (const path of ['/dashboard/nope.js', '/dashboard/../../package.json', '/dashboard/%2e%2e/%2e%2e/package.json', '/dashboard/js/', '/dashboard/js', '/dashboard/..%2f..%2fREADME.md', '/dashboard//etc/passwd']) {
      const res = await t.call('GET', path);
      expect(res.status, path).toBe(404);
      expect(res.text, path).not.toContain('"workspaces"');
    }
  });

  it('requires no login for the static files, but the API behind them needs one', async () => {
    expect((await t.call('GET', '/dashboard/')).status).toBe(200);
    expect((await t.call('GET', '/admin/projects')).status).toBe(401);
  });
});

describe('dashboard source safety', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dashboard', 'public');
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : files.push(join(dir, name)));
  })(root);
  const read = (f: string) => readFileSync(f, 'utf8');

  it('never turns data into markup or code', () => {
    expect(files.length).toBeGreaterThan(8);
    for (const f of files.filter((x) => x.endsWith('.js'))) {
      const code = read(f);
      for (const bad of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new\s+Function\b/, /setTimeout\s*\(\s*['"`]/, /javascript:/i, /dangerouslySet/, /\.srcdoc\b/]) {
        expect(code, `${f} contains ${bad}`).not.toMatch(bad);
      }
    }
  });

  it('has no inline script, inline style or inline event handler in the HTML', () => {
    const html = read(join(root, 'index.html'));
    const tags = html.match(/<script\b[^>]*>/g)!;
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.every((tag) => /\bsrc=/.test(tag))).toBe(true);
    expect(html.match(/<script\b[^>]*>\s*<\/script>/g)).toHaveLength(tags.length); // every script element is empty: no inline code
    expect(html).not.toMatch(/<style\b/);
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it('loads nothing from other origins', () => {
    for (const f of files) expect(read(f), f).not.toMatch(/(?:src|href)=["']https?:\/\//);
    for (const f of files.filter((x) => x.endsWith('.js'))) expect(read(f), f).not.toMatch(/import\s+[^;]*from\s+['"]https?:/);
    expect(read(join(root, 'style.css'))).not.toMatch(/url\(\s*['"]?https?:|@import/);
  });
});

describe('logging in', () => {
  it('issues a session cookie that is HttpOnly, SameSite=Strict and limited to /admin', async () => {
    const { res, set } = await login();
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    expect(set).toMatch(/^sbb_admin=/);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Strict/i);
    expect(set).toMatch(/Path=\/admin/);
    expect(set).toMatch(/Max-Age=28800/);
    expect(set).not.toMatch(/;\s*Secure/i); // plain http in tests
    expect(set).not.toContain(ADMIN_TOKEN); // the cookie is a session, not the token itself
    expect(res.text).not.toContain(ADMIN_TOKEN);
  });

  it('marks the cookie Secure behind an HTTPS proxy, but only when a proxy is trusted', async () => {
    const proxied = await makeTestApp({ trustProxyHops: 1 });
    try {
      const res = await proxied.call('POST', '/admin/login', { body: { token: ADMIN_TOKEN }, headers: { host: 'a.test', origin: 'https://a.test', 'x-sbb-csrf': '1', 'x-forwarded-proto': 'https', 'x-forwarded-for': '1.1.1.1' } });
      expect(res.headers.get('set-cookie')).toMatch(/;\s*Secure/i);
    } finally {
      await proxied.close();
    }
    const spoofed = await login({ 'x-forwarded-proto': 'https' });
    expect(spoofed.set).not.toMatch(/;\s*Secure/i); // untrusted header is ignored
  });

  it('refuses a wrong token without a cookie', async () => {
    const res = await dash(null, 'POST', '/admin/login', { token: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect((await dash(null, 'POST', '/admin/login', {})).status).toBe(400);
  });

  it('blocks guessing: ten wrong tokens lock the client out, even for the right token', async () => {
    for (let i = 0; i < 10; i++) expect((await dash(null, 'POST', '/admin/login', { token: `wrong-${i}` })).status).toBe(401);
    const blocked = await dash(null, 'POST', '/admin/login', { token: ADMIN_TOKEN });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('set-cookie')).toBeNull();
  });

  it('cannot be triggered from another site (login CSRF)', async () => {
    expect((await dash(null, 'POST', '/admin/login', { token: ADMIN_TOKEN }, { 'x-sbb-csrf': '' })).status).toBe(403);
    expect((await dash(null, 'POST', '/admin/login', { token: ADMIN_TOKEN }, { origin: 'https://evil.example' })).status).toBe(403);
  });

  it('accepts the session for API calls', async () => {
    const { cookie } = await login();
    expect((await dash(cookie, 'GET', '/projects')).status).toBe(200);
    expect((await dash(cookie, 'GET', '/session')).json).toEqual({ authenticated: true });
    expect((await t.call('GET', '/admin/session')).status).toBe(401); // without it: not logged in
  });

  it('does not count a visit without credentials as a failed attempt', async () => {
    for (let i = 0; i < 15; i++) expect((await t.call('GET', '/admin/session')).status).toBe(401);
    expect((await login()).res.status).toBe(200);
  });
});

describe('protection of cookie sessions against forged requests', () => {
  it('requires the dashboard header and a matching Origin for anything that changes data', async () => {
    const { cookie } = await login();
    const create = (extra: Record<string, string>, name: string) => dash(cookie, 'POST', '/projects', { name }, extra);

    expect((await create({ 'x-sbb-csrf': '' }, 'a')).status).toBe(403);
    expect((await create({ origin: 'https://evil.example' }, 'b')).status).toBe(403);
    expect((await create({ origin: 'null' }, 'c')).status).toBe(403);
    expect((await create({ origin: 'not a url' }, 'd')).status).toBe(403);
    expect((await create({ host: 'other.test' }, 'e')).status).toBe(403); // Origin and Host disagree
    const forbidden = await create({ 'x-sbb-csrf': '' }, 'f');
    expect(forbidden.json.error.code).toBe('csrf_rejected');
    expect((await dash(cookie, 'GET', '/projects')).json.projects).toEqual([]); // none of them took effect

    expect((await create({}, 'real')).status).toBe(201);
  });

  it('allows reads without the header (they change nothing)', async () => {
    const { cookie } = await login();
    const res = await t.call('GET', '/admin/projects', { headers: { cookie, host: 'localhost', origin: 'https://evil.example' } });
    expect(res.status).toBe(200);
  });

  it('does not apply to Bearer-token callers (scripts, curl): no cookie, nothing to forge', async () => {
    expect((await t.admin('POST', '/projects', { name: 'scripted' })).status).toBe(201);
  });

  it('is not reachable from other sites through CORS', async () => {
    const pre = await t.call('OPTIONS', '/admin/projects', { headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-sbb-csrf' } });
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('ending a session', () => {
  it('logout clears the cookie and also revokes the session on the server', async () => {
    const { cookie } = await login();
    const out = await dash(cookie, 'POST', '/admin/logout');
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toMatch(/sbb_admin=;|sbb_admin=\s*;|Max-Age=0/i);

    // someone who copied the cookie earlier gains nothing
    const replay = await dash(cookie, 'GET', '/projects');
    expect(replay.status).toBe(401);
    expect(replay.json.error.code).toBe('session_expired');
  });

  it('sessions expire after eight hours', async () => {
    const { cookie } = await login();
    t.clock.advanceSeconds(8 * 3600 - 60);
    expect((await dash(cookie, 'GET', '/projects')).status).toBe(200);
    t.clock.advanceSeconds(120);
    expect((await dash(cookie, 'GET', '/projects')).json.error.code).toBe('session_expired');
  });

  it('rejects tampered or foreign cookies', async () => {
    const { cookie } = await login();
    const value = cookie.split('=')[1]!;
    const [h, p, s] = value.split('.') as [string, string, string];
    for (const bad of [`sbb_admin=${h}.${p}.${s.slice(0, -3)}abc`, `sbb_admin=${h}.${Buffer.from('{"role":"admin","jti":"x","exp":9999999999}').toString('base64url')}.${s}`, 'sbb_admin=garbage', 'sbb_admin=']) {
      expect((await dash(bad, 'GET', '/projects')).status, bad.slice(0, 40)).toBe(401);
    }
    const other = await makeTestApp({ jwtMasterSecret: 'another-master-secret-' + 'z'.repeat(32) });
    try {
      const foreign = await other.call('POST', '/admin/login', { body: { token: ADMIN_TOKEN }, headers: { host: 'localhost', 'x-sbb-csrf': '1' } });
      const foreignCookie = /sbb_admin=[^;]+/.exec(foreign.headers.get('set-cookie') ?? '')![0];
      expect((await dash(foreignCookie, 'GET', '/projects')).status).toBe(401); // signed with a different server secret
    } finally {
      await other.close();
    }
  });

  it('a project key or a user token is not an admin session', async () => {
    const p = await t.createProject('p');
    expect((await dash(`sbb_admin=${p.keys.service_role}`, 'GET', '/projects')).status).toBe(401);
  });
});

describe('managing users', () => {
  let project: Awaited<ReturnType<TestApp['createProject']>>;
  const signup = (email: string) => t.call('POST', '/auth/signup', { body: { email, password: PASSWORD, data: { name: email.split('@')[0] } }, headers: { apikey: project.keys.anon } });
  beforeEach(async () => {
    project = await t.createProject('people');
  });

  it('lists users newest first with their session count, and never exposes password hashes', async () => {
    for (const n of ['a', 'b', 'c']) await signup(`${n}@example.com`);
    const res = await t.admin('GET', `/projects/${project.id}/users`);
    expect(res.status).toBe(200);
    expect(res.json.total).toBe(3);
    expect(res.json.users).toHaveLength(3);
    expect(res.json.users[0]).toMatchObject({ email: expect.stringMatching(/@example\.com$/), user_metadata: { name: expect.any(String) }, active_sessions: 1 });
    expect(res.text).not.toMatch(/password|argon2/i);
  });

  it('pages', async () => {
    for (const n of ['a', 'b', 'c']) await signup(`${n}@example.com`);
    const page = await t.admin('GET', `/projects/${project.id}/users?limit=2&offset=2`);
    expect(page.json.users).toHaveLength(1);
    expect(page.json.total).toBe(3);
    expect((await t.admin('GET', `/projects/${project.id}/users?limit=-5&offset=abc`)).status).toBe(200);
  });

  it('deleting a user ends their sessions immediately', async () => {
    const s = await signup('gone@example.com');
    const id = s.json.user.id;
    const token = s.json.access_token;
    expect((await t.admin('DELETE', `/projects/${project.id}/users/${id}`)).status).toBe(204);
    expect((await t.call('GET', '/auth/user', { headers: { apikey: project.keys.anon, authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await t.admin('GET', `/projects/${project.id}/users`)).json.total).toBe(0);
    expect((await t.admin('DELETE', `/projects/${project.id}/users/${id}`)).status).toBe(404);
  });

  it('can sign a user out of every device without deleting them', async () => {
    const s = await signup('kick@example.com');
    expect((await t.admin('POST', `/projects/${project.id}/users/${s.json.user.id}/sign-out`)).status).toBe(204);
    expect((await t.call('GET', '/auth/user', { headers: { apikey: project.keys.anon, authorization: `Bearer ${s.json.access_token}` } })).status).toBe(401);
    expect((await t.call('POST', '/auth/login', { body: { email: 'kick@example.com', password: PASSWORD }, headers: { apikey: project.keys.anon } })).status).toBe(200);
    expect((await t.admin('POST', `/projects/${project.id}/users/no-such-id/sign-out`)).status).toBe(404);
  });

  it('is admin-only, and scoped to one project', async () => {
    await signup('a@example.com');
    expect((await t.admin('GET', `/projects/${project.id}/users`, undefined, null)).status).toBe(401);
    const other = await t.createProject('other');
    expect((await t.admin('GET', `/projects/${other.id}/users`)).json.total).toBe(0);
    expect((await t.admin('GET', '/projects/aaaaaaaaaaaaaaaa/users')).status).toBe(404);
  });
});

describe('row editor (REST as service_role)', () => {
  it('reads and writes any table regardless of policies', async () => {
    const p = await t.createProject('rows');
    await t.admin('POST', `/projects/${p.id}/tables`, { name: 'notes', columns: [{ name: 'id', type: 'integer', primary_key: true }, { name: 'body', type: 'text', not_null: true }] });
    const { cookie } = await login();
    expect((await dash(cookie, 'POST', `/projects/${p.id}/rest/notes`, { body: 'from dashboard' })).status).toBe(201);
    const list = await dash(cookie, 'GET', `/projects/${p.id}/rest/notes`);
    expect(list.json).toEqual([{ id: 1, body: 'from dashboard' }]);
    expect((await dash(cookie, 'PATCH', `/projects/${p.id}/rest/notes?id=eq.1`, { body: 'edited' })).status).toBe(204);
    expect((await dash(cookie, 'DELETE', `/projects/${p.id}/rest/notes?id=eq.1`)).status).toBe(204);
    // the same policy-free table stays closed to the public API
    expect((await t.call('GET', '/rest/notes', { headers: { apikey: p.keys.anon } })).status).toBe(403);
    // and the mount does not leak other projects' tables
    const q = await t.createProject('other');
    expect((await dash(cookie, 'GET', `/projects/${q.id}/rest/notes`)).status).toBe(404);
    expect((await t.admin('GET', `/projects/${p.id}/rest/notes`, undefined, null)).status).toBe(401);
  });
});
