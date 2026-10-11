import { describe, expect, it } from 'vitest';
import { openSqlite } from '../src/db/sqlite/driver.js';
import { evaluate, matches, toSql, type EvalContext } from '../src/policy/eval.js';
import { PolicyError, collectColumns, parsePolicy } from '../src/policy/parse.js';
import type { ComparisonOp, Expr, Operand } from '../src/policy/types.js';
import { SqlParams } from '../src/rest/builder.js';
import { sqliteDialect } from '../src/db/sqlite/driver.js';
import type { TableInfo } from '../src/schema/types.js';

const table: TableInfo = {
  name: 'notes',
  columns: [
    { name: 'id', type: 'integer', primary_key: true, not_null: true, unique: false },
    { name: 'owner', type: 'text', primary_key: false, not_null: false, unique: false },
    { name: 'body', type: 'text', primary_key: false, not_null: false, unique: false },
    { name: 'level', type: 'integer', primary_key: false, not_null: false, unique: false },
    { name: 'shared', type: 'boolean', primary_key: false, not_null: true, unique: false },
    { name: 'at', type: 'timestamp', primary_key: false, not_null: false, unique: false },
    { name: 'meta', type: 'json', primary_key: false, not_null: false, unique: false },
    { name: 'ref', type: 'uuid', primary_key: false, not_null: false, unique: false },
  ],
};

const lit = (value: string | number | null): Operand => ({ kind: 'lit', value });
const uid: Operand = { kind: 'var', name: 'uid' };
const cmp = (column: string, op: ComparisonOp, operand: Operand): Expr => ({ kind: 'cmp', column, op, operand });
const ctx = (u: string | null): EvalContext => ({ uid: u });

describe('three-valued logic (must match SQL)', () => {
  const row = { owner: null, level: 5, body: 'x' };

  it('comparisons with NULL are unknown, and unknown is not a match', () => {
    expect(evaluate(cmp('owner', 'eq', lit('a')), row, ctx(null))).toBeNull();
    expect(evaluate(cmp('owner', 'eq', uid), row, ctx(null))).toBeNull();
    expect(evaluate(cmp('body', 'eq', uid), row, ctx(null))).toBeNull(); // anon's uid is NULL
    expect(matches(cmp('owner', 'eq', uid), { owner: null }, ctx(null))).toBe(false); // NULL = NULL is NOT true
  });

  it('NOT of unknown stays unknown (so it does not accidentally grant access)', () => {
    const e: Expr = { kind: 'not', item: cmp('owner', 'eq', lit('a')) };
    expect(evaluate(e, row, ctx('u'))).toBeNull();
    expect(matches(e, row, ctx('u'))).toBe(false);
  });

  it('AND / OR combine unknowns like SQL', () => {
    const unknown = cmp('owner', 'eq', lit('a'));
    const t = cmp('level', 'eq', lit(5));
    const f = cmp('level', 'eq', lit(6));
    expect(evaluate({ kind: 'and', items: [t, unknown] }, row, ctx(null))).toBeNull();
    expect(evaluate({ kind: 'and', items: [f, unknown] }, row, ctx(null))).toBe(false);
    expect(evaluate({ kind: 'or', items: [t, unknown] }, row, ctx(null))).toBe(true);
    expect(evaluate({ kind: 'or', items: [f, unknown] }, row, ctx(null))).toBeNull();
  });

  it('IN with NULL in the list', () => {
    const e: Expr = { kind: 'in', column: 'level', operands: [lit(1), uid] };
    expect(evaluate(e, { level: 1 }, ctx(null))).toBe(true);
    expect(evaluate(e, { level: 2 }, ctx(null))).toBeNull(); // 2 IN (1, NULL) is unknown
    expect(evaluate(e, { level: null }, ctx('x'))).toBeNull();
  });

  it('isnull is a plain two-valued test', () => {
    expect(evaluate({ kind: 'isnull', column: 'owner' }, { owner: null }, ctx(null))).toBe(true);
    expect(evaluate({ kind: 'isnull', column: 'owner' }, {}, ctx(null))).toBe(true);
    expect(evaluate({ kind: 'isnull', column: 'owner' }, { owner: 'a' }, ctx(null))).toBe(false);
  });
});

