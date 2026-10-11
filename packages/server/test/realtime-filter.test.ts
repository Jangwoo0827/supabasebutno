import { describe, expect, it } from 'vitest';
import { openSqlite, sqliteDialect } from '../src/db/sqlite/driver.js';
import { evalFilter, matchesFilters } from '../src/realtime/filter.js';
import { SqlParams, compileFilter } from '../src/rest/builder.js';
import { parseFilterString } from '../src/rest/parse.js';
import { AppError } from '../src/core/errors.js';
import type { TableInfo } from '../src/schema/types.js';

const col = (name: string, type: TableInfo['columns'][number]['type'], pk = false) => ({ name, type, primary_key: pk, not_null: pk, unique: false });
const table: TableInfo = { name: 't', columns: [col('id', 'integer', true), col('a', 'integer'), col('b', 'text'), col('flag', 'boolean')] };

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('subscription filters', () => {
  it('evaluate exactly like the SQL they are compiled to (thousands of random combinations)', async () => {
    const rand = rng(777);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const TEXTS = ['x', 'X', 'x_y', 'x%y', 'xay', 'Äb', 'äb', 'xy', ''];
    const INTS = [-2, 0, 1, 2, 3];

    // filter templates as a client would write them (URL-encoded where needed)
    const templates: (() => string)[] = [
      () => `a=${pick(['eq', 'neq', 'gt', 'gte', 'lt', 'lte'])}.${pick(INTS)}`,
      () => `a=${pick(['', 'not.'])}in.(${INTS.filter(() => rand() < 0.5).join(',')})`,
      () => `a=${pick(['', 'not.'])}is.null`,
      () => `b=${pick(['', 'not.'])}${pick(['like', 'ilike'])}.${encodeURIComponent(pick(['x*', '*y', 'x_y', 'x%y', '*', 'ä*', 'X*', '', 'x?y', '*_*']))}`,
      () => `b=${pick(['eq', 'neq', 'gt', 'lt'])}.${encodeURIComponent(pick(TEXTS))}`,
      () => `b=${pick(['', 'not.'])}in.(${TEXTS.filter(() => rand() < 0.4).map((s) => `"${s}"`).join(',')})`,
      () => `b=${pick(['', 'not.'])}is.null`,
      () => `flag=${pick(['is.true', 'is.false', 'eq.true', 'eq.false', 'not.is.true', 'is.null'])}`,
    ];

    const db = openSqlite(':memory:');
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, b TEXT, flag INTEGER)');
    const rows: Record<string, unknown>[] = [];
    const maybeNull = <T>(v: T) => (rand() < 0.2 ? null : v);
    for (let id = 1; id <= 60; id++) {
      const row = { id, a: maybeNull(pick(INTS)), b: maybeNull(pick(TEXTS)), flag: maybeNull(pick([0, 1])) };
      rows.push(row);
      await db.run('INSERT INTO t VALUES (?, ?, ?, ?)', [row.id, row.a as number, row.b as string, row.flag as number]);
    }

    let disagreements = 0;
    let selective = 0;
    for (let i = 0; i < 2500; i++) {
      const query = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(templates)()).join('&');
      let filters;
      try {
        filters = parseFilterString(query, table);
      } catch (e) {
        if (e instanceof AppError) continue; // a template produced something the parser rightly refuses
        throw e;
      }
      const p = new SqlParams(sqliteDialect);
      const where = filters.map((f) => compileFilter(f, p)).join(' AND ');
      const viaSql = (await db.all<{ id: number }>(`SELECT id FROM t ${where ? `WHERE ${where}` : ''} ORDER BY id`, p.values)).map((r) => r.id);
      const viaJs = rows.filter((r) => matchesFilters(filters, r)).map((r) => r.id as number);
      if (JSON.stringify(viaSql) !== JSON.stringify(viaJs)) {
        disagreements++;
        if (disagreements <= 3) console.error('MISMATCH', query, viaSql, viaJs);
      }
      if (viaSql.length > 0 && viaSql.length < rows.length) selective++;
    }
    expect(disagreements).toBe(0);
    expect(selective).toBeGreaterThan(600);
  });

  it('treat LIKE metacharacters in the pattern as literals, and only ASCII letters as case-insensitive', () => {
    const f = (q: string) => parseFilterString(q, table)[0]!;
    expect(evalFilter(f('b=like.x_y'), { b: 'x_y' })).toBe(true);
    expect(evalFilter(f('b=like.x_y'), { b: 'xay' })).toBe(false);
    expect(evalFilter(f(`b=like.${encodeURIComponent('x%y')}`), { b: 'xzzy' })).toBe(false);
    expect(evalFilter(f('b=like.ABC*'), { b: 'abcdef' })).toBe(true);
    expect(evalFilter(f(`b=like.${encodeURIComponent('Ä*')}`), { b: 'ä1' })).toBe(false); // non-ASCII case differs, as in SQLite
    expect(evalFilter(f('b=like.x*'), { b: null })).toBeNull();
  });

  it('empty IN matches nothing and its negation matches everything, even NULLs (as in the SQL)', () => {
    const f = (q: string) => parseFilterString(q, table)[0]!;
    expect(evalFilter(f('a=in.()'), { a: 1 })).toBe(false);
    expect(evalFilter(f('a=not.in.()'), { a: null })).toBe(true);
  });

  it('are validated like REST filters', () => {
    const code = (q: string) => {
      try {
        parseFilterString(q, table);
      } catch (e) {
        return (e as AppError).code;
      }
      return 'ok';
    };
    expect(code('ghost=eq.1')).toBe('unknown_column');
    expect(code('a=eq.abc')).toBe('invalid_filter_value');
    expect(code('a=bogus.1')).toBe('invalid_filter');
    expect(code('limit=5')).toBe('invalid_filter');
    expect(code('select=a')).toBe('invalid_filter');
    expect(code(Array(6).fill('a=eq.1').join('&'))).toBe('too_many_filters');
    expect(code('a=eq.1&b=like.x*')).toBe('ok');
    expect(code('')).toBe('ok');
  });
});
