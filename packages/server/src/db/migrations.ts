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
];
