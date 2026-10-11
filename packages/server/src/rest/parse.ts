import type { SqlValue } from '../db/driver.js';
import { badRequest } from '../core/errors.js';
import type { ColumnInfo, TableInfo } from '../schema/types.js';
import { coerceFilterValue } from './values.js';

export const FILTER_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'is'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export interface Filter {
  column: string;
  op: FilterOp;
  /** `not.<op>.<value>` in the query string. */
  negate: boolean;
  /** eq..lte: scalar. like/ilike: LIKE pattern (ESCAPE '\'). in: list. is: null (is.null) or 0/1 (is.true/is.false). */
  value: SqlValue | SqlValue[];
}

export interface OrderTerm {
  column: string;
  desc: boolean;
  nulls?: 'first' | 'last';
}

export interface ParsedQuery {
  /** null = all columns. */
  select: string[] | null;
  filters: Filter[];
  order: OrderTerm[];
  limit: number;
  offset: number;
  onConflict?: string;
}

export const MAX_LIMIT = 1000;
export const MAX_FILTERS = 30;
export const MAX_IN_ITEMS = 1000;
const MAX_ORDER_TERMS = 5;
const MAX_LIKE_LENGTH = 256;

export type QueryMode = 'read' | 'write' | 'insert';

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict']);
const ALLOWED_PARAMS: Record<QueryMode, ReadonlySet<string>> = {
  read: new Set(['select', 'order', 'limit', 'offset']),
  write: new Set(['select']),
  insert: new Set(['select', 'on_conflict']),
};

function unknownColumn(name: string): never {
  throw badRequest('unknown_column', `Column "${name}" does not exist`, { column: name });
}

function columnOf(table: TableInfo, name: string): ColumnInfo {
  const col = table.columns.find((c) => c.name === name);
  if (!col) unknownColumn(name);
  return col;
}

/** Splits `a,b,"c,d"` honouring double quotes (with \" and \\ escapes). */
export function splitList(s: string): string[] {
  const items: string[] = [];
  let cur = '';
  let quoted = false;
  let wasQuoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '\\' && i + 1 < s.length) cur += s[++i];
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') {
      quoted = true;
      wasQuoted = true;
    } else if (ch === ',') {
      items.push(cur);
      cur = '';
      wasQuoted = false;
    } else cur += ch;
  }
  if (quoted) throw badRequest('invalid_list', 'Unterminated quote in list');
  if (cur !== '' || wasQuoted || items.length > 0) items.push(cur);
  return items;
}

/** Escapes LIKE metacharacters in user input, then maps the `*` wildcard to `%`. */
function likePattern(raw: string): string {
  if (raw.length > MAX_LIKE_LENGTH) throw badRequest('invalid_filter', `like pattern is longer than ${MAX_LIKE_LENGTH} characters`);
  return raw.replace(/[\\%_]/g, (m) => `\\${m}`).replaceAll('*', '%');
}

function parseFilter(column: ColumnInfo, raw: string): Filter {
  let rest = raw;
  let negate = false;
  if (rest.startsWith('not.')) {
    negate = true;
    rest = rest.slice(4);
  }
  const dot = rest.indexOf('.');
  const op = (dot > 0 ? rest.slice(0, dot) : rest) as FilterOp;
  if (!FILTER_OPS.includes(op) || dot < 0) {
    throw badRequest('invalid_filter', `Filter on "${column.name}" must look like [not.]<op>.<value> with op one of ${FILTER_OPS.join(', ')}`, { column: column.name });
  }
  const arg = rest.slice(dot + 1);
  const base = { column: column.name, op, negate };

  switch (op) {
    case 'like':
    case 'ilike':
      if (!['text', 'uuid', 'timestamp', 'json'].includes(column.type)) {
        throw badRequest('invalid_filter', `${op} can only be used on text columns ("${column.name}" is ${column.type})`, { column: column.name });
      }
      return { ...base, value: likePattern(arg) };
    case 'in': {
      if (!arg.startsWith('(') || !arg.endsWith(')')) throw badRequest('invalid_filter', `in expects a list like in.(a,b,c) on "${column.name}"`, { column: column.name });
      const items = splitList(arg.slice(1, -1));
      if (items.length > MAX_IN_ITEMS) throw badRequest('invalid_filter', `in accepts at most ${MAX_IN_ITEMS} values`, { column: column.name });
      return { ...base, value: items.map((v) => coerceFilterValue(column, v)) };
    }
    case 'is':
      if (arg === 'null') return { ...base, value: null };
      if ((arg === 'true' || arg === 'false') && column.type === 'boolean') return { ...base, value: arg === 'true' ? 1 : 0 };
      throw badRequest('invalid_filter', `is expects null (or true/false on boolean columns) for "${column.name}"`, { column: column.name });
    default:
      return { ...base, value: coerceFilterValue(column, arg) };
  }
}

