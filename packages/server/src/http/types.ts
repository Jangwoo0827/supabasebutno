import type { Config } from '../config.js';
import type { ProjectRegistry, ProjectRecord } from '../db/registry.js';
import type { ApiKeyRole } from '../keys.js';

export interface Deps {
  config: Config;
  registry: ProjectRegistry;
}

export type AppEnv = {
  Variables: {
    requestId: string;
    /** Set by apiKeyAuth: the project the API key belongs to and the key's role. */
    project: ProjectRecord;
    role: ApiKeyRole;
  };
};
