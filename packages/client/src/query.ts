import { SbbError, toError } from './errors.js';
import type { Http } from './http.js';
import type { Row } from './types.js';

export interface QueryResult<D> {
  data: D | null;
  error: SbbError | null;
  /** Total matching rows, when requested with `{ count: 'exact' }`. */
  count: number | null;
  /** HTTP status of the request (0 if it never reached the server). */
  status: number;
}

type Method = 'select' | 'insert' | 'upsert' | 'update' | 'delete';
type Scalar = string | number | boolean | bigint | Date;

/** `a b` -> `"a b"`; plain tokens are left alone. Used for `in (...)` lists. */
function listItem(v: Scalar): string {
  const s = scalar(v);
  return s === '' || /[,"()\s\\]/.test(s) ? `"${s.replace(/[\\"]/g, '\\$&')}"` : s;
}

function scalar(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  throw new TypeError(`Unsupported filter value: ${v === null ? 'null (use .is(column, null))' : typeof v}`);
}

/**
 * A database query. Add filters and options, then `await` it: it resolves to
 * `{ data, error, count, status }` and does not throw for server errors.
 */
export class QueryBuilder<T extends Row = Row, D = T[]> implements PromiseLike<QueryResult<D>> {
  private readonly params = new URLSearchParams();
  private columns = '*';
  private orders: string[] = [];
  private limitValue: number | undefined;
  private offsetValue: number | undefined;
  private wantCount = false;
  private returning = false;
  private mode: 'many' | 'single' | 'maybeSingle' = 'many';
  private argumentError: unknown;

  /** @internal use `client.from(table)` instead. */
  constructor(
    private readonly http: Http,
    private readonly table: string,
    private readonly method: Method,
    private readonly body?: unknown,
    private readonly writeOptions: { onConflict?: string; ignoreDuplicates?: boolean } = {},
  ) {}

  // ---- what to return --------------------------------------------------------

  /** For reads: the columns to return (`'id,title'`; default all). After insert/update/delete/upsert: return the affected rows. */
  select(columns = '*', options: { count?: 'exact' } = {}): this {
    this.columns = columns.replace(/\s+/g, '');
    this.returning = true;
    if (options.count === 'exact') this.wantCount = true;
    return this;
  }

  // ---- filters (all combined with AND) -----------------------------------------

  eq(column: string, value: Scalar): this {
    return this.add(column, 'eq', () => scalar(value));
  }
  neq(column: string, value: Scalar): this {
    return this.add(column, 'neq', () => scalar(value));
  }
  gt(column: string, value: Scalar): this {
    return this.add(column, 'gt', () => scalar(value));
  }
  gte(column: string, value: Scalar): this {
    return this.add(column, 'gte', () => scalar(value));
  }
  lt(column: string, value: Scalar): this {
    return this.add(column, 'lt', () => scalar(value));
  }
  lte(column: string, value: Scalar): this {
    return this.add(column, 'lte', () => scalar(value));
  }

  /** Pattern match. `%` and `*` are wildcards; `_` is a literal underscore here (unlike Postgres). Case-insensitive for ASCII. */
  like(column: string, pattern: string): this {
    return this.add(column, 'like', () => pattern.replaceAll('%', '*'));
  }
  ilike(column: string, pattern: string): this {
    return this.add(column, 'ilike', () => pattern.replaceAll('%', '*'));
  }

  in(column: string, values: Scalar[]): this {
    return this.add(column, 'in', () => `(${values.map(listItem).join(',')})`);
  }

  /** `null`, `true` or `false`. */
  is(column: string, value: null | boolean): this {
    return this.add(column, 'is', () => (value === null ? 'null' : String(value)));
  }

  /** Negates any operator: `.not('done', 'eq', true)`, `.not('email', 'is', null)`, `.not('id', 'in', [1, 2])`. */
  not(column: string, operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'in' | 'is', value: Scalar | Scalar[] | null): this {
    return this.add(column, `not.${operator}`, () =>
      operator === 'in'
        ? `(${(value as Scalar[]).map(listItem).join(',')})`
        : operator === 'is'
          ? String(value)
          : operator === 'like' || operator === 'ilike'
            ? String(value).replaceAll('%', '*')
            : scalar(value),
    );
  }

  /** Equality on several columns at once. */
  match(values: Record<string, Scalar>): this {
    for (const [column, value] of Object.entries(values)) this.eq(column, value);
    return this;
  }

  /** Any operator by name, for when you build filters dynamically: `.filter('score', 'gte', 10)`. */
  filter(column: string, operator: string, value: Scalar | null): this {
    return this.add(column, operator, () => (value === null ? 'null' : scalar(value)));
  }

  // ---- shape of the result -------------------------------------------------------

  order(column: string, options: { ascending?: boolean; nullsFirst?: boolean } = {}): this {
    let term = `${column}.${options.ascending === false ? 'desc' : 'asc'}`;
    if (options.nullsFirst !== undefined) term += options.nullsFirst ? '.nullsfirst' : '.nullslast';
    this.orders.push(term);
    return this;
  }

  limit(count: number): this {
    this.limitValue = count;
    return this;
  }

  /** Rows `from` to `to`, both inclusive and zero-based: `.range(0, 9)` is the first ten. */
  range(from: number, to: number): this {
    this.offsetValue = from;
    this.limitValue = to - from + 1;
    return this;
  }

  /** Expect exactly one row: `data` is that row, or `error.code === 'not_single'` for zero or several. */
  single(): QueryBuilder<T, T> {
    this.mode = 'single';
    return this as unknown as QueryBuilder<T, T>;
  }

  /** Like single(), but zero rows is fine: `data` is the row or null. */
  maybeSingle(): QueryBuilder<T, T | null> {
    this.mode = 'maybeSingle';
    return this as unknown as QueryBuilder<T, T | null>;
  }

  // ---- execution -----------------------------------------------------------------

  then<R1 = QueryResult<D>, R2 = never>(
    onfulfilled?: ((value: QueryResult<D>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  /** An invalid argument is remembered and reported by the awaited result, so builder calls themselves never throw. */
  private add(column: string, operator: string, value: () => string): this {
    try {
      this.params.append(column, `${operator}.${value()}`);
    } catch (err) {
      this.argumentError ??= err;
    }
    return this;
  }

  private async execute(): Promise<QueryResult<D>> {
    try {
      return await this.run();
    } catch (err) {
      // Anything thrown here is either a server/network error or a bad argument (e.g. an unsupported filter value).
      return { data: null, error: toError(err), count: null, status: err instanceof SbbError ? err.status : 0 };
    }
  }

  private async run(): Promise<QueryResult<D>> {
    if (this.argumentError !== undefined) throw this.argumentError;
    const isRead = this.method === 'select';
    // Writes always affect every matching row. Dropping a `limit` would silently change a one-row update
    // into a mass update, so refuse instead of ignoring it.
    if (!isRead && (this.limitValue !== undefined || this.offsetValue !== undefined || this.orders.length > 0)) {
      throw new SbbError('limit(), range() and order() only apply to reads; narrow an update or delete with filters instead', 'unsupported_modifier', 0);
    }

    const query = new URLSearchParams(this.params);
    const headers: Record<string, string> = {};
    const prefer: string[] = [];

    if (this.columns !== '*') query.set('select', this.columns);
    if (this.orders.length) query.set('order', this.orders.join(','));
    // One extra row is enough to tell "exactly one" from "several".
    const limit = this.mode === 'many' ? this.limitValue : Math.min(this.limitValue ?? 2, 2);
    if (limit !== undefined && isRead) query.set('limit', String(limit));
    if (this.offsetValue !== undefined && isRead) query.set('offset', String(this.offsetValue));
    if (this.wantCount && isRead) prefer.push('count=exact');
    if (!isRead && this.returning) prefer.push('return=representation');
    if (this.method === 'upsert') {
      prefer.push(this.writeOptions.ignoreDuplicates ? 'resolution=ignore-duplicates' : 'resolution=merge-duplicates');
      if (this.writeOptions.onConflict) query.set('on_conflict', this.writeOptions.onConflict);
    }
    if (prefer.length) headers.Prefer = prefer.join(',');

    const verb = { select: 'GET', insert: 'POST', upsert: 'POST', update: 'PATCH', delete: 'DELETE' }[this.method];
    const res = await this.http.request({
      method: verb,
      path: `/rest/${encodeURIComponent(this.table)}`,
      query,
      headers,
      json: this.body,
      responseType: isRead || this.returning ? 'json' : 'none',
    });

    const total = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1];
    const count = total !== undefined ? Number(total) : null;
    const rows = (res.data ?? null) as T[] | null;

    if (this.mode !== 'many' && rows) {
      if (rows.length === 1 || (rows.length === 0 && this.mode === 'maybeSingle')) {
        return { data: (rows[0] ?? null) as unknown as D, error: null, count, status: res.status };
      }
      const err = new SbbError(`Expected a single row but the query matched ${rows.length >= 2 ? 'several' : 'none'}`, 'not_single', res.status);
      return { data: null, error: err, count, status: res.status };
    }
    return { data: rows as D | null, error: null, count, status: res.status };
  }
}

/** Entry point for one table: `client.from('todos')`. */
export class TableClient<T extends Row = Row> {
  constructor(
    private readonly http: Http,
    private readonly table: string,
  ) {}

  select(columns = '*', options: { count?: 'exact' } = {}): QueryBuilder<T> {
    return new QueryBuilder<T>(this.http, this.table, 'select').select(columns, options);
  }

  /** Insert one row or an array of rows (atomically). Chain `.select()` to get the stored rows back. */
  insert(values: Partial<T> | Partial<T>[]): QueryBuilder<T> {
    return new QueryBuilder<T>(this.http, this.table, 'insert', values);
  }

  /** Insert, or update the existing row with the same key (the primary key unless `onConflict` names a UNIQUE column). */
  upsert(values: Partial<T> | Partial<T>[], options: { onConflict?: string; ignoreDuplicates?: boolean } = {}): QueryBuilder<T> {
    return new QueryBuilder<T>(this.http, this.table, 'upsert', values, options);
  }

  /** Update the rows matching the filters you add afterwards. At least one filter is required. */
  update(values: Partial<T>): QueryBuilder<T> {
    return new QueryBuilder<T>(this.http, this.table, 'update', values);
  }

  /** Delete the rows matching the filters you add afterwards. At least one filter is required. */
  delete(): QueryBuilder<T> {
    return new QueryBuilder<T>(this.http, this.table, 'delete');
  }
}
