import { existsSync } from 'node:fs';
import { resolveDataDir } from '../config.js';
import { createBackup } from '../maintenance/backup.js';

// Optional .env at the repo root, like the server (only DATA_DIR matters here).
const envFile = new URL('../../../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const out = process.argv[2];
if (!out || out === '--help' || out === '-h') {
  console.error('Usage: backup <output-directory>\n\nCreates <output-directory>/backup-<time>/ from DATA_DIR (the server may keep running).');
  process.exit(out ? 0 : 1);
}

try {
  const dataDir = resolveDataDir();
  const result = await createBackup(dataDir, out);
  console.log(`Backed up ${result.projects} project(s), ${result.files} file(s), ${(result.bytes / 1024 / 1024).toFixed(2)} MiB`);
  console.log(`  from: ${dataDir}\n  to:   ${result.dir}`);
  console.log('Not included: JWT_MASTER_SECRET and ADMIN_TOKEN. Store them separately; without the master secret all API keys change.');
} catch (err) {
  console.error(`Backup failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
