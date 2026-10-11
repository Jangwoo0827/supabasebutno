import { join } from 'node:path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import type { Config } from './config.js';
import { AppError } from './core/errors.js';
import { createLimits } from './auth/limits.js';
import { ConsoleMailer, type Mailer } from './auth/mailer.js';
import { authRoutes } from './auth/routes.js';
import { ProjectRegistry } from './db/registry.js';
import { sqliteSchemaDriver } from './db/sqlite/schema.js';
import { PolicyStore } from './policy/store.js';
import { RealtimeHub, type HubOptions } from './realtime/hub.js';
import { adminRoutes } from './http/admin-routes.js';
import { AdminSessions } from './http/admin-session.js';
import { dashboardRoutes } from './http/dashboard.js';
import { apiKeyAuth } from './http/auth.js';
import { onError, onNotFound } from './http/error-handler.js';
import type { AppEnv, Deps } from './http/types.js';
import { restRoutes } from './rest/routes.js';
import { SchemaCache } from './schema/cache.js';
import { LocalDiskBackend, type StorageBackend } from './storage/backend.js';
import { publicStorageRoutes, storageRoutes } from './storage/routes.js';
import { StorageService } from './storage/service.js';

export interface CreatedApp {
  app: Hono<AppEnv>;
  registry: ProjectRegistry;
  /** WebSocket side of the server: call `realtime.attach(httpServer)` once the HTTP server exists. */
  realtime: RealtimeHub;
}

/** Replaceable collaborators (production defaults are used when omitted). */
export interface AppOverrides {
  mailer?: Mailer;
  /** Current time in ms. */
  now?: () => number;
  /** Where uploaded files are kept (default: local disk under the data directory). */
  storageBackend?: StorageBackend;
  /** Realtime limits and timers (defaults: see DEFAULT_HUB_OPTIONS). */
  realtime?: Partial<HubOptions>;
}

export async function createApp(config: Config, overrides: AppOverrides = {}): Promise<CreatedApp> {
  const registry = await ProjectRegistry.open(config.dataDir);
  const now = overrides.now ?? Date.now;
  const backend = overrides.storageBackend ?? new LocalDiskBackend(join(config.dataDir, 'projects'));
  const schemas = new SchemaCache(sqliteSchemaDriver);
  const policies = new PolicyStore();
  const realtime = new RealtimeHub({ config, registry, schemas, policies, now }, { maxConnections: config.realtimeMaxConnections, ...overrides.realtime });
  const deps: Deps = {
    config,
    registry,
    schemas,
    policies,
    realtime,
    adminSessions: new AdminSessions(config.jwtMasterSecret, now),
    storage: new StorageService(backend, config, now),
    mailer: overrides.mailer ?? new ConsoleMailer(),
    limits: createLimits(now),
    now,
  };

  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.notFound(onNotFound);

  app.use('*', requestId());
  // Cross-Origin-Resource-Policy is handled below: secureHeaders would overwrite a route's own value.
  // Nothing this server returns is meant to be framed, so DENY everywhere (the dashboard also sends frame-ancestors 'none').
  app.use('*', secureHeaders({ crossOriginResourcePolicy: false, xFrameOptions: 'DENY' }));
  app.use('*', async (c, next) => {
    await next();
    // Responses are same-origin only by default; public file downloads opt in to being embedded elsewhere.
    if (!c.res.headers.has('Cross-Origin-Resource-Policy')) c.header('Cross-Origin-Resource-Policy', 'same-origin');
  });

  // CORS for data APIs only. /admin is never exposed cross-origin.
  if (config.corsOrigins === 'any' || config.corsOrigins.length > 0) {
    const origins = config.corsOrigins;
    const corsMiddleware = cors({
      origin: origins === 'any' ? '*' : origins,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['authorization', 'apikey', 'content-type', 'prefer', 'x-client-info', 'x-upsert'],
      exposeHeaders: ['content-range', 'content-length', 'etag', 'x-request-id'],
      maxAge: 600,
    });
    app.use('*', (c, next) => (c.req.path.startsWith('/admin') ? next() : corsMiddleware(c, next)));
  }

  // JSON requests are small; file uploads stream through their own size limits (see storage/service.ts).
  const jsonLimit = bodyLimit({
    maxSize: config.maxJsonBytes,
    onError: () => {
      throw new AppError(413, 'payload_too_large', `Request body exceeds ${config.maxJsonBytes} bytes`);
    },
  });
  app.use('*', (c, next) => (c.req.method === 'POST' && /\/storage\/object\//.test(c.req.path) ? next() : jsonLimit(c, next)));

  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Lets a client verify its apikey and see which project/role it resolves to.
  app.get('/whoami', apiKeyAuth(deps), (c) => {
    const project = c.get('project');
    const userId = c.get('userId');
    return c.json({ project: { id: project.id, name: project.name }, role: c.get('role'), user: userId ? { id: userId } : null });
  });

  app.use('/auth/*', apiKeyAuth(deps, { bearer: 'lenient' }));
  app.route('/auth', authRoutes(deps));

  app.use('/rest/*', apiKeyAuth(deps));
  app.route('/rest', restRoutes(deps));

  // Everything under /storage needs an apikey except public downloads (their URL names the project).
  const storageAuth = apiKeyAuth(deps);
  app.use('/storage/*', (c, next) => (c.req.path.startsWith('/storage/public/') ? next() : storageAuth(c, next)));
  app.route('/storage/public', publicStorageRoutes(deps));
  app.route('/storage', storageRoutes(deps, { prefixSegments: 1 }));

  app.route('/admin', adminRoutes(deps));
  app.route('/dashboard', dashboardRoutes());

  return { app, registry, realtime };
}
