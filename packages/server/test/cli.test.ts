import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureEnv, needsBuild, readEnvFile } from '../../../scripts/local.mjs';
import { PRESETS, UsageError, buildColumns, main, parseArgs, parseColumn, presetPolicy } from '../../../scripts/sbb.mjs';
import { ADMIN_TOKEN, makeTestApp } from './helpers.js';

describe('sbb: columns', () => {
  it('parses name:type and flags', () => {
    expect(parseColumn('id:integer:pk')).toEqual({ name: 'id', type: 'integer', primary_key: true });
    expect(parseColumn('player:text:nn')).toEqual({ name: 'player', type: 'text', not_null: true });
    expect(parseColumn('email:text:unique:nn')).toEqual({ name: 'email', type: 'text', unique: true, not_null: true });
    expect(parseColumn('note')).toEqual({ name: 'note', type: 'text' });
    expect(parseColumn('at:timestamp:default=now')).toEqual({ name: 'at', type: 'timestamp', default: { fn: 'now' } });
    expect(parseColumn('id:uuid:pk:default=uuid')).toMatchObject({ default: { fn: 'uuid' } });
    expect(parseColumn('n:integer:default=5').default).toBe(5);
    expect(parseColumn('r:real:default=-1.5').default).toBe(-1.5);
    expect(parseColumn('done:boolean:default=false').default).toBe(false);
    expect(parseColumn('s:text:default=hello').default).toBe('hello');
    expect(parseColumn('s:text:default=null').default).toBeNull();
  });

  it('rejects mistakes with a clear message', () => {
    for (const bad of [':text', 'a:varchar', 'a:text:primary', 'n:integer:default=abc', 'b:boolean:default=yes', 'n:integer:default=']) {
      expect(() => parseColumn(bad), bad).toThrow(UsageError);
    }
  });

  it('adds an id primary key unless one is given', () => {
    expect(buildColumns(['player:text:nn'])).toEqual([{ name: 'id', type: 'integer', primary_key: true }, { name: 'player', type: 'text', not_null: true }]);
    expect(buildColumns(['uid:uuid:pk', 'x:text'])).toHaveLength(2);
  });
});

describe('sbb: presets and arguments', () => {
  it('builds each preset, taking the owner column from the name or the table', () => {
    expect(PRESETS).toEqual(['public-read', 'authenticated', 'owner', 'leaderboard']);
    expect(presetPolicy('public-read').select).toEqual({ roles: ['anon', 'authenticated'], where: true });
    expect(presetPolicy('authenticated').insert).toEqual({ roles: ['authenticated'] });
    expect(presetPolicy('owner', 'user_id').update).toEqual({ roles: ['authenticated'], where: { user_id: '$uid' } });
    expect(presetPolicy('leaderboard=player_id', 'user_id').insert).toEqual({ roles: ['authenticated'], set: { player_id: '$uid' } });
    expect(presetPolicy('leaderboard', 'user_id').delete).toEqual({ roles: ['authenticated'], where: { user_id: '$uid' } });
  });

  it('explains what is missing for owner-based presets', () => {
    expect(() => presetPolicy('owner')).toThrow(/user_id/);
    expect(() => presetPolicy('leaderboard')).toThrow(UsageError);
    expect(() => presetPolicy('nope')).toThrow(/Presets:/);
  });

  it('splits flags from positional arguments', () => {
    expect(parseArgs(['bucket', 'game', 'pics', '--public', '--max-bytes', '2000', '--types=image/*,audio/*'])).toEqual({
      positional: ['bucket', 'game', 'pics'],
      flags: { public: true, 'max-bytes': '2000', types: 'image/*,audio/*' },
    });
    expect(parseArgs(['delete', 'p', '--confirm', 'My Game']).flags.confirm).toBe('My Game');
  });
});

