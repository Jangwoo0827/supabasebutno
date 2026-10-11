import { cmp, type Tri } from '../policy/eval.js';
import type { Filter } from '../rest/parse.js';

const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * Converts a LIKE pattern as produced by the filter parser (`%` wildcard, `\` escapes) to a
 * regular expression. SQLite's LIKE ignores case for ASCII letters only, so both sides are
 * lower-cased the same way (not with a Unicode-aware /i).
 */
function likeToRegExp(pattern: string): RegExp {
  let re = '';
  const p = asciiLower(pattern);
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === '\\' && i + 1 < p.length) re += escape(p[++i]!);
    else if (ch === '%') re += '[\\s\\S]*';
    else if (ch === '_') re += '[\\s\\S]';
    else re += escape(ch);
  }
  return new RegExp(`^${re}$`, 'u');
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const likeCache = new Map<string, RegExp>();
function like(pattern: string): RegExp {
  let re = likeCache.get(pattern);
  if (!re) {
    if (likeCache.size > 500) likeCache.clear();
    likeCache.set(pattern, (re = likeToRegExp(pattern)));
  }
  return re;
}

/** SQL three-valued evaluation of one REST-style filter against a row in database form. Mirrors rest/builder.ts compileFilter. */
export function evalFilter(f: Filter, row: Record<string, unknown>): Tri {
  const v = row[f.column];
  const isNull = v === null || v === undefined;
  let r: Tri;
  switch (f.op) {
    case 'eq':
    case 'neq':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      r = cmp(f.op, v, f.value);
      break;
    case 'like':
    case 'ilike':
      r = isNull ? null : like(f.value as string).test(asciiLower(String(v)));
      break;
    case 'in': {
      const list = f.value as unknown[];
      if (list.length === 0) r = false; // SQL side emits `0 = 1`, which is false even for NULL columns
      else if (isNull) r = null;
      else r = list.some((x) => cmp('eq', v, x) === true); // list items come from typed filter values, never NULL
      break;
    }
    case 'is':
      r = f.value === null ? isNull : cmp('eq', v, f.value);
      break;
  }
  return f.negate ? (r === null ? null : !r) : r;
}

/** True when every filter is definitely satisfied. */
export const matchesFilters = (filters: Filter[], row: Record<string, unknown>): boolean => filters.every((f) => evalFilter(f, row) === true);
