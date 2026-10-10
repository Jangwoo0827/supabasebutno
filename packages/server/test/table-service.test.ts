import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { projectMigrations } from '../src/db/migrations.js';
import { openSqlite, type SqliteDatabase } from '../src/db/sqlite/driver.js';
import { sqliteSchemaDriver } from '../src/db/sqlite/schema.js';
import { AppError } from '../src/core/errors.js';
import { TableService } from '../src/schema/service.js';
import type { CreateTableInput } from '../src/schema/types.js';

let db: SqliteDatabase;
let tables: TableService;

beforeEach(async () => {
  db = openSqlite(':memory:');
  await migrate(db, projectMigrations); // creates reserved _meta / _migrations tables
  tables = new TableService(db, sqliteSchemaDriver);
});

const todos: CreateTableInput = {
  name: 'todos',
  columns: [
    { name: 'id', type: 'integer', primary_key: true },
    { name: 'title', type: 'text', not_null: true, default: "it's a default" },
    { name: 'done', type: 'boolean', not_null: true, default: false },
    { name: 'priority', type: 'real', default: -1.5 },
    { name: 'email', type: 'text', unique: true },
    { name: 'meta', type: 'json', default: '{}' },
    { name: 'created_at', type: 'timestamp', default: { fn: 'now' } },
  ],
};

async function expectError(p: Promise<unknown>, status: number, code: string) {
  const err = await p.then(
    () => undefined,
    (e) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect({ status: err.status, code: err.code }).toEqual({ status, code });
}

describe('TableService.create / get', () => {
  it('round-trips the schema through introspection', async () => {
    await tables.create(todos);
    const t = await tables.get('todos');
    const col = (n: string) => t.columns.find((c) => c.name === n)!;

    expect(t.columns.map((c) => c.name)).toEqual(todos.columns.map((c) => c.name));
    expect(col('id')).toMatchObject({ type: 'integer', primary_key: true, not_null: true });
    expect(col('title')).toMatchObject({ type: 'text', not_null: true, default: "it's a default" });
    expect(col('done')).toMatchObject({ type: 'boolean', not_null: true, default: false });
    expect(col('priority')).toMatchObject({ type: 'real', default: -1.5, not_null: false });
    expect(col('email')).toMatchObject({ unique: true, primary_key: false });
    expect(col('meta')).toMatchObject({ type: 'json', default: '{}' });
    expect(col('created_at')).toMatchObject({ type: 'timestamp', default: { fn: 'now' } });
    expect(col('title').unique).toBe(false);
  });

  it('server-side defaults actually fire', async () => {
    await tables.create({
      name: 'items',
      columns: [
        { name: 'id', type: 'uuid', primary_key: true, default: { fn: 'uuid' } },
        { name: 'created_at', type: 'timestamp', default: { fn: 'now' } },
      ],
    });
    await db.exec('INSERT INTO items DEFAULT VALUES');
    const row = (await db.get<{ id: string; created_at: string }>('SELECT * FROM items'))!;
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect((await tables.get('items')).columns[0]!.default).toEqual({ fn: 'uuid' });
  });

  it('integer primary keys auto-increment and never reuse ids', async () => {
    await tables.create({ name: 't', columns: [{ name: 'id', type: 'integer', primary_key: true }] });
    await db.exec('INSERT INTO t DEFAULT VALUES; INSERT INTO t DEFAULT VALUES;');
    await db.exec('DELETE FROM t WHERE id = 2; INSERT INTO t DEFAULT VALUES;');
    expect((await db.all<{ id: number }>('SELECT id FROM t ORDER BY id')).map((r) => r.id)).toEqual([1, 3]);
  });

  it('stores hostile default strings as data', async () => {
    const evil = `x'); DROP TABLE _meta; --`;
    await tables.create({
      name: 'safe',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'note', type: 'text', default: evil },
      ],
    });
    await db.exec('INSERT INTO safe DEFAULT VALUES');
    expect((await db.get<{ note: string }>('SELECT note FROM safe'))!.note).toBe(evil);
    expect(await db.get(`SELECT 1 AS x FROM sqlite_master WHERE name = '_meta'`)).toBeTruthy();
  });

  it('rejects duplicates with 409 and unknown tables with 404', async () => {
    await tables.create(todos);
    await expectError(tables.create(todos), 409, 'table_exists');
    await expectError(tables.get('nope'), 404, 'not_found');
  });

  it('lists tables alphabetically', async () => {
    await tables.create({ ...todos, name: 'zebra' });
    await tables.create({ ...todos, name: 'apple' });
    expect((await tables.list()).map((t) => t.name)).toEqual(['apple', 'zebra']);
  });
});

