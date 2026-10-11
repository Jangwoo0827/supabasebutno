import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { deriveSecret } from '../keys.js';

export const ADMIN_COOKIE = 'sbb_admin';
export const ADMIN_SESSION_SECONDS = 8 * 60 * 60;

/**
 * Dashboard login sessions. The browser never holds the admin token: after one successful
 * login it gets a signed, expiring session cookie instead. Logging out revokes the session on
 * the server, so a copied cookie stops working too (the revocation list lives in memory and
 * is only needed until the session would have expired anyway).
 */
export class AdminSessions {
  private readonly revoked = new Map<string, number>(); // jti -> expiry (unix seconds)
  private readonly secret: Uint8Array;

  constructor(
    masterSecret: string,
    private readonly now: () => number,
  ) {
    this.secret = deriveSecret(masterSecret, 'admin-dashboard', 'admin', 1);
  }

  async issue(): Promise<string> {
    const nowSec = Math.floor(this.now() / 1000);
    return new SignJWT({ role: 'admin' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('supabasebutno-admin')
      .setJti(randomUUID())
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + ADMIN_SESSION_SECONDS)
      .sign(this.secret);
  }

  /** The session id if the cookie value is a valid, unexpired, unrevoked session; otherwise null. */
  async verify(token: string): Promise<string | null> {
    try {
      const { payload } = await jwtVerify(token, this.secret, { algorithms: ['HS256'], issuer: 'supabasebutno-admin', currentDate: new Date(this.now()) });
      if (payload.role !== 'admin' || typeof payload.jti !== 'string' || this.revoked.has(payload.jti)) return null;
      return payload.jti;
    } catch {
      return null;
    }
  }

  async revoke(token: string): Promise<void> {
    try {
      const { payload } = await jwtVerify(token, this.secret, { algorithms: ['HS256'], issuer: 'supabasebutno-admin', currentDate: new Date(this.now()) });
      if (typeof payload.jti === 'string') this.revoked.set(payload.jti, payload.exp ?? 0);
    } catch {
      /* already invalid: nothing to revoke */
    }
    const nowSec = Math.floor(this.now() / 1000);
    for (const [jti, exp] of this.revoked) if (exp < nowSec) this.revoked.delete(jti);
  }
}
