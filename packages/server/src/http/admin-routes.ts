import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { AppError, badRequest, notFound, tooManyRequests, unauthorized } from '../core/errors.js';
import { PROJECT_ID_RE } from '../core/ids.js';
import { safeEqual } from '../core/safe-equal.js';
import { restRoutes } from '../rest/routes.js';
import { PolicyError } from '../policy/parse.js';
import type { ProjectRecord } from '../db/registry.js';
import { sqliteSchemaDriver } from '../db/sqlite/schema.js';
import { issueApiKeys } from '../keys.js';
import { TableService } from '../schema/service.js';
import { alterTableSchema, createProjectSchema, createTableSchema } from '../schema/validation.js';
import { storageRoutes } from '../storage/routes.js';
import { ADMIN_COOKIE, ADMIN_SESSION_SECONDS } from './admin-session.js';
import { actAsServiceRole, requireAdmin, requireSameSiteRequest } from './auth.js';
import { clientIp } from './client-ip.js';
import { parseJson, readJson } from './helpers.js';
import type { AppEnv, Deps } from './types.js';

const loginSchema = z.strictObject({ token: z.string().min(1).max(500) });
const MAX_PAGE = 200;

/**
 * Admin API (Bearer ADMIN_TOKEN). Manages projects, their API keys and their table schemas.
 * Not CORS-enabled: it is meant for the operator's own tooling and the (same-origin) dashboard.
 */
