import BetterSqlite3 from 'better-sqlite3';
import type { Database, Dialect, Row, RunResult, SqlValue } from '../driver.js';

export const sqliteDialect: Dialect = {
  name: 'sqlite',
  quoteIdent(name) {
    if (name.length === 0 || name.includes('\0')) throw new Error('Invalid identifier');
    return `"${name.replaceAll('"', '""')}"`;
  },
  placeholder: () => '?',
  isUniqueViolation(err) {
    const code = (err as { code?: unknown } | null)?.code;
    return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
  },
};

function bind(params: readonly SqlValue[]): unknown[] {
  return params.map((p) => (p instanceof Uint8Array && !Buffer.isBuffer(p) ? Buffer.from(p) : p));
}

const allSync = <T>(raw: BetterSqlite3.Database, sql: string, params: readonly SqlValue[]) =>
  raw.prepare(sql).all(...bind(params)) as T[];
const getSync = <T>(raw: BetterSqlite3.Database, sql: string, params: readonly SqlValue[]) =>
  raw.prepare(sql).get(...bind(params)) as T | undefined;
const runSync = (raw: BetterSqlite3.Database, sql: string, params: readonly SqlValue[]): RunResult => {
  const r = raw.prepare(sql).run(...bind(params));
  return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
};

/** Handle passed to transaction callbacks: runs directly, bypassing the transaction gate. */
class SqliteTx implements Database {
  readonly dialect = sqliteDialect;
  constructor(private readonly raw: BetterSqlite3.Database) {}

  async all<T = Row>(sql: string, params: readonly SqlValue[] = []) {
    return allSync<T>(this.raw, sql, params);
  }
  async get<T = Row>(sql: string, params: readonly SqlValue[] = []) {
    return getSync<T>(this.raw, sql, params);
  }
  async run(sql: string, params: readonly SqlValue[] = []) {
    return runSync(this.raw, sql, params);
  }
  async exec(sql: string) {
    this.raw.exec(sql);
  }
  /** Nested call joins the surrounding transaction. */
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    return fn(this);
  }
  async close(): Promise<void> {
    throw new Error('Cannot close a database from inside a transaction');
  }
}

export class SqliteDatabase implements Database {
  readonly dialect = sqliteDialect;
  /**
   * better-sqlite3 has a single connection, so while an async transaction is
   * open any other query on this object would silently become part of it.
   * Every non-transactional call therefore waits for `gate`, and each
   * transaction replaces `gate` with a promise that resolves when it ends.
   */
  private gate: Promise<void> = Promise.resolve();

  constructor(private readonly raw: BetterSqlite3.Database) {}

  async all<T = Row>(sql: string, params: readonly SqlValue[] = []) {
    await this.gate;
    return allSync<T>(this.raw, sql, params);
  }
  async get<T = Row>(sql: string, params: readonly SqlValue[] = []) {
    await this.gate;
    return getSync<T>(this.raw, sql, params);
  }
  async run(sql: string, params: readonly SqlValue[] = []) {
    await this.gate;
    return runSync(this.raw, sql, params);
  }
  async exec(sql: string) {
    await this.gate;
    this.raw.exec(sql);
  }

  async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    const previous = this.gate;
    let release!: () => void;
    this.gate = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(new SqliteTx(this.raw));
        this.raw.exec('COMMIT');
        return result;
      } catch (err) {
        if (this.raw.inTransaction) this.raw.exec('ROLLBACK');
        throw err;
      }
    } finally {
      release();
    }
  }

  async close() {
    await this.gate;
    this.raw.close();
  }
}

/** Open (or create) a SQLite database file. Use ':memory:' for tests. */
export function openSqlite(file: string): SqliteDatabase {
  const raw = new BetterSqlite3(file);
  raw.pragma('journal_mode = WAL');
  raw.pragma('synchronous = NORMAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 5000');
  return new SqliteDatabase(raw);
}
