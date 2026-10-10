import type { Dialect, SqlValue } from '../db/driver.js';
import type { ColumnInfo, TableInfo } from '../schema/types.js';
import type { Filter, OrderTerm, ParsedQuery } from './parse.js';

/**
 * Collects bound parameters while SQL text is assembled.
 *
 * Rule for every builder below: call `add()` in the same order the placeholders
 * appear in the final statement. (SQLite's `?` is positional.)
 */
export class SqlParams {
  readonly values: SqlValue[] = [];
  constructor(readonly dialect: Dialect) {}
  add(value: SqlValue): string {
    this.values.push(value);
    return this.dialect.placeholder(this.values.length);
  }
}

/** Produces a boolean SQL expression, appending its parameters to `p`. Used for access-policy conditions. */
export type Condition = (p: SqlParams) => string;

export interface BuiltQuery {
  sql: string;
  params: SqlValue[];
}

const pkOf = (table: TableInfo): ColumnInfo => table.columns.find((c) => c.primary_key) ?? table.columns[0]!;

export function compileFilter(f: Filter, p: SqlParams): string {
  const col = p.dialect.quoteIdent(f.column);
  const scalar = f.value as SqlValue;
  let sql: string;
  switch (f.op) {
    case 'eq':
      sql = `${col} = ${p.add(scalar)}`;
      break;
    case 'neq':
      sql = `${col} <> ${p.add(scalar)}`;
      break;
    case 'gt':
      sql = `${col} > ${p.add(scalar)}`;
      break;
    case 'gte':
      sql = `${col} >= ${p.add(scalar)}`;
      break;
    case 'lt':
      sql = `${col} < ${p.add(scalar)}`;
      break;
    case 'lte':
      sql = `${col} <= ${p.add(scalar)}`;
      break;
    case 'like':
    case 'ilike':
      // SQLite's LIKE is already case-insensitive for ASCII, so both map to it.
      sql = `${col} LIKE ${p.add(scalar)} ESCAPE '\\'`;
      break;
    case 'in': {
      const list = f.value as SqlValue[];
      sql = list.length === 0 ? '0 = 1' : `${col} IN (${list.map((v) => p.add(v)).join(', ')})`;
      break;
    }
    case 'is':
      sql = scalar === null ? `${col} IS NULL` : `${col} = ${p.add(scalar)}`;
      break;
  }
  return f.negate ? `NOT (${sql})` : sql;
}

function whereClause(filters: Filter[], extra: Condition[], p: SqlParams): string {
  const parts = [...filters.map((f) => compileFilter(f, p)), ...extra.map((c) => `(${c(p)})`)];
  return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
}

function columnList(d: Dialect, table: TableInfo, names: string[] | null): string {
  return (names ?? table.columns.map((c) => c.name)).map((n) => d.quoteIdent(n)).join(', ');
}

function orderBy(d: Dialect, table: TableInfo, terms: OrderTerm[]): string {
  const parts = terms.map((t) => {
    let s = `${d.quoteIdent(t.column)} ${t.desc ? 'DESC' : 'ASC'}`;
    if (t.nulls) s += t.nulls === 'first' ? ' NULLS FIRST' : ' NULLS LAST';
    return s;
  });
  // Deterministic paging: always end with the primary key.
  const pk = pkOf(table).name;
  if (!terms.some((t) => t.column === pk)) parts.push(`${d.quoteIdent(pk)} ASC`);
  return ` ORDER BY ${parts.join(', ')}`;
}

export function buildSelect(d: Dialect, table: TableInfo, q: ParsedQuery, extra: Condition[] = []): BuiltQuery {
  const p = new SqlParams(d);
  let sql = `SELECT ${columnList(d, table, q.select)} FROM ${d.quoteIdent(table.name)}`;
  sql += whereClause(q.filters, extra, p);
  sql += orderBy(d, table, q.order);
  sql += ` LIMIT ${p.add(q.limit)} OFFSET ${p.add(q.offset)}`;
  return { sql, params: p.values };
}

export function buildCount(d: Dialect, table: TableInfo, q: ParsedQuery, extra: Condition[] = []): BuiltQuery {
  const p = new SqlParams(d);
  const sql = `SELECT COUNT(*) AS count FROM ${d.quoteIdent(table.name)}${whereClause(q.filters, extra, p)}`;
  return { sql, params: p.values };
}

export interface InsertOptions {
  /** Columns to return, or null for none. */
  returning: string[] | null;
  /** Upsert on `column`: update `update` columns from the new row, optionally only where `where` holds. */
  onConflict?: { column: string; update: string[]; where?: Condition };
}

export function buildInsert(d: Dialect, table: TableInfo, row: Record<string, SqlValue>, opts: InsertOptions): BuiltQuery {
  const p = new SqlParams(d);
  const cols = Object.keys(row);
  let sql = `INSERT INTO ${d.quoteIdent(table.name)}`;
  sql += cols.length ? ` (${cols.map((c) => d.quoteIdent(c)).join(', ')}) VALUES (${cols.map((c) => p.add(row[c]!)).join(', ')})` : ' DEFAULT VALUES';

  if (opts.onConflict) {
    const { column, update, where } = opts.onConflict;
    sql += ` ON CONFLICT (${d.quoteIdent(column)})`;
    if (update.length === 0) sql += ' DO NOTHING';
    else {
      sql += ` DO UPDATE SET ${update.map((c) => `${d.quoteIdent(c)} = excluded.${d.quoteIdent(c)}`).join(', ')}`;
      if (where) sql += ` WHERE ${where(p)}`;
    }
  }
  if (opts.returning) sql += ` RETURNING ${opts.returning.map((c) => d.quoteIdent(c)).join(', ')}`;
  return { sql, params: p.values };
}

export function buildUpdate(
  d: Dialect,
  table: TableInfo,
  values: Record<string, SqlValue>,
  q: ParsedQuery,
  extra: Condition[],
  returning: string[] | null,
): BuiltQuery {
  const p = new SqlParams(d);
  const sets = Object.keys(values).map((c) => `${d.quoteIdent(c)} = ${p.add(values[c]!)}`);
  if (sets.length === 0) throw new Error('UPDATE without columns');
  let sql = `UPDATE ${d.quoteIdent(table.name)} SET ${sets.join(', ')}`;
  const where = whereClause(q.filters, extra, p);
  if (!where) throw new Error('UPDATE without WHERE');
  sql += where;
  if (returning) sql += ` RETURNING ${returning.map((c) => d.quoteIdent(c)).join(', ')}`;
  return { sql, params: p.values };
}

export function buildDelete(d: Dialect, table: TableInfo, q: ParsedQuery, extra: Condition[], returning: string[] | null): BuiltQuery {
  const p = new SqlParams(d);
  let sql = `DELETE FROM ${d.quoteIdent(table.name)}`;
  const where = whereClause(q.filters, extra, p);
  if (!where) throw new Error('DELETE without WHERE');
  sql += where;
  if (returning) sql += ` RETURNING ${returning.map((c) => d.quoteIdent(c)).join(', ')}`;
  return { sql, params: p.values };
}
