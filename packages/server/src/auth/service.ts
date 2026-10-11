import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { AppError, badRequest, conflict, unauthorized } from '../core/errors.js';
import type { Database } from '../db/driver.js';
import type { Mailer } from './mailer.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './passwords.js';
import { hashToken, newOpaqueToken, signAccessToken } from './tokens.js';

/** Everything the auth operations need for one request to one project. */
export interface AuthEnv {
  db: Database;
  projectId: string;
  projectName: string;
  config: Config;
  mailer: Mailer;
  /** Current time in ms (injectable for tests). */
  now: () => number;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  user_metadata: string;
  created_at: string;
  updated_at: string;
  last_sign_in_at: string | null;
}

export interface UserDto {
  id: string;
  email: string;
  user_metadata: Record<string, unknown>;
  created_at: string;
  last_sign_in_at: string | null;
}

export interface SessionDto {
  access_token: string;
  token_type: 'bearer';
  /** Seconds until the access token expires. */
  expires_in: number;
  /** Unix time (seconds) at which the access token expires. */
  expires_at: number;
  refresh_token: string;
  user: UserDto;
}

const RECOVERY_TTL_MS = 60 * 60 * 1000;
/** A just-rotated refresh token may be presented again within this window (two tabs refreshing at once). */
const REUSE_GRACE_MS = 10_000;
export const MAX_METADATA_BYTES = 4096;

const iso = (ms: number) => new Date(ms).toISOString();

function toUser(row: UserRow): UserDto {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(row.user_metadata) as Record<string, unknown>;
  } catch {
    /* corrupted metadata: expose none rather than failing */
  }
  return { id: row.id, email: row.email, user_metadata: metadata, created_at: row.created_at, last_sign_in_at: row.last_sign_in_at };
}

const invalidCredentials = () => unauthorized('invalid_credentials', 'Invalid email or password');

async function issueRefreshToken(tx: Database, env: AuthEnv, sessionId: string): Promise<string> {
  const { token, hash } = newOpaqueToken();
  const now = env.now();
  await tx.run('INSERT INTO _auth_refresh_tokens (id, session_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', [
    randomUUID(),
    sessionId,
    hash,
    iso(now),
    iso(now + env.config.refreshTokenTtlDays * 86_400_000),
  ]);
  return token;
}

async function buildSession(env: AuthEnv, user: UserRow, sessionId: string, refreshToken: string): Promise<SessionDto> {
  const nowSec = Math.floor(env.now() / 1000);
  const { token, expiresAt } = await signAccessToken(
    env.config.jwtMasterSecret,
    env.projectId,
    { userId: user.id, email: user.email, sessionId },
    env.config.accessTokenTtlSeconds,
    nowSec,
  );
  return {
    access_token: token,
    token_type: 'bearer',
    expires_in: expiresAt - nowSec,
    expires_at: expiresAt,
    refresh_token: refreshToken,
    user: toUser(user),
  };
}

/** Starts a new login session. Also prunes expired tokens and dead sessions (housekeeping without a timer). */
async function createSession(tx: Database, env: AuthEnv, user: UserRow): Promise<SessionDto> {
  await tx.run('DELETE FROM _auth_refresh_tokens WHERE expires_at < ?', [iso(env.now())]);
  await tx.run('DELETE FROM _auth_sessions WHERE NOT EXISTS (SELECT 1 FROM _auth_refresh_tokens t WHERE t.session_id = _auth_sessions.id)');
  const sessionId = randomUUID();
  await tx.run('INSERT INTO _auth_sessions (id, user_id, created_at) VALUES (?, ?, ?)', [sessionId, user.id, iso(env.now())]);
  const refresh = await issueRefreshToken(tx, env, sessionId);
  return buildSession(env, user, sessionId, refresh);
}

