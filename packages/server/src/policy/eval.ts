import type { SqlValue } from '../db/driver.js';
import type { SqlParams } from '../rest/builder.js';
import type { ComparisonOp, Expr, Operand } from './types.js';

/** Per-request facts a condition can refer to. */
export interface EvalContext {
  /** The signed-in user's id, or null (anon). A null uid never equals anything. */
  uid: string | null;
}

const SQL_OPS: Record<ComparisonOp, string> = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };

function operandValue(o: Operand, ctx: EvalContext): SqlValue {
  return o.kind === 'lit' ? o.value : ctx.uid;
}

/**
 * Renders the condition as SQL, binding every value as a parameter. SQL's three-valued
 * logic applies (a comparison with NULL is unknown, and unknown rows are not matched).
 */
export function toSql(expr: Expr, ctx: EvalContext, p: SqlParams): string {
  const q = (name: string) => p.dialect.quoteIdent(name);
  switch (expr.kind) {
    case 'true':
      return '1 = 1';
    case 'cmp':
      return `${q(expr.column)} ${SQL_OPS[expr.op]} ${p.add(operandValue(expr.operand, ctx))}`;
    case 'in':
      return `${q(expr.column)} IN (${expr.operands.map((o) => p.add(operandValue(o, ctx))).join(', ')})`;
    case 'isnull':
      return `${q(expr.column)} IS NULL`;
    case 'and':
      return `(${expr.items.map((e) => toSql(e, ctx, p)).join(' AND ')})`;
    case 'or':
      return `(${expr.items.map((e) => toSql(e, ctx, p)).join(' OR ')})`;
    case 'not':
      return `NOT (${toSql(expr.item, ctx, p)})`;
  }
}

type Tri = boolean | null; // null = SQL "unknown"

/** SQLite ordering of two non-null values: numbers sort before text; text compares as UTF-8 bytes. */
function compare(a: unknown, b: unknown): number {
  const an = typeof a === 'number' || typeof a === 'bigint';
  const bn = typeof b === 'number' || typeof b === 'bigint';
  if (an && bn) return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
  if (an !== bn) return an ? -1 : 1;
  return Buffer.compare(Buffer.from(String(a)), Buffer.from(String(b)));
}

function cmp(op: ComparisonOp, a: unknown, b: unknown): Tri {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  const c = compare(a, b);
  switch (op) {
    case 'eq':
      return c === 0;
    case 'neq':
      return c !== 0;
    case 'gt':
      return c > 0;
    case 'gte':
      return c >= 0;
    case 'lt':
      return c < 0;
    case 'lte':
      return c <= 0;
  }
}

/**
 * Evaluates the same condition against one row in memory, with SQL's three-valued
 * logic so that results are identical to toSql(). The row is in database form
 * (booleans 0/1, JSON as text), as returned by RETURNING.
 * Parity with toSql() is checked by randomized tests: keep the two in sync.
 */
export function evaluate(expr: Expr, row: Record<string, unknown>, ctx: EvalContext): Tri {
  switch (expr.kind) {
    case 'true':
      return true;
    case 'cmp':
      return cmp(expr.op, row[expr.column], operandValue(expr.operand, ctx));
    case 'in': {
      const v = row[expr.column];
      if (v === null || v === undefined) return null;
      let sawUnknown = false;
      for (const o of expr.operands) {
        const r = cmp('eq', v, operandValue(o, ctx));
        if (r === true) return true;
        if (r === null) sawUnknown = true;
      }
      return sawUnknown ? null : false;
    }
    case 'isnull':
      return row[expr.column] === null || row[expr.column] === undefined;
    case 'and': {
      let unknown = false;
      for (const e of expr.items) {
        const r = evaluate(e, row, ctx);
        if (r === false) return false;
        if (r === null) unknown = true;
      }
      return unknown ? null : true;
    }
    case 'or': {
      let unknown = false;
      for (const e of expr.items) {
        const r = evaluate(e, row, ctx);
        if (r === true) return true;
        if (r === null) unknown = true;
      }
      return unknown ? null : false;
    }
    case 'not': {
      const r = evaluate(expr.item, row, ctx);
      return r === null ? null : !r;
    }
  }
}

/** True only when the condition is definitely satisfied (unknown counts as not satisfied). */
export const matches = (expr: Expr, row: Record<string, unknown>, ctx: EvalContext): boolean => evaluate(expr, row, ctx) === true;