describe('SQL and in-memory evaluation agree', () => {
  // Strings chosen so that UTF-8 byte order differs from UTF-16 code-unit order:
  // U+FF5E (UTF-8 EF BD 9E) sorts BEFORE U+1F600 (UTF-8 F0 9F 98 80), but its UTF-16 unit 0xFF5E is AFTER 0xD83D.
  const TEXTS = ['a', 'b', 'ab', 'B', 'é', '～', '\u{1F600}', ''];
  const INTS = [-2, 0, 1, 2, 3];

  function rng(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('gives identical answers for thousands of random conditions, rows and users', async () => {
    const rand = rng(12345);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const ops: ComparisonOp[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'];

    const genOperand = (kind: 'text' | 'int'): Operand => {
      if (kind === 'text') return rand() < 0.3 ? uid : lit(pick(TEXTS));
      return lit(pick(INTS));
    };
    const genExpr = (depth: number): Expr => {
      const r = rand();
      if (depth <= 0 || r < 0.5) {
        const col = pick(['owner', 'body', 'level', 'score'] as const);
        const kind = col === 'owner' || col === 'body' ? 'text' : 'int';
        const k = rand();
        if (k < 0.15) return { kind: 'isnull', column: col };
        if (k < 0.3) return { kind: 'in', column: col, operands: Array.from({ length: 1 + Math.floor(rand() * 3) }, () => genOperand(kind)) };
        if (k < 0.35) return { kind: 'true' };
        return cmp(col, pick(ops), genOperand(kind));
      }
      if (r < 0.65) return { kind: 'not', item: genExpr(depth - 1) };
      const items = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => genExpr(depth - 1));
      return { kind: rand() < 0.5 ? 'and' : 'or', items };
    };

    const db = openSqlite(':memory:');
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, owner TEXT, body TEXT, level INTEGER, score INTEGER)');
    const rows: Record<string, unknown>[] = [];
    const nullable = <T>(v: T): T | null => (rand() < 0.2 ? null : v);
    for (let id = 1; id <= 60; id++) {
      const row = { id, owner: nullable(pick(TEXTS)), body: nullable(pick(TEXTS)), level: nullable(pick(INTS)), score: nullable(pick(INTS)) };
      rows.push(row);
      await db.run('INSERT INTO t VALUES (?, ?, ?, ?, ?)', [row.id, row.owner, row.body, row.level, row.score]);
    }

    let disagreements = 0;
    let nonTrivial = 0;
    for (let i = 0; i < 3000; i++) {
      const expr = genExpr(3);
      const c = ctx(rand() < 0.3 ? null : pick(TEXTS));
      const p = new SqlParams(sqliteDialect);
      const where = toSql(expr, c, p);
      const viaSql = (await db.all<{ id: number }>(`SELECT id FROM t WHERE ${where} ORDER BY id`, p.values)).map((r) => r.id);
      const viaJs = rows.filter((r) => matches(expr, r, c)).map((r) => r.id as number);
      if (JSON.stringify(viaSql) !== JSON.stringify(viaJs)) {
        disagreements++;
        if (disagreements <= 3) console.error('MISMATCH', JSON.stringify(expr), JSON.stringify(c), viaSql, viaJs);
      }
      if (viaSql.length > 0 && viaSql.length < rows.length) nonTrivial++;
    }
    expect(disagreements).toBe(0);
    expect(nonTrivial).toBeGreaterThan(500); // the sample actually exercised selective conditions
  });

  it('orders text by UTF-8 bytes like SQLite does', async () => {
    const db = openSqlite(':memory:');
    await db.exec('CREATE TABLE t (s TEXT)');
    await db.run('INSERT INTO t VALUES (?)', ['～']);
    for (const op of ['gt', 'lt'] as const) {
      const p = new SqlParams(sqliteDialect);
      const e = cmp('s', op, lit('\u{1F600}'));
      const sql = (await db.all(`SELECT s FROM t WHERE ${toSql(e, ctx(null), p)}`, p.values)).length === 1;
      expect(matches(e, { s: '～' }, ctx(null))).toBe(sql);
    }
  });
});

describe('toSql', () => {
  it('binds every value, including the user id', () => {
    const p = new SqlParams(sqliteDialect);
    const sql = toSql({ kind: 'or', items: [cmp('owner', 'eq', uid), { kind: 'not', item: cmp('level', 'lt', lit(3)) }] }, ctx("x'); DROP TABLE t;--"), p);
    expect(sql).toBe('("owner" = ? OR NOT ("level" < ?))');
    expect(p.values).toEqual(["x'); DROP TABLE t;--", 3]);
  });
});

