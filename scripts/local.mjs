// One command to run supabasebutno on this machine:   npm run local
//
// First run: creates .env with fresh random secrets, installs dependencies if needed.
// Every run: rebuilds the server when the sources changed, then starts it (127.0.0.1 only) and prints the addresses.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const entry = join(root, 'packages', 'server', 'dist', 'index.js');

const secret = () => randomBytes(32).toString('base64url');

/** Creates .env on first use. Never overwrites an existing one. Returns true if it was created. */
export function ensureEnv(path = envPath) {
  if (existsSync(path)) return false;
  writeFileSync(
    path,
    [
      '# Created by `npm run local`. Keep this file private (it is git-ignored). See .env.example for all options.',
      `ADMIN_TOKEN=${secret()}`,
      `JWT_MASTER_SECRET=${secret()}`,
      'HOST=127.0.0.1',
      'PORT=8787',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  return true;
}

export function readEnvFile(path = envPath) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) out[m[1]] = m[2];
  }
  return out;
}

/** True if any source file is newer than the build (or there is no build). */
export function needsBuild(srcDir = join(root, 'packages', 'server', 'src'), built = entry) {
  if (!existsSync(built)) return true;
  const builtAt = statSync(built).mtimeMs;
  const newest = (dir) =>
    readdirSync(dir, { withFileTypes: true }).reduce((max, e) => Math.max(max, e.isDirectory() ? newest(join(dir, e.name)) : statSync(join(dir, e.name)).mtimeMs), 0);
  return newest(srcDir) > builtAt;
}

const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });

function main() {
  if (!existsSync(join(root, 'node_modules'))) {
    console.log('Installing dependencies (first run)...');
    run('npm', ['install']);
  }
  if (ensureEnv()) console.log(`Created ${envPath} with new random secrets.`);
  if (needsBuild()) {
    console.log('Building the server...');
    run('npm', ['run', 'build', '-w', '@supabasebutno/server']);
  }

  const env = { ...readEnvFile(), ...process.env };
  const base = `http://${env.HOST === '0.0.0.0' ? '127.0.0.1' : (env.HOST ?? '127.0.0.1')}:${env.PORT ?? '8787'}`;
  console.log(`\n  API:        ${base}`);
  console.log(`  Dashboard:  ${base}/dashboard/   (log in with ADMIN_TOKEN from ${envPath})`);
  console.log('  Manage:     npm run sbb -- --help\n  Stop:       Ctrl+C\n');

  const child = spawn(process.execPath, [entry], { cwd: root, stdio: 'inherit', env: { ...env } });
  const forward = (sig) => () => child.kill(sig);
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  child.on('exit', (code) => process.exit(code ?? 0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
