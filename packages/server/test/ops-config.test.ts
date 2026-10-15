import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { ADMIN_TOKEN, MASTER_SECRET, makeTestApp } from './helpers.js';

const BASE_ENV = { ADMIN_TOKEN, JWT_MASTER_SECRET: MASTER_SECRET };
type TestApp = Awaited<ReturnType<typeof makeTestApp>>;
const apps: TestApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
async function app(overrides: Parameters<typeof makeTestApp>[0] = {}) {
  const a = await makeTestApp(overrides);
  apps.push(a);
  return a;
}
const viaProxy = (ip: string) => ({ headers: { 'x-forwarded-for': ip, authorization: `Bearer ${ADMIN_TOKEN}` } });

describe('ADMIN_ALLOWED_IPS / SIGNUP_ENABLED config', () => {
  it('defaults: no IP restriction, sign-up on', () => {
    const c = loadConfig(BASE_ENV);
    expect(c.adminAllowedIps).toEqual([]);
    expect(c.signupEnabled).toBe(true);
  });

  it('parses a list of IPs and the sign-up switch', () => {
    const c = loadConfig({ ...BASE_ENV, ADMIN_ALLOWED_IPS: ' 203.0.113.10 ,::1', SIGNUP_ENABLED: 'false' });
    expect(c.adminAllowedIps).toEqual(['203.0.113.10', '::1']);
    expect(c.signupEnabled).toBe(false);
  });

  it('rejects things that are not single IPs and bad switch values', () => {
    expect(() => loadConfig({ ...BASE_ENV, ADMIN_ALLOWED_IPS: '10.0.0.0/8' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...BASE_ENV, ADMIN_ALLOWED_IPS: 'example.com' })).toThrow(/ADMIN_ALLOWED_IPS/);
    expect(() => loadConfig({ ...BASE_ENV, SIGNUP_ENABLED: 'no' })).toThrow(ConfigError);
  });
});

describe('admin IP allowlist', () => {
  it('without a list the admin API is reachable (unchanged behaviour)', async () => {
    const t = await app();
    expect((await t.admin('GET', '/projects')).status).toBe(200);
  });

  it('behind one proxy the real client IP decides; other IPs get a plain 404, even with the right token', async () => {
    const t = await app({ adminAllowedIps: ['203.0.113.10'], trustProxyHops: 1 });
    expect((await t.call('GET', '/admin/projects', viaProxy('203.0.113.10'))).status).toBe(200);
    const stranger = await t.call('GET', '/admin/projects', viaProxy('198.51.100.7'));
    expect(stranger.status).toBe(404);
    expect(stranger.json).toMatchObject({ error: { code: 'not_found' } });
    expect((await t.call('GET', '/dashboard/', { headers: { 'x-forwarded-for': '198.51.100.7' } })).status).toBe(404);
    expect((await t.call('GET', '/dashboard/', { headers: { 'x-forwarded-for': '203.0.113.10' } })).status).not.toBe(404);
  });

  it('a spoofed X-Forwarded-For prefix does not get in (only the proxy-appended entry counts)', async () => {
    const t = await app({ adminAllowedIps: ['203.0.113.10'], trustProxyHops: 1 });
    expect((await t.call('GET', '/admin/projects', viaProxy('203.0.113.10, 198.51.100.7'))).status).toBe(404);
  });

  it('data APIs and /health are not affected by the list', async () => {
    const t = await app({ adminAllowedIps: ['203.0.113.10'], trustProxyHops: 1 });
    expect((await t.call('GET', '/health', { headers: { 'x-forwarded-for': '198.51.100.7' } })).status).toBe(200);
  });
});

describe('sign-up switch', () => {
  const signup = (t: TestApp, key: string) =>
    t.call('POST', '/auth/signup', { body: { email: 'a@example.com', password: 'correct horse battery' }, headers: { apikey: key } });

  it('SIGNUP_ENABLED=false answers 403 signup_disabled', async () => {
    const t = await app({ signupEnabled: false });
    const p = await t.createProject('p1');
    const res = await signup(t, p.keys.anon);
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ error: { code: 'signup_disabled' } });
  });

  it('is on by default and an existing user can still log in after it is switched off', async () => {
    const t = await app();
    const p = await t.createProject('p2');
    expect((await signup(t, p.keys.anon)).status).toBe(201);
    t.config.signupEnabled = false; // the app reads the config object per request
    expect((await signup(t, p.keys.anon)).status).toBe(403);
    const login = await t.call('POST', '/auth/login', { body: { email: 'a@example.com', password: 'correct horse battery' }, headers: { apikey: p.keys.anon } });
    expect(login.status).toBe(200);
  });
});
