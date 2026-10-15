// 백업 한 번 실행 → 날짜별 .tar.gz 로 압축 → 최근 N개만 남기고 정리.
//
//   npm run backup:rotate                      내 PC / VM 에서 직접 실행 중인 서버
//   npm run backup:rotate -- --docker          Docker Compose 로 실행 중인 서버
//   옵션: --dir backups   저장 폴더 (기본 ./backups)
//         --keep 7        남길 개수 (기본 7, 또는 .env 의 BACKUP_KEEP)
//
// 백업 자체는 server 의 `backup` 명령(SQLite 온라인 백업 + 체크섬)을 그대로 씁니다. 서버를 끌 필요가 없습니다.
// 압축에는 시스템의 `tar` 를 씁니다 (Windows 10+ / macOS / Linux 모두 기본 제공).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readEnvFile } from './local.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 이름의 시각(backup-YYYYMMDD-HHMMSS)이 오래된 순으로 정렬되므로, 앞쪽을 지우면 오래된 것부터 지워집니다. */
export function selectBackupsToDelete(names, keep) {
  const archives = names.filter((n) => /^backup-\d{8}-\d{6}\.tar\.gz$/.test(n)).sort();
  return archives.slice(0, Math.max(0, archives.length - keep));
}

/** 압축되지 않은 백업 폴더(backup-YYYYMMDD-HHMMSS) 이름만 골라냅니다. */
export function uncompressedBackups(entries) {
  return entries.filter((e) => e.isDirectory() && /^backup-\d{8}-\d{6}$/.test(e.name)).map((e) => e.name);
}

export function parseArgs(argv, env = {}) {
  const out = { dir: 'backups', keep: Number(env.BACKUP_KEEP) || 7, docker: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--docker') out.docker = true;
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--keep') out.keep = Number(argv[++i]);
    else throw new Error(`알 수 없는 옵션: ${a}`);
  }
  if (!out.dir) throw new Error('--dir 뒤에 폴더 이름이 필요합니다');
  if (!Number.isInteger(out.keep) || out.keep < 1) throw new Error('--keep 은 1 이상의 정수여야 합니다');
  return out;
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
  if (res.error) throw new Error(`${cmd} 실행 실패: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${cmd} 가 종료 코드 ${res.status} 로 끝났습니다`);
}

/** 백업 → 압축 → 정리. 테스트에서 가짜 `runner` 를 넣을 수 있습니다. */
export function backupAndRotate({ dir, keep, docker }, runner = run) {
  const backupDir = resolve(root, dir);
  mkdirSync(backupDir, { recursive: true });

  if (docker) runner('docker', ['compose', '--profile', 'tools', 'run', '--rm', 'backup']);
  else {
    if (!existsSync(join(root, 'packages', 'server', 'dist', 'cli', 'backup.js'))) throw new Error('서버가 빌드되지 않았습니다. 먼저 `npm run build` 를 실행하세요.');
    runner(process.execPath, [join(root, 'packages', 'server', 'dist', 'cli', 'backup.js'), backupDir]);
  }

  const packed = [];
  for (const name of uncompressedBackups(readdirSync(backupDir, { withFileTypes: true }))) {
    const archive = `${name}.tar.gz`;
    // 폴더 안에서 상대 경로로 실행합니다: GNU tar(Git Bash 등)는 "C:\..." 를 원격 호스트 주소로 오해하기 때문입니다.
    runner('tar', ['-czf', archive, name], { cwd: backupDir });
    // 압축 파일이 실제로 만들어진 것을 확인한 뒤에만 원본 폴더를 지웁니다.
    if (!existsSync(join(backupDir, archive)) || statSync(join(backupDir, archive)).size === 0) throw new Error(`${archive} 압축에 실패했습니다 (원본 폴더는 그대로 둡니다)`);
    rmSync(join(backupDir, name), { recursive: true, force: true });
    packed.push(archive);
  }

  const removed = selectBackupsToDelete(readdirSync(backupDir), keep);
  for (const name of removed) rmSync(join(backupDir, name), { force: true });
  return { backupDir, packed, removed, kept: readdirSync(backupDir).filter((n) => n.endsWith('.tar.gz')).length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const opts = parseArgs(process.argv.slice(2), readEnvFile());
    const r = backupAndRotate(opts);
    console.log(`\n압축: ${r.packed.join(', ') || '(새 백업 없음)'}`);
    console.log(`삭제(오래된 것): ${r.removed.join(', ') || '없음'}`);
    console.log(`보관 중인 백업: ${r.kept}개 (최대 ${opts.keep}개) — 폴더: ${r.backupDir}`);
    console.log('주의: 백업에는 사용자 비밀번호 해시가 들어 있습니다. 저장소에 올리지 말고, ADMIN_TOKEN / JWT_MASTER_SECRET 은 따로 보관하세요.');
  } catch (err) {
    console.error(`백업 실패: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}