describe('parsePolicy', () => {
  const parse = (raw: unknown) => parsePolicy(raw, table);
  const fail = (raw: unknown) => {
    try {
      parse(raw);
    } catch (e) {
      if (e instanceof PolicyError) return `${e.path}: ${e.message}`;
      throw e;
    }
    return 'accepted';
  };

  it('compiles the common owner-only policy', () => {
    const { policy, columns } = parse({
      select: { roles: ['anon', 'authenticated'], where: { or: [{ shared: true }, { owner: '$uid' }] } },
      insert: { roles: ['authenticated'], set: { owner: '$uid' } },
      update: { roles: ['authenticated'], where: { owner: '$uid' } },
      delete: { roles: ['authenticated'], where: { owner: '$uid' } },
    });
    expect(columns).toEqual(['owner', 'shared']);
    expect(policy.select!.where).toEqual({
      kind: 'or',
      items: [
        { kind: 'cmp', column: 'shared', op: 'eq', operand: { kind: 'lit', value: 1 } },
        { kind: 'cmp', column: 'owner', op: 'eq', operand: { kind: 'var', name: 'uid' } },
      ],
    });
    expect(policy.insert!.set).toEqual({ owner: { kind: 'var', name: 'uid' } });
    expect(policy.update!.check).toEqual(policy.update!.where); // check defaults to where
    expect(policy.insert!.check).toEqual({ kind: 'true' });
  });

  it('supports the explicit form, in / is / not / and / or', () => {
    const { policy } = parse({
      select: {
        roles: ['authenticated'],
        where: {
          and: [
            { column: 'level', op: 'gte', value: 3 },
            { column: 'body', op: 'in', value: ['a', 'b'] },
            { not: { column: 'owner', op: 'is', value: null } },
            { column: 'at', op: 'gt', value: '2026-01-01T00:00:00Z' },
          ],
        },
      },
    });
    expect(collectColumns(policy.select!.where)).toEqual(new Set(['level', 'body', 'owner', 'at']));
  });

  it('accepts true as "every row"', () => {
    expect(parse({ select: { roles: ['anon'], where: true } }).policy.select!.where).toEqual({ kind: 'true' });
    expect(parse({ select: { roles: ['anon'] } }).policy.select!.where).toEqual({ kind: 'true' });
  });

  it('reports precise, helpful errors', () => {
    expect(fail('nope')).toMatch(/must be a JSON object/);
    expect(fail({})).toMatch(/at least one operation/);
    expect(fail({ read: {} })).toMatch(/unknown operation/);
    expect(fail({ select: { where: true } })).toMatch(/select\.roles: roles must be a non-empty list/);
    expect(fail({ select: { roles: [] } })).toMatch(/roles/);
    expect(fail({ select: { roles: ['service_role'] } })).toMatch(/unknown role .*bypasses/);
    expect(fail({ select: { roles: ['admin'] } })).toMatch(/unknown role/);
    expect(fail({ select: { roles: ['anon'], wher: true } })).toMatch(/select\.wher: unexpected key/);
    expect(fail({ select: { roles: ['anon'], where: { ghost: 1 } } })).toMatch(/select\.where\.ghost: unknown column/);
    expect(fail({ select: { roles: ['anon'], where: { owner: '$user' } } })).toMatch(/unknown variable/);
    expect(fail({ select: { roles: ['anon'], where: { level: '$uid' } } })).toMatch(/only be compared with text or uuid/);
    expect(fail({ select: { roles: ['anon'], where: { level: 'five' } } })).toMatch(/expects an integer/);
    expect(fail({ select: { roles: ['anon'], where: { owner: null } } })).toMatch(/op":"is"/);
    expect(fail({ select: { roles: ['anon'], where: { meta: 'x' } } })).toMatch(/json column/);
    expect(fail({ select: { roles: ['anon'], where: { column: 'level', op: 'like', value: 'x' } } })).toMatch(/op must be one of/);
    expect(fail({ select: { roles: ['anon'], where: { column: 'level', op: 'eq' } } })).toMatch(/missing value/);
    expect(fail({ select: { roles: ['anon'], where: { column: 'owner', op: 'is', value: 5 } } })).toMatch(/only supports null/);
    expect(fail({ select: { roles: ['anon'], where: { column: 'level', op: 'in', value: [] } } })).toMatch(/1 to 50/);
    expect(fail({ select: { roles: ['anon'], where: { and: [] } } })).toMatch(/1 to 20/);
    expect(fail({ select: { roles: ['anon'], where: {} } })).toMatch(/empty condition/);
    expect(fail({ select: { roles: ['anon'], where: false } })).toMatch(/true or an object/);
    expect(fail({ insert: { roles: ['authenticated'], set: { ghost: 1 } } })).toMatch(/insert\.set\.ghost: unknown column/);
    expect(fail({ insert: { roles: ['authenticated'], set: [] } })).toMatch(/set must be an object/);
  });

  it('bounds nesting depth and size', () => {
    let deep: unknown = { owner: '$uid' };
    for (let i = 0; i < 10; i++) deep = { not: deep };
    expect(fail({ select: { roles: ['anon'], where: deep } })).toMatch(/nested more than/);
    const many = { and: Array.from({ length: 20 }, () => ({ and: Array.from({ length: 5 }, () => ({ owner: 'a' })) })) };
    expect(fail({ select: { roles: ['anon'], where: many } })).toMatch(/at most/);
  });

  it('literals are converted like stored values', () => {
    const { policy } = parse({ select: { roles: ['anon'], where: { and: [{ shared: false }, { column: 'at', op: 'gt', value: '2026-01-01T09:00:00+09:00' }] } } });
    const and = policy.select!.where as Extract<Expr, { kind: 'and' }>;
    expect(and.items[0]).toMatchObject({ operand: { value: 0 } });
    expect(and.items[1]).toMatchObject({ operand: { value: '2026-01-01T00:00:00.000Z' } });
  });
});
