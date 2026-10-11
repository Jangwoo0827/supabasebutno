import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../src/auth/passwords.js';
import { hashToken, newOpaqueToken, signAccessToken, verifyAccessToken } from '../src/auth/tokens.js';
import { RateLimiter } from '../src/core/rate-limit.js';
import { clientIp } from '../src/http/client-ip.js';
import { deriveSecret } from '../src/keys.js';

const MASTER = 'm'.repeat(40);
const claims = { userId: 'user-1', email: 'a@x.io', sessionId: 'sess-1' };
const NOW = 1_800_000_000; // seconds

describe('RateLimiter', () => {
  const make = (limit = 3, windowMs = 1000) => {
    let t = 10_000;
    const rl = new RateLimiter(limit, windowMs, () => t);
    return { rl, advance: (ms: number) => (t += ms) };
  };

  it('allows up to the limit, then refuses', () => {
    const { rl } = make();
    expect([rl.hit('k'), rl.hit('k'), rl.hit('k'), rl.hit('k')]).toEqual([true, true, true, false]);
    expect(rl.allowed('k')).toBe(false);
  });

  it('slides: old hits expire one by one', () => {
    const { rl, advance } = make();
    rl.hit('k');
    advance(400);
    rl.hit('k');
    advance(400);
    rl.hit('k');
    expect(rl.allowed('k')).toBe(false);
    advance(300); // first hit (t=0) is now 1100ms old
    expect(rl.count('k')).toBe(2);
    expect(rl.allowed('k')).toBe(true);
  });

  it('tracks keys independently and can reset one', () => {
    const { rl } = make(1);
    rl.hit('a');
    expect(rl.allowed('a')).toBe(false);
    expect(rl.allowed('b')).toBe(true);
    rl.reset('a');
    expect(rl.allowed('a')).toBe(true);
  });

  it('reports a sensible Retry-After', () => {
    const { rl, advance } = make(1, 10_000);
    rl.hit('k');
    advance(2500);
    expect(rl.retryAfterSeconds('k')).toBe(8);
    expect(rl.retryAfterSeconds('unknown')).toBe(0);
  });

  it('does not record refused hits (so a flood cannot extend its own lockout)', () => {
    const { rl, advance } = make(1, 1000);
    rl.hit('k');
    for (let i = 0; i < 50; i++) rl.hit('k');
    advance(1001);
    expect(rl.allowed('k')).toBe(true);
  });

  it('bounds memory when flooded with distinct keys', () => {
    let t = 0;
    const rl = new RateLimiter(5, 60_000, () => t, 100);
    for (let i = 0; i < 5000; i++) {
      t++;
      rl.hit(`key-${i}`);
    }
    let live = 0;
    for (let i = 0; i < 5000; i++) if (rl.count(`key-${i}`) > 0) live++;
    expect(live).toBeLessThan(1200); // swept in batches of 1000, never unbounded
  });
});

describe('clientIp', () => {
  const ctx = (xff?: string) => ({ req: { header: (n: string) => (n === 'x-forwarded-for' ? xff : undefined) } }) as never;

  it('ignores X-Forwarded-For entirely when no proxy is trusted', () => {
    expect(clientIp(ctx('6.6.6.6'), 0)).toBe('unknown'); // no socket in this fake context
  });

  it('takes the Nth entry from the right, never the attacker-controlled left side', () => {
    expect(clientIp(ctx('9.9.9.9'), 1)).toBe('9.9.9.9');
    expect(clientIp(ctx('6.6.6.6, 7.7.7.7, 9.9.9.9'), 1)).toBe('9.9.9.9');
    expect(clientIp(ctx('6.6.6.6, 7.7.7.7, 9.9.9.9'), 2)).toBe('7.7.7.7');
    expect(clientIp(ctx('9.9.9.9'), 3)).toBe('unknown'); // fewer entries than trusted hops: do not guess
  });
});

describe('passwords', () => {
  it('hashes with argon2id and verifies', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain('correct horse');
    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hash, 'Correct horse battery')).toBe(false);
  });

  it('uses a fresh salt every time', async () => {
    expect(await hashPassword('same-password')).not.toBe(await hashPassword('same-password'));
  });

  it('treats a malformed stored hash as a failed login, not a crash', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
    await expect(verifyAgainstDummy('anything')).resolves.toBeUndefined();
  });
});

