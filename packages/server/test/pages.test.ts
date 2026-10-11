import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPages, contentSecurityPolicy, parseApiOrigin } from '../../../scripts/build-pages.mjs';
import { ConfigError, loadConfig } from '../src/config.js';
import { ADMIN_TOKEN, makeTestApp } from './helpers.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dashboard', 'public');
let out: string;
beforeEach(async () => {
  out = await mkdtemp(join(tmpdir(), 'sbb-pages-'));
});
afterEach(async () => {
  await rm(out, { recursive: true, force: true });
});

describe('parseApiOrigin', () => {
  it('accepts https origins (and http only for localhost), dropping path and trailing slash', () => {
    expect(parseApiOrigin('https://api.example.com')).toBe('https://api.example.com');
    expect(parseApiOrigin(' https://api.example.com:8443/some/path?x=1 ')).toBe('https://api.example.com:8443');
    expect(parseApiOrigin('http://localhost:8787')).toBe('http://localhost:8787');
    expect(parseApiOrigin('http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787');
  });

  it('rejects anything that could send the admin token somewhere unsafe or break out of the policy', () => {
    for (const bad of ['', 'api.example.com', 'http://api.example.com', 'ftp://x.example', 'https://user:pass@api.example.com', 'javascript:alert(1)', 'https://a.example"><script>alert(1)</script>', "https://a.example; script-src *"]) {
      expect(() => parseApiOrigin(bad), bad).toThrow();
    }
  });
});

describe('contentSecurityPolicy', () => {
  it('pins connect-src to the API origin and allows nothing inline', () => {
    const csp = contentSecurityPolicy('https://api.example.com');
    expect(csp).toContain("connect-src https://api.example.com;");
    for (const part of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "base-uri 'none'", "form-action 'none'"]) expect(csp).toContain(part);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
  });

  it('falls back to https and localhost when no address is configured', () => {
    expect(contentSecurityPolicy(null)).toContain('connect-src https: http://localhost:* http://127.0.0.1:*');
  });
});

describe('buildPages', () => {
  it('copies the dashboard and adds the remote-mode markers and a pinned CSP', async () => {
    const res = buildPages({ outDir: out, apiUrl: 'https://api.example.com/' });
    expect(res.apiOrigin).toBe('https://api.example.com');
    const html = await readFile(join(out, 'index.html'), 'utf8');
    expect(html).toMatch(/<meta http-equiv="Content-Security-Policy" content="[^"]*connect-src https:\/\/api\.example\.com;[^"]*" \/>/);
    expect(html).toContain('<meta name="sbb-mode" content="remote" />');
    expect(html).toContain('<meta name="sbb-api-url" content="https://api.example.com" />');
    // the CSP must come before any script so it governs everything that loads
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script'));
    expect(await readdir(out)).toContain('.nojekyll');
  });

  it('leaves every other file byte-identical and does not touch the source', async () => {
    const before = await readFile(join(PUBLIC, 'index.html'), 'utf8');
    buildPages({ outDir: out, apiUrl: 'https://api.example.com' });
    for (const rel of ['style.css', 'js/main.js', 'js/api.js', 'js/views/storage.js', 'favicon.svg']) {
      expect(await readFile(join(out, rel), 'utf8'), rel).toBe(await readFile(join(PUBLIC, rel), 'utf8'));
    }
    expect(await readFile(join(PUBLIC, 'index.html'), 'utf8')).toBe(before);
    expect(before).not.toContain('sbb-mode'); // the server-hosted page stays in same-origin (cookie) mode
  });

  it('without an address, builds the generic page that asks for one', async () => {
    const res = buildPages({ outDir: out });
    expect(res.apiOrigin).toBeNull();
    const html = await readFile(join(out, 'index.html'), 'utf8');
    expect(html).not.toContain('sbb-api-url');
    expect(html).toContain('connect-src https: http://localhost:*');
  });

  it('refuses a bad address instead of publishing a weak page', () => {
    expect(() => buildPages({ outDir: out, apiUrl: 'http://api.example.com' })).toThrow(/https/);
    expect(() => buildPages({ outDir: out, apiUrl: 'https://a.example"><script>x</script>' })).toThrow();
  });

  it('still has no inline script, style or handler after the injection', async () => {
    buildPages({ outDir: out, apiUrl: 'https://api.example.com' });
    const html = await readFile(join(out, 'index.html'), 'utf8');
    const tags = html.match(/<script\b[^>]*>/g)!;
    expect(tags.every((t) => /\bsrc=/.test(t))).toBe(true);
    expect(html).not.toMatch(/<style\b|\sstyle=|\son[a-z]+=/i);
  });
});

