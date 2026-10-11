import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie } from 'hono/cookie';
import { AppError, notFound, tooManyRequests, unauthorized } from '../core/errors.js';
import { ADMIN_COOKIE } from './admin-session.js';
import { PROJECT_ID_RE } from '../core/ids.js';
import { safeEqual } from '../core/safe-equal.js';
import { clientIp } from './client-ip.js';
import { resolveIdentity } from './identity.js';
import type { AppEnv, Deps } from './types.js';

/**
 * Guards /admin/*: `Authorization: Bearer <ADMIN_TOKEN>`.
 * Failed attempts are counted per client IP; once over the limit even the correct
 * token is refused until the window passes.
 */
export function requireAdmin({ config, limits, adminSessions }: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const ip = clientIp(c, config.trustProxyHops);
    if (!limits.adminFailIp.allowed(ip)) throw tooManyRequests(limits.adminFailIp.retryAfterSeconds(ip));

    const bearer = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')?.[1];
    if (bearer) {
      if (!safeEqual(bearer, config.adminToken)) {
        limits.adminFailIp.hit(ip);
        throw unauthorized('invalid_admin_token', 'Missing or invalid admin token');
      }
      return next();
    }

    // Dashboard: a session cookie obtained by POST /admin/login. Browsers attach cookies to cross-site
    // requests on their own, so unsafe methods must prove they come from our own pages.
    const cookie = getCookie(c, ADMIN_COOKIE);
    if (cookie) {
      if (!(await adminSessions.verify(cookie))) {
        deleteCookie(c, ADMIN_COOKIE, { path: '/admin' });
        throw unauthorized('session_expired', 'The admin session has expired; log in again');
      }
      requireSameSiteRequest(c, config.trustProxyHops);
      return next();
    }
    // No credentials at all (e.g. the dashboard's first load): not an attack, so it is not counted.
    throw unauthorized('invalid_admin_token', 'Missing or invalid admin token');
  };
}

/** CSRF guard for cookie-authenticated requests that change things. */
export function requireSameSiteRequest(c: Context<AppEnv>, trustProxyHops: number): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return;
  const forbiddenRequest = () => new AppError(403, 'csrf_rejected', 'This request does not look like it came from the dashboard');
  // A custom header cannot be added by another site without a CORS preflight, which /admin never grants.
  if (c.req.header('x-sbb-csrf') !== '1') throw forbiddenRequest();
  const origin = c.req.header('origin');
  if (origin) {
    const host = (trustProxyHops > 0 && c.req.header('x-forwarded-host')) || c.req.header('host');
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      /* malformed Origin: rejected below */
    }
    if (!host || originHost !== host) throw forbiddenRequest();
  }
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
    const bearer = /^Bearer (.+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
    const token = c.req.header('apikey');
    if (!token) throw unauthorized('missing_apikey', 'Missing apikey header');
    const identity = await resolveIdentity(deps, token, bearer);
    if (!identity) throw unauthorized('invalid_apikey', 'Invalid API key');

    if ((identity.bearer === 'expired' || identity.bearer === 'invalid') && opts.bearer !== 'lenient') {
      throw unauthorized(identity.bearer === 'expired' ? 'token_expired' : 'invalid_token', 'Invalid or expired token');
    }

    c.set('project', identity.project);
    c.set('apiRole', identity.apiRole);
    c.set('role', identity.role);
    c.set('userId', identity.userId);
    c.set('sessionId', identity.sessionId);
    c.set('bearerError', identity.bearer === 'expired' || identity.bearer === 'invalid' ? identity.bearer : null);
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