const MAX_SUBSCRIPTION_FILTERS = 5;

/**
 * Parses a stand-alone filter such as `done=eq.false&user_id=eq.abc` (realtime subscriptions).
 * Same grammar and validation as REST filters; reserved parameters (select, order, ...) are refused.
 */
export function parseFilterString(raw: string, table: TableInfo): Filter[] {
  const filters: Filter[] = [];
  for (const [key, value] of new URLSearchParams(raw)) {
    if (RESERVED.has(key)) throw badRequest('invalid_filter', `"${key}" cannot be used in a subscription filter`);
    if (filters.length >= MAX_SUBSCRIPTION_FILTERS) throw badRequest('too_many_filters', `At most ${MAX_SUBSCRIPTION_FILTERS} filters are allowed`);
    filters.push(parseFilter(columnOf(table, key), value));
  }
  return filters;
}

function parseSelect(raw: string, table: TableInfo): string[] | null {
  if (raw === '*') return null;
  const names = splitList(raw);
  if (names.length === 0 || names.length > table.columns.length) throw badRequest('invalid_select', 'select must be * or a list of column names');
  for (const n of names) if (n === '*' || !table.columns.some((c) => c.name === n)) unknownColumn(n);
  return [...new Set(names)];
}

function parseOrder(raw: string, table: TableInfo): OrderTerm[] {
  const terms = splitList(raw);
  if (terms.length === 0 || terms.length > MAX_ORDER_TERMS) throw badRequest('invalid_order', `order accepts 1 to ${MAX_ORDER_TERMS} terms`);
  return terms.map((term) => {
    const [name = '', ...mods] = term.split('.');
    columnOf(table, name);
    const out: OrderTerm = { column: name, desc: false };
    for (const m of mods) {
      if (m === 'asc') out.desc = false;
      else if (m === 'desc') out.desc = true;
      else if (m === 'nullsfirst') out.nulls = 'first';
      else if (m === 'nullslast') out.nulls = 'last';
      else throw badRequest('invalid_order', `Unknown order modifier "${m}" (use asc, desc, nullsfirst, nullslast)`);
    }
    return out;
  });
}

function parseIntParam(name: string, raw: string, max: number): number {
  if (!/^\d{1,10}$/.test(raw) || Number(raw) > max) throw badRequest(`invalid_${name}`, `${name} must be an integer between 0 and ${max}`);
  return Number(raw);
}

/**
 * Parses PostgREST-style query parameters against the table's columns.
 * Every column name is checked against the live schema; values are converted to the
 * column type. Nothing from the query string ever reaches SQL text.
 *
 * Writes (PATCH/DELETE) accept only filters and `select`: `limit`, `order` and
 * `offset` are rejected rather than ignored, because silently ignoring
 * `?limit=1` on an update would modify far more rows than the caller intended.
 */
export function parseQuery(params: URLSearchParams, table: TableInfo, mode: QueryMode = 'read'): ParsedQuery {
  const q: ParsedQuery = { select: null, filters: [], order: [], limit: MAX_LIMIT, offset: 0 };
  const seen = new Set<string>();

  for (const [key, value] of params) {
    if (RESERVED.has(key)) {
      if (seen.has(key)) throw badRequest('invalid_parameter', `"${key}" may only be given once`);
      seen.add(key);
      if (!ALLOWED_PARAMS[mode].has(key)) {
        throw badRequest('unsupported_parameter', `"${key}" is not supported on this kind of request`);
      }

      switch (key) {
        case 'select':
          q.select = parseSelect(value, table);
          break;
        case 'order':
          q.order = parseOrder(value, table);
          break;
        case 'limit':
          q.limit = parseIntParam('limit', value, MAX_LIMIT);
          break;
        case 'offset':
          q.offset = parseIntParam('offset', value, 1_000_000_000);
          break;
        case 'on_conflict': {
          const col = columnOf(table, value);
          if (!col.primary_key && !col.unique) throw badRequest('invalid_on_conflict', `"${value}" must be the primary key or a UNIQUE column`);
          q.onConflict = value;
          break;
        }
      }
      continue;
    }
    if (mode === 'insert') throw badRequest('unsupported_parameter', `Filters are not supported on POST ("${key}")`);
    if (q.filters.length >= MAX_FILTERS) throw badRequest('too_many_filters', `At most ${MAX_FILTERS} filters are allowed`);
    q.filters.push(parseFilter(columnOf(table, key), value));
  }
  return q;
}
