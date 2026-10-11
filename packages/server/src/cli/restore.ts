import { existsSync } from 'node:fs';
import { resolveDataDir } from '../config.js';
import { restoreBackup, verifyBackup } from '../maintenance/backup.js';

const envFile = new URL('../../../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const args = process.argv.slice(2);
const force = args.includes('--force');
const verifyOnly = args.includes('--verify');
const dir = args.find((a) => !a.startsWith('--'));
if (!dir || args.includes('--help')) {
  console.error('Usage: restore <backup-directory> [--force] [--verify]\n\n  --verify  only check the backup (checksums + SQLite integrity), change nothing\n  --force   replace existing data in DATA_DIR (it is moved aside, not deleted)\n\nSTOP THE SERVER before restoring.');
  process.exit(dir ? 0 : 1);
}

try {
  if (verifyOnly) {
    const manifest = await verifyBackup(dir);
    console.log(`OK: backup from ${manifest.created_at}, ${manifest.projects.length} project(s)`);
  } else {
    const dataDir = resolveDataDir();
    const result = await restoreBackup(dir, dataDir, { force });
    console.log(`Restored ${result.projects} project(s), ${result.files} file(s) into ${dataDir}`);
    if (result.movedAside) console.log(`The previous data was moved to ${result.movedAside} (delete it yourself once you are happy with the restore).`);
    console.log('Start the server with the SAME JWT_MASTER_SECRET as before, or issued API keys will no longer be valid.');
  }
} catch (err) {
  console.error(`Restore failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
