import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupAndRotate, parseArgs, selectBackupsToDelete, uncompressedBackups } from '../../../scripts/backup-rotate.mjs';
import { tunnelCommand } from '../../../scripts/tunnel.mjs';

describe('backup rotation', () => {
  it('keeps the newest N archives and deletes the oldest; ignores other files', () => {
    const names = [
      'backup-20261011-020000.tar.gz',
      'backup-20261012-020000.tar.gz',
      'backup-20261013-020000.tar.gz',
      'backup-20261014-020000.tar.gz',
      'notes.txt',
      'backup-20261015-020000', // 압축 전 폴더는 대상이 아님
    ];
    expect(selectBackupsToDelete(names, 2)).toEqual(['backup-20261011-020000.tar.gz', 'backup-20261012-020000.tar.gz']);
    expect(selectBackupsToDelete(names, 4)).toEqual([]);
    expect(selectBackupsToDelete(names, 10)).toEqual([]);
  });

  it('parses options and rejects bad ones', () => {
    expect(parseArgs([], {})).toEqual({ dir: 'backups', keep: 7, docker: false });
    expect(parseArgs(['--docker', '--keep', '3', '--dir', 'x'], {})).toEqual({ dir: 'x', keep: 3, docker: true });
    expect(parseArgs([], { BACKUP_KEEP: '5' }).keep).toBe(5);
    expect(() => parseArgs(['--keep', '0'], {})).toThrow();
    expect(() => parseArgs(['--nope'], {})).toThrow();
  });

  it('picks only uncompressed backup folders', () => {
    const e = (name: string, dir: boolean) => ({ name, isDirectory: () => dir });
    expect(uncompressedBackups([e('backup-20261011-020000', true), e('backup-20261011-020000.tar.gz', false), e('other', true)])).toEqual(['backup-20261011-020000']);
  });

  it('end to end with a fake runner: packs the new folder, removes it, trims to --keep', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sbb-rot-'));
    try {
      for (const d of ['20261010', '20261011', '20261012']) await writeFile(join(dir, `backup-${d}-020000.tar.gz`), 'x');
      const calls: string[] = [];
      // "백업" 단계는 새 폴더를 만들고, "tar" 단계는 압축 파일을 만드는 것처럼 흉내 낸다 (runner 는 동기 호출).
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const syncRunner = (cmd: string, args: string[], opts?: { cwd?: string }) => {
        calls.push(cmd === 'tar' ? 'tar' : 'backup');
        if (cmd === 'tar') {
          expect(opts?.cwd).toBe(dir); // 상대 경로 + cwd 로 실행되는지
          expect(args[1]).toBe('backup-20261013-020000.tar.gz');
          writeFileSync(join(opts!.cwd!, args[1]!), 'archive-data');
        }
        else {
          mkdirSync(join(dir, 'backup-20261013-020000'));
          writeFileSync(join(dir, 'backup-20261013-020000', 'manifest.json'), '{}');
        }
      };
      const result = backupAndRotate({ dir, keep: 3, docker: true }, syncRunner);
      expect(calls).toEqual(['backup', 'tar']);
      expect(result.packed).toEqual(['backup-20261013-020000.tar.gz']);
      expect(result.removed).toEqual(['backup-20261010-020000.tar.gz']);
      expect((await readdir(dir)).sort()).toEqual(['backup-20261011-020000.tar.gz', 'backup-20261012-020000.tar.gz', 'backup-20261013-020000.tar.gz']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the original folder when compression produced nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sbb-rot-'));
    try {
      const { mkdirSync } = await import('node:fs');
      const runner = (cmd: string) => {
        if (cmd !== 'tar') mkdirSync(join(dir, 'backup-20261013-020000'));
        // tar 는 아무것도 만들지 않음
      };
      expect(() => backupAndRotate({ dir: dir, keep: 3, docker: true }, runner)).toThrow(/압축/);
      expect(await readdir(dir)).toEqual(['backup-20261013-020000']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('tunnel command', () => {
  it('defaults to ngrok with the admin-blocking policy on the configured port', () => {
    const t = tunnelCommand({ PORT: '9000' });
    expect(t).toMatchObject({ provider: 'ngrok', cmd: 'ngrok' });
    expect(t.args).toEqual(['http', '9000', '--traffic-policy-file', 'deploy/ngrok-policy.yml']);
  });

  it('cloudflared with a token passes it by environment, never on the command line', () => {
    const t = tunnelCommand({ TUNNEL: 'cloudflared', CLOUDFLARE_TUNNEL_TOKEN: 'secret-token' });
    expect(t.cmd).toBe('cloudflared');
    expect(t.args.join(' ')).not.toContain('secret-token');
    expect(t.env).toEqual({ TUNNEL_TOKEN: 'secret-token' });
    expect(t.temporary).toBeUndefined();
  });

  it('cloudflared without a token starts a temporary tunnel to the local port', () => {
    const t = tunnelCommand({ TUNNEL: 'cloudflared', PORT: '8787' });
    expect(t.temporary).toBe(true);
    expect(t.args).toContain('http://127.0.0.1:8787');
  });

  it('rejects unknown providers', () => {
    expect(() => tunnelCommand({ TUNNEL: 'frp' })).toThrow(/TUNNEL/);
  });
});
