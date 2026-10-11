import { Hono, type Context } from 'hono';
import { badRequest, notFound } from '../core/errors.js';
import { readJson } from '../http/helpers.js';
import type { AppEnv, Deps } from '../http/types.js';
import { buildPlan, type RequestKind } from '../policy/plan.js';
import { runDelete, runInsert, runSelect, runUpdate } from './engine.js';
import { parseQuery } from './parse.js';

interface Prefer {
  count?: 'exact';
  return?: 'representation' | 'minimal';
  resolution?: 'merge-duplicates' | 'ignore-duplicates';
}

/** Parses `Prefer: return=representation, count=exact, resolution=merge-duplicates` (unknown tokens are ignored). */
function parsePrefer(header: string | undefined): Prefer {
  const out: Prefer = {};
  for (const token of (header ?? '').split(',')) {
    const [k, v] = token.trim().split('=');
    if (k === 'count' && v === 'exact') out.count = 'exact';
    else if (k === 'return' && (v === 'representation' || v === 'minimal')) out.return = v;
    else if (k === 'resolution' && (v === 'merge-duplicates' || v === 'ignore-duplicates')) out.resolution = v;
  }
  return out;
}

function contentRange(offset: number, count: number, total: number | undefined): string {
  const range = count > 0 ? `${offset}-${offset + count - 1}` : '*';
  return `${range}/${total ?? '*'}`;
}

/**
 * REST CRUD over the project's tables:
 *   GET /:table   POST /:table   PATCH /:table   DELETE /:table
 *
 * Expects an earlier middleware to have set `project`, `role` and `userId` (apikey auth,
 * or the admin mount, which acts as service_role). What a caller may do is decided by
 * the table's policy (policy/plan.ts); without one, only service_role gets in.
 */
export function restRoutes({ registry, schemas, policies }: Deps): Hono<AppEnv> {
  const rest = new Hono<AppEnv>();

  rest.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  async function open(c: Context<AppEnv>, kind: RequestKind, wantRows = false) {
    const project = c.get('project');
    const db = await registry.db(project.id);
    const name = c.req.param('table') ?? '';
    // Access is decided BEFORE the table is looked up, so callers without access
    // cannot use 403-vs-404 to find out which tables exist.
    const role = c.get('role');
    const policy = role === 'service_role' ? undefined : await policies.get(project.id, db, name);
    const plan = buildPlan(kind, role, c.get('userId'), policy, wantRows);
    const table = await schemas.table(project.id, db, name);
    if (!table) throw notFound('Table');
    return { db, table, plan };
  }

  const searchParams = (c: Context) => new URL(c.req.url).searchParams;

  rest.get('/:table', async (c) => {
    const { db, table, plan } = await open(c, 'select');
    const q = parseQuery(searchParams(c), table, 'read');
    const prefer = parsePrefer(c.req.header('prefer'));
    const { rows, total } = await runSelect(db, table, q, plan, prefer.count === 'exact');
    c.header('Content-Range', contentRange(q.offset, rows.length, total));
    return c.json(rows);
  });

  rest.post('/:table', async (c) => {
    const prefer = parsePrefer(c.req.header('prefer'));
    const returning = prefer.return === 'representation';
    const { db, table, plan } = await open(c, prefer.resolution ? 'upsert' : 'insert', returning);
    const q = parseQuery(searchParams(c), table, 'insert');
    const body = await readJson(c);

    let onConflict;
    if (prefer.resolution) {
      const pk = table.columns.find((col) => col.primary_key)!;
      onConflict = { column: q.onConflict ?? pk.name, mode: prefer.resolution === 'merge-duplicates' ? ('merge' as const) : ('ignore' as const) };
    } else if (q.onConflict) {
      throw badRequest('invalid_parameter', '"on_conflict" requires Prefer: resolution=merge-duplicates or ignore-duplicates');
    }

    const rows = await runInsert(db, table, { rows: Array.isArray(body) ? body : [body], returning, select: q.select, onConflict }, plan);
    return returning ? c.json(rows, 201) : c.body(null, 201);
  });

  rest.patch('/:table', async (c) => {
    const returning = parsePrefer(c.req.header('prefer')).return === 'representation';
    const { db, table, plan } = await open(c, 'update', returning);
    const q = parseQuery(searchParams(c), table, 'write');
    // Mass updates must be explicit (e.g. `id=not.is.null`), never the result of a forgotten filter.
    if (q.filters.length === 0) throw badRequest('filter_required', 'PATCH requires at least one filter. To update every row, filter on the primary key with not.is.null');
    const result = await runUpdate(db, table, await readJson(c), q, returning, plan);
    return returning ? c.json(result.rows, 200) : c.body(null, 204);
  });

  rest.delete('/:table', async (c) => {
    const returning = parsePrefer(c.req.header('prefer')).return === 'representation';
    const { db, table, plan } = await open(c, 'delete', returning);
    const q = parseQuery(searchParams(c), table, 'write');
    if (q.filters.length === 0) throw badRequest('filter_required', 'DELETE requires at least one filter. To delete every row, filter on the primary key with not.is.null');
    const result = await runDelete(db, table, q, returning, plan);
    return returning ? c.json(result.rows, 200) : c.body(null, 204);
  });

  return rest;
}
