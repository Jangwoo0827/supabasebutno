import type { Database, SqlValue } from '../db/driver.js';
import { AppError, badRequest } from '../core/errors.js';
import type { RowChange } from '../realtime/types.js';
import type { TableInfo } from '../schema/types.js';
import { buildCount, buildDelete, buildInsert, buildSelect, buildSelectWhere, buildUpdate, type Condition, type SqlParams } from './builder.js';
import type { ParsedQuery } from './parse.js';
import { coerceWriteValue, decodeRow } from './values.js';

export const MAX_INSERT_ROWS = 1000;

type Row = Record<string, unknown>;

/**
 * What the caller is allowed to do with one request, derived from the table's policy
 * (see policy/plan.ts). Rows handed to `check` / `canRead` are in database form, exactly
 * as stored (RETURNING *), so they reflect defaults and triggers, not just client input.
 */
export interface AccessPlan {
  /** false = service role: no policy applies and no extra bookkeeping is done. */
  restricted: boolean;
  /** SQL conditions ANDed into SELECT / UPDATE / DELETE (and into the DO UPDATE branch of an upsert). */
  where: Condition[];
  /** Verifies each row AFTER it was written; returning false rolls the whole request back. */
  check?: (row: Row) => boolean;
  /** Columns forced to a value on insert, overriding what the client sent. */
  set?: Record<string, SqlValue>;
  /** Filters rows returned from a write to those the caller may also SELECT. */
  canRead?: (row: Row) => boolean;
}
export const UNRESTRICTED: AccessPlan = { restricted: false, where: [] };

export const policyViolation = () => new AppError(403, 'policy_violation', "The change would violate this table's access policy");

/** Result of a write: the rows to echo to the caller, and the committed changes to broadcast to realtime subscribers. */
export interface WriteResult {
  rows: Row[];
  count: number;
  /** Only filled when `capture` was requested; publish them AFTER the transaction has committed (which is when this returns). */
  changes: RowChange[];
}

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

const allColumns = (table: TableInfo) => table.columns.map((c) => c.name);
const returningColumns = (table: TableInfo, select: string[] | null) => select ?? allColumns(table);
const pkName = (table: TableInfo) => (table.columns.find((c) => c.primary_key) ?? table.columns[0]!).name;

/** What a write returns to the caller: rows they may read, limited to the requested columns, in API form. */
function present(table: TableInfo, rows: Row[], select: string[] | null, plan: AccessPlan): Row[] {
  const visible = plan.restricted ? rows.filter((r) => plan.canRead?.(r) === true) : rows;
  return visible.map((r) => {
    const projected = select ? Object.fromEntries(select.map((c) => [c, r[c]])) : r;
    return decodeRow(table, projected);
  });
}

