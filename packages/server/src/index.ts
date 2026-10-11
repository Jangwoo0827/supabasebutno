import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';

// Optional .env at the repo root (does not override variables already set in the environment).
const envFile = new URL('../../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}

const { app, registry, realtime } = await createApp(config);

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`supabasebutno listening on http://${info.address}:${info.port} (realtime: ws://${info.address}:${info.port}/realtime)`);
  console.log(`data directory: ${config.dataDir}`);
  if (config.corsOrigins === 'any') console.warn('warning: CORS_ORIGINS=* allows any website to call the data APIs');
});

realtime.attach(server as Server);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  server.close();
  await realtime.close();
  await registry.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