export function adminRoutes(deps: Deps): Hono<AppEnv> {
  const { config, registry, schemas, policies, adminSessions, limits } = deps;
  const admin = new Hono<AppEnv>();

  // Responses may contain API keys: never cache them.
  admin.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  // ---- dashboard login (before the auth guard: this is how you get a session) -------------

  admin.post('/login', async (c) => {
    const ip = clientIp(c, config.trustProxyHops);
    if (!limits.adminFailIp.allowed(ip)) throw tooManyRequests(limits.adminFailIp.retryAfterSeconds(ip));
    requireSameSiteRequest(c, config.trustProxyHops); // a foreign page must not be able to log the admin in as someone else's session
    const { token } = await parseJson(c, loginSchema);
    if (!safeEqual(token, config.adminToken)) {
      limits.adminFailIp.hit(ip);
      throw unauthorized('invalid_admin_token', 'Wrong admin token');
    }
    const https = c.req.url.startsWith('https:') || (config.trustProxyHops > 0 && c.req.header('x-forwarded-proto') === 'https');
    setCookie(c, ADMIN_COOKIE, await adminSessions.issue(), {
      httpOnly: true, // not readable by page scripts
      sameSite: 'Strict', // not sent on cross-site requests
      secure: https,
      path: '/admin',
      maxAge: ADMIN_SESSION_SECONDS,
    });
    return c.json({ ok: true });
  });

  admin.post('/logout', async (c) => {
    requireSameSiteRequest(c, config.trustProxyHops);
    const cookie = getCookie(c, ADMIN_COOKIE);
    if (cookie) await adminSessions.revoke(cookie);
    deleteCookie(c, ADMIN_COOKIE, { path: '/admin' });
    return c.body(null, 204);
  });

  admin.use('*', requireAdmin(deps));

  /** Lets the dashboard ask "am I still logged in?" */
  admin.get('/session', (c) => c.json({ authenticated: true }));

  const publicProject = (p: ProjectRecord) => ({
    id: p.id,
    name: p.name,
    key_version: p.key_version,
    created_at: p.created_at,
  });
  const withKeys = async (p: ProjectRecord) => ({
    ...publicProject(p),
    keys: await issueApiKeys(config.jwtMasterSecret, p),
  });
  const requireProject = async (id: string) => {
    const project = PROJECT_ID_RE.test(id) ? await registry.get(id) : undefined;
    if (!project) throw notFound('Project');
    return project;
  };
  const tablesOf = async (projectId: string) =>
    new TableService(await registry.db(projectId), sqliteSchemaDriver);

  // ---- projects ----------------------------------------------------------

  admin.get('/projects', async (c) => c.json({ projects: (await registry.list()).map(publicProject) }));

  admin.post('/projects', async (c) => {
    const { name } = await parseJson(c, createProjectSchema);
    return c.json(await withKeys(await registry.create(name)), 201);
  });

  admin.get('/projects/:id', async (c) => c.json(await withKeys(await requireProject(c.req.param('id')))));

  admin.delete('/projects/:id', async (c) => {
    const project = await requireProject(c.req.param('id'));
    if (c.req.query('confirm') !== project.name) {
      throw badRequest('confirmation_required', 'Deleting a project is irreversible. Repeat the request with ?confirm=<project name>');
    }
    await registry.delete(project.id);
    schemas.invalidate(project.id);
    policies.invalidate(project.id);
    return c.body(null, 204);
  });

  admin.post('/projects/:id/rotate-keys', async (c) => {
    const project = await requireProject(c.req.param('id'));
    return c.json(await withKeys(await registry.rotateKeys(project.id)));
  });

  // ---- tables ------------------------------------------------------------

  admin.get('/projects/:id/tables', async (c) => {
    const project = await requireProject(c.req.param('id'));
    return c.json({ tables: await (await tablesOf(project.id)).list() });
  });

  admin.post('/projects/:id/tables', async (c) => {
    const project = await requireProject(c.req.param('id'));
    const input = await parseJson(c, createTableSchema);
    const created = await (await tablesOf(project.id)).create(input);
    schemas.invalidate(project.id);
    return c.json(created, 201);
  });

  admin.get('/projects/:id/tables/:table', async (c) => {
    const project = await requireProject(c.req.param('id'));
    return c.json(await (await tablesOf(project.id)).get(c.req.param('table')));
  });

  admin.patch('/projects/:id/tables/:table', async (c) => {
    const project = await requireProject(c.req.param('id'));
    const input = await parseJson(c, alterTableSchema);
    const altered = await (await tablesOf(project.id)).alter(c.req.param('table'), input);
    schemas.invalidate(project.id);
    policies.invalidate(project.id); // a table rename moves its policy
    return c.json(altered);
  });

  admin.delete('/projects/:id/tables/:table', async (c) => {
    const project = await requireProject(c.req.param('id'));
    await (await tablesOf(project.id)).drop(c.req.param('table'));
    schemas.invalidate(project.id);
    policies.invalidate(project.id);
    return c.body(null, 204);
  });

  // ---- row editor (same handlers as /rest, acting as service_role) ------

  admin.use('/projects/:id/rest/*', actAsServiceRole(deps));
  admin.route('/projects/:id/rest', restRoutes(deps));

  // ---- end users -----------------------------------------------------------

  admin.get('/projects/:id/users', async (c) => {
    const project = await requireProject(c.req.param('id'));
    const db = await registry.db(project.id);
    const int = (v: string | undefined, def: number, max: number) => Math.min(Math.max(Number.parseInt(v ?? '', 10) || def, 0), max);
    const limit = Math.max(int(c.req.query('limit'), 50, MAX_PAGE), 1);
    const offset = int(c.req.query('offset'), 0, 1_000_000_000);
    const users = await db.all<Record<string, unknown>>(
      `SELECT u.id, u.email, u.user_metadata, u.created_at, u.last_sign_in_at,
              (SELECT COUNT(*) FROM _auth_sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL) AS active_sessions
         FROM _auth_users u ORDER BY u.created_at DESC, u.id LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    const total = (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM _auth_users'))!.n;
    return c.json({
      total,
      users: users.map((u) => ({ ...u, user_metadata: JSON.parse(String(u.user_metadata)) as unknown })), // password hashes are never selected
    });
  });

  admin.delete('/projects/:id/users/:userId', async (c) => {
    const project = await requireProject(c.req.param('id'));
    const res = await (await registry.db(project.id)).run('DELETE FROM _auth_users WHERE id = ?', [c.req.param('userId')]); // sessions go with it
    if (res.changes === 0) throw notFound('User');
    return c.body(null, 204);
  });

  admin.post('/projects/:id/users/:userId/sign-out', async (c) => {
    const project = await requireProject(c.req.param('id'));
    const db = await registry.db(project.id);
    if (!(await db.get('SELECT 1 AS ok FROM _auth_users WHERE id = ?', [c.req.param('userId')]))) throw notFound('User');
    await db.run('UPDATE _auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [new Date(deps.now()).toISOString(), c.req.param('userId')]);
    return c.body(null, 204);
  });

  // ---- storage (same handlers as /storage, acting as service_role) -------

  admin.use('/projects/:id/storage/*', actAsServiceRole(deps));
  admin.route('/projects/:id/storage', storageRoutes(deps, { prefixSegments: 4 }));

  // ---- access policies ---------------------------------------------------

  admin.get('/projects/:id/policies', async (c) => {
    const project = await requireProject(c.req.param('id'));
    return c.json({ policies: await policies.list(await registry.db(project.id)) });
  });

  admin.get('/projects/:id/policies/:table', async (c) => {
    const project = await requireProject(c.req.param('id'));
    const stored = await policies.getSource(await registry.db(project.id), c.req.param('table'));
    if (!stored) throw notFound('Policy');
    return c.json(stored);
  });

  admin.put('/projects/:id/policies/:table', async (c) => {
    const project = await requireProject(c.req.param('id'));
    const db = await registry.db(project.id);
    const table = await schemas.table(project.id, db, c.req.param('table'));
    if (!table) throw notFound('Table');
    const raw = await readJson(c);
    try {
      return c.json(await policies.put(project.id, db, table, raw, new Date(deps.now()).toISOString()));
    } catch (err) {
      if (err instanceof PolicyError) throw new AppError(400, 'invalid_policy', err.message, [{ path: err.path, message: err.message }]);
      throw err;
    }
  });

  admin.delete('/projects/:id/policies/:table', async (c) => {
    const project = await requireProject(c.req.param('id'));
    if (!(await policies.remove(project.id, await registry.db(project.id), c.req.param('table')))) throw notFound('Policy');
    return c.body(null, 204);
  });

  return admin;
}