describe('access tokens', () => {
  it('round-trips claims', async () => {
    const { token, expiresAt } = await signAccessToken(MASTER, 'projectaaaaaaaaa', claims, 900, NOW);
    expect(expiresAt).toBe(NOW + 900);
    expect(await verifyAccessToken(MASTER, 'projectaaaaaaaaa', token, NOW * 1000)).toEqual({ ok: true, ...claims, expiresAt: NOW + 900 });
  });

  it('expires', async () => {
    const { token } = await signAccessToken(MASTER, 'projectaaaaaaaaa', claims, 900, NOW);
    expect(await verifyAccessToken(MASTER, 'projectaaaaaaaaa', token, (NOW + 899) * 1000)).toMatchObject({ ok: true });
    expect(await verifyAccessToken(MASTER, 'projectaaaaaaaaa', token, (NOW + 906) * 1000)).toEqual({ ok: false, reason: 'expired' });
  });

  it('is bound to its project', async () => {
    const { token } = await signAccessToken(MASTER, 'projectaaaaaaaaa', claims, 900, NOW);
    expect(await verifyAccessToken(MASTER, 'projectbbbbbbbbb', token, NOW * 1000)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a wrong master secret, tampering, other algorithms and wrong roles', async () => {
    const { token } = await signAccessToken(MASTER, 'projectaaaaaaaaa', claims, 900, NOW);
    expect((await verifyAccessToken('x'.repeat(40), 'projectaaaaaaaaa', token, NOW * 1000)).ok).toBe(false);

    const [h, p, s] = token.split('.') as [string, string, string];
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...payload, sub: 'someone-else' })).toString('base64url');
    expect((await verifyAccessToken(MASTER, 'projectaaaaaaaaa', `${h}.${forged}.${s}`, NOW * 1000)).ok).toBe(false);

    const secret = deriveSecret(MASTER, 'projectaaaaaaaaa', 'user', 1);
    const sign = (alg: string, extra: Record<string, unknown>) =>
      new SignJWT({ role: 'authenticated', ref: 'projectaaaaaaaaa', email: 'a@x.io', sid: 's', ...extra })
        .setProtectedHeader({ alg })
        .setIssuer('supabasebutno')
        .setSubject('u')
        .setIssuedAt(NOW)
        .setExpirationTime(NOW + 900)
        .sign(secret);
    expect((await verifyAccessToken(MASTER, 'projectaaaaaaaaa', await sign('HS256', {}), NOW * 1000)).ok).toBe(true);
    expect((await verifyAccessToken(MASTER, 'projectaaaaaaaaa', await sign('HS512', {}), NOW * 1000)).ok).toBe(false);
    expect((await verifyAccessToken(MASTER, 'projectaaaaaaaaa', await sign('HS256', { role: 'service_role' }), NOW * 1000)).ok).toBe(false);
    expect((await verifyAccessToken(MASTER, 'projectaaaaaaaaa', await sign('HS256', { sid: undefined }), NOW * 1000)).ok).toBe(false);
  });

  it('an API key never verifies as a user token (separate key domains)', async () => {
    const apikeySecret = deriveSecret(MASTER, 'projectaaaaaaaaa', 'apikey', 1);
    const asUser = await new SignJWT({ role: 'authenticated', ref: 'projectaaaaaaaaa', email: 'a@x.io', sid: 's' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('supabasebutno')
      .setSubject('u')
      .setIssuedAt(NOW)
      .setExpirationTime(NOW + 900)
      .sign(apikeySecret);
    expect((await verifyAccessToken(MASTER, 'projectaaaaaaaaa', asUser, NOW * 1000)).ok).toBe(false);
  });

  it('rejects garbage without throwing', async () => {
    for (const bad of ['', 'abc', 'a.b.c', 'x'.repeat(5000)]) {
      expect(await verifyAccessToken(MASTER, 'projectaaaaaaaaa', bad, NOW * 1000)).toEqual({ ok: false, reason: 'invalid' });
    }
  });
});

describe('opaque tokens', () => {
  it('are random, long, and stored only as a hash', () => {
    const a = newOpaqueToken();
    const b = newOpaqueToken();
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(43);
    expect(a.hash).toBe(hashToken(a.token));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).not.toContain(a.token);
  });
});
