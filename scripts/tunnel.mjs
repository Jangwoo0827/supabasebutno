// 서버를 인터넷에 여는 터널을 실행합니다.   npm run tunnel
//
// .env 의 TUNNEL 값으로 종류를 고릅니다 (기본: ngrok).
//   TUNNEL=ngrok         ngrok 고정 도메인. /admin, /dashboard 는 deploy/ngrok-policy.yml 이 404 로 막습니다.
//   TUNNEL=cloudflared   Cloudflare Tunnel.
//       CLOUDFLARE_TUNNEL_TOKEN 이 있으면 → 내 도메인에 연결된 고정 터널 (권장)
//       없으면                          → 임시 주소(trycloudflare.com, 실행할 때마다 바뀜). 테스트용입니다.
//
// 주의: Cloudflare 쪽에는 ngrok 정책 같은 경로 차단이 없으므로, 관리자 보호는 서버의 ADMIN_ALLOWED_IPS 로 하세요
//       (README 의 "보안 체크리스트" 참고). 터널 뒤에서는 TRUST_PROXY_HOPS=1 이어야 합니다.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readEnvFile } from './local.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 실행할 명령을 계산합니다 (실행은 하지 않음 — 테스트하기 쉽게 분리). */
export function tunnelCommand(env) {
  const provider = (env.TUNNEL || 'ngrok').toLowerCase();
  const port = env.PORT || '8787';
  if (provider === 'ngrok') {
    return { provider, cmd: 'ngrok', args: ['http', port, '--traffic-policy-file', 'deploy/ngrok-policy.yml'], env: {} };
  }
  if (provider === 'cloudflared' || provider === 'cloudflare') {
    const token = env.CLOUDFLARE_TUNNEL_TOKEN;
    if (token) {
      // 토큰은 명령줄(프로세스 목록에 보임)이 아니라 환경변수로 넘깁니다.
      return { provider: 'cloudflared', cmd: 'cloudflared', args: ['tunnel', '--no-autoupdate', 'run'], env: { TUNNEL_TOKEN: token } };
    }
    return { provider: 'cloudflared', cmd: 'cloudflared', args: ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], env: {}, temporary: true };
  }
  throw new Error(`알 수 없는 TUNNEL 값: "${provider}" (ngrok 또는 cloudflared)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const env = { ...readEnvFile(), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => ['TUNNEL', 'PORT', 'CLOUDFLARE_TUNNEL_TOKEN'].includes(k))) };
    const t = tunnelCommand(env);
    if (t.temporary) console.log('CLOUDFLARE_TUNNEL_TOKEN 이 없어 임시 주소로 실행합니다 (주소가 매번 바뀜). 고정 주소는 README 의 Cloudflare 절차를 따르세요.');
    console.log(`터널 시작: ${t.provider}  (끄려면 Ctrl+C)`);
    const child = spawn(t.cmd, t.args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...t.env } });
    child.on('error', (e) => {
      console.error(`${t.cmd} 를 실행할 수 없습니다: ${e.message}\n설치되어 있고 PATH 에 있는지 확인하세요.`);
      process.exitCode = 1;
    });
    child.on('exit', (code) => process.exit(code ?? 0));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
