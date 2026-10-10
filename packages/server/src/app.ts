import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import type { Config } from './config.js';
import { AppError } from './core/errors.js';
import { ProjectRegistry } from './db/registry.js';
import { adminRoutes } from './http/admin-routes.js';
import { apiKeyAuth } from './http/auth.js';
import { onError, onNotFound } from './http/error-handler.js';
import type { AppEnv, Deps } from './http/types.js';

export interface CreatedApp {
  app: Hono<AppEnv>;
  registry: ProjectRegistry;
}

export async function createApp(config: Config): Promise<CreatedApp> {
  const registry = await ProjectRegistry.open(config.dataDir);
  const deps: Deps = { config, registry };

  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.notFound(onNotFound);

  app.use('*', requestId());
  app.use('*', secureHeaders());

  // CORS for data APIs only. /admin is never exposed cross-origin.
  if (config.corsOrigins === 'any' || config.corsOrigins.length > 0) {
    const origins = config.corsOrigins;
    const corsMiddleware = cors({
      origin: origins === 'any' ? '*' : origins,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['authorization', 'apikey', 'content-type', 'prefer', 'x-client-info'],
      exposeHeaders: ['content-range', 'x-request-id'],
      maxAge: 600,
    });
    app.use('*', (c, next) => (c.req.path.startsWith('/admin') ? next() : corsMiddleware(c, next)));
  }

  app.use(
    '*',
    bodyLimit({
      maxSize: config.maxJsonBytes,
      onError: () => {
        throw new AppError(413, 'payload_too_large', `Request body exceeds ${config.maxJsonBytes} bytes`);
      },
    }),
  );

  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Lets a client verify its apikey and see which project/role it resolves to.
  app.get('/whoami', apiKeyAuth(deps), (c) => {
    const project = c.get('project');
    return c.json({ project: { id: project.id, name: project.name }, role: c.get('role') });
  });

  app.route('/admin', adminRoutes(deps));

  return { app, registry };
}
