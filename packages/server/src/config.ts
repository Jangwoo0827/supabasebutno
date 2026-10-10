import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** <repo>/data — computed from this file's location so it doesn't depend on the cwd (npm workspaces change it). */
const DEFAULT_DATA_DIR = fileURLToPath(new URL('../../../data', import.meta.url));

const envSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(8787),
    HOST: z.string().min(1).default('127.0.0.1'),
    DATA_DIR: z.string().min(1).optional(),
    ADMIN_TOKEN: z.string().min(32, 'must be at least 32 characters'),
    JWT_MASTER_SECRET: z.string().min(32, 'must be at least 32 characters'),
    CORS_ORIGINS: z.string().default(''),
    MAX_JSON_BYTES: z.coerce.number().int().positive().default(1_048_576),
  })
  .refine((e) => e.ADMIN_TOKEN !== e.JWT_MASTER_SECRET, {
    path: ['JWT_MASTER_SECRET'],
    message: 'must differ from ADMIN_TOKEN',
  });

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  adminToken: string;
  jwtMasterSecret: string;
  /** 'any' = `*`; an empty array = CORS disabled. */
  corsOrigins: 'any' | string[];
  maxJsonBytes: number;
}

export class ConfigError extends Error {}

/** Throws ConfigError listing the offending variable NAMES (never their values). */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}\nSee .env.example`);
  }
  const e = parsed.data;
  const origins = e.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    port: e.PORT,
    host: e.HOST,
    dataDir: resolve(e.DATA_DIR ?? DEFAULT_DATA_DIR),
    adminToken: e.ADMIN_TOKEN,
    jwtMasterSecret: e.JWT_MASTER_SECRET,
    corsOrigins: origins.includes('*') ? 'any' : origins,
    maxJsonBytes: e.MAX_JSON_BYTES,
  };
}
