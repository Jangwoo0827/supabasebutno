import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** <repo>/data — computed from this file's location so it doesn't depend on the cwd (npm workspaces change it). */
const DEFAULT_DATA_DIR = fileURLToPath(new URL('../../../data', import.meta.url));

const MIB = 1024 * 1024;

/** Where the data lives: DATA_DIR, or <repo>/data. Shared with the backup/restore commands, which need no secrets. */
export function resolveDataDir(env: Record<string, string | undefined> = process.env): string {
  return resolve(env.DATA_DIR || DEFAULT_DATA_DIR);
}

const envSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(8787),
    HOST: z.string().min(1).default('127.0.0.1'),
    DATA_DIR: z.string().min(1).optional(),
    ADMIN_TOKEN: z.string().min(32, 'must be at least 32 characters'),
    JWT_MASTER_SECRET: z.string().min(32, 'must be at least 32 characters'),
    CORS_ORIGINS: z.string().default(''),
    MAX_JSON_BYTES: z.coerce.number().int().positive().default(1_048_576),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(50 * MIB),
    STORAGE_USER_QUOTA_BYTES: z.coerce.number().int().positive().default(100 * MIB),
    STORAGE_PROJECT_QUOTA_BYTES: z.coerce.number().int().positive().default(2048 * MIB),
    REALTIME_MAX_CONNECTIONS: z.coerce.number().int().positive().default(500),
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
  /** Number of reverse proxies in front of the server; used to pick the client IP from X-Forwarded-For. 0 = use the socket address. */
  trustProxyHops: number;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  /** Largest single upload, whatever a bucket allows. */
  maxUploadBytes: number;
  /** Total bytes one signed-in user may store in a project (service_role is exempt). */
  storageUserQuotaBytes: number;
  /** Total bytes of all files in a project. */
  storageProjectQuotaBytes: number;
  /** Simultaneous WebSocket connections the server accepts. */
  realtimeMaxConnections: number;
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
    trustProxyHops: e.TRUST_PROXY_HOPS,
    accessTokenTtlSeconds: e.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlDays: e.REFRESH_TOKEN_TTL_DAYS,
    maxUploadBytes: e.MAX_UPLOAD_BYTES,
    storageUserQuotaBytes: e.STORAGE_USER_QUOTA_BYTES,
    storageProjectQuotaBytes: e.STORAGE_PROJECT_QUOTA_BYTES,
    realtimeMaxConnections: e.REALTIME_MAX_CONNECTIONS,
  };
}
