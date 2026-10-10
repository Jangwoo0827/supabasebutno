/**
 * Database access abstraction. Everything above this layer (registry, schema
 * service, later the REST query builder) talks only to these interfaces, so a
 * Postgres driver can be added without touching the callers.
 *
 * The interface is async even though better-sqlite3 is synchronous.
 */

export type SqlValue = string | number | bigint | Uint8Array | null;
export type Row = Record<string, unknown>;

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/** Dialect-specific bits the SQL generators need. */
export interface Dialect {
  readonly name: 'sqlite';
  /** Quote an identifier. Callers must still validate names; this is defense in depth. */
  quoteIdent(name: string): string;
  /** Positional placeholder for the n-th (1-based) bound parameter. */
  placeholder(n: number): string;
  /** True if the error is a UNIQUE / PRIMARY KEY constraint violation. */
  isUniqueViolation(err: unknown): boolean;
}

export interface Database {
  readonly dialect: Dialect;
  /** Always use bound parameters (`params`); never interpolate values into `sql`. */
  all<T = Row>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  get<T = Row>(sql: string, params?: readonly SqlValue[]): Promise<T | undefined>;
  run(sql: string, params?: readonly SqlValue[]): Promise<RunResult>;
  /** Run one or more statements without parameters (DDL / migrations). */
  exec(sql: string): Promise<void>;
  /**
   * Run `fn` atomically. Use the `tx` handle passed to `fn` for every query
   * inside the transaction — calling the outer object from inside `fn` waits
   * for the transaction to finish and therefore deadlocks.
   */
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
