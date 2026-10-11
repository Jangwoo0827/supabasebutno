import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, errors, jwtVerify } from 'jose';
import { deriveSecret } from '../keys.js';

const ISSUER = 'supabasebutno';
/** Bump to invalidate every user session of every project at once (not exposed as a setting). */
const USER_KEY_VERSION = 1;

export interface AccessClaims {
  userId: string;
  email: string;
  /** Session (login) this token belongs to; checked against the database on every request. */
  sessionId: string;
}

export async function signAccessToken(
  masterSecret: string,
  projectId: string,
  claims: AccessClaims,
  ttlSeconds: number,
  nowSeconds: number,
): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = nowSeconds + ttlSeconds;
  const token = await new SignJWT({ role: 'authenticated', ref: projectId, email: claims.email, sid: claims.sessionId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setSubject(claims.userId)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(expiresAt)
    .sign(deriveSecret(masterSecret, projectId, 'user', USER_KEY_VERSION));
  return { token, expiresAt };
}

export type AccessVerification = ({ ok: true } & AccessClaims) | { ok: false; reason: 'expired' | 'invalid' };

/** Verifies signature, expiry and that the token belongs to `projectId`. Does NOT check the session row. */
export async function verifyAccessToken(
  masterSecret: string,
  projectId: string,
  token: string,
  nowMs: number = Date.now(),
): Promise<AccessVerification> {
  try {
    const { payload } = await jwtVerify(token, deriveSecret(masterSecret, projectId, 'user', USER_KEY_VERSION), {
      algorithms: ['HS256'],
      issuer: ISSUER,
      clockTolerance: 5,
      currentDate: new Date(nowMs),
    });
    if (payload.role !== 'authenticated' || payload.ref !== projectId) return { ok: false, reason: 'invalid' };
    const { sub, sid, email } = payload;
    if (typeof sub !== 'string' || typeof sid !== 'string' || typeof email !== 'string') return { ok: false, reason: 'invalid' };
    return { ok: true, userId: sub, sessionId: sid, email };
  } catch (err) {
    return { ok: false, reason: err instanceof errors.JWTExpired ? 'expired' : 'invalid' };
  }
}

/** Refresh tokens are 256 random bits; only their SHA-256 is stored, so a database leak does not leak sessions. */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export function newOpaqueToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}
