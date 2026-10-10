import type { Database } from '../db/driver.js';

/** Portable column types. Each dialect maps them to native types (SQLite: see db/sqlite/schema.ts). */
export const COLUMN_TYPES = ['text', 'integer', 'real', 'boolean', 'json', 'timestamp', 'uuid'] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

/** Server-evaluated defaults: `now` (ISO-8601 UTC, timestamp columns) and `uuid` (v4, uuid columns). */
export type DefaultFn = { fn: 'now' | 'uuid' };
export type DefaultValue = string | number | boolean | null | DefaultFn;

export interface ColumnInput {
  name: string;
  type: ColumnType;
  primary_key?: boolean;
  not_null?: boolean;
  unique?: boolean;
  default?: DefaultValue;
}

export interface CreateTableInput {
  name: string;
  columns: ColumnInput[];
}

/** Columns added to an existing table cannot be primary keys or UNIQUE (SQLite limitation). */
export type AddColumnInput = Omit<ColumnInput, 'primary_key' | 'unique'>;

export interface AlterTableInput {
  add_columns?: AddColumnInput[];
  rename_columns?: { from: string; to: string }[];
  drop_columns?: string[];
  rename_to?: string;
}

/** What introspection reports for an existing column. */
export interface ColumnInfo {
  name: string;
  type: ColumnType;
  primary_key: boolean;
  not_null: boolean;
  unique: boolean;
  /** Absent = no default. `{ sql }` = a default expression we did not create ourselves. */
  default?: DefaultValue | { sql: string };
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
}

/**
 * Dialect-specific half of schema management: reading the catalog and
 * generating DDL. Contains no validation — TableService does that.
 */
export interface SchemaDriver {
  listTableNames(db: Database): Promise<string[]>;
  describeTable(db: Database, name: string): Promise<TableInfo | undefined>;
  createTableSql(input: CreateTableInput): string;
  addColumnSql(table: string, column: AddColumnInput): string;
  renameColumnSql(table: string, from: string, to: string): string;
  dropColumnSql(table: string, column: string): string;
  renameTableSql(from: string, to: string): string;
  dropTableSql(name: string): string;
}