export async function runSelect(
  db: Database,
  table: TableInfo,
  q: ParsedQuery,
  plan: AccessPlan,
  withCount: boolean,
): Promise<{ rows: Row[]; total?: number }> {
  const sel = buildSelect(db.dialect, table, q, plan.where);
  const rows = (await db.all<Row>(sel.sql, sel.params)).map((r) => decodeRow(table, r));
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
export async function runInsert(db: Database, table: TableInfo, req: InsertRequest, plan: AccessPlan, capture = false): Promise<WriteResult> {
  if (req.rows.length === 0 || req.rows.length > MAX_INSERT_ROWS) {
    throw badRequest('invalid_body', `Provide between 1 and ${MAX_INSERT_ROWS} rows`);
  }
  // Forced values (policy `set`) win over anything the client sent.
  const prepared = req.rows.map((r) => ({ ...toRow(table, r, { forInsert: true }), ...plan.set }));
  // Restricted callers (policy check) and realtime capture need the full stored row.
  const needFull = plan.restricted || capture;
  const cols = needFull ? allColumns(table) : returningColumns(table, req.select);
  const wantRows = needFull || req.returning;
  const q = db.dialect.quoteIdent;

  return guarded(db, () =>
    db.transaction(async (tx) => {
      const out: Row[] = [];
      const changes: RowChange[] = [];
      for (const row of prepared) {
        const onConflict = req.onConflict && {
          column: req.onConflict.column,
          update: req.onConflict.mode === 'merge' ? Object.keys(row).filter((c) => c !== req.onConflict!.column) : [],
          where: plan.where.length ? (p: SqlParams) => plan.where.map((c) => `(${c(p)})`).join(' AND ') : undefined,
        };

        // For realtime, an upsert is an UPDATE (with the previous row) if the key already exists, otherwise an INSERT.
        let previous: Row | undefined;
        if (capture && req.onConflict?.mode === 'merge') {
          const key = row[req.onConflict.column];
          if (key !== undefined && key !== null) {
            previous = await tx.get<Row>(`SELECT * FROM ${q(table.name)} WHERE ${q(req.onConflict.column)} = ${tx.dialect.placeholder(1)}`, [key]);
          }
        }

        const stmt = buildInsert(tx.dialect, table, row, { returning: wantRows ? cols : null, onConflict });
        if (!wantRows) {
          await tx.run(stmt.sql, stmt.params);
          continue;
        }
        const rows = await tx.all<Row>(stmt.sql, stmt.params);
        if (plan.restricted) {
          // A merge that touched nothing means the key exists but the caller may not update that row.
          if (rows.length === 0 && req.onConflict?.mode === 'merge') throw policyViolation();
          if (plan.check && !rows.every((r) => plan.check!(r))) throw policyViolation();
        }
        out.push(...rows);
        if (capture) for (const r of rows) changes.push(previous ? { type: 'UPDATE', table, new: r, old: previous } : { type: 'INSERT', table, new: r });
      }
      return { rows: req.returning ? present(table, out, req.select, plan) : [], count: out.length, changes };
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
  capture = false,
): Promise<WriteResult> {
  const values = toRow(table, body, { forInsert: false });
  if (Object.keys(values).length === 0) throw badRequest('invalid_body', 'Provide at least one column to update');
  const needFull = plan.restricted || capture;
  const wantRows = needFull || returning;
  const stmt = buildUpdate(db.dialect, table, values, q, plan.where, wantRows ? (needFull ? allColumns(table) : returningColumns(table, q.select)) : null);
  const pk = pkName(table);

  return guarded(db, () =>
    db.transaction(async (tx) => {
      // The rows as they were before the update, so subscribers can be told what changed.
      const before = new Map<unknown, Row>();
      if (capture) {
        const sel = buildSelectWhere(tx.dialect, table, q.filters, plan.where);
        for (const r of await tx.all<Row>(sel.sql, sel.params)) before.set(r[pk], r);
      }
      if (!wantRows) return { rows: [], count: (await tx.run(stmt.sql, stmt.params)).changes, changes: [] };

      const rows = await tx.all<Row>(stmt.sql, stmt.params);
      if (plan.restricted && plan.check && !rows.every((r) => plan.check!(r))) throw policyViolation();
      const changes: RowChange[] = capture ? rows.map((r) => ({ type: 'UPDATE', table, new: r, old: before.get(r[pk]) })) : [];
      return { rows: returning ? present(table, rows, q.select, plan) : [], count: rows.length, changes };
    }),
  );
}

export async function runDelete(
  db: Database,
  table: TableInfo,
  q: ParsedQuery,
  returning: boolean,
  plan: AccessPlan,
  capture = false,
): Promise<WriteResult> {
  const wantRows = returning || capture;
  const stmt = buildDelete(db.dialect, table, q, plan.where, wantRows ? (plan.restricted || capture ? allColumns(table) : returningColumns(table, q.select)) : null);
  return guarded(db, async () => {
    if (!wantRows) return { rows: [], count: (await db.run(stmt.sql, stmt.params)).changes, changes: [] };
    const rows = await db.all<Row>(stmt.sql, stmt.params);
    const changes: RowChange[] = capture ? rows.map((r) => ({ type: 'DELETE', table, old: r })) : [];
    return { rows: returning ? present(table, rows, q.select, plan) : [], count: rows.length, changes };
  });
}
