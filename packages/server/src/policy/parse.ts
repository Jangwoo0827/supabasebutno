import { AppError } from '../core/errors.js';
import { coerceWriteValue } from '../rest/values.js';
import type { ColumnInfo, TableInfo } from '../schema/types.js';
import {
  COMPARISON_OPS,
  POLICY_ROLES,
  TRUE_EXPR,
  type ComparisonOp,
  type Expr,
  type Operand,
  type Policy,
  type PolicyRole,
} from './types.js';

/** A problem in a policy definition, with the JSON path where it was found. */
export class PolicyError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

const MAX_DEPTH = 8;
const MAX_NODES = 60;
const MAX_IN_ITEMS = 50;
const OPERATIONS = ['select', 'insert', 'update', 'delete'] as const;

interface Ctx {
  table: TableInfo;
  nodes: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function column(ctx: Ctx, name: unknown, path: string): ColumnInfo {
  const col = typeof name === 'string' ? ctx.table.columns.find((c) => c.name === name) : undefined;
  if (!col) throw new PolicyError(path, `unknown column ${JSON.stringify(name)} in table "${ctx.table.name}"`);
  return col;
}

function operand(ctx: Ctx, col: ColumnInfo, raw: unknown, path: string): Operand {
  if (typeof raw === 'string' && raw.startsWith('$')) {
    if (raw !== '$uid') throw new PolicyError(path, `unknown variable ${JSON.stringify(raw)}; the only variable is "$uid"`);
    if (col.type !== 'text' && col.type !== 'uuid') throw new PolicyError(path, `"$uid" can only be compared with text or uuid columns ("${col.name}" is ${col.type})`);
    return { kind: 'var', name: 'uid' };
  }
  if (raw === null) throw new PolicyError(path, 'use {"op":"is","value":null} to test for NULL');
  if (col.type === 'json') throw new PolicyError(path, `json column "${col.name}" cannot be compared`);
  try {
    // Same conversion as a real write, so the literal matches how values are stored.
    return { kind: 'lit', value: coerceWriteValue({ ...col, not_null: false }, raw) };
  } catch (err) {
    throw new PolicyError(path, err instanceof AppError ? err.message : 'invalid value');
  }
}

function parseExpr(raw: unknown, ctx: Ctx, path: string, depth: number): Expr {
  if (depth > MAX_DEPTH) throw new PolicyError(path, `conditions are nested more than ${MAX_DEPTH} levels deep`);
  if (++ctx.nodes > MAX_NODES) throw new PolicyError(path, `a policy may contain at most ${MAX_NODES} conditions`);

  if (raw === true) return TRUE_EXPR;
  if (!isObject(raw)) throw new PolicyError(path, 'a condition must be true or an object');
  const keys = Object.keys(raw);
  if (keys.length === 0) throw new PolicyError(path, 'empty condition');

  // Combinators: {"and":[...]}, {"or":[...]}, {"not":{...}}
  if (keys.length === 1) {
    const key = keys[0]!;
    const value = raw[key];
    if ((key === 'and' || key === 'or') && Array.isArray(value)) {
      if (value.length === 0 || value.length > 20) throw new PolicyError(`${path}.${key}`, `"${key}" needs 1 to 20 conditions`);
      return { kind: key, items: value.map((v, i) => parseExpr(v, ctx, `${path}.${key}[${i}]`, depth + 1)) };
    }
    if (key === 'not' && isObject(value)) return { kind: 'not', item: parseExpr(value, ctx, `${path}.not`, depth + 1) };
  }

  // Explicit comparison: {"column":"score","op":"gte","value":10}
  if ('column' in raw && 'op' in raw) {
    for (const k of keys) if (!['column', 'op', 'value'].includes(k)) throw new PolicyError(`${path}.${k}`, 'unexpected key in comparison');
    const col = column(ctx, raw.column, `${path}.column`);
    const op = raw.op;
    if (op === 'is') {
      if (raw.value !== null) throw new PolicyError(`${path}.value`, '"is" only supports null; use {"not": ...} to test for NOT NULL');
      return { kind: 'isnull', column: col.name };
    }
    if (op === 'in') {
      const list = raw.value;
      if (!Array.isArray(list) || list.length === 0 || list.length > MAX_IN_ITEMS) throw new PolicyError(`${path}.value`, `"in" needs a list of 1 to ${MAX_IN_ITEMS} values`);
      return { kind: 'in', column: col.name, operands: list.map((v, i) => operand(ctx, col, v, `${path}.value[${i}]`)) };
    }
    if (typeof op !== 'string' || !(COMPARISON_OPS as readonly string[]).includes(op)) {
      throw new PolicyError(`${path}.op`, `op must be one of ${[...COMPARISON_OPS, 'in', 'is'].join(', ')}`);
    }
    if (!('value' in raw)) throw new PolicyError(`${path}.value`, 'missing value');
    return { kind: 'cmp', column: col.name, op: op as ComparisonOp, operand: operand(ctx, col, raw.value, `${path}.value`) };
  }

  // Shorthand equality: {"user_id":"$uid","archived":false}  (all must match)
  const items: Expr[] = keys.map((k) => {
    const col = column(ctx, k, `${path}.${k}`);
    const v = raw[k];
    if (isObject(v) || Array.isArray(v)) throw new PolicyError(`${path}.${k}`, 'shorthand conditions take a plain value; use {"column":...,"op":...} for anything else');
    return { kind: 'cmp', column: col.name, op: 'eq', operand: operand(ctx, col, v, `${path}.${k}`) };
  });
  ctx.nodes += items.length;
  return items.length === 1 ? items[0]! : { kind: 'and', items };
}

function parseRoles(raw: unknown, path: string): PolicyRole[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new PolicyError(path, `roles must be a non-empty list of ${POLICY_ROLES.join(', ')}`);
  const roles = new Set<PolicyRole>();
  raw.forEach((r, i) => {
    if (!(POLICY_ROLES as readonly unknown[]).includes(r)) {
      throw new PolicyError(`${path}[${i}]`, `unknown role ${JSON.stringify(r)}; allowed: ${POLICY_ROLES.join(', ')} (service_role always bypasses policies)`);
    }
    roles.add(r as PolicyRole);
  });
  return [...roles];
}

function onlyKeys(rule: Record<string, unknown>, allowed: string[], path: string) {
  for (const k of Object.keys(rule)) if (!allowed.includes(k)) throw new PolicyError(`${path}.${k}`, `unexpected key; allowed: ${allowed.join(', ')}`);
}

/** Walks a compiled expression and collects every column it reads. */
export function collectColumns(expr: Expr, into = new Set<string>()): Set<string> {
  switch (expr.kind) {
    case 'cmp':
    case 'in':
    case 'isnull':
      into.add(expr.column);
      break;
    case 'and':
    case 'or':
      expr.items.forEach((e) => collectColumns(e, into));
      break;
    case 'not':
      collectColumns(expr.item, into);
      break;
  }
  return into;
}

export interface ParsedPolicy {
  policy: Policy;
  /** Every column the policy refers to; schema changes that would break them are refused. */
  columns: string[];
}

/**
 * Validates a policy definition against the table's real columns and compiles it.
 * Throws PolicyError (with a JSON path) for anything invalid, so mistakes surface
 * when the policy is written, not when a request arrives.
 */
export function parsePolicy(raw: unknown, table: TableInfo): ParsedPolicy {
  if (!isObject(raw)) throw new PolicyError('$', 'a policy must be a JSON object like {"select": {...}, "insert": {...}}');
  for (const k of Object.keys(raw)) {
    if (!(OPERATIONS as readonly string[]).includes(k)) throw new PolicyError(k, `unknown operation; allowed: ${OPERATIONS.join(', ')}`);
  }
  const ctx: Ctx = { table, nodes: 0 };
  const policy: Policy = {};
  const columns = new Set<string>();
  const expr = (v: unknown, path: string): Expr => {
    const e = v === undefined ? TRUE_EXPR : parseExpr(v, ctx, path, 0);
    collectColumns(e, columns);
    return e;
  };

  for (const op of OPERATIONS) {
    const rule = raw[op];
    if (rule === undefined) continue;
    if (!isObject(rule)) throw new PolicyError(op, 'a rule must be an object with a "roles" list');
    const roles = parseRoles(rule.roles, `${op}.roles`);

    switch (op) {
      case 'select':
        onlyKeys(rule, ['roles', 'where'], op);
        policy.select = { roles, where: expr(rule.where, 'select.where') };
        break;
      case 'delete':
        onlyKeys(rule, ['roles', 'where'], op);
        policy.delete = { roles, where: expr(rule.where, 'delete.where') };
        break;
      case 'update': {
        onlyKeys(rule, ['roles', 'where', 'check'], op);
        const where = expr(rule.where, 'update.where');
        policy.update = { roles, where, check: rule.check === undefined ? where : expr(rule.check, 'update.check') };
        break;
      }
      case 'insert': {
        onlyKeys(rule, ['roles', 'check', 'set'], op);
        const set: Record<string, Operand> = {};
        if (rule.set !== undefined) {
          if (!isObject(rule.set)) throw new PolicyError('insert.set', 'set must be an object of column: value');
          for (const [name, v] of Object.entries(rule.set)) {
            const col = column(ctx, name, `insert.set.${name}`);
            set[name] = operand(ctx, col, v, `insert.set.${name}`);
            columns.add(name);
          }
        }
        policy.insert = { roles, check: expr(rule.check, 'insert.check'), set };
        break;
      }
    }
  }
  if (Object.keys(policy).length === 0) throw new PolicyError('$', 'a policy must define at least one operation (an empty policy would deny everything: delete it instead)');
  return { policy, columns: [...columns].sort() };
}
