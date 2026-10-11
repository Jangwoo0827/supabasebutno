import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createBackup, restoreBackup, verifyBackup } from '../src/maintenance/backup.js';
import { makeTestApp } from './helpers.js';

type TestApp = Awaited<ReturnType<typeof makeTestApp>>;
let t: TestApp;
let workdir: string;
const PASSWORD = 'correct horse battery';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 5)]);

beforeEach(async () => {
  t = await makeTestApp();
  workdir = await mkdtemp(join(tmpdir(), 'sbb-backup-'));
});
afterEach(async () => {
  await t.close();
  await rm(workdir, { recursive: true, force: true });
});

/** A project with a table, rows, a user and an uploaded file. */
async function populate(name = 'game') {
  const p = await t.createProject(name);
  await t.admin('POST', `/projects/${p.id}/tables`, { name: 'scores', columns: [{ name: 'id', type: 'integer', primary_key: true }, { name: 'player', type: 'text', not_null: true }] });
  await t.call('POST', '/rest/scores', { body: [{ player: 'ada' }, { player: 'bob' }], headers: { apikey: p.keys.service_role } });
  await t.admin('PUT', `/projects/${p.id}/policies/scores`, { select: { roles: ['anon'], where: true } });
  const user = await t.call('POST', '/auth/signup', { body: { email: `${name}@example.com`, password: PASSWORD }, headers: { apikey: p.keys.anon } });
  await t.call('POST', '/storage/buckets', { body: { name: 'pics', public: true }, headers: { apikey: p.keys.service_role } });
  const up = await t.app.request('/storage/object/pics/a/me.png', { method: 'POST', headers: { apikey: p.keys.anon, authorization: `Bearer ${user.json.access_token}`, 'content-type': 'image/png' }, body: new Uint8Array(PNG) });
  expect(up.status).toBe(201);
  return p;
}

describe('createBackup', () => {
  it('snapshots databases and files and writes a manifest with checksums', async () => {
    const p = await populate();
    const result = await createBackup(t.dataDir, workdir, new Date('2026-03-04T05:06:07Z'));
    expect(result.dir.endsWith('backup-20260304-050607')).toBe(true);
    expect(result).toMatchObject({ projects: 1, files: 1 });

    const manifest = JSON.parse(await readFile(join(result.dir, 'manifest.json'), 'utf8'));
    expect(manifest.projects).toEqual([{ id: p.id, name: 'game', objects: [expect.stringMatching(/^[0-9a-f-]{36}$/)] }]);
    expect(Object.keys(manifest.checksums).sort()).toEqual(['admin.sqlite', join('projects', p.id, 'db.sqlite')].sort());
    expect(Object.values(manifest.checksums).every((c) => /^[0-9a-f]{64}$/.test(c as string))).toBe(true);
    expect(await verifyBackup(result.dir)).toMatchObject({ format: 1 });
  });

  it('does not contain the secrets', async () => {
    await populate();
    const { dir } = await createBackup(t.dataDir, workdir);
    const everything = (await readdir(dir, { recursive: true })).filter((f) => !f.endsWith('storage') && /\.(sqlite|json)$/.test(f));
    for (const f of everything) {
      const bytes = (await readFile(join(dir, f))).toString('latin1');
      expect(bytes, f).not.toContain(t.config.adminToken);
      expect(bytes, f).not.toContain(t.config.jwtMasterSecret);
    }
  });

  it('works while the server keeps writing, and skips uploads that are still in flight', async () => {
    const p = await populate();
    await t.registry.db(p.id); // database open, as in a running server
    const writing = Promise.all(Array.from({ length: 30 }, (_, i) => t.call('POST', '/rest/scores', { body: { player: `p${i}` }, headers: { apikey: p.keys.service_role } })));
    const { dir } = await createBackup(t.dataDir, workdir);
    await writing;
    expect((await verifyBackup(dir)).projects).toHaveLength(1); // internally consistent, whatever moment it caught
    const storage = await readdir(join(dir, 'projects', p.id, 'storage'));
    expect(storage.every((n) => /^[0-9a-f-]{36}$/.test(n))).toBe(true); // no .tmp
  });

  it('refuses to overwrite a backup and to back up a directory that holds no data', async () => {
    await populate();
    const when = new Date('2026-01-01T00:00:00Z');
    await createBackup(t.dataDir, workdir, when);
    await expect(createBackup(t.dataDir, workdir, when)).rejects.toThrow(/already exists/);
    await expect(createBackup(join(workdir, 'empty'), workdir)).rejects.toThrow(/No admin.sqlite/);
  });

  it('handles an instance without projects', async () => {
    const { dir, projects } = await createBackup(t.dataDir, workdir);
    expect(projects).toBe(0);
    expect((await verifyBackup(dir)).projects).toEqual([]);
  });
});

