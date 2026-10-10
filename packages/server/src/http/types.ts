import type { Config } from '../config.js';
import type { ProjectRegistry, ProjectRecord } from '../db/registry.js';
import type { ApiKeyRole } from '../keys.js';
import type { SchemaCache } from '../schema/cache.js';

export interface Deps {
  config: Config;
  registry: ProjectRegistry;
  /** Table metadata cache; call `schemas.invalidate(projectId)` after any DDL. */
  schemas: SchemaCache;
}

export type AppEnv = {
  Variables: {
    requestId: string;
    /** Set by apiKeyAuth: the project the API key belongs to and the key's role. */
    project: ProjectRecord;
    role: ApiKeyRole;
  };
};
