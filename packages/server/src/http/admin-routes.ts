import { Hono } from 'hono';
import { badRequest, notFound } from '../core/errors.js';
import { PROJECT_ID_RE } from '../core/ids.js';
import type { ProjectRecord } from '../db/registry.js';
import { sqliteSchemaDriver } from '../db/sqlite/schema.js';
import { issueApiKeys } from '../keys.js';
import { TableService } from '../schema/service.js';
import { alterTableSchema, createProjectSchema, createTableSchema } from '../schema/validation.js';
import { requireAdmin } from './auth.js';
import { parseJson } from './helpers.js';
import type { AppEnv, Deps } from './types.js';

/**
 * Admin API (Bearer ADMIN_TOKEN). Manages projects, their API keys and their table schemas.
 * Not CORS-enabled: it is meant for the operator's own tooling and the (same-origin) dashboard.
 */
export function adminRoutes(deps: Deps): Hono<AppEnv> {
  const { config, registry, schemas } = deps;
  const admin = new Hono<AppEnv>();

  admin.use('*', requireAdmin(deps));
  // Responses may contain API keys: never cache them.
  admin.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

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
    return c.json(altered);
  });

  admin.delete('/projects/:id/tables/:table', async (c) => {
    const project = await requireProject(c.req.param('id'));
    await (await tablesOf(project.id)).drop(c.req.param('table'));
    schemas.invalidate(project.id);
    return c.body(null, 204);
  });

  return admin;
}
