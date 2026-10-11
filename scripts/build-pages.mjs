// Builds the admin dashboard for static hosting (GitHub Pages).
//
//   node scripts/build-pages.mjs [outDir]            (API address from the SBB_API_URL environment variable, optional)
//
// Copies packages/dashboard/public to outDir and, in index.html:
//   * marks the page as "remote" (the dashboard then asks for the API address and uses the admin token as a Bearer header),
//   * adds a Content-Security-Policy <meta>: GitHub Pages cannot send headers, and this is what stops the page from
//     talking to any server but yours. With an API address the policy pins connect-src to exactly that origin.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SRC = join(root, 'packages', 'dashboard', 'public');
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** An origin like https://api.example.com, or throws. http is accepted only for localhost. */
export function parseApiOrigin(text) {
  let url;
  try {
    url = new URL(text.trim());
  } catch {
    throw new Error(`SBB_API_URL is not a URL: ${JSON.stringify(text)}`);
  }
  const local = LOCAL_HOSTS.includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('SBB_API_URL must be an https:// address (http:// only for localhost): the admin token travels to it');
  }
  if (url.username || url.password) throw new Error('SBB_API_URL must not contain credentials');
  return url.origin;
}

export function contentSecurityPolicy(apiOrigin) {
  // Without a configured address the page must be able to reach whichever server the user types in.
  const connect = apiOrigin ?? 'https: http://localhost:* http://127.0.0.1:*';
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    `connect-src ${connect}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** @returns {{ outDir: string, apiOrigin: string | null }} */
export function buildPages({ srcDir = DEFAULT_SRC, outDir, apiUrl } = {}) {
  if (!outDir) throw new Error('outDir is required');
  const apiOrigin = apiUrl && apiUrl.trim() ? parseApiOrigin(apiUrl) : null;

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(srcDir, outDir, { recursive: true });

  const indexPath = join(outDir, 'index.html');
  const html = readFileSync(indexPath, 'utf8');
  if (!/<meta charset="utf-8" \/>/.test(html)) throw new Error('index.html changed shape: expected <meta charset="utf-8" />');
  const injected = [
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(contentSecurityPolicy(apiOrigin))}" />`,
    '<meta name="sbb-mode" content="remote" />',
    apiOrigin && `<meta name="sbb-api-url" content="${escapeAttr(apiOrigin)}" />`,
    '<meta name="referrer" content="no-referrer" />',
  ]
    .filter(Boolean)
    .join('\n    ');
  writeFileSync(indexPath, html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n    ${injected}`));
  writeFileSync(join(outDir, '.nojekyll'), ''); // serve files as they are (no Jekyll processing)
  return { outDir, apiOrigin };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const outDir = resolve(process.argv[2] ?? 'pages-dist');
    const { apiOrigin } = buildPages({ outDir, apiUrl: process.env.SBB_API_URL });
    console.log(`Dashboard built into ${outDir}`);
    console.log(apiOrigin ? `Pinned to API server ${apiOrigin}` : 'No SBB_API_URL set: the page accepts any https:// API address typed at login (weaker CSP).');
    if (!existsSync(join(outDir, 'index.html'))) process.exit(1);
  } catch (err) {
    console.error(`build-pages failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