describe('internal tables are unreachable', () => {
  it('hides _-prefixed and sqlite_ tables from every operation', async () => {
    await tables.create(todos); // creates sqlite_sequence as a side effect
    expect((await tables.list()).map((t) => t.name)).toEqual(['todos']);

    for (const name of ['_meta', '_migrations', 'sqlite_master', 'sqlite_sequence']) {
      await expectError(tables.get(name), 404, 'not_found');
      await expectError(tables.drop(name), 404, 'not_found');
      await expectError(tables.alter(name, { drop_columns: ['value'] }), 404, 'not_found');
    }
    expect(await db.get(`SELECT 1 AS x FROM _meta LIMIT 1`).catch(() => 'missing')).not.toBe('missing');
  });

  it('ignores tables that violate the naming rules (created outside the API)', async () => {
    await db.exec('CREATE TABLE "Legacy" (x INTEGER)');
    expect((await tables.list()).map((t) => t.name)).toEqual([]);
    await expectError(tables.get('Legacy'), 404, 'not_found');
  });
});

describe('TableService.alter', () => {
  beforeEach(async () => {
    await tables.create(todos);
    await db.exec(`INSERT INTO todos (title, email) VALUES ('a', 'a@x.io')`);
  });

  it('adds columns with a constant default, backfilling existing rows', async () => {
    const t = await tables.alter('todos', {
      add_columns: [
        { name: 'tag', type: 'text', not_null: true, default: 'none' },
        { name: 'score', type: 'integer' },
      ],
    });
    expect(t.columns.map((c) => c.name).slice(-2)).toEqual(['tag', 'score']);
    expect((await db.get<{ tag: string }>('SELECT tag FROM todos'))!.tag).toBe('none');
  });

  it('renames and drops columns, keeping data', async () => {
    const t = await tables.alter('todos', {
      rename_columns: [{ from: 'title', to: 'name' }],
      drop_columns: ['priority'],
    });
    const names = t.columns.map((c) => c.name);
    expect(names).toContain('name');
    expect(names).not.toContain('title');
    expect(names).not.toContain('priority');
    expect((await db.get<{ name: string }>('SELECT name FROM todos'))!.name).toBe('a');
  });

  it('applies operations in order: add, rename, drop, rename table', async () => {
    const t = await tables.alter('todos', {
      add_columns: [{ name: 'tmp', type: 'text' }],
      rename_columns: [{ from: 'tmp', to: 'tmp2' }],
      drop_columns: ['tmp2'],
      rename_to: 'tasks',
    });
    expect(t.name).toBe('tasks');
    expect(t.columns.map((c) => c.name)).not.toContain('tmp2');
    await expectError(tables.get('todos'), 404, 'not_found');
    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks'))!.n).toBe(1);
  });

  it('renaming a table keeps its autoincrement counter', async () => {
    await tables.alter('todos', { rename_to: 'tasks' });
    await db.exec(`INSERT INTO tasks (title) VALUES ('b')`);
    expect((await db.get<{ id: number }>('SELECT MAX(id) AS id FROM tasks'))!.id).toBe(2);
  });

  it('refuses invalid alterations with precise errors', async () => {
    await expectError(tables.alter('todos', { drop_columns: ['id'] }), 422, 'column_in_use');
    await expectError(tables.alter('todos', { drop_columns: ['email'] }), 422, 'column_in_use');
    await expectError(tables.alter('todos', { drop_columns: ['ghost'] }), 422, 'column_not_found');
    await expectError(tables.alter('todos', { rename_columns: [{ from: 'ghost', to: 'x' }] }), 422, 'column_not_found');
    await expectError(tables.alter('todos', { rename_columns: [{ from: 'title', to: 'done' }] }), 409, 'column_exists');
    await expectError(tables.alter('todos', { add_columns: [{ name: 'title', type: 'text' }] }), 409, 'column_exists');
    await tables.create({ ...todos, name: 'other' });
    await expectError(tables.alter('other', { rename_to: 'todos' }), 409, 'table_exists');
    await expectError(tables.alter('missing', { drop_columns: ['x'] }), 404, 'not_found');
  });

  it('cannot remove the last column (only reachable for tables created outside the API)', async () => {
    await db.exec('CREATE TABLE ext (a INTEGER)');
    await expectError(tables.alter('ext', { drop_columns: ['a'] }), 422, 'no_columns_left');
  });

  it('is atomic: a failure part-way leaves the table untouched', async () => {
    // An index created outside the API makes SQLite refuse the drop at execution time,
    // after the preceding ADD COLUMN statement already ran.
    await db.exec('CREATE INDEX idx_priority ON todos (priority)');
    const before = await tables.get('todos');
    await expectError(
      tables.alter('todos', { add_columns: [{ name: 'extra', type: 'text' }], drop_columns: ['priority'] }),
      422,
      'alter_failed',
    );
    expect(await tables.get('todos')).toEqual(before);
  });
});

describe('TableService.drop', () => {
  it('drops a table, and 404s afterwards', async () => {
    await tables.create(todos);
    await tables.drop('todos');
    await expectError(tables.get('todos'), 404, 'not_found');
    await expectError(tables.drop('todos'), 404, 'not_found');
  });
});
