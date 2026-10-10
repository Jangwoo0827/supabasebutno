import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import type { ProjectRecord } from '../src/db/registry.js';
import { deriveSecret, issueApiKeys, verifyApiKey } from '../src/keys.js';

const MASTER = 'm'.repeat(40);
const projectA: ProjectRecord = { id: 'aaaaaaaaaaaaaaaa', name: 'A', key_version: 1, keys_issued_at: 1_700_000_000, created_at: '' };
const projectB: ProjectRecord = { id: 'bbbbbbbbbbbbbbbb', name: 'B', key_version: 1, keys_issued_at: 1_700_000_000, created_at: '' };

const store = new Map<string, ProjectRecord>([
  [projectA.id, projectA],
  [projectB.id, projectB],
]);
const lookup = async (id: string) => store.get(id);
const verify = (token: string, master = MASTER, get = lookup) => verifyApiKey(master, token, get);

/** Signs an arbitrary payload with project A's real secret, for forgery attempts. */
const forge = (claims: Record<string, unknown>, alg = 'HS256', project = projectA) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg })
    .setIssuer('supabasebutno')
    .sign(deriveSecret(MASTER, project.id, 'apikey', project.key_version));

describe('API keys', () => {
  it('issues keys that verify with the right role and project', async () => {
    const keys = await issueApiKeys(MASTER, projectA);
    expect(await verify(keys.anon)).toMatchObject({ role: 'anon', project: { id: projectA.id } });
    expect(await verify(keys.service_role)).toMatchObject({ role: 'service_role', project: { id: projectA.id } });
  });

  it('is deterministic, so keys can be shown again later', async () => {
    expect(await issueApiKeys(MASTER, projectA)).toEqual(await issueApiKeys(MASTER, projectA));
  });

  it('gives each project distinct secrets and keys', async () => {
    expect(deriveSecret(MASTER, projectA.id, 'apikey', 1)).not.toEqual(deriveSecret(MASTER, projectB.id, 'apikey', 1));
    expect((await issueApiKeys(MASTER, projectA)).anon).not.toBe((await issueApiKeys(MASTER, projectB)).anon);
  });

  it('rejects a key whose ref was changed to another project (signature no longer matches)', async () => {
    const forged = await forge({ role: 'service_role', ref: projectB.id, kv: 1 }); // signed with A's secret
    expect(await verify(forged)).toBeNull();
  });

  it('rejects tampered tokens', async () => {
    const { anon } = await issueApiKeys(MASTER, projectA);
    const [h, p, s] = anon.split('.') as [string, string, string];
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    const escalated = Buffer.from(JSON.stringify({ ...payload, role: 'service_role' })).toString('base64url');
    expect(await verify(`${h}.${escalated}.${s}`)).toBeNull();
    expect(await verify(`${h}.${p}.${s.slice(0, -2)}xx`)).toBeNull();
  });

  it('rejects unsigned (alg: none) tokens', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ role: 'service_role', ref: projectA.id, kv: 1, iss: 'supabasebutno' })).toString('base64url');
    expect(await verify(`${header}.${body}.`)).toBeNull();
  });

  it('only accepts HS256, even if signed with the right secret', async () => {
    expect(await verify(await forge({ role: 'anon', ref: projectA.id, kv: 1 }, 'HS512'))).toBeNull();
    expect(await verify(await forge({ role: 'anon', ref: projectA.id, kv: 1 }, 'HS256'))).not.toBeNull();
  });

  it('rejects roles other than anon / service_role', async () => {
    expect(await verify(await forge({ role: 'authenticated', ref: projectA.id, kv: 1 }))).toBeNull();
    expect(await verify(await forge({ role: 'admin', ref: projectA.id, kv: 1 }))).toBeNull();
    expect(await verify(await forge({ ref: projectA.id, kv: 1 }))).toBeNull();
  });

  it('rejects keys from a rotated (older) key version', async () => {
    const old = await issueApiKeys(MASTER, projectA);
    const rotated = { ...projectA, key_version: 2, keys_issued_at: projectA.keys_issued_at + 10 };
    const get = async (id: string) => (id === projectA.id ? rotated : undefined);
    expect(await verify(old.anon, MASTER, get)).toBeNull();
    const fresh = await issueApiKeys(MASTER, rotated);
    expect(await verify(fresh.anon, MASTER, get)).toMatchObject({ role: 'anon' });
  });

  it('rejects keys for unknown (e.g. deleted) projects and a wrong master secret', async () => {
    const { anon } = await issueApiKeys(MASTER, projectA);
    expect(await verify(anon, MASTER, async () => undefined)).toBeNull();
    expect(await verify(anon, 'x'.repeat(40))).toBeNull();
  });

  it('rejects malformed input without throwing', async () => {
    for (const bad of ['', 'abc', 'a.b.c', '....', 'Bearer x', ' ']) {
      expect(await verify(bad)).toBeNull();
    }
    // ref that tries to be a path
    expect(await verify(await forge({ role: 'anon', ref: '../../etc', kv: 1 }))).toBeNull();
  });
});
