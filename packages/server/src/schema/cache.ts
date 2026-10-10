import type { Database } from '../db/driver.js';
import type { SchemaDriver, TableInfo } from './types.js';
import { isUserTableName } from './validation.js';

/**
 * Per-project cache of table metadata, used by the REST layer as its whitelist of
 * table and column names. All DDL goes through this process, so DDL handlers
 * simply call invalidate(); the generation counter stops a lookup that raced with
 * DDL from re-populating the cache with stale data.
 */
export class SchemaCache {
  private readonly tables = new Map<string, Map<string, TableInfo>>();
  private readonly generation = new Map<string, number>();

  constructor(private readonly driver: SchemaDriver) {}

  /** Returns undefined for unknown tables and for any name that is not a valid user-table name. */
  async table(projectId: string, db: Database, name: string): Promise<TableInfo | undefined> {
    if (!isUserTableName(name)) return undefined;
    const cached = this.tables.get(projectId)?.get(name);
    if (cached) return cached;

    const gen = this.generation.get(projectId) ?? 0;
    const info = await this.driver.describeTable(db, name);
    if (info && (this.generation.get(projectId) ?? 0) === gen) {
      let perProject = this.tables.get(projectId);
      if (!perProject) this.tables.set(projectId, (perProject = new Map()));
      perProject.set(name, info);
    }
    return info;
  }

  invalidate(projectId: string): void {
    this.tables.delete(projectId);
    this.generation.set(projectId, (this.generation.get(projectId) ?? 0) + 1);
  }
}