describe('ADMIN_CORS_ORIGINS', () => {
  const base = { ADMIN_TOKEN: 'a'.repeat(32), JWT_MASTER_SECRET: 'b'.repeat(32) };

  it('is off by default and parses exact origins', () => {
    expect(loadConfig(base).adminCorsOrigins).toEqual([]);
    expect(loadConfig({ ...base, ADMIN_CORS_ORIGINS: 'https://me.github.io, http://localhost:5173' }).adminCorsOrigins).toEqual(['https://me.github.io', 'http://localhost:5173']);
  });

  it('refuses wildcards, paths, null and malformed values (this list opens the admin API)', () => {
    for (const bad of ['*', 'https://me.github.io/', 'https://me.github.io/dashboard', 'null', 'me.github.io', 'https://*.github.io', 'ftp://x.example']) {
      expect(() => loadConfig({ ...base, ADMIN_CORS_ORIGINS: bad }), bad).toThrow(ConfigError);
    }
  });
});

describe('admin API from another origin', () => {
  const PAGES = 'https://me.github.io';
  let t: Awaited<ReturnType<typeof makeTestApp>>;
  beforeEach(async () => {
    t = await makeTestApp({ adminCorsOrigins: [PAGES] });
  });
  afterEach(async () => {
    await t.close();
  });

  it('answers the preflight for the listed page only, without credentials', async () => {
    const ask = (origin: string) =>
      t.call('OPTIONS', '/admin/projects', { headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
    const ok = await ask(PAGES);
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(PAGES);
    expect(ok.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization');
    expect(ok.headers.get('access-control-allow-methods')).toContain('DELETE');
    expect(ok.headers.get('access-control-allow-credentials')).toBeNull(); // cookies are never part of this path

    for (const other of ['https://evil.example', 'https://me.github.io.evil.example', 'http://me.github.io', 'null']) {
      expect((await ask(other)).headers.get('access-control-allow-origin'), other).toBeNull();
    }
  });

  it('lets the listed page call the API with the Bearer token and read the answer', async () => {
    const res = await t.call('GET', '/admin/projects', { headers: { origin: PAGES, authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(PAGES);
    expect(res.headers.get('vary')?.toLowerCase()).toContain('origin');
    const created = await t.call('POST', '/admin/projects', { body: { name: 'from-pages' }, headers: { origin: PAGES, authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(created.status).toBe(201);
    expect(created.headers.get('access-control-allow-origin')).toBe(PAGES);
  });

  it('still refuses calls without the token, from any origin', async () => {
    const res = await t.call('GET', '/admin/projects', { headers: { origin: PAGES } });
    expect(res.status).toBe(401);
    const wrong = await t.call('GET', '/admin/projects', { headers: { origin: 'https://evil.example', authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('access-control-allow-origin')).toBeNull(); // a foreign page cannot even read the error
  });

  it('does not open the data APIs to that page, nor the dashboard cookie flow', async () => {
    const p = await t.createProject('p');
    const data = await t.call('GET', '/rest/anything', { headers: { origin: PAGES, apikey: p.keys.anon } });
    expect(data.headers.get('access-control-allow-origin')).toBeNull(); // data APIs follow CORS_ORIGINS, which is separate
    // the cookie login keeps requiring its own CSRF header, which a foreign Origin cannot satisfy
    const login = await t.call('POST', '/admin/login', { body: { token: ADMIN_TOKEN }, headers: { origin: PAGES, host: 'localhost', 'x-sbb-csrf': '1' } });
    expect(login.status).toBe(403);
  });

  it('is invisible when not configured', async () => {
    const plain = await makeTestApp();
    try {
      const res = await plain.call('OPTIONS', '/admin/projects', { headers: { origin: PAGES, 'access-control-request-method': 'GET' } });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      const get = await plain.call('GET', '/admin/projects', { headers: { origin: PAGES, authorization: `Bearer ${ADMIN_TOKEN}` } });
      expect(get.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await plain.close();
    }
  });
});
