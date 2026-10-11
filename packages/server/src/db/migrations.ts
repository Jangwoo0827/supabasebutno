import type { Migration } from './migrate.js';

/** admin.sqlite — the control plane. */
export const controlMigrations: Migration[] = [
  {
    version: 1,
    name: 'create_projects',
    sql: `
      CREATE TABLE projects (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL COLLATE NOCASE UNIQUE,
        key_version    INTEGER NOT NULL DEFAULT 1,
        keys_issued_at INTEGER NOT NULL,
        created_at     TEXT NOT NULL
      );
    `,
  },
];

/** projects/<id>/db.sqlite — one per project. Later phases append (auth, policies, storage). */
export const projectMigrations: Migration[] = [
  {
    version: 1,
    name: 'create_meta',
    sql: `
      CREATE TABLE _meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'create_auth',
    sql: `
      CREATE TABLE _auth_users (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        user_metadata TEXT NOT NULL DEFAULT '{}',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        last_sign_in_at TEXT
      );

      -- One row per login. Access tokens carry the session id, and the session is
      -- checked on every request, so revoking it takes effect immediately.
      CREATE TABLE _auth_sessions (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES _auth_users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX _auth_sessions_user ON _auth_sessions (user_id);

      -- Only the SHA-256 of a refresh token is stored. rotated_at is set when the token
      -- has been exchanged for a new one; presenting it again later signals theft.
      CREATE TABLE _auth_refresh_tokens (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES _auth_sessions(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        rotated_at TEXT
      );
      CREATE INDEX _auth_refresh_session ON _auth_refresh_tokens (session_id);

      CREATE TABLE _auth_recovery_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES _auth_users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        used_at    TEXT
      );
    `,
  },
];
