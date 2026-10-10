import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const good = { ADMIN_TOKEN: 'a'.repeat(32), JWT_MASTER_SECRET: 'b'.repeat(32) };

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const c = loadConfig(good);
    expect(c).toMatchObject({ port: 8787, host: '127.0.0.1', corsOrigins: [], maxJsonBytes: 1_048_576 });
    expect(c.dataDir).toMatch(/data$/);
  });

  it('requires both secrets, with a minimum length', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ ...good, ADMIN_TOKEN: 'short' })).toThrow(/ADMIN_TOKEN/);
    expect(() => loadConfig({ ...good, JWT_MASTER_SECRET: 'short' })).toThrow(/JWT_MASTER_SECRET/);
  });

  it('refuses to reuse one value for both secrets', () => {
    const same = 'z'.repeat(40);
    expect(() => loadConfig({ ADMIN_TOKEN: same, JWT_MASTER_SECRET: same })).toThrow(/differ/);
  });

  it('never echoes secret values in the error', () => {
    const secret = 'topsecret'.repeat(2); // too short on purpose
    try {
      loadConfig({ ADMIN_TOKEN: secret, JWT_MASTER_SECRET: good.JWT_MASTER_SECRET });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
  });

  it('parses CORS origins', () => {
    expect(loadConfig({ ...good, CORS_ORIGINS: 'https://a.example, https://b.example ,' }).corsOrigins).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
    expect(loadConfig({ ...good, CORS_ORIGINS: '*' }).corsOrigins).toBe('any');
    expect(loadConfig({ ...good, CORS_ORIGINS: '' }).corsOrigins).toEqual([]);
  });

  it('validates port and body limit', () => {
    expect(() => loadConfig({ ...good, PORT: '0' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...good, PORT: '99999' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...good, MAX_JSON_BYTES: '-1' })).toThrow(/MAX_JSON_BYTES/);
    expect(loadConfig({ ...good, PORT: '3000' }).port).toBe(3000);
  });
});
