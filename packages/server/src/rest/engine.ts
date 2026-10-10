import type { Database, SqlValue } from '../db/driver.js';
import { AppError, badRequest } from '../core/errors.js';
import type { TableInfo } from '../schema/types.js';
import { buildCount, buildDelete, buildInsert, buildSelect, buildUpdate, type Condition, type SqlParams } from './builder.js';
import type { ParsedQuery } from './parse.js';
import { coerceWriteValue, decodeRow } from './values.js';

export const MAX_INSERT_ROWS = 1000;

/** What the caller is allowed to touch. `where` conditions are ANDed into every statement. */
export interface AccessPlan {
  where: Condition[];
}
export const UNRESTRICTED: AccessPlan = { where: [] };

type Row = Record<string, unknown>;

/** Maps integrity-constraint failures to client errors (409/400) instead of an opaque 500. */
function translate(db: Database, err: unknown): never {
  const v = db.dialect.constraintViolation(err);
  if (!v) throw err;
  const details = v.column ? { column: v.column } : undefined;
  switch (v.kind) {
    case 'unique':
      throw new AppError(409, 'unique_violation', 'A row with the same value already exists', details);
    case 'not_null':
      throw new AppError(400, 'not_null_violation', 'A required column is missing or null', details);
    case 'foreign_key':
      throw new AppError(409, 'foreign_key_violation', 'The row references or is referenced by another row', details);
    case 'check':
      throw new AppError(400, 'check_violation', 'The row violates a table constraint', details);
  }
}

async function guarded<T>(db: Database, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    return translate(db, err);
  }
}

/** Validates a JSON object against the table and converts it to bound values. Unknown columns are rejected. */
export function toRow(table: TableInfo, input: unknown, opts: { forInsert: boolean }): Record<string, SqlValue> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest('invalid_body', 'Each row must be a JSON object');
  }
  const out: Record<string, SqlValue> = {};
  for (const key of Object.keys(input)) {
    const col = table.columns.find((c) => c.name === key);
    if (!col) throw badRequest('unknown_column', `Column "${key}" does not exist`, { column: key });
    const value = (input as Row)[key];
    // `null` for an integer primary key means "assign one" on insert.
    if (opts.forInsert && value === null && col.primary_key && col.type === 'integer') continue;
    out[key] = coerceWriteValue(col, value);
  }
  return out;
}

const returningColumns = (table: TableInfo, select: string[] | null) => select ?? table.columns.map((c) => c.name);
const decodeAll = (table: TableInfo, rows: Row[]) => rows.map((r) => decodeRow(table, r));

export async function runSelect(
  db: Database,
  table: TableInfo,
  q: ParsedQuery,
  plan: AccessPlan,
  withCount: boolean,
): Promise<{ rows: Row[]; total?: number }> {
  const sel = buildSelect(db.dialect, table, q, plan.where);
  const rows = decodeAll(table, await db.all<Row>(sel.sql, sel.params));
  if (!withCount) return { rows };
  const cnt = buildCount(db.dialect, table, q, plan.where);
  const total = (await db.get<{ count: number }>(cnt.sql, cnt.params))?.count ?? 0;
  return { rows, total };
}

export interface InsertRequest {
  rows: unknown[];
  returning: boolean;
  select: string[] | null;
  /** 'merge' = update on conflict, 'ignore' = skip on conflict. */
  onConflict?: { column: string; mode: 'merge' | 'ignore' };
}

/** Inserts all rows atomically. Returns the created/updated rows when `returning` is set. */
export async function runInsert(db: Database, table: TableInfo, req: InsertRequest, plan: AccessPlan): Promise<Row[]> {
  if (req.rows.length === 0 || req.rows.length > MAX_INSERT_ROWS) {
    throw badRequest('invalid_body', `Provide between 1 and ${MAX_INSERT_ROWS} rows`);
  }
  const prepared = req.rows.map((r) => toRow(table, r, { forInsert: true }));
  const cols = returningColumns(table, req.select);

  return guarded(db, () =>
    db.transaction(async (tx) => {
      const out: Row[] = [];
      for (const row of prepared) {
        const onConflict = req.onConflict && {
          column: req.onConflict.column,
          update: req.onConflict.mode === 'merge' ? Object.keys(row).filter((c) => c !== req.onConflict!.column) : [],
          where: plan.where.length ? (p: SqlParams) => plan.where.map((c) => `(${c(p)})`).join(' AND ') : undefined,
        };
        const q = buildInsert(tx.dialect, table, row, { returning: req.returning ? cols : null, onConflict });
        if (req.returning) out.push(...(await tx.all<Row>(q.sql, q.params)));
        else await tx.run(q.sql, q.params);
      }
      return decodeAll(table, out);
    }),
  );
}

export async function runUpdate(
  db: Database,
  table: TableInfo,
  body: unknown,
  q: ParsedQuery,
  returning: boolean,
  plan: AccessPlan,
): Promise<{ rows: Row[]; changes: number }> {
  const values = toRow(table, body, { forInsert: false });
  if (Object.keys(values).length === 0) throw badRequest('invalid_body', 'Provide at least one column to update');
  const stmt = buildUpdate(db.dialect, table, values, q, plan.where, returning ? returningColumns(table, q.select) : null);
  return guarded(db, async () => {
    if (returning) {
      const rows = await db.all<Row>(stmt.sql, stmt.params);
      return { rows: decodeAll(table, rows), changes: rows.length };
    }
    return { rows: [], changes: (await db.run(stmt.sql, stmt.params)).changes };
  });
}

export async function runDelete(
  db: Database,
  table: TableInfo,
  q: ParsedQuery,
  returning: boolean,
  plan: AccessPlan,
): Promise<{ rows: Row[]; changes: number }> {
  const stmt = buildDelete(db.dialect, table, q, plan.where, returning ? returningColumns(table, q.select) : null);
  return guarded(db, async () => {
    if (returning) {
      const rows = await db.all<Row>(stmt.sql, stmt.params);
      return { rows: decodeAll(table, rows), changes: rows.length };
    }
    return { rows: [], changes: (await db.run(stmt.sql, stmt.params)).changes };
  });
}
