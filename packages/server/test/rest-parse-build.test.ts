import { describe, expect, it } from 'vitest';
import { sqliteDialect } from '../src/db/sqlite/driver.js';
import { AppError } from '../src/core/errors.js';
import { buildCount, buildDelete, buildInsert, buildSelect, buildUpdate, SqlParams } from '../src/rest/builder.js';
import { parseQuery, splitList } from '../src/rest/parse.js';
import { coerceFilterValue, coerceWriteValue, decodeRow } from '../src/rest/values.js';
import type { TableInfo } from '../src/schema/types.js';

const table: TableInfo = {
  name: 'todos',
  columns: [
    { name: 'id', type: 'integer', primary_key: true, not_null: true, unique: false },
    { name: 'title', type: 'text', primary_key: false, not_null: true, unique: false },
    { name: 'done', type: 'boolean', primary_key: false, not_null: true, unique: false },
    { name: 'score', type: 'real', primary_key: false, not_null: false, unique: false },
    { name: 'email', type: 'text', primary_key: false, not_null: false, unique: true },
    { name: 'meta', type: 'json', primary_key: false, not_null: false, unique: false },
    { name: 'at', type: 'timestamp', primary_key: false, not_null: false, unique: false },
    { name: 'ref', type: 'uuid', primary_key: false, not_null: false, unique: false },
  ],
};

const parse = (qs: string, mode: 'read' | 'write' | 'insert' = 'read') => parseQuery(new URLSearchParams(qs), table, mode);
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? e.code : `non-AppError: ${e}`;
  }
  return 'no error';
};
const d = sqliteDialect;

