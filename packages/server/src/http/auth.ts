import type { Context, MiddlewareHandler } from 'hono';
import { isSessionActive } from '../auth/service.js';
import { verifyAccessToken } from '../auth/tokens.js';
import { notFound, tooManyRequests, unauthorized } from '../core/errors.js';
import { PROJECT_ID_RE } from '../core/ids.js';
import { safeEqual } from '../core/safe-equal.js';
import type { ProjectRecord } from '../db/registry.js';
import { verifyApiKey } from '../keys.js';
import { clientIp } from './client-ip.js';
import type { AppEnv, Deps } from './types.js';

/**
 * Guards /admin/*: `Authorization: Bearer <ADMIN_TOKEN>`.
 * Failed attempts are counted per client IP; once over the limit even the correct
 * token is refused until the window passes.
 */
export function requireAdmin({ config, limits }: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const ip = clientIp(c, config.trustProxyHops);
    if (!limits.adminFailIp.allowed(ip)) throw tooManyRequests(limits.adminFailIp.retryAfterSeconds(ip));

    const match = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '');
    if (!match || !safeEqual(match[1]!, config.adminToken)) {
      limits.adminFailIp.hit(ip);
      throw unauthorized('invalid_admin_token', 'Missing or invalid admin token');
    }
    await next();
  };
}

type BearerResult =
  | { kind: 'user'; userId: string; sessionId: string }
  | { kind: 'apikey' }
  | { kind: 'invalid'; reason: 'expired' | 'invalid' };

async function resolveBearer(deps: Deps, project: ProjectRecord, token: string): Promise<BearerResult> {
  const { config, registry, now } = deps;
  const user = await verifyAccessToken(config.jwtMasterSecret, project.id, token, now());
  if (user.ok) {
    // Revoked sessions (logout, password change, user deleted) stop working immediately.
    const active = await isSessionActive(await registry.db(project.id), user.sessionId, user.userId);
    return active ? { kind: 'user', userId: user.userId, sessionId: user.sessionId } : { kind: 'invalid', reason: 'invalid' };
  }
  if (user.reason === 'invalid') {
    // Some clients send the anon key as `Authorization: Bearer`. That is not a user token; ignore it.
    const key = await verifyApiKey(config.jwtMasterSecret, token, (id) => registry.get(id));
    if (key && key.project.id === project.id) return { kind: 'apikey' };
  }
  return { kind: 'invalid', reason: user.reason };
}

export interface ApiKeyAuthOptions {
  /**
   * What to do with an Authorization token that is invalid or expired.
   * 'strict' (default): answer 401. 'lenient': ignore it and record why in `bearerError`
   * (used by /auth endpoints such as login and refresh, which must work even when a
   * client still holds a stale token).
   */
  bearer?: 'strict' | 'lenient';
}

/**
 * Guards project data APIs. The `apikey` header must hold an anon or service key; it
 * identifies the project (so URLs don't carry a project id) and the key's role. An
 * optional `Authorization: Bearer <user access token>` upgrades an anon key to the
 * `authenticated` role. The key is deliberately not read from the query string:
 * URLs end up in logs and referrers.
 */
export function apiKeyAuth(deps: Deps, opts: ApiKeyAuthOptions = {}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = c.req.header('apikey');
    if (!token) throw unauthorized('missing_apikey', 'Missing apikey header');
    const verified = await verifyApiKey(deps.config.jwtMasterSecret, token, (id) => deps.registry.get(id));
    if (!verified) throw unauthorized('invalid_apikey', 'Invalid API key');

    c.set('project', verified.project);
    c.set('apiRole', verified.role);
    c.set('role', verified.role);
    c.set('userId', null);
    c.set('sessionId', null);
    c.set('bearerError', null);

    const bearer = /^Bearer (.+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
    if (bearer) {
      const result = await resolveBearer(deps, verified.project, bearer);
      if (result.kind === 'user') {
        c.set('userId', result.userId);
        c.set('sessionId', result.sessionId);
        // A service key stays a service key; the user id is merely recorded.
        if (verified.role === 'anon') c.set('role', 'authenticated');
      } else if (result.kind === 'invalid') {
        if (opts.bearer !== 'lenient') {
          throw unauthorized(result.reason === 'expired' ? 'token_expired' : 'invalid_token', 'Invalid or expired token');
        }
        c.set('bearerError', result.reason);
      }
    }
    await next();
  };
}

/**
 * For routes mounted under /admin/projects/:id/...: the admin token has already been checked,
 * so the request acts as that project's service_role (no apikey involved).
 */
export function actAsServiceRole({ registry }: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const id = c.req.param('id') ?? '';
    const project = PROJECT_ID_RE.test(id) ? await registry.get(id) : undefined;
    if (!project) throw notFound('Project');
    c.set('project', project);
    c.set('apiRole', 'service_role');
    c.set('role', 'service_role');
    c.set('userId', null);
    c.set('sessionId', null);
    c.set('bearerError', null);
    await next();
  };
}

/** For endpoints that act on "the current user". */
export function requireUser(c: Context<AppEnv>): { userId: string; sessionId: string } {
  const userId = c.get('userId');
  const sessionId = c.get('sessionId');
  if (!userId || !sessionId) {
    const err = c.get('bearerError');
    throw unauthorized(err === 'expired' ? 'token_expired' : err === 'invalid' ? 'invalid_token' : 'missing_token', 'A valid user access token is required');
  }
  return { userId, sessionId };
}
