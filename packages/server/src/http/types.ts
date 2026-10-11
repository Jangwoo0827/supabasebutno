import type { Mailer } from '../auth/mailer.js';
import type { Limits } from '../auth/limits.js';
import type { Config } from '../config.js';
import type { ProjectRegistry, ProjectRecord } from '../db/registry.js';
import type { ApiKeyRole } from '../keys.js';
import type { PolicyStore } from '../policy/store.js';
import type { SchemaCache } from '../schema/cache.js';

export interface Deps {
  config: Config;
  registry: ProjectRegistry;
  /** Table metadata cache; call `schemas.invalidate(projectId)` after any DDL. */
  schemas: SchemaCache;
  /** Per-table access policies (compiled, cached). */
  policies: PolicyStore;
  mailer: Mailer;
  limits: Limits;
  /** Current time in ms (injectable for tests). */
  now: () => number;
}

/** The identity a request acts as. `authenticated` = a signed-in end user. */
export type Role = ApiKeyRole | 'authenticated';

export type AppEnv = {
  Variables: {
    requestId: string;
    /** Set by apiKeyAuth: the project the API key belongs to. */
    project: ProjectRecord;
    /** Role of the API key itself (anon or service_role). */
    apiRole: ApiKeyRole;
    /** Effective role: `authenticated` when a valid user token accompanies an anon key. */
    role: Role;
    userId: string | null;
    sessionId: string | null;
    /** Why a supplied Authorization token was not accepted (only set in lenient mode). */
    bearerError: 'expired' | 'invalid' | null;
  };
};
