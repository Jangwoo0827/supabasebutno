import type { Database } from './driver.js';

export interface Migration {
  /** Strictly increasing, starting at 1. */
  version: number;
  name: string;
  /** Statements run inside one transaction. */
  sql: string;
}

/**
 * Applies pending migrations in order. Applied versions are recorded in
 * `_migrations` (underscore-prefixed tables are reserved and never exposed by the API).
 * Refuses to run against a database that is newer than this code.
 */
export async function migrate(db: Database, migrations: readonly Migration[]): Promise<void> {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`Migration versions must be 1..n in order (got ${m.version} at index ${i})`);
  });

  await db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at TEXT NOT NULL
     )`,
  );
  const row = await db.get<{ v: number | null }>('SELECT MAX(version) AS v FROM _migrations');
  const current = row?.v ?? 0;
  if (current > migrations.length) {
    throw new Error(`Database schema version ${current} is newer than this server supports (${migrations.length})`);
  }

  for (const m of migrations.slice(current)) {
    await db.transaction(async (tx) => {
      await tx.exec(m.sql);
      await tx.run('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        m.version,
        m.name,
        new Date().toISOString(),
      ]);
    });
  }
}
