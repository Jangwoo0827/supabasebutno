import { z } from 'zod';
import { COLUMN_TYPES, type ColumnInput } from './types.js';

/**
 * Table / column names. Lowercase, must start with a letter (so `_`-prefixed
 * internal tables can never be created or touched through the API), max 63 chars.
 * The REST layer re-checks every name against the live schema as well.
 */
export const IDENTIFIER_RE = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * The single source of truth for "this is a name a user table may have".
 * `sqlite_*` is reserved by SQLite itself (sqlite_master, sqlite_sequence, ...).
 */
export const isUserTableName = (name: string): boolean => IDENTIFIER_RE.test(name) && !name.startsWith('sqlite_');

export const identifier = z
  .string()
  .regex(IDENTIFIER_RE, 'must match ^[a-z][a-z0-9_]{0,62}$ (lowercase letters, digits, underscore; start with a letter)')
  .refine((s) => !s.startsWith('sqlite_'), 'names starting with "sqlite_" are reserved');

const columnType = z.enum(COLUMN_TYPES);

const defaultValue = z.union([
  z.string().max(1000).refine((s) => !s.includes('\0'), 'must not contain NUL'),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.strictObject({ fn: z.enum(['now', 'uuid']) }),
]);

const columnShape = {
  name: identifier,
  type: columnType,
  primary_key: z.boolean().optional(),
  not_null: z.boolean().optional(),
  unique: z.boolean().optional(),
  default: defaultValue.optional(),
};

const columnSchema = z.strictObject(columnShape);
const addColumnSchema = z.strictObject({
  name: columnShape.name,
  type: columnShape.type,
  not_null: columnShape.not_null,
  default: columnShape.default,
});

type Issue = (path: (string | number)[], message: string) => void;

/** Cross-field rules for a single column (type vs default, primary-key constraints). */
function checkColumn(col: Omit<ColumnInput, 'name'> & { name: string }, path: (string | number)[], issue: Issue) {
  if (col.primary_key) {
    if (!['integer', 'text', 'uuid'].includes(col.type)) issue([...path, 'type'], 'a primary key must be integer, text or uuid');
    if (col.unique) issue([...path, 'unique'], 'a primary key is already unique');
  }
  const d = col.default;
  if (d === undefined) return;

  if (col.primary_key && col.type === 'integer') {
    issue([...path, 'default'], 'an integer primary key is auto-incremented and cannot have a default');
    return;
  }
  if (d === null) {
    if (col.primary_key || col.not_null) issue([...path, 'default'], 'a NOT NULL column cannot default to null');
    return;
  }
  if (typeof d === 'object') {
    if (d.fn === 'now' && col.type !== 'timestamp') issue([...path, 'default'], '{"fn":"now"} is only valid for timestamp columns');
    if (d.fn === 'uuid' && col.type !== 'uuid') issue([...path, 'default'], '{"fn":"uuid"} is only valid for uuid columns');
    return;
  }
  switch (col.type) {
    case 'integer':
      if (typeof d !== 'number' || !Number.isSafeInteger(d)) issue([...path, 'default'], 'default must be an integer');
      break;
    case 'real':
      if (typeof d !== 'number') issue([...path, 'default'], 'default must be a number');
      break;
    case 'boolean':
      if (typeof d !== 'boolean') issue([...path, 'default'], 'default must be true or false');
      break;
    case 'json':
      if (typeof d !== 'string') {
        issue([...path, 'default'], 'default must be a JSON string, e.g. "{}"');
      } else {
        try {
          JSON.parse(d);
        } catch {
          issue([...path, 'default'], 'default is not valid JSON');
        }
      }
      break;
    default:
      if (typeof d !== 'string') issue([...path, 'default'], 'default must be a string');
  }
}

export const createTableSchema = z
  .strictObject({
    name: identifier,
    columns: z.array(columnSchema).min(1).max(200),
  })
  .superRefine((t, ctx) => {
    const issue: Issue = (path, message) => ctx.addIssue({ code: 'custom', path, message });
    const seen = new Set<string>();
    t.columns.forEach((c, i) => {
      if (seen.has(c.name)) issue(['columns', i, 'name'], `duplicate column "${c.name}"`);
      seen.add(c.name);
      checkColumn(c, ['columns', i], issue);
    });
    const pks = t.columns.filter((c) => c.primary_key).length;
    if (pks !== 1) issue(['columns'], `exactly one column must have primary_key: true (found ${pks})`);
  });

export const alterTableSchema = z
  .strictObject({
    add_columns: z.array(addColumnSchema).min(1).max(50).optional(),
    rename_columns: z.array(z.strictObject({ from: identifier, to: identifier })).min(1).max(50).optional(),
    drop_columns: z.array(identifier).min(1).max(50).optional(),
    rename_to: identifier.optional(),
  })
  .superRefine((t, ctx) => {
    const issue: Issue = (path, message) => ctx.addIssue({ code: 'custom', path, message });
    if (!t.add_columns && !t.rename_columns && !t.drop_columns && !t.rename_to) {
      issue([], 'provide at least one of add_columns, rename_columns, drop_columns, rename_to');
    }
    t.add_columns?.forEach((c, i) => {
      const path = ['add_columns', i];
      checkColumn(c, path, issue);
      // SQLite's ALTER TABLE ADD COLUMN only accepts constant defaults.
      if (c.default !== null && typeof c.default === 'object') {
        issue([...path, 'default'], 'function defaults (now/uuid) can only be used when the table is created');
      }
      if (c.not_null && (c.default === undefined || c.default === null)) {
        issue([...path, 'not_null'], 'a NOT NULL column added to an existing table needs a non-null default');
      }
    });
  });

export const createProjectSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[^\p{Cc}]+$/u, 'must not contain control characters'),
});
