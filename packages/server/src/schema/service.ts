import type { Database } from '../db/driver.js';
import { AppError, conflict, notFound, unprocessable } from '../core/errors.js';
import type { AlterTableInput, ColumnInfo, CreateTableInput, SchemaDriver, TableInfo } from './types.js';
import { isUserTableName } from './validation.js';

/**
 * Table DDL for one project database. Input is expected to have passed the zod
 * schemas in validation.ts; this class adds the checks that need the live schema.
 *
 * Only tables passing isUserTableName() are visible here, which keeps the internal
 * `_`-prefixed tables (migrations, meta, later auth/policies) and SQLite's own
 * `sqlite_*` tables out of reach.
 */
export class TableService {
  constructor(
    private readonly db: Database,
    private readonly driver: SchemaDriver,
  ) {}

  async list(): Promise<TableInfo[]> {
    const names = (await this.driver.listTableNames(this.db)).filter((n) => isUserTableName(n));
    const tables: TableInfo[] = [];
    for (const name of names) {
      const t = await this.driver.describeTable(this.db, name);
      if (t) tables.push(t);
    }
    return tables;
  }

  async get(name: string): Promise<TableInfo> {
    const t = isUserTableName(name) ? await this.driver.describeTable(this.db, name) : undefined;
    if (!t) throw notFound('Table');
    return t;
  }

  async create(input: CreateTableInput): Promise<TableInfo> {
    return this.db.transaction(async (tx) => {
      if (await this.driver.describeTable(tx, input.name)) {
        throw conflict('table_exists', `Table "${input.name}" already exists`);
      }
      await tx.exec(this.driver.createTableSql(input));
      return (await this.driver.describeTable(tx, input.name))!;
    });
  }

  /** Operations apply in this order: add_columns, rename_columns, drop_columns, rename_to. */
  async alter(name: string, input: AlterTableInput): Promise<TableInfo> {
    if (!isUserTableName(name)) throw notFound('Table');
    const d = this.driver;

    return this.db.transaction(async (tx) => {
      const current = await d.describeTable(tx, name);
      if (!current) throw notFound('Table');

      const cols = new Map<string, ColumnInfo>(current.columns.map((c) => [c.name, c]));
      const statements: string[] = [];
      const missing = (col: string) => unprocessable('column_not_found', `Column "${col}" does not exist`);

      for (const col of input.add_columns ?? []) {
        if (cols.has(col.name)) throw conflict('column_exists', `Column "${col.name}" already exists`);
        cols.set(col.name, {
          name: col.name,
          type: col.type,
          primary_key: false,
          not_null: !!col.not_null,
          unique: false,
        });
        statements.push(d.addColumnSql(name, col));
      }

      for (const { from, to } of input.rename_columns ?? []) {
        const col = cols.get(from);
        if (!col) throw missing(from);
        if (cols.has(to)) throw conflict('column_exists', `Column "${to}" already exists`);
        cols.delete(from);
        cols.set(to, { ...col, name: to });
        statements.push(d.renameColumnSql(name, from, to));
      }

      for (const colName of input.drop_columns ?? []) {
        const col = cols.get(colName);
        if (!col) throw missing(colName);
        if (col.primary_key) throw unprocessable('column_in_use', `Cannot drop primary key column "${colName}"`);
        if (col.unique) throw unprocessable('column_in_use', `Cannot drop UNIQUE column "${colName}"`);
        cols.delete(colName);
        statements.push(d.dropColumnSql(name, colName));
      }
      if (cols.size === 0) throw unprocessable('no_columns_left', 'A table must keep at least one column');

      // A policy that names a column which disappears would silently stop protecting (or
      // wrongly expose) the table, so such changes are refused until the policy is updated.
      const policy = await tx.get<{ columns: string }>('SELECT columns FROM _policies WHERE table_name = ?', [name]);
      if (policy) {
        const used = new Set(JSON.parse(policy.columns) as string[]);
        const touched = [...(input.rename_columns ?? []).map((r) => r.from), ...(input.drop_columns ?? [])];
        const blocking = touched.find((c) => used.has(c));
        if (blocking) {
          throw unprocessable('column_in_use_by_policy', `Column "${blocking}" is used by this table's access policy. Update the policy first.`);
        }
      }

      let finalName = name;
      if (input.rename_to && input.rename_to !== name) {
        if (await d.describeTable(tx, input.rename_to)) {
          throw conflict('table_exists', `Table "${input.rename_to}" already exists`);
        }
        finalName = input.rename_to;
        statements.push(d.renameTableSql(name, finalName));
      }

      for (const sql of statements) {
        try {
          await tx.exec(sql);
        } catch (err) {
          // The statements are generated from validated input, so a failure here is a
          // constraint of the engine itself (e.g. column used by an index). Safe to report.
          if (typeof (err as { code?: unknown }).code === 'string' && (err as { code: string }).code.startsWith('SQLITE_')) {
            throw new AppError(422, 'alter_failed', `The database rejected this change: ${(err as Error).message}`);
          }
          throw err;
        }
      }
      if (finalName !== name) await tx.run('UPDATE _policies SET table_name = ? WHERE table_name = ?', [finalName, name]);
      return (await d.describeTable(tx, finalName))!;
    });
  }

  async drop(name: string): Promise<void> {
    if (!isUserTableName(name)) throw notFound('Table');
    await this.db.transaction(async (tx) => {
      if (!(await this.driver.describeTable(tx, name))) throw notFound('Table');
      await tx.exec(this.driver.dropTableSql(name));
      // A policy outliving its table would silently apply to a different table created under the same name.
      await tx.run('DELETE FROM _policies WHERE table_name = ?', [name]);
    });
  }
}
