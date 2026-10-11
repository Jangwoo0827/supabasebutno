import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import BetterSqlite3 from 'better-sqlite3';
import { PROJECT_ID_RE } from '../core/ids.js';

export const BACKUP_FORMAT = 1;
// Names inside a backup are checked before they are used as paths, so a doctored backup cannot write elsewhere.
const OBJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface Manifest {
  format: number;
  created_at: string;
  projects: { id: string; name: string; objects: string[] }[];
  /** SHA-256 of every database snapshot, keyed by its path inside the backup. */
  checksums: Record<string, string>;
  bytes: number;
}

const sha256 = async (file: string) => {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
};

async function exists(path: string) {
  return stat(path).then(() => true, () => false);
}

/** A consistent snapshot of one SQLite file, taken with SQLite's online backup API (safe while the server is writing). */
async function snapshot(source: string, dest: string) {
  const db = new BetterSqlite3(source, { readonly: true, fileMustExist: true });
  try {
    await db.backup(dest);
  } finally {
    db.close();
  }
}

export interface BackupResult {
  dir: string;
  projects: number;
  files: number;
  bytes: number;
}

/**
 * Copies the whole instance into `<outRoot>/backup-<UTC time>`:
 *   admin.sqlite, projects/<id>/db.sqlite, projects/<id>/storage/<file ids>, manifest.json
 * The server may keep running. NOT included: JWT_MASTER_SECRET and ADMIN_TOKEN (keep those safe
 * separately — without the master secret every API key changes). The backup holds password hashes
 * and user data, so treat it as sensitive.
 */
export async function createBackup(dataDir: string, outRoot: string, now: Date = new Date()): Promise<BackupResult> {
  const adminDb = join(dataDir, 'admin.sqlite');
  if (!(await exists(adminDb))) throw new Error(`No admin.sqlite in ${dataDir}: nothing to back up (is DATA_DIR right?)`);

  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const dest = resolve(outRoot, `backup-${stamp}`);
  if (await exists(dest)) throw new Error(`${dest} already exists; refusing to overwrite a backup`);
  await mkdir(dest, { recursive: true, mode: 0o700 });

  const checksums: Record<string, string> = {};
  let bytes = 0;
  let files = 0;
  const record = async (rel: string) => {
    const full = join(dest, rel);
    checksums[rel] = await sha256(full);
    bytes += (await stat(full)).size;
  };

  await snapshot(adminDb, join(dest, 'admin.sqlite'));
  await record('admin.sqlite');

  const control = new BetterSqlite3(join(dest, 'admin.sqlite'), { readonly: true });
  const listed = control.prepare('SELECT id, name FROM projects ORDER BY created_at, id').all() as { id: string; name: string }[];
  control.close();

  const projects: Manifest['projects'] = [];
  for (const p of listed) {
    if (!PROJECT_ID_RE.test(p.id)) continue;
    const src = join(dataDir, 'projects', p.id);
    const out = join('projects', p.id);
    await mkdir(join(dest, out), { recursive: true });
    await snapshot(join(src, 'db.sqlite'), join(dest, out, 'db.sqlite'));
    await record(join(out, 'db.sqlite'));

    const objects: string[] = [];
    const storage = join(src, 'storage');
    if (await exists(storage)) {
      await mkdir(join(dest, out, 'storage'), { recursive: true });
      for (const name of await readdir(storage)) {
        if (!OBJECT_ID_RE.test(name)) continue; // skips .tmp (uploads in flight) and anything foreign
        try {
          await copyFile(join(storage, name), join(dest, out, 'storage', name));
          bytes += (await stat(join(dest, out, 'storage', name))).size;
          objects.push(name);
          files++;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; // deleted while we were copying: fine
        }
      }
    }
    projects.push({ id: p.id, name: p.name, objects });
  }

  const manifest: Manifest = { format: BACKUP_FORMAT, created_at: now.toISOString(), projects, checksums, bytes };
  await writeFile(join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { dir: dest, projects: projects.length, files, bytes };
}

export interface RestoreResult {
  projects: number;
  files: number;
  /** Where the data that was in the way was moved to (only with `force`). */
  movedAside?: string;
}

async function readManifest(backupDir: string): Promise<Manifest> {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await readFile(join(backupDir, 'manifest.json'), 'utf8'));
  } catch {
    throw new Error(`${backupDir} is not a backup (manifest.json is missing or unreadable)`);
  }
  if (manifest.format !== BACKUP_FORMAT) throw new Error(`Unsupported backup format ${manifest.format}`);
  for (const p of manifest.projects) {
    if (!PROJECT_ID_RE.test(p.id)) throw new Error(`Backup lists an invalid project id: ${JSON.stringify(p.id)}`);
    for (const o of p.objects) if (!OBJECT_ID_RE.test(o)) throw new Error(`Backup lists an invalid file id: ${JSON.stringify(o)}`);
  }
  return manifest;
}

