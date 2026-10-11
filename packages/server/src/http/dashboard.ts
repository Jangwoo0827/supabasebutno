import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type { AppEnv } from './types.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * No inline script or style, no external resources, no framing. Together with a UI that never builds
 * HTML from data, this is what keeps a stored `<script>` in some table cell from running in the admin's browser.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** <repo>/packages/dashboard/public — same relative depth from src/http and dist/http. */
const ROOT = fileURLToPath(new URL('../../../dashboard/public', import.meta.url));

/**
 * Serves the admin dashboard (static files, loaded into memory at startup, so only files that
 * existed then can ever be served and no request path touches the filesystem).
 */
export function dashboardRoutes(root: string = ROOT): Hono<AppEnv> {
  const files = new Map<string, { body: Buffer; type: string }>();
  if (existsSync(root)) {
    const walk = (dir: string, prefix: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, `${prefix}${name}/`);
        else files.set(`${prefix}${name}`, { body: readFileSync(full), type: TYPES[extname(name)] ?? 'application/octet-stream' });
      }
    };
    walk(root, '');
  } else {
    console.warn(`dashboard files not found at ${root}; /dashboard is disabled`);
  }

  const app = new Hono<AppEnv>();
  app.get('/', (c) => (files.has('index.html') ? c.redirect('/dashboard/') : c.notFound()));
  app.get('/*', (c) => {
    const path = new URL(c.req.url).pathname.replace(/^\/dashboard\/?/, '') || 'index.html';
    const file = files.get(path);
    if (!file) return c.notFound();
    return c.body(new Uint8Array(file.body), 200, {
      'Content-Type': file.type,
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-cache',
    });
  });
  return app;
}