describe('sbb: against a running server', () => {
  let t: Awaited<ReturnType<typeof makeTestApp>>;
  let url: string;
  const lines: string[] = [];
  const errors: string[] = [];
  const sbb = (...argv: string[]) => main(argv, { env: { SBB_URL: url, SBB_ADMIN_TOKEN: ADMIN_TOKEN }, envFile: {}, out: (l) => lines.push(l), err: (l) => errors.push(l) });
  const output = () => lines.join('\n');

  beforeEach(async () => {
    t = await makeTestApp();
    url = (await t.listen()).httpUrl;
    lines.length = errors.length = 0;
  });
  afterEach(async () => {
    await t.close();
  });

  it('goes from nothing to a working leaderboard backend in four commands', async () => {
    expect(await sbb('status')).toBe(0);
    expect(output()).toContain('0 projects');

    expect(await sbb('new', 'my game', '--json')).toBe(0);
    const created = JSON.parse(lines.at(-1)!);
    expect(created).toMatchObject({ name: 'my game', url });

    expect(await sbb('table', 'my game', 'scores', 'user_id:text', 'player:text:nn', 'time_ms:integer:nn')).toBe(0);
    expect(output()).toMatch(/Created table scores: id:integer \(pk\), user_id/);
    expect(output()).toMatch(/until you add a policy/);

    expect(await sbb('tables', 'my game')).toBe(0);
    expect(output()).toContain('NO POLICY');

    expect(await sbb('policy', 'my game', 'scores', 'leaderboard')).toBe(0); // owner column guessed: user_id
    lines.length = 0;
    await sbb('tables', 'my game');
    expect(output()).toContain('[policy]');

    // the generated backend really behaves like a leaderboard: anyone reads, nobody anonymous writes
    const rest = (method: string, body?: unknown) => fetch(`${url}/rest/scores`, { method, headers: { apikey: created.anon, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    expect((await rest('GET')).status).toBe(200);
    expect((await rest('POST', { player: 'x', time_ms: 5 })).status).toBe(403);
    expect(created.service_role).not.toBe(created.anon);
  });

  it('finds projects by name (any case) or by id, and prints a copy-paste snippet', async () => {
    await sbb('new', 'Boss Rush');
    lines.length = 0;
    expect(await sbb('keys', 'boss rush', '--json')).toBe(0);
    const { id, anon } = JSON.parse(lines.at(-1)!);
    lines.length = 0;
    expect(await sbb('snippet', id)).toBe(0);
    expect(output()).toContain(`supabasebutno.createClient('${url}', '${anon}')`);
    expect(output()).not.toContain('service'); // the secret key never appears in the snippet
  });

  it('creates buckets and lists projects', async () => {
    await sbb('new', 'p');
    lines.length = 0;
    expect(await sbb('bucket', 'p', 'avatars', '--public', '--max-bytes', '2000', '--types', 'image/*')).toBe(0);
    expect(output()).toContain('public bucket avatars');
    const p = (await t.admin('GET', '/projects')).json.projects[0];
    const bucket = (await t.admin('GET', `/projects/${p.id}/storage/buckets`)).json.buckets[0];
    expect(bucket).toMatchObject({ name: 'avatars', public: true, file_size_limit: 2000, allowed_mime_types: ['image/*'] });
    lines.length = 0;
    await sbb('list');
    expect(output()).toMatch(/^[a-z0-9]{16}  p$/);
  });

  it('applies a policy from a JSON file, and shows the server validation errors', async () => {
    await sbb('new', 'p');
    await sbb('table', 'p', 't', 'owner:text');
    const files = { 'good.json': '{"select":{"roles":["anon"],"where":true}}', 'bad.json': '{"select":{"roles":["anon"],"where":{"ghost":1}}}' };
    const read = (path: string) => files[path as keyof typeof files];
    const run = (...argv: string[]) => main(argv, { env: { SBB_URL: url, SBB_ADMIN_TOKEN: ADMIN_TOKEN }, envFile: {}, out: (l) => lines.push(l), err: (l) => errors.push(l), readFile: read });
    expect(await run('policy', 'p', 't', 'good.json')).toBe(0);
    expect(await run('policy', 'p', 't', 'bad.json')).toBe(1);
    expect(errors.join('\n')).toMatch(/invalid_policy.*ghost/s);
  });

  it('refuses to delete without the exact name, then deletes', async () => {
    await sbb('new', 'doomed');
    expect(await sbb('delete', 'doomed')).toBe(2);
    expect(await sbb('delete', 'doomed', '--confirm', 'wrong')).toBe(2);
    expect(errors.join('\n')).toContain('--confirm "doomed"');
    expect((await t.admin('GET', '/projects')).json.projects).toHaveLength(1);
    expect(await sbb('delete', 'doomed', '--confirm', 'doomed')).toBe(0);
    expect((await t.admin('GET', '/projects')).json.projects).toHaveLength(0);
  });

  it('gives actionable errors', async () => {
    expect(await sbb('keys', 'ghost')).toBe(2);
    expect(errors.at(-1)).toMatch(/No project "ghost"/);
    expect(await sbb('table', 'only-two')).toBe(2);
    expect(errors.at(-1)).toMatch(/Usage: sbb table/);
    expect(await sbb('frobnicate')).toBe(1);
    expect(await sbb()).toBe(1);
    expect(await sbb('help')).toBe(0);

    const down = await main(['status'], { env: { SBB_URL: 'http://127.0.0.1:1', SBB_ADMIN_TOKEN: 'x' }, envFile: {}, out: () => undefined, err: (l) => errors.push(l) });
    expect(down).toBe(1);
    expect(errors.at(-1)).toMatch(/npm run local/);

    const wrongToken = await main(['list'], { env: { SBB_URL: url, SBB_ADMIN_TOKEN: 'nope' }, envFile: {}, out: () => undefined, err: (l) => errors.push(l) });
    expect(wrongToken).toBe(1);
    expect(errors.at(-1)).toMatch(/invalid_admin_token/);
    const noToken = await main(['list'], { env: { SBB_URL: url }, envFile: {}, out: () => undefined, err: (l) => errors.push(l) });
    expect(noToken).toBe(2);
    expect(errors.at(-1)).toMatch(/npm run local/);
  });
});

describe('npm run local', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sbb-local-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates .env with two different random secrets, once, and never overwrites it', async () => {
    const path = join(dir, '.env');
    expect(ensureEnv(path)).toBe(true);
    const env = readEnvFile(path);
    expect(env.ADMIN_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(env.JWT_MASTER_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(env.ADMIN_TOKEN).not.toBe(env.JWT_MASTER_SECRET);
    expect(env).toMatchObject({ HOST: '127.0.0.1', PORT: '8787' }); // local only by default

    await writeFile(path, 'ADMIN_TOKEN=mine\n');
    expect(ensureEnv(path)).toBe(false);
    expect(await readFile(path, 'utf8')).toBe('ADMIN_TOKEN=mine\n');

    const other = join(dir, 'second.env');
    ensureEnv(other);
    expect(readEnvFile(other).ADMIN_TOKEN).not.toBe(env.ADMIN_TOKEN);
  });

  it('parses .env files, ignoring comments and blank lines', async () => {
    const path = join(dir, '.env');
    await writeFile(path, '# comment\n\nADMIN_TOKEN = abc \r\n#PORT=1\nPORT=9000\n');
    expect(readEnvFile(path)).toEqual({ ADMIN_TOKEN: 'abc', PORT: '9000' });
    expect(readEnvFile(join(dir, 'missing.env'))).toEqual({});
  });

  it('rebuilds only when the sources are newer than the build', async () => {
    const src = join(dir, 'src');
    await mkdir(join(src, 'deep'), { recursive: true });
    const built = join(dir, 'index.js');
    await writeFile(join(src, 'deep', 'a.ts'), '1');
    expect(needsBuild(src, built)).toBe(true); // no build yet

    await writeFile(built, 'built');
    const later = new Date(Date.now() + 5000);
    await utimes(built, later, later);
    expect(needsBuild(src, built)).toBe(false);

    const evenLater = new Date(Date.now() + 10_000);
    await utimes(join(src, 'deep', 'a.ts'), evenLater, evenLater);
    expect(needsBuild(src, built)).toBe(true); // a nested source changed
    expect((await stat(built)).isFile()).toBe(true);
  });
});