describe('splitList', () => {
  it('splits plain and quoted items', () => {
    expect(splitList('a,b,c')).toEqual(['a', 'b', 'c']);
    expect(splitList('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
    expect(splitList('"say \\"hi\\""')).toEqual(['say "hi"']);
    expect(splitList('')).toEqual([]);
    expect(splitList('a,')).toEqual(['a', '']);
    expect(() => splitList('"open')).toThrow();
  });
});

describe('parseQuery', () => {
  it('has safe defaults', () => {
    expect(parse('')).toEqual({ select: null, filters: [], order: [], limit: 1000, offset: 0 });
  });

  it('parses every filter operator with typed values', () => {
    const q = parse('id=gte.5&title=like.*milk*&done=is.true&score=lt.2.5&email=is.null&id=not.in.(1,2,3)&title=neq.a.b');
    expect(q.filters).toEqual([
      { column: 'id', op: 'gte', negate: false, value: 5 },
      { column: 'title', op: 'like', negate: false, value: '%milk%' },
      { column: 'done', op: 'is', negate: false, value: 1 },
      { column: 'score', op: 'lt', negate: false, value: 2.5 },
      { column: 'email', op: 'is', negate: false, value: null },
      { column: 'id', op: 'in', negate: true, value: [1, 2, 3] },
      { column: 'title', op: 'neq', negate: false, value: 'a.b' },
    ]);
  });

  it('escapes LIKE metacharacters in user input', () => {
    expect(parse('title=like.50%_off*').filters[0]!.value).toBe('50\\%\\_off%');
    expect(parse('title=like.a\\b').filters[0]!.value).toBe('a\\\\b');
  });

  it('parses select, order, limit, offset', () => {
    const q = parse('select=id,title&order=score.desc.nullslast,id&limit=10&offset=20');
    expect(q).toMatchObject({
      select: ['id', 'title'],
      order: [
        { column: 'score', desc: true, nulls: 'last' },
        { column: 'id', desc: false },
      ],
      limit: 10,
      offset: 20,
    });
    expect(parse('select=*').select).toBeNull();
  });

  it('rejects unknown columns everywhere', () => {
    for (const qs of ['nope=eq.1', 'select=id,nope', 'select=*,id', 'order=nope', 'order=nope.desc']) {
      expect(code(() => parse(qs)), qs).toBe('unknown_column');
    }
  });

  it('rejects hostile column names (they never reach SQL)', () => {
    const evil = ['title"; DROP TABLE todos;--', "id' OR '1'='1", 'id)--', 'title;', '_meta', 'sqlite_master'];
    for (const name of evil) {
      expect(code(() => parse(`${encodeURIComponent(name)}=eq.1`)), name).toBe('unknown_column');
      // names containing quotes are already rejected by the list parser
      expect(code(() => parse(`select=${encodeURIComponent(name)}`)), name).toMatch(/^(unknown_column|invalid_list)$/);
      expect(code(() => parse(`order=${encodeURIComponent(name)}`)), name).toMatch(/^(unknown_column|invalid_list)$/);
    }
    // A double-quoted list item is just the name inside the quotes — here a real column, so it is harmless.
    expect(parse('select=%22title%22').select).toEqual(['title']);
    expect(code(() => parse('%22title%22=eq.1'))).toBe('unknown_column');
  });

  it('rejects malformed filters', () => {
    for (const qs of ['id=5', 'id=foo.5', 'id=eq', 'id=.5', 'id=in.1,2', 'id=in.(1,2', 'title=is.maybe', 'done=is.5', 'id=like.5', 'score=like.x']) {
      expect(code(() => parse(qs)), qs).toMatch(/invalid_filter/);
    }
  });

  it('rejects values of the wrong type', () => {
    expect(code(() => parse('id=eq.abc'))).toBe('invalid_filter_value');
    expect(code(() => parse('id=eq.1.5'))).toBe('invalid_filter_value');
    expect(code(() => parse('id=eq.1;DROP'))).toBe('invalid_filter_value');
    expect(code(() => parse('score=eq.NaN'))).toBe('invalid_filter_value');
    expect(code(() => parse('done=eq.yes'))).toBe('invalid_filter_value');
    expect(code(() => parse('at=gt.yesterday'))).toBe('invalid_filter_value');
    expect(code(() => parse('id=eq.99999999999999999999'))).toBe('invalid_filter_value');
  });

  it('keeps hostile TEXT values as plain data', () => {
    const q = parse(`title=eq.${encodeURIComponent(`x' OR 1=1; --`)}`);
    expect(q.filters[0]!.value).toBe("x' OR 1=1; --");
  });

  it('bounds limit, offset, order terms, filters and IN lists', () => {
    expect(code(() => parse('limit=1001'))).toBe('invalid_limit');
    expect(code(() => parse('limit=-1'))).toBe('invalid_limit');
    expect(code(() => parse('limit=abc'))).toBe('invalid_limit');
    expect(code(() => parse('offset=-5'))).toBe('invalid_offset');
    expect(code(() => parse('order=id,id,id,id,id,id'))).toBe('invalid_order');
    expect(code(() => parse('order=id.sideways'))).toBe('invalid_order');
    expect(code(() => parse(Array(31).fill('id=eq.1').join('&')))).toBe('too_many_filters');
    expect(code(() => parse(`id=in.(${Array.from({ length: 1001 }, (_, i) => i).join(',')})`))).toBe('invalid_filter');
    expect(code(() => parse('limit=1&limit=2'))).toBe('invalid_parameter');
  });

  it('allows only filters and select on writes; limit/order/offset are rejected, not ignored', () => {
    expect(parse('id=eq.1&select=id', 'write').filters).toHaveLength(1);
    for (const qs of ['id=eq.1&limit=1', 'id=eq.1&order=id', 'id=eq.1&offset=1', 'id=eq.1&on_conflict=id']) {
      expect(code(() => parse(qs, 'write')), qs).toBe('unsupported_parameter');
    }
  });

  it('on_conflict is POST-only and must name a primary key or unique column', () => {
    expect(parse('on_conflict=email', 'insert').onConflict).toBe('email');
    expect(code(() => parse('on_conflict=title', 'insert'))).toBe('invalid_on_conflict');
    expect(code(() => parse('on_conflict=email', 'read'))).toBe('unsupported_parameter');
    expect(code(() => parse('id=eq.1', 'insert'))).toBe('unsupported_parameter');
  });
});

describe('value coercion', () => {
  const col = (name: string) => table.columns.find((c) => c.name === name)!;

  it('writes are strictly typed', () => {
    expect(coerceWriteValue(col('title'), 'x')).toBe('x');
    expect(coerceWriteValue(col('done'), true)).toBe(1);
    expect(coerceWriteValue(col('done'), false)).toBe(0);
    expect(coerceWriteValue(col('meta'), { a: [1, 2] })).toBe('{"a":[1,2]}');
    expect(coerceWriteValue(col('at'), '2026-01-02T03:04:05+09:00')).toBe('2026-01-01T18:04:05.000Z');
    expect(coerceWriteValue(col('ref'), 'ABCDEF01-2345-4678-89AB-CDEF01234567')).toBe('abcdef01-2345-4678-89ab-cdef01234567');
    expect(coerceWriteValue(col('score'), null)).toBeNull();

    for (const [name, v] of [
      ['title', 5], ['title', 'a\0b'], ['id', '1'], ['id', 1.5], ['id', 2 ** 60], ['score', '1'], ['score', Infinity],
      ['done', 1], ['done', 'true'], ['at', 'yesterday'], ['at', '2026-01-01T10:00:00'], ['ref', 'not-a-uuid'], ['title', null],
    ] as const) {
      expect(code(() => coerceWriteValue(col(name), v)), `${name}=${String(v)}`).toMatch(/invalid_value|not_null_violation/);
    }
  });

  it('filter values map booleans to 0/1', () => {
    expect(coerceFilterValue(col('done'), 'true')).toBe(1);
    expect(coerceFilterValue(col('done'), 'false')).toBe(0);
  });

  it('decodeRow restores booleans and JSON, and tolerates bad JSON', () => {
    expect(decodeRow(table, { id: 1, done: 1, meta: '{"a":1}', score: null })).toEqual({ id: 1, done: true, meta: { a: 1 }, score: null });
    expect(decodeRow(table, { done: 0, meta: '{broken' })).toEqual({ done: false, meta: '{broken' });
    expect(decodeRow(table, { id: 1, ghost: 'x' })).toEqual({ id: 1 }); // columns outside the schema are dropped
  });
});

describe('SQL builders', () => {
  it('select: quoted identifiers, bound values, deterministic order, paging', () => {
    const q = parse('select=id,title&done=eq.false&title=like.*a*&order=score.desc&limit=5&offset=10');
    const { sql, params } = buildSelect(d, table, q);
    expect(sql).toBe(
      `SELECT "id", "title" FROM "todos" WHERE "done" = ? AND "title" LIKE ? ESCAPE '\\' ORDER BY "score" DESC, "id" ASC LIMIT ? OFFSET ?`,
    );
    expect(params).toEqual([0, '%a%', 5, 10]);
  });

  it('select without options lists every column explicitly and orders by primary key', () => {
    const { sql } = buildSelect(d, table, parse(''));
    expect(sql).toMatch(/^SELECT "id", "title", "done", "score", "email", "meta", "at", "ref" FROM "todos" ORDER BY "id" ASC LIMIT \? OFFSET \?$/);
  });

  it('never puts values in the SQL text', () => {
    const evil = `'; DROP TABLE todos; --`;
    const q = parse(`title=eq.${encodeURIComponent(evil)}&title=in.(${encodeURIComponent(`"${evil}"`)})&title=like.${encodeURIComponent(evil)}`);
    const { sql, params } = buildSelect(d, table, q);
    expect(sql).not.toContain('DROP');
    expect(sql).not.toContain("'; ");
    expect(params).toContain(evil);
  });

  it('IN handles empty lists and negation', () => {
    expect(buildSelect(d, table, parse('id=in.()')).sql).toContain('WHERE 0 = 1');
    expect(buildSelect(d, table, parse('id=not.in.(1,2)')).sql).toContain('WHERE NOT ("id" IN (?, ?))');
    expect(buildSelect(d, table, parse('email=not.is.null')).sql).toContain('WHERE NOT ("email" IS NULL)');
  });

  it('extra (policy) conditions are ANDed in, with parameters in textual order', () => {
    const q = parse('id=gt.1&limit=3');
    const { sql, params } = buildSelect(d, table, q, [(p) => `"title" = ${p.add('mine')} OR "title" = ${p.add('yours')}`]);
    expect(sql).toContain('WHERE "id" > ? AND ("title" = ? OR "title" = ?) ORDER BY');
    expect(params).toEqual([1, 'mine', 'yours', 3, 0]);
  });

  it('count shares the WHERE clause but has no paging', () => {
    const { sql, params } = buildCount(d, table, parse('done=eq.true&limit=2'));
    expect(sql).toBe('SELECT COUNT(*) AS count FROM "todos" WHERE "done" = ?');
    expect(params).toEqual([1]);
  });

  it('insert: columns and values line up; DEFAULT VALUES for empty rows; RETURNING list', () => {
    expect(buildInsert(d, table, { title: 'a', done: 0 }, { returning: ['id'] })).toEqual({
      sql: 'INSERT INTO "todos" ("title", "done") VALUES (?, ?) RETURNING "id"',
      params: ['a', 0],
    });
    expect(buildInsert(d, table, {}, { returning: null }).sql).toBe('INSERT INTO "todos" DEFAULT VALUES');
  });

  it('insert: upsert variants', () => {
    const merge = buildInsert(d, table, { email: 'a@x', title: 't' }, { returning: null, onConflict: { column: 'email', update: ['title'] } });
    expect(merge.sql).toBe('INSERT INTO "todos" ("email", "title") VALUES (?, ?) ON CONFLICT ("email") DO UPDATE SET "title" = excluded."title"');
    const ignore = buildInsert(d, table, { email: 'a@x' }, { returning: null, onConflict: { column: 'email', update: [] } });
    expect(ignore.sql).toBe('INSERT INTO "todos" ("email") VALUES (?) ON CONFLICT ("email") DO NOTHING');
    const guarded = buildInsert(d, table, { email: 'a@x', title: 't' }, {
      returning: null,
      onConflict: { column: 'email', update: ['title'], where: (p) => `"title" <> ${p.add('locked')}` },
    });
    expect(guarded.sql).toContain('DO UPDATE SET "title" = excluded."title" WHERE "title" <> ?');
    expect(guarded.params).toEqual(['a@x', 't', 'locked']);
  });

  it('update: SET parameters come before WHERE parameters', () => {
    const q = parse('id=eq.7');
    const { sql, params } = buildUpdate(d, table, { title: 'x', done: 1 }, q, [(p) => `"score" > ${p.add(2)}`], ['id']);
    expect(sql).toBe('UPDATE "todos" SET "title" = ?, "done" = ? WHERE "id" = ? AND ("score" > ?) RETURNING "id"');
    expect(params).toEqual(['x', 1, 7, 2]);
  });

  it('update and delete refuse to run without a WHERE clause', () => {
    expect(() => buildUpdate(d, table, { title: 'x' }, parse(''), [], null)).toThrow(/WHERE/);
    expect(() => buildDelete(d, table, parse(''), [], null)).toThrow(/WHERE/);
    expect(() => buildUpdate(d, table, {}, parse('id=eq.1'), [], null)).toThrow();
  });

  it('SqlParams numbers placeholders in order of addition', () => {
    const p = new SqlParams(d);
    expect([p.add('a'), p.add('b')]).toEqual(['?', '?']);
    expect(p.values).toEqual(['a', 'b']);
  });
});