export async function signUp(env: AuthEnv, input: { email: string; password: string; data?: Record<string, unknown> }): Promise<SessionDto> {
  const metadata = JSON.stringify(input.data ?? {});
  if (Buffer.byteLength(metadata) > MAX_METADATA_BYTES) throw badRequest('metadata_too_large', `data may be at most ${MAX_METADATA_BYTES} bytes`);

  const passwordHash = await hashPassword(input.password);
  const now = iso(env.now());
  const user: UserRow = {
    id: randomUUID(),
    email: input.email,
    password_hash: passwordHash,
    user_metadata: metadata,
    created_at: now,
    updated_at: now,
    last_sign_in_at: now,
  };
  return env.db.transaction(async (tx) => {
    try {
      await tx.run(
        'INSERT INTO _auth_users (id, email, password_hash, user_metadata, created_at, updated_at, last_sign_in_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [user.id, user.email, user.password_hash, user.user_metadata, user.created_at, user.updated_at, user.last_sign_in_at],
      );
    } catch (err) {
      if (tx.dialect.isUniqueViolation(err)) throw conflict('user_exists', 'A user with this email already exists');
      throw err;
    }
    return createSession(tx, env, user);
  });
}

export async function signIn(env: AuthEnv, input: { email: string; password: string }): Promise<SessionDto> {
  const user = await env.db.get<UserRow>('SELECT * FROM _auth_users WHERE email = ?', [input.email]);
  if (!user) {
    await verifyAgainstDummy(input.password); // same cost as a real check: no timing oracle for registered emails
    throw invalidCredentials();
  }
  if (!(await verifyPassword(user.password_hash, input.password))) throw invalidCredentials();

  return env.db.transaction(async (tx) => {
    const now = iso(env.now());
    await tx.run('UPDATE _auth_users SET last_sign_in_at = ? WHERE id = ?', [now, user.id]);
    return createSession(tx, env, { ...user, last_sign_in_at: now });
  });
}

/**
 * Exchanges a refresh token for a new session token pair (rotation).
 *
 * Presenting an already-rotated token after the grace window means it leaked (or the
 * client is broken): the whole session is revoked so neither party keeps access.
 */
export async function refresh(env: AuthEnv, refreshToken: string): Promise<SessionDto> {
  const hash = hashToken(refreshToken);
  const outcome = await env.db.transaction(async (tx) => {
    const row = await tx.get<{ id: string; session_id: string; expires_at: string; rotated_at: string | null; revoked_at: string | null; user_id: string }>(
      `SELECT rt.id, rt.session_id, rt.expires_at, rt.rotated_at, s.revoked_at, s.user_id
         FROM _auth_refresh_tokens rt JOIN _auth_sessions s ON s.id = rt.session_id
        WHERE rt.token_hash = ?`,
      [hash],
    );
    if (!row || row.revoked_at || row.expires_at <= iso(env.now())) return { kind: 'invalid' as const };

    if (row.rotated_at) {
      if (env.now() - Date.parse(row.rotated_at) > REUSE_GRACE_MS) {
        await tx.run('UPDATE _auth_sessions SET revoked_at = ? WHERE id = ?', [iso(env.now()), row.session_id]);
        return { kind: 'reused' as const }; // returned, not thrown: throwing would roll the revocation back
      }
    } else {
      await tx.run('UPDATE _auth_refresh_tokens SET rotated_at = ? WHERE id = ?', [iso(env.now()), row.id]);
    }

    const user = (await tx.get<UserRow>('SELECT * FROM _auth_users WHERE id = ?', [row.user_id]))!;
    const next = await issueRefreshToken(tx, env, row.session_id);
    return { kind: 'ok' as const, session: await buildSession(env, user, row.session_id, next) };
  });

  if (outcome.kind === 'ok') return outcome.session;
  if (outcome.kind === 'reused') throw unauthorized('refresh_token_reused', 'This refresh token was already used. The session has been revoked; sign in again.');
  throw unauthorized('invalid_refresh_token', 'Invalid or expired refresh token');
}

/** True while the session exists and has not been revoked. Called for every authenticated request. */
export async function isSessionActive(db: Database, sessionId: string, userId: string): Promise<boolean> {
  return !!(await db.get('SELECT 1 AS ok FROM _auth_sessions WHERE id = ? AND user_id = ? AND revoked_at IS NULL', [sessionId, userId]));
}