/** Checks every database snapshot against its checksum and SQLite's own integrity check. Throws on the first problem. */
export async function verifyBackup(backupDir: string): Promise<Manifest> {
  const manifest = await readManifest(backupDir);
  const expected = ['admin.sqlite', ...manifest.projects.map((p) => join('projects', p.id, 'db.sqlite'))];
  for (const rel of expected) {
    if (!manifest.checksums[rel]) throw new Error(`Backup is incomplete: no checksum for ${rel}`);
    const file = join(backupDir, rel);
    if (!(await exists(file))) throw new Error(`Backup is incomplete: ${rel} is missing`);
    if ((await sha256(file)) !== manifest.checksums[rel]) throw new Error(`Backup is damaged: ${rel} does not match its checksum`);
    const db = new BetterSqlite3(file, { readonly: true });
    try {
      const result = db.pragma('integrity_check', { simple: true });
      if (result !== 'ok') throw new Error(`Backup is damaged: ${rel} fails SQLite's integrity check (${String(result)})`);
    } finally {
      db.close();
    }
  }
  for (const p of manifest.projects) {
    for (const o of p.objects) {
      if (!(await exists(join(backupDir, 'projects', p.id, 'storage', o)))) throw new Error(`Backup is incomplete: file ${o} of project ${p.id} is missing`);
    }
  }
  return manifest;
}

/**
 * Replaces `dataDir` with the contents of a backup. STOP THE SERVER FIRST.
 * The backup is fully verified before anything is touched; the new data is assembled next to the
 * old and swapped in with a rename. Existing data is never deleted: with `force` it is moved aside.
 */
export async function restoreBackup(backupDir: string, dataDir: string, opts: { force?: boolean; now?: Date } = {}): Promise<RestoreResult> {
  backupDir = resolve(backupDir);
  dataDir = resolve(dataDir);
  const manifest = await verifyBackup(backupDir);

  const occupied = await exists(join(dataDir, 'admin.sqlite'));
  if (occupied && !opts.force) {
    throw new Error(`${dataDir} already contains data. Stop the server and pass --force to move it aside and restore over it.`);
  }

  const staging = `${dataDir}.restoring`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(join(staging, 'projects'), { recursive: true, mode: 0o700 });
  let files = 0;
  try {
    await copyFile(join(backupDir, 'admin.sqlite'), join(staging, 'admin.sqlite'));
    for (const p of manifest.projects) {
      const out = join(staging, 'projects', p.id);
      await mkdir(join(out, 'storage'), { recursive: true });
      await copyFile(join(backupDir, 'projects', p.id, 'db.sqlite'), join(out, 'db.sqlite'));
      for (const o of p.objects) {
        await copyFile(join(backupDir, 'projects', p.id, 'storage', o), join(out, 'storage', o));
        files++;
      }
    }
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }

  let movedAside: string | undefined;
  if (await exists(dataDir)) {
    const stamp = (opts.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
    movedAside = `${dataDir}.before-restore-${stamp}`;
    await rename(dataDir, movedAside);
  }
  await mkdir(dirname(dataDir), { recursive: true });
  await rename(staging, dataDir);
  return { projects: manifest.projects.length, files, movedAside };
}
