import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import type { Config } from '../src/config.js';

export const ADMIN_TOKEN = 'test-admin-token-' + 'a'.repeat(32);
export const MASTER_SECRET = 'test-master-secret-' + 'b'.repeat(32);

export async function makeTestApp(overrides: Partial<Config> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'sbb-test-'));
  const config: Config = {
    port: 0,
    host: '127.0.0.1',
    dataDir,
    adminToken: ADMIN_TOKEN,
    jwtMasterSecret: MASTER_SECRET,
    corsOrigins: [],
    maxJsonBytes: 100_000,
    ...overrides,
  };
  const { app, registry } = await createApp(config);

  async function call(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...opts.headers };
    let body: string | undefined;
    if (opts.body !== undefined) {
      body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      headers['content-type'] ??= 'application/json';
    }
    const res = await app.request(path, { method, headers, body });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body */
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  /** Request to /admin with the admin token (unless `token` is overridden). */
  const admin = (method: string, path: string, body?: unknown, token: string | null = ADMIN_TOKEN) =>
    call(method, `/admin${path}`, { body, headers: token ? { authorization: `Bearer ${token}` } : {} });

  return {
    app,
    registry,
    config,
    dataDir,
    call,
    admin,
    async createProject(name = 'demo') {
      const res = await admin('POST', '/projects', { name });
      if (res.status !== 201) throw new Error(`createProject failed: ${res.status} ${res.text}`);
      return res.json as { id: string; name: string; keys: { anon: string; service_role: string } };
    },
    async close() {
      await registry.close().catch(() => undefined);
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