describe('restoreBackup', () => {
  it('brings everything back: logins, rows, policies, files and the same API keys', async () => {
    const p = await populate();
    const { dir } = await createBackup(t.dataDir, workdir);

    // a brand-new server on an empty data directory, same secrets
    const target = join(workdir, 'restored');
    const res = await restoreBackup(dir, target);
    expect(res).toMatchObject({ projects: 1, files: 1 });

    const { app, registry, realtime } = await createApp({ ...t.config, dataDir: target });
    try {
      const call = (method: string, path: string, init: RequestInit = {}) => app.request(path, { method, ...init });
      // the keys issued before still work: they are derived from the (unchanged) master secret
      const rows = await call('GET', '/rest/scores', { headers: { apikey: p.keys.anon } });
      expect(((await rows.json()) as { player: string }[]).map((r) => r.player)).toEqual(['ada', 'bob']);
      // the user can sign in with the old password
      const login = await call('POST', '/auth/login', { headers: { apikey: p.keys.anon, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'game@example.com', password: PASSWORD }) });
      expect(login.status).toBe(200);
      // the file is identical
      const file = await call('GET', `/storage/public/${p.id}/pics/a/me.png`);
      expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true);
      // and the admin API sees the project
      const list = await call('GET', '/admin/projects', { headers: { authorization: `Bearer ${t.config.adminToken}` } });
      expect(((await list.json()) as { projects: { name: string }[] }).projects.map((x) => x.name)).toEqual(['game']);
    } finally {
      await realtime.close();
      await registry.close();
    }
  });

  it('refuses a backup that was damaged, and leaves existing data alone', async () => {
    await populate();
    const { dir } = await createBackup(t.dataDir, workdir);
    const target = join(workdir, 'target');
    await restoreBackup(dir, target);

    const victim = join(dir, 'admin.sqlite');
    const bytes = await readFile(victim);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    await writeFile(victim, bytes);

    await expect(verifyBackup(dir)).rejects.toThrow(/damaged|does not match/);
    await expect(restoreBackup(dir, target, { force: true })).rejects.toThrow(/damaged/);
    expect((await stat(join(target, 'admin.sqlite'))).size).toBeGreaterThan(0); // untouched
    expect(await readdir(workdir)).not.toContain('target.restoring'); // no half-built leftovers
  });

  it('notices missing files', async () => {
    const p = await populate();
    const { dir } = await createBackup(t.dataDir, workdir);
    const [file] = await readdir(join(dir, 'projects', p.id, 'storage'));
    await rm(join(dir, 'projects', p.id, 'storage', file!));
    await expect(verifyBackup(dir)).rejects.toThrow(/missing/);
    await rm(join(dir, 'projects', p.id, 'db.sqlite'));
    await expect(verifyBackup(dir)).rejects.toThrow(/missing/);
  });

  it('will not replace existing data without --force, and then moves it aside instead of deleting it', async () => {
    await populate();
    const { dir } = await createBackup(t.dataDir, workdir);
    const target = join(workdir, 'live');
    await restoreBackup(dir, target);
    await writeFile(join(target, 'marker.txt'), 'precious');

    await expect(restoreBackup(dir, target)).rejects.toThrow(/--force/);
    expect(await readFile(join(target, 'marker.txt'), 'utf8')).toBe('precious');

    const res = await restoreBackup(dir, target, { force: true, now: new Date('2026-05-06T07:08:09Z') });
    expect(res.movedAside).toBe(`${target}.before-restore-20260506-070809`);
    expect(await readFile(join(res.movedAside!, 'marker.txt'), 'utf8')).toBe('precious');
    expect(await readdir(target)).not.toContain('marker.txt');
  });

  it('rejects a doctored manifest that tries to write outside the data directory', async () => {
    await populate();
    const { dir } = await createBackup(t.dataDir, workdir);
    const manifestPath = join(dir, 'manifest.json');
    const good = JSON.parse(await readFile(manifestPath, 'utf8'));

    for (const evil of [
      { ...good, projects: [{ id: '../../../../tmp/evil', name: 'x', objects: [] }] },
      { ...good, projects: [{ ...good.projects[0], objects: ['../../escape'] }] },
      { ...good, projects: [{ ...good.projects[0], objects: ['..\\..\\escape'] }] },
      { ...good, format: 99 },
    ]) {
      await writeFile(manifestPath, JSON.stringify(evil));
      await expect(restoreBackup(dir, join(workdir, 'out'))).rejects.toThrow(/invalid|Unsupported/);
    }
    expect(await readdir(workdir)).not.toContain('out');
    await writeFile(manifestPath, 'not json');
    await expect(verifyBackup(dir)).rejects.toThrow(/not a backup/);
  });

  it('restores into a data directory whose parent does not exist yet', async () => {
    await populate();
    const { dir } = await createBackup(t.dataDir, workdir);
    const target = join(workdir, 'deep', 'er', 'data');
    await restoreBackup(dir, target);
    expect((await stat(join(target, 'admin.sqlite'))).isFile()).toBe(true);
  });
});
