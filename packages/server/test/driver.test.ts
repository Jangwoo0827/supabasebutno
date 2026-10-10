import { describe, expect, it } from 'vitest';
import { migrate, type Migration } from '../src/db/migrate.js';
import { openSqlite, sqliteDialect } from '../src/db/sqlite/driver.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('sqlite driver', () => {
  it('binds parameters and never interprets them as SQL', async () => {
    const db = openSqlite(':memory:');
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    const evil = `x'); DROP TABLE t; --`;
    await db.run('INSERT INTO t (name) VALUES (?)', [evil]);
    expect(await db.all('SELECT name FROM t')).toEqual([{ name: evil }]);
    expect(await db.get('SELECT name FROM t WHERE name = ?', ['nope'])).toBeUndefined();
  });

  it('commits a transaction and rolls back when the callback throws', async () => {
    const db = openSqlite(':memory:');
    await db.exec('CREATE TABLE t (x INTEGER)');
    await db.transaction(async (tx) => {
      await tx.run('INSERT INTO t VALUES (1)');
    });
    await expect(
      db.transaction(async (tx) => {
        await tx.run('INSERT INTO t VALUES (2)');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.all('SELECT x FROM t')).toEqual([{ x: 1 }]);
  });

  it('keeps other queries out of an open transaction (they wait, then run on their own)', async () => {
    const db = openSqlite(':memory:');
    await db.exec('CREATE TABLE t (x INTEGER)');

    const tx = db.transaction(async (tx) => {
      await tx.run('INSERT INTO t VALUES (1)');
      await sleep(40);
      throw new Error('rollback me');
    });
    tx.catch(() => undefined);
    await sleep(5); // the transaction is now open and suspended
    const outside = db.run('INSERT INTO t VALUES (2)'); // must NOT join the transaction
    await expect(tx).rejects.toThrow('rollback me');
    await outside;

    expect(await db.all('SELECT x FROM t')).toEqual([{ x: 2 }]);
  });

  it('serializes concurrent transactions', async () => {
    const db = openSqlite(':memory:');
    await db.exec('CREATE TABLE t (x INTEGER)');
    const order: string[] = [];
    const run = (label: string) =>
      db.transaction(async (tx) => {
        order.push(`${label}:start`);
        await tx.run('INSERT INTO t VALUES (1)');
        await sleep(10);
        order.push(`${label}:end`);
      });
    await Promise.all([run('a'), run('b'), run('c')]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('detects unique violations', async () => {
    const db = openSqlite(':memory:');
    await db.exec('CREATE TABLE t (x TEXT UNIQUE)');
    await db.run('INSERT INTO t VALUES (?)', ['a']);
    const err = await db.run('INSERT INTO t VALUES (?)', ['a']).catch((e) => e);
    expect(sqliteDialect.isUniqueViolation(err)).toBe(true);
    expect(sqliteDialect.isUniqueViolation(new Error('other'))).toBe(false);
  });

  it('quotes identifiers safely', () => {
    expect(sqliteDialect.quoteIdent('todos')).toBe('"todos"');
    expect(sqliteDialect.quoteIdent('a"b')).toBe('"a""b"');
    expect(() => sqliteDialect.quoteIdent('a\0b')).toThrow();
    expect(() => sqliteDialect.quoteIdent('')).toThrow();
  });
});

describe('migrate', () => {
  const m1: Migration = { version: 1, name: 'one', sql: 'CREATE TABLE a (x INTEGER);' };
  const m2: Migration = { version: 2, name: 'two', sql: 'CREATE TABLE b (x INTEGER);' };

  it('applies pending migrations once and is idempotent', async () => {
    const db = openSqlite(':memory:');
    await migrate(db, [m1]);
    await migrate(db, [m1, m2]);
    await migrate(db, [m1, m2]);
    const rows = await db.all<{ version: number }>('SELECT version FROM _migrations ORDER BY version');
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
  });

  it('rolls back a failing migration and does not record it', async () => {
    const db = openSqlite(':memory:');
    const bad: Migration = { version: 2, name: 'bad', sql: 'CREATE TABLE c (x INTEGER); NOT VALID SQL;' };
    await migrate(db, [m1]);
    await expect(migrate(db, [m1, bad])).rejects.toThrow();
    expect(await db.get(`SELECT name FROM sqlite_master WHERE name = 'c'`)).toBeUndefined();
    expect((await db.get<{ v: number }>('SELECT MAX(version) AS v FROM _migrations'))?.v).toBe(1);
  });

  it('refuses a database that is newer than the code', async () => {
    const db = openSqlite(':memory:');
    await migrate(db, [m1, m2]);
    await expect(migrate(db, [m1])).rejects.toThrow(/newer/);
  });

  it('rejects out-of-order version numbers', async () => {
    const db = openSqlite(':memory:');
    await expect(migrate(db, [m2])).rejects.toThrow(/order/);
  });
});
