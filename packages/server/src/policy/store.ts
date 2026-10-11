import type { Database } from '../db/driver.js';
import { isUserTableName } from '../schema/validation.js';
import type { TableInfo } from '../schema/types.js';
import { parsePolicy } from './parse.js';
import type { Policy } from './types.js';

export interface StoredPolicy {
  table: string;
  /** The JSON the admin submitted. */
  policy: unknown;
  updated_at: string;
}

/**
 * Reads and writes the per-table policies of a project database, with an in-memory cache
 * of the compiled form. Any change goes through this class or calls invalidate(), so a
 * policy edit takes effect on the very next request.
 */
export class PolicyStore {
  private readonly cache = new Map<string, Map<string, Policy | null>>();
  private readonly generation = new Map<string, number>();

  /** The compiled policy, or undefined when the table has none (=> everything is denied). */
  async get(projectId: string, db: Database, table: string): Promise<Policy | undefined> {
    if (!isUserTableName(table)) return undefined;
    const cached = this.cache.get(projectId)?.get(table);
    if (cached !== undefined) return cached ?? undefined;

    const gen = this.generation.get(projectId) ?? 0;
    const row = await db.get<{ compiled: string }>('SELECT compiled FROM _policies WHERE table_name = ?', [table]);
    let policy: Policy | null = null;
    if (row) {
      try {
        policy = JSON.parse(row.compiled) as Policy;
      } catch {
        console.error(`corrupt policy for ${projectId}/${table}; denying all access`);
      }
    }
    if ((this.generation.get(projectId) ?? 0) === gen) {
      let perProject = this.cache.get(projectId);
      if (!perProject) this.cache.set(projectId, (perProject = new Map()));
      perProject.set(table, policy);
    }
    return policy ?? undefined;
  }

  /** Validates `raw` against the table and stores it, replacing any existing policy. Throws PolicyError if invalid. */
  async put(projectId: string, db: Database, table: TableInfo, raw: unknown, now: string): Promise<StoredPolicy> {
    const { policy, columns } = parsePolicy(raw, table);
    await db.run(
      `INSERT INTO _policies (table_name, source, compiled, columns, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (table_name) DO UPDATE SET source = excluded.source, compiled = excluded.compiled, columns = excluded.columns, updated_at = excluded.updated_at`,
      [table.name, JSON.stringify(raw), JSON.stringify(policy), JSON.stringify(columns), now],
    );
    this.invalidate(projectId);
    return { table: table.name, policy: raw, updated_at: now };
  }

  async remove(projectId: string, db: Database, table: string): Promise<boolean> {
    const res = await db.run('DELETE FROM _policies WHERE table_name = ?', [table]);
    this.invalidate(projectId);
    return res.changes > 0;
  }

  async getSource(db: Database, table: string): Promise<StoredPolicy | undefined> {
    const row = await db.get<{ source: string; updated_at: string }>('SELECT source, updated_at FROM _policies WHERE table_name = ?', [table]);
    return row && { table, policy: JSON.parse(row.source), updated_at: row.updated_at };
  }

  async list(db: Database): Promise<StoredPolicy[]> {
    const rows = await db.all<{ table_name: string; source: string; updated_at: string }>(
      'SELECT table_name, source, updated_at FROM _policies ORDER BY table_name',
    );
    return rows.map((r) => ({ table: r.table_name, policy: JSON.parse(r.source), updated_at: r.updated_at }));
  }

  invalidate(projectId: string): void {
    this.cache.delete(projectId);
    this.generation.set(projectId, (this.generation.get(projectId) ?? 0) + 1);
  }
}
