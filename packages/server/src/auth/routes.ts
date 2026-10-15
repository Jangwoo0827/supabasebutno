import { Hono, type Context } from 'hono';
import { AppError, badRequest } from '../core/errors.js';
import { clientIp } from '../http/client-ip.js';
import { parseJson, parseOptionalJson } from '../http/helpers.js';
import { requireUser } from '../http/auth.js';
import { countAttempt, ensureAllowed } from '../http/rate.js';
import type { AppEnv, Deps } from '../http/types.js';
import { logoutSchema, recoverSchema, refreshSchema, resetSchema, signInSchema, signUpSchema, updateUserSchema } from './schemas.js';
import * as service from './service.js';
import type { AuthEnv } from './service.js';

/**
 * End-user authentication, scoped to the project named by the apikey.
 *
 *   POST /signup  /login  /refresh  /logout  /recover  /reset      GET|PUT /user
 */
export function authRoutes(deps: Deps): Hono<AppEnv> {
  const { config, registry, mailer, limits, now } = deps;
  const auth = new Hono<AppEnv>();

  auth.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  async function envFor(c: Context<AppEnv>): Promise<AuthEnv> {
    const project = c.get('project');
    return { db: await registry.db(project.id), projectId: project.id, projectName: project.name, config, mailer, now };
  }
  const ipOf = (c: Context<AppEnv>) => `${c.get('project').id}:${clientIp(c, config.trustProxyHops)}`;

  auth.post('/signup', async (c) => {
    if (!config.signupEnabled) throw new AppError(403, 'signup_disabled', 'Sign-up is turned off on this server');
    countAttempt(limits.signupIp, ipOf(c));
    const input = await parseJson(c, signUpSchema);
    return c.json(await service.signUp(await envFor(c), input), 201);
  });

  auth.post('/login', async (c) => {
    const { email, password } = await parseJson(c, signInSchema);
    const pid = c.get('project').id;
    const ip = ipOf(c);
    const keys = { ip, accountIp: `${pid}:${email}:${ip}`, account: `${pid}:${email}` };
    ensureAllowed(limits.loginIp, keys.ip);
    ensureAllowed(limits.loginAccountIp, keys.accountIp);
    ensureAllowed(limits.loginAccount, keys.account);

    try {
      const session = await service.signIn(await envFor(c), { email, password });
      limits.loginAccountIp.reset(keys.accountIp);
      limits.loginAccount.reset(keys.account);
      return c.json(session);
    } catch (err) {
      if ((err as { code?: string }).code === 'invalid_credentials') {
        limits.loginIp.hit(keys.ip);
        limits.loginAccountIp.hit(keys.accountIp);
        limits.loginAccount.hit(keys.account);
      }
      throw err;
    }
  });

  auth.post('/refresh', async (c) => {
    const { refresh_token } = await parseJson(c, refreshSchema);
    const ip = ipOf(c);
    ensureAllowed(limits.refreshIp, ip);
    try {
      return c.json(await service.refresh(await envFor(c), refresh_token));
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'invalid_refresh_token' || code === 'refresh_token_reused') limits.refreshIp.hit(ip);
      throw err;
    }
  });

  auth.post('/logout', async (c) => {
    const who = requireUser(c);
    const { scope } = await parseOptionalJson(c, logoutSchema);
    await service.signOut(await envFor(c), who, scope);
    return c.body(null, 204);
  });

  auth.get('/user', async (c) => {
    const { userId } = requireUser(c);
    return c.json(await service.getUser((await envFor(c)).db, userId));
  });

  auth.put('/user', async (c) => {
    const who = requireUser(c);
    const input = await parseJson(c, updateUserSchema);
    const env = await envFor(c);
    const user = await service.getUser(env.db, who.userId);
    const accountKey = `${c.get('project').id}:${user.email}`;
    if (input.password) ensureAllowed(limits.loginAccount, accountKey); // the current password must not be guessable
    return c.json(await service.updateUser(env, who, input, () => limits.loginAccount.hit(accountKey)));
  });

  auth.post('/recover', async (c) => {
    const { email } = await parseJson(c, recoverSchema);
    countAttempt(limits.recoverIp, ipOf(c));
    countAttempt(limits.recoverAccount, `${c.get('project').id}:${email}`);
    await service.recover(await envFor(c), email);
    // Same answer whether or not the address is registered.
    return c.json({ message: 'If that address is registered, a reset message has been sent.' });
  });

  auth.post('/reset', async (c) => {
    const { token, password } = await parseJson(c, resetSchema);
    const ip = ipOf(c);
    ensureAllowed(limits.resetIp, ip);
    const ok = await service.resetPassword(await envFor(c), token, password);
    if (!ok) {
      limits.resetIp.hit(ip);
      throw badRequest('invalid_or_expired_token', 'The reset token is invalid, expired or already used');
    }
    return c.body(null, 204);
  });

  return auth;
}