export async function signOut(env: AuthEnv, who: { userId: string; sessionId: string }, scope: 'local' | 'global'): Promise<void> {
  const now = iso(env.now());
  if (scope === 'global') {
    await env.db.run('UPDATE _auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [now, who.userId]);
  } else {
    await env.db.run('UPDATE _auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [now, who.sessionId]);
  }
}

export async function getUser(db: Database, userId: string): Promise<UserDto> {
  const row = await db.get<UserRow>('SELECT * FROM _auth_users WHERE id = ?', [userId]);
  if (!row) throw unauthorized('invalid_token', 'User no longer exists');
  return toUser(row);
}

export interface UpdateUserInput {
  data?: Record<string, unknown>;
  password?: string;
  current_password?: string;
}

/** Updates metadata (shallow merge; a null value deletes the key) and/or the password (needs the current one). */
export async function updateUser(
  env: AuthEnv,
  who: { userId: string; sessionId: string },
  input: UpdateUserInput,
  onBadCurrentPassword: () => void,
): Promise<UserDto> {
  const row = await env.db.get<UserRow>('SELECT * FROM _auth_users WHERE id = ?', [who.userId]);
  if (!row) throw unauthorized('invalid_token', 'User no longer exists');

  let metadata = row.user_metadata;
  if (input.data) {
    const merged = { ...(JSON.parse(row.user_metadata) as Record<string, unknown>), ...input.data };
    for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
    metadata = JSON.stringify(merged);
    if (Buffer.byteLength(metadata) > MAX_METADATA_BYTES) throw badRequest('metadata_too_large', `user_metadata may be at most ${MAX_METADATA_BYTES} bytes`);
  }

  let passwordHash = row.password_hash;
  if (input.password) {
    if (!input.current_password || !(await verifyPassword(row.password_hash, input.current_password))) {
      onBadCurrentPassword();
      throw new AppError(400, 'invalid_current_password', 'current_password is missing or incorrect');
    }
    passwordHash = await hashPassword(input.password);
  }

  const now = iso(env.now());
  await env.db.transaction(async (tx) => {
    await tx.run('UPDATE _auth_users SET user_metadata = ?, password_hash = ?, updated_at = ? WHERE id = ?', [metadata, passwordHash, now, row.id]);
    if (input.password) {
      // A password change signs out every other device.
      await tx.run('UPDATE _auth_sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL', [now, row.id, who.sessionId]);
    }
  });
  return toUser({ ...row, user_metadata: metadata, updated_at: now });
}

/**
 * Starts password recovery. Never reveals whether the e-mail is registered: it always
 * returns normally, and the (possibly slow) mail delivery is not awaited.
 */
export async function recover(env: AuthEnv, email: string): Promise<void> {
  const user = await env.db.get<UserRow>('SELECT * FROM _auth_users WHERE email = ?', [email]);
  if (!user) return;
  const { token, hash } = newOpaqueToken();
  await env.db.transaction(async (tx) => {
    await tx.run('DELETE FROM _auth_recovery_tokens WHERE user_id = ? AND used_at IS NULL', [user.id]);
    await tx.run('INSERT INTO _auth_recovery_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [hash, user.id, iso(env.now() + RECOVERY_TTL_MS)]);
  });
  void env.mailer
    .send({
      to: user.email,
      subject: `Reset your password (${env.projectName})`,
      text: `Use this token to set a new password within 1 hour:\n\n${token}\n\nSend it with the new password to POST /auth/reset. If you did not ask for this, ignore this message.`,
    })
    .catch((err) => console.error('failed to send recovery mail:', err));
}

/** Consumes a recovery token and sets a new password. Revokes every session of the user. */
export async function resetPassword(env: AuthEnv, token: string, newPassword: string): Promise<boolean> {
  const passwordHash = await hashPassword(newPassword);
  const hash = hashToken(token);
  return env.db.transaction(async (tx) => {
    const row = await tx.get<{ user_id: string; expires_at: string; used_at: string | null }>(
      'SELECT user_id, expires_at, used_at FROM _auth_recovery_tokens WHERE token_hash = ?',
      [hash],
    );
    if (!row || row.used_at || row.expires_at <= iso(env.now())) return false;
    const now = iso(env.now());
    await tx.run('UPDATE _auth_recovery_tokens SET used_at = ? WHERE token_hash = ?', [now, hash]);
    await tx.run('UPDATE _auth_users SET password_hash = ?, updated_at = ? WHERE id = ?', [passwordHash, now, row.user_id]);
    await tx.run('UPDATE _auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [now, row.user_id]);
    return true;
  });
}
