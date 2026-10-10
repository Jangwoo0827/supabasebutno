import type { MiddlewareHandler } from 'hono';
import { unauthorized } from '../core/errors.js';
import { safeEqual } from '../core/safe-equal.js';
import { verifyApiKey } from '../keys.js';
import type { AppEnv, Deps } from './types.js';

/** Guards /admin/*: `Authorization: Bearer <ADMIN_TOKEN>`. */
export function requireAdmin({ config }: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const match = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '');
    if (!match || !safeEqual(match[1]!, config.adminToken)) {
      throw unauthorized('invalid_admin_token', 'Missing or invalid admin token');
    }
    await next();
  };
}

/**
 * Guards project data APIs: the `apikey` header must hold an anon or service
 * key. Resolves the project (so URLs don't carry a project id) and the key's role.
 * Deliberately not read from the query string: URLs end up in logs and referrers.
 */
export function apiKeyAuth({ config, registry }: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = c.req.header('apikey');
    if (!token) throw unauthorized('missing_apikey', 'Missing apikey header');
    const verified = await verifyApiKey(config.jwtMasterSecret, token, (id) => registry.get(id));
    if (!verified) throw unauthorized('invalid_apikey', 'Invalid API key');
    c.set('project', verified.project);
    c.set('role', verified.role);
    await next();
  };
}
