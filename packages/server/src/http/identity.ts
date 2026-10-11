import { isSessionActive } from '../auth/service.js';
import { verifyAccessToken } from '../auth/tokens.js';
import type { ProjectRecord } from '../db/registry.js';
import { verifyApiKey, type ApiKeyRole } from '../keys.js';
import type { Deps, Role } from './types.js';

/** Who a request (or WebSocket connection) acts as, derived from its credentials. */
export interface Identity {
  project: ProjectRecord;
  /** Role of the API key itself. */
  apiRole: ApiKeyRole;
  /** Effective role: `authenticated` when a valid user token accompanies an anon key. */
  role: Role;
  userId: string | null;
  sessionId: string | null;
  /** Unix seconds at which the user token stops being valid (null when no user token is involved). */
  tokenExpiresAt: number | null;
  /** What became of the user token: 'user' accepted, 'ignored' (it was an API key), 'expired', 'invalid', or 'none' supplied. */
  bearer: 'none' | 'user' | 'ignored' | 'expired' | 'invalid';
}

/** Returns null when the API key is missing or invalid. */
export async function resolveIdentity(
  deps: Pick<Deps, 'config' | 'registry' | 'now'>,
  apikey: string | undefined,
  bearer: string | undefined,
): Promise<Identity | null> {
  if (!apikey) return null;
  const { config, registry, now } = deps;
  const verified = await verifyApiKey(config.jwtMasterSecret, apikey, (id) => registry.get(id));
  if (!verified) return null;

  const identity: Identity = {
    project: verified.project,
    apiRole: verified.role,
    role: verified.role,
    userId: null,
    sessionId: null,
    tokenExpiresAt: null,
    bearer: 'none',
  };
  if (!bearer) return identity;

  const user = await verifyAccessToken(config.jwtMasterSecret, verified.project.id, bearer, now());
  if (user.ok) {
    // Revoked sessions (logout, password change, user deleted) stop working immediately.
    if (await isSessionActive(await registry.db(verified.project.id), user.sessionId, user.userId)) {
      identity.userId = user.userId;
      identity.sessionId = user.sessionId;
      identity.tokenExpiresAt = user.expiresAt;
      identity.bearer = 'user';
      // A service key stays a service key; the user id is merely recorded.
      if (verified.role === 'anon') identity.role = 'authenticated';
    } else identity.bearer = 'invalid';
    return identity;
  }
  if (user.reason === 'invalid') {
    // Some clients send the anon key as `Authorization: Bearer`. That is not a user token; ignore it.
    const key = await verifyApiKey(config.jwtMasterSecret, bearer, (id) => registry.get(id));
    if (key && key.project.id === verified.project.id) {
      identity.bearer = 'ignored';
      return identity;
    }
  }
  identity.bearer = user.reason;
  return identity;
}
