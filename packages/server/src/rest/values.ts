import type { SqlValue } from '../db/driver.js';
import { badRequest } from '../core/errors.js';
import type { ColumnInfo, TableInfo } from '../schema/types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT_RE = /^-?\d{1,18}$/;
const NUM_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
// Calendar date, or full date-time WITH an explicit zone, so parsing never depends on server locale.
const ISO_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2}))?$/;

const invalid = (code: string, column: string, message: string) => badRequest(code, message, { column });

/** Turns a query-string value (always a string) into a bound parameter of the column's type. */
export function coerceFilterValue(col: ColumnInfo, raw: string): SqlValue {
  switch (col.type) {
    case 'integer':
      if (!INT_RE.test(raw) || !Number.isSafeInteger(Number(raw))) throw invalid('invalid_filter_value', col.name, `"${col.name}" expects an integer`);
      return Number(raw);
    case 'real':
      if (!NUM_RE.test(raw) || !Number.isFinite(Number(raw))) throw invalid('invalid_filter_value', col.name, `"${col.name}" expects a number`);
      return Number(raw);
    case 'boolean':
      if (raw === 'true') return 1;
      if (raw === 'false') return 0;
      throw invalid('invalid_filter_value', col.name, `"${col.name}" expects true or false`);
    case 'timestamp':
      if (!ISO_RE.test(raw) || Number.isNaN(Date.parse(raw))) throw invalid('invalid_filter_value', col.name, `"${col.name}" expects an ISO-8601 timestamp`);
      return raw;
    default:
      return raw;
  }
}

/** Validates and converts a JSON body value for writing. Types are strict: nothing is silently coerced. */
export function coerceWriteValue(col: ColumnInfo, value: unknown): SqlValue {
  if (value === null) {
    if (col.not_null) throw invalid('not_null_violation', col.name, `"${col.name}" must not be null`);
    return null;
  }
  switch (col.type) {
    case 'text':
      if (typeof value !== 'string') throw invalid('invalid_value', col.name, `"${col.name}" expects a string`);
      if (value.includes('\0')) throw invalid('invalid_value', col.name, `"${col.name}" must not contain NUL characters`);
      return value;
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw invalid('invalid_value', col.name, `"${col.name}" expects an integer`);
      return value;
    case 'real':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid('invalid_value', col.name, `"${col.name}" expects a number`);
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') throw invalid('invalid_value', col.name, `"${col.name}" expects true or false`);
      return value ? 1 : 0;
    case 'uuid':
      if (typeof value !== 'string' || !UUID_RE.test(value)) throw invalid('invalid_value', col.name, `"${col.name}" expects a UUID`);
      return value.toLowerCase();
    case 'timestamp': {
      if (typeof value !== 'string' || !ISO_RE.test(value) || Number.isNaN(Date.parse(value))) {
        throw invalid('invalid_value', col.name, `"${col.name}" expects an ISO-8601 timestamp (with a time zone if it has a time)`);
      }
      return new Date(value).toISOString();
    }
    case 'json':
      return JSON.stringify(value);
  }
}

/** Converts a database row to its API representation (booleans, parsed JSON). */
export function decodeRow(table: TableInfo, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of table.columns) {
    if (!(col.name in row)) continue;
    const v = row[col.name];
    if (v === null || v === undefined) out[col.name] = null;
    else if (col.type === 'boolean') out[col.name] = v !== 0 && v !== '0' && v !== false;
    else if (col.type === 'json' && typeof v === 'string') {
      try {
        out[col.name] = JSON.parse(v);
      } catch {
        out[col.name] = v; // tampered/legacy data: return it verbatim rather than failing the whole request
      }
    } else out[col.name] = v;
  }
  return out;
}
