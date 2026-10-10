import { describe, expect, it } from 'vitest';
import { alterTableSchema, createProjectSchema, createTableSchema, identifier } from '../src/schema/validation.js';

const pk = { name: 'id', type: 'integer', primary_key: true };
const table = (columns: unknown[], name = 'todos') => ({ name, columns });
const ok = (input: unknown) => createTableSchema.safeParse(input).success;
const messages = (input: unknown) => {
  const r = createTableSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe('identifier', () => {
  it.each(['todos', 'user_id', 'a', 'a1_b2', 'x'.repeat(63)])('accepts %s', (name) => {
    expect(identifier.safeParse(name).success).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['uppercase', 'Todos'],
    ['leading underscore (reserved for internal tables)', '_meta'],
    ['leading digit', '1abc'],
    ['space', 'a b'],
    ['SQL injection', 'a; DROP TABLE x'],
    ['quote', 'a"b'],
    ['single quote', "a'b"],
    ['dash', 'a-b'],
    ['unicode', 'tödos'],
    ['NUL byte', 'a\0b'],
    ['sqlite_ prefix', 'sqlite_master'],
    ['too long', 'x'.repeat(64)],
    ['newline', 'a\nb'],
  ])('rejects %s', (_label, name) => {
    expect(identifier.safeParse(name).success).toBe(false);
  });
});

describe('createTableSchema', () => {
  it('accepts a typical table', () => {
    expect(
      ok(
        table([
          pk,
          { name: 'title', type: 'text', not_null: true },
          { name: 'done', type: 'boolean', not_null: true, default: false },
          { name: 'created_at', type: 'timestamp', default: { fn: 'now' } },
          { name: 'email', type: 'text', unique: true },
          { name: 'meta', type: 'json', default: '{}' },
        ]),
      ),
    ).toBe(true);
  });

  it('accepts a uuid primary key with a generated default', () => {
    expect(ok(table([{ name: 'id', type: 'uuid', primary_key: true, default: { fn: 'uuid' } }]))).toBe(true);
  });

  it('requires exactly one primary key', () => {
    expect(ok(table([{ name: 'a', type: 'text' }]))).toBe(false);
    expect(ok(table([pk, { name: 'b', type: 'integer', primary_key: true }]))).toBe(false);
  });

  it('rejects primary keys of unsuitable type, or also marked unique', () => {
    expect(ok(table([{ name: 'id', type: 'real', primary_key: true }]))).toBe(false);
    expect(ok(table([{ name: 'id', type: 'json', primary_key: true }]))).toBe(false);
    expect(ok(table([{ ...pk, unique: true }]))).toBe(false);
  });

  it('rejects duplicate column names', () => {
    expect(ok(table([pk, { name: 'a', type: 'text' }, { name: 'a', type: 'text' }]))).toBe(false);
  });

  it('rejects unknown column types and unknown keys', () => {
    expect(ok(table([pk, { name: 'a', type: 'varchar' }]))).toBe(false);
    expect(ok(table([pk, { name: 'a', type: 'text', check: '1=1' }]))).toBe(false);
    expect(ok({ ...table([pk]), extra: 1 })).toBe(false);
  });

  it('rejects empty or oversized column lists', () => {
    expect(ok(table([]))).toBe(false);
    expect(ok(table(Array.from({ length: 201 }, (_, i) => ({ name: `c${i}`, type: 'text', primary_key: i === 0 }))))).toBe(false);
  });

  it.each([
    ['integer default must be integer', { name: 'a', type: 'integer', default: 1.5 }],
    ['integer default must be a number', { name: 'a', type: 'integer', default: '1' }],
    ['real default must be a number', { name: 'a', type: 'real', default: 'x' }],
    ['boolean default must be boolean', { name: 'a', type: 'boolean', default: 1 }],
    ['text default must be string', { name: 'a', type: 'text', default: 5 }],
    ['json default must be valid JSON', { name: 'a', type: 'json', default: '{oops' }],
    ['now only for timestamp', { name: 'a', type: 'text', default: { fn: 'now' } }],
    ['uuid only for uuid', { name: 'a', type: 'text', default: { fn: 'uuid' } }],
    ['unknown fn', { name: 'a', type: 'text', default: { fn: 'shell' } }],
    ['NOT NULL cannot default to null', { name: 'a', type: 'text', not_null: true, default: null }],
    ['NUL in string default', { name: 'a', type: 'text', default: 'a\0b' }],
    ['non-finite number', { name: 'a', type: 'real', default: 1e999 }],
  ])('defaults: %s', (_label, col) => {
    expect(ok(table([pk, col]))).toBe(false);
  });

  it('forbids a default on an auto-incrementing integer primary key', () => {
    expect(messages(table([{ ...pk, default: 5 }])).join()).toMatch(/auto-incremented/);
  });

  it('allows a nullable default null and SQL-looking string defaults (they are data, not code)', () => {
    expect(ok(table([pk, { name: 'a', type: 'text', default: null }]))).toBe(true);
    expect(ok(table([pk, { name: 'a', type: 'text', default: `x'); DROP TABLE y; --` }]))).toBe(true);
  });
});

describe('alterTableSchema', () => {
  const ok = (input: unknown) => alterTableSchema.safeParse(input).success;

  it('requires at least one operation', () => {
    expect(ok({})).toBe(false);
  });

  it('accepts each operation', () => {
    expect(ok({ add_columns: [{ name: 'c', type: 'text' }] })).toBe(true);
    expect(ok({ rename_columns: [{ from: 'a', to: 'b' }] })).toBe(true);
    expect(ok({ drop_columns: ['a'] })).toBe(true);
    expect(ok({ rename_to: 'new_name' })).toBe(true);
  });

  it('cannot add primary key or unique columns (SQLite limitation)', () => {
    expect(ok({ add_columns: [{ name: 'c', type: 'text', primary_key: true }] })).toBe(false);
    expect(ok({ add_columns: [{ name: 'c', type: 'text', unique: true }] })).toBe(false);
  });

  it('cannot add columns with function defaults', () => {
    expect(ok({ add_columns: [{ name: 'c', type: 'timestamp', default: { fn: 'now' } }] })).toBe(false);
  });

  it('a NOT NULL column needs a non-null default', () => {
    expect(ok({ add_columns: [{ name: 'c', type: 'text', not_null: true }] })).toBe(false);
    expect(ok({ add_columns: [{ name: 'c', type: 'text', not_null: true, default: '' }] })).toBe(true);
  });

  it('validates every name', () => {
    expect(ok({ rename_to: '_hidden' })).toBe(false);
    expect(ok({ drop_columns: ['A;B'] })).toBe(false);
    expect(ok({ rename_columns: [{ from: 'a', to: 'b b' }] })).toBe(false);
  });
});

describe('createProjectSchema', () => {
  it('trims and bounds the name', () => {
    expect(createProjectSchema.parse({ name: '  My App  ' }).name).toBe('My App');
    expect(createProjectSchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(createProjectSchema.safeParse({ name: 'x'.repeat(65) }).success).toBe(false);
    expect(createProjectSchema.safeParse({ name: 'a\u0000b' }).success).toBe(false);
    expect(createProjectSchema.safeParse({ name: 'a', admin: true }).success).toBe(false);
  });
});
