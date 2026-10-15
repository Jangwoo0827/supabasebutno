# supabasebutno

Supabase의 핵심 기능 중 실제로 쓰는 것만 가볍게 구현한 **셀프호스팅 멀티 프로젝트 BaaS**입니다.
Node.js + TypeScript, [Hono](https://hono.dev), SQLite(better-sqlite3).

> **기능**: 멀티 프로젝트 · 테이블 관리 · REST CRUD · 이메일 로그인 · 행 단위 접근 정책 · 파일 스토리지 · 실시간(WebSocket) · JS SDK · 관리자 대시보드 · 백업/복원 · Docker.
> 각 기능의 설계와 **한계/경고**는 아래 장마다 적혀 있습니다. 운영 전에는 [프로덕션 체크리스트](#프로덕션-체크리스트)를 꼭 읽으세요.

## 요구사항

- Node.js **22.9 이상** (개발은 24에서 확인)
- 영구 디스크가 있는 단일 서버/컨테이너 (SQLite 파일을 쓰므로 서버리스 환경은 불가)

## 빠른 시작

```bash
npm install
cp .env.example .env     # 그 다음 .env 의 ADMIN_TOKEN, JWT_MASTER_SECRET 채우기
npm run dev
```

비밀값 생성 (각각 따로 생성하세요):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

서버는 기본적으로 `http://127.0.0.1:8787` 에서 뜹니다. **관리자 대시보드는 `http://127.0.0.1:8787/dashboard/`** 입니다 (`ADMIN_TOKEN` 으로 로그인).

| 스크립트 | 설명 |
|---|---|
| `npm run dev` | tsx watch 로 개발 서버 실행 (대시보드 파일은 시작할 때 읽으므로 고치면 서버를 다시 시작하세요) |
| `npm run build` / `npm start` | `dist/` 로 빌드 후 실행 (SDK 번들 포함) |
| `npm test` | 서버 + SDK 전체 테스트 (실제 서버를 띄워서 실행) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run backup -- <폴더>` / `npm run restore -- <백업폴더>` | [백업·복원](#백업과-복원) (먼저 `npm run build`) |
| `npm run backup:rotate` | 백업 → 날짜별 `.tar.gz` 압축 → 최근 7개만 보관. [정기 백업](#정기-백업-날짜별-압축--최근-7개) |
| `npm run tunnel` | 서버를 인터넷에 여는 터널 실행 (`.env` 의 `TUNNEL=ngrok` 또는 `cloudflared`) |

## 내 PC에서 바로 쓰기 (가장 쉬운 방법)

```bash
npm run local            # 또는 start-local.cmd 더블클릭
```

처음 실행하면 무작위 비밀값이 든 `.env` 를 만들고(git 에 올라가지 않음), 필요하면 설치·빌드까지 한 뒤 `127.0.0.1:8787` 에서 서버를 켭니다. **이 PC 안에서만 접근 가능**하므로 HTTPS·도메인·GitHub Pages 가 필요 없고, 대시보드는 `http://127.0.0.1:8787/dashboard/` 입니다 (`.env` 의 `ADMIN_TOKEN` 으로 로그인).

`sbb` 명령으로 대시보드 없이도 프로젝트를 만들 수 있습니다 (서버가 켜져 있어야 함):

```bash
npm run sbb -- new my-game                                   # 프로젝트 + 키 출력
npm run sbb -- table my-game scores player:text:nn time_ms:integer:nn user_id:text
npm run sbb -- policy my-game scores leaderboard             # 누구나 읽기, 로그인해야 기록 (user_id 컬럼 자동 사용)
npm run sbb -- snippet my-game                               # 웹페이지에 붙여 넣을 코드
npm run sbb -- --help                                        # status list keys tables bucket delete …
```

- 컬럼 문법: `이름:타입[:pk][:nn][:unique][:default=값|now|uuid]` (타입: text integer real boolean json timestamp uuid). `pk` 가 없으면 `id integer` 기본 키가 자동으로 추가됩니다.
- 정책 프리셋: `public-read` · `authenticated` · `owner` · `leaderboard` (`owner=컬럼`, `leaderboard=컬럼` 으로 사용자 id 컬럼 지정). JSON 파일 경로를 줘도 됩니다.
- **테이블을 만들어도 정책이 없으면 `service_role` 키만 쓸 수 있습니다.** `sbb tables <프로젝트>` 가 정책이 없는 테이블을 `NO POLICY` 로 표시합니다.
- **내 PC 에서만 도는 서버**를 쓰는 앱은 PC 가 꺼져 있으면 동작하지 않고, 다른 사람은 접속할 수 없습니다. GitHub Pages/itch.io 에 올려 다른 사람이 쓰는 앱에는 공개 HTTPS 서버가 필요합니다 (임시로는 `npm run tunnel` / `start-online.cmd`, 상시 운영은 [배포](#배포-docker)와 [상시 운영으로 옮기기](#상시-운영으로-옮기기) 참고).
- PC 를 켤 때 자동으로 시작하고 싶다면 `start-local.cmd` 의 바로가기를 시작프로그램 폴더(`shell:startup`)에 넣으면 됩니다.

## 관리자 대시보드 (Phase 7)

`/dashboard/` — 프로젝트 목록·생성·삭제, **API 키 확인·재발급**, 테이블 편집기(생성·컬럼 추가/이름 변경/삭제·테이블 이름 변경/삭제), **데이터 편집기**(필터·페이지·행 추가/수정/삭제), 접근 정책 편집기(템플릿 + 서버 검증 오류 표시), 사용자 목록(삭제·강제 로그아웃), 파일(버킷 설정, 업로드·다운로드·삭제).

- **로그인**: `ADMIN_TOKEN` 을 한 번 입력하면 서버가 8시간짜리 세션 쿠키를 줍니다. 쿠키는 `HttpOnly` · `SameSite=Strict` · `Path=/admin` (HTTPS 에서는 `Secure`)이고 토큰 자체는 브라우저에 남지 않습니다. 로그아웃하면 세션이 **서버에서도 폐기**되어 복사해 둔 쿠키도 못 씁니다. 로그인 실패는 IP 당 10회/15분으로 제한됩니다.
- **CSRF 방어**: 쿠키로 인증된 요청 중 데이터를 바꾸는 것은 `X-SBB-CSRF` 헤더와 같은 Origin 이어야 통과합니다 (다른 사이트는 CORS 가 막혀 이 헤더를 못 붙임). Bearer 토큰으로 호출하는 스크립트(curl 등)는 영향이 없습니다.
- **XSS 방어**: 화면은 `innerHTML` 없이 DOM API 로만 그리고(테스트가 소스를 검사함), CSP 는 `script-src 'self'; style-src 'self'; default-src 'none'; frame-ancestors 'none'` 입니다. 테이블 셀이나 프로젝트 이름에 `<script>` 가 들어 있어도 글자로만 표시됩니다.
- 데이터 편집기와 파일 화면은 `service_role` 권한으로 동작해서 **접근 정책을 우회**합니다 (관리자 도구이므로).
- 외부 접근을 막고 싶다면 리버스 프록시에서 `/admin*`, `/dashboard*` 를 내 IP 에만 열어 두세요 ([deploy/Caddyfile.example](deploy/Caddyfile.example)).

### GitHub Pages 에서 대시보드 호스팅

대시보드는 정적 파일이라 GitHub Pages 에 올릴 수 있습니다. 단, **페이지(`https://<이름>.github.io`)와 API 서버는 다른 출처**라서 서버 쪽 설정이 필요합니다. 이 방식에서는 쿠키 대신 로그인 화면에서 **API 주소 + `ADMIN_TOKEN`** 을 입력하고, 토큰은 그 탭의 `sessionStorage` 에만 보관(탭을 닫으면 삭제)한 채 `Authorization: Bearer` 로 보냅니다.

1. **API 서버를 HTTPS 로 공개** — GitHub Pages 는 HTTPS 라서 `http://` 서버는 브라우저가 막습니다 (localhost 제외). [배포](#배포-docker) 장의 Caddy 예시를 쓰세요. 대시보드의 API 호출은 Pages 서버가 아니라 **내 브라우저**가 보내므로, 예시처럼 프록시에서 `/admin*` 을 내 IP 로만 허용해도 그대로 동작하고 오히려 권장합니다 (집 IP 가 바뀌면 설정도 바꿔야 함).
2. **서버 `.env`**: `ADMIN_CORS_ORIGINS=https://<이름>.github.io` — 이 출처의 페이지만 `/admin` 을 호출할 수 있습니다 (정확한 출처만, `*`·경로 불가. 설정하지 않으면 `/admin` 은 같은 출처 전용 그대로).
3. **저장소 설정**: Settings → Pages → Source 를 **GitHub Actions** 로, Settings → Secrets and variables → Actions → **Variables** 에 `SBB_API_URL=https://내-api-서버` 추가.
4. Actions 탭에서 **Dashboard (GitHub Pages)** 워크플로를 수동 실행합니다 ([.github/workflows/pages.yml](.github/workflows/pages.yml)). 실수로 공개되지 않도록 일부러 수동 실행입니다.

로컬에서 미리 만들어 보려면 `SBB_API_URL=https://… npm run build:pages` → `pages-dist/`. [scripts/build-pages.mjs](scripts/build-pages.mjs) 가 `index.html` 에 원격 모드 표시와 CSP `<meta>` 를 넣습니다 (GitHub Pages 는 응답 헤더를 못 보내기 때문). `SBB_API_URL` 을 지정하면 CSP 의 `connect-src` 가 **그 서버 하나로 고정**되어, 페이지가 변조되더라도 토큰을 다른 서버로 보내는 연결은 브라우저가 막습니다. 지정하지 않으면 로그인 화면에서 입력한 아무 `https://` 서버에 연결할 수 있어 이 보호가 약해지니 **지정을 권장**합니다. 주소는 `https://`(또는 localhost 의 `http://`)만 허용하고, 아니면 빌드가 실패합니다.

**Pages 방식의 위험 (같은 출처 쿠키 방식보다 약한 점)**

- 토큰이 **GitHub 에서 내려받은 JavaScript 가 도는 페이지**에 입력됩니다. 저장소/계정이 탈취되면 배포된 코드가 바뀌어 토큰을 훔칠 수 있습니다. GitHub 계정에 2단계 인증을 켜고, 저장소 쓰기 권한을 최소로 하고, `SBB_API_URL` 로 CSP 를 고정하세요.
- 쿠키 방식은 토큰이 브라우저에 남지 않지만, 이 방식은 탭이 열려 있는 동안 `sessionStorage` 에 있습니다. 공용 PC 에서는 쓰지 말고 끝나면 로그아웃하세요.
- `/admin` 이 인터넷의 다른 출처에서 호출 가능해지므로 `ADMIN_TOKEN` 이 약하면 위험합니다 (실패는 IP 당 10회/15분으로 제한되지만 분산 공격은 막지 못함). 32자 이상 무작위 값을 쓰세요.
- 더 안전하게 쓰려면 Pages 대신 서버가 직접 서빙하는 `/dashboard/` 를 쓰고 프록시로 내 IP 만 허용하는 방식이 낫습니다.

## 환경변수

| 이름 | 기본값 | 설명 |
|---|---|---|
| `ADMIN_TOKEN` | (필수, 32자↑) | `/admin` API 의 Bearer 토큰. **모든 프로젝트에 대한 전체 권한** |
| `JWT_MASTER_SECRET` | (필수, 32자↑) | 프로젝트별 API 키 서명 시크릿의 원본. `ADMIN_TOKEN` 과 달라야 함. **바꾸면 발급된 모든 키가 무효화** |
| `PORT` | `8787` | |
| `HOST` | `127.0.0.1` | Docker 안에서는 `0.0.0.0`, 앞단에 TLS 리버스 프록시 필수 |
| `DATA_DIR` | `<repo>/data` | `admin.sqlite` 와 프로젝트별 데이터 위치 |
| `CORS_ORIGINS` | (빈 값 = CORS 꺼짐) | 데이터 API 를 호출할 수 있는 origin 목록(쉼표 구분) 또는 `*`. `/admin` 에는 적용되지 않음 |
| `MAX_JSON_BYTES` | `1048576` | JSON 요청 본문 최대 크기 (파일 업로드는 해당 없음) |
| `TRUST_PROXY_HOPS` | `0` | 앞단 리버스 프록시 개수. rate limit 의 클라이언트 IP 판단에 쓰임 ([인증](#사용자-인증-api-phase-2) 참고) |
| `ACCESS_TOKEN_TTL_SECONDS` / `REFRESH_TOKEN_TTL_DAYS` | `900` / `30` | 로그인 세션 수명 |
| `MAX_UPLOAD_BYTES` | `52428800` | 파일 1개 최대 크기 (50 MiB) |
| `STORAGE_USER_QUOTA_BYTES` | `104857600` | 로그인 사용자 1명이 프로젝트에 저장할 수 있는 총량 (100 MiB) |
| `STORAGE_PROJECT_QUOTA_BYTES` | `2147483648` | 프로젝트 전체 저장 총량 (2 GiB) |
| `REALTIME_MAX_CONNECTIONS` | `500` | 동시에 받아주는 WebSocket 연결 수 |
| `ADMIN_ALLOWED_IPS` | (빈 값 = 제한 없음) | `/admin`, `/dashboard` 에 접근할 수 있는 IP (쉼표 구분, 단일 IP). 그 외는 404. 프록시 뒤에서는 `TRUST_PROXY_HOPS` 필수 |
| `SIGNUP_ENABLED` | `true` | `false` 면 새 가입을 막음 (기존 사용자는 로그인 가능) |
| `PUBLIC_URL` | (빈 값) | 공개 주소 안내용 (`start-online.cmd` 가 표시만 함, 코드는 이 값에 의존하지 않음) |
| `TUNNEL` / `CLOUDFLARE_TUNNEL_TOKEN` | `ngrok` / (빈 값) | `npm run tunnel` 이 쓰는 터널 종류와 Cloudflare 토큰 (비밀) |
| `BACKUP_KEEP` | `7` | `npm run backup:rotate` 가 남길 백업 개수 |

## 구조

```
data/
├─ admin.sqlite                    # 프로젝트 목록 (control plane)
└─ projects/<id>/
   ├─ db.sqlite                    # 프로젝트 전용 DB (사용자 테이블 + 예약된 _테이블)
   └─ storage/<파일 uuid>          # 업로드한 파일 (이름은 랜덤 uuid, 사용자가 정한 경로는 DB 의 이름표)
```

소스 구조: `packages/server`(API 서버) · `packages/client`(SDK) · `packages/dashboard/public`(대시보드 정적 파일).

- 프로젝트마다 **DB 파일, 스토리지, API 키 서명 시크릿이 완전히 분리**됩니다.
- API 키는 Supabase 처럼 JWT(`role: anon | service_role`, `ref: <projectId>`)이고, 서명 시크릿은
  `HKDF(JWT_MASTER_SECRET, 프로젝트 id, key_version)` 으로 파생됩니다. 키 자체는 DB에 저장되지 않고 언제든 다시 조회할 수 있습니다.
- 요청이 어느 프로젝트의 것인지는 `apikey` 헤더의 키에서 결정됩니다 (`/rest/:table` 처럼 URL에 프로젝트 id 가 없음).
- 이름이 `_` 로 시작하는 테이블은 내부용으로 예약되어 API로 읽기/수정/삭제할 수 없습니다.

## Admin API (Phase 1a)

모든 요청에 `Authorization: Bearer <ADMIN_TOKEN>` 이 필요합니다. 예제는 bash 기준입니다.

```bash
export B=http://127.0.0.1:8787
export A="Authorization: Bearer $ADMIN_TOKEN"
```

### 프로젝트

| 메서드 | 경로 | 설명 |
|---|---|---|
| `POST` | `/admin/projects` | 생성. 본문 `{"name": "..."}` → 키 포함 응답(201) |
| `GET` | `/admin/projects` | 목록 (키 미포함) |
| `GET` | `/admin/projects/:id` | 상세 + `anon` / `service_role` 키 |
| `POST` | `/admin/projects/:id/rotate-keys` | 키 로테이션 (이전 키 전부 즉시 무효화) |
| `DELETE` | `/admin/projects/:id?confirm=<프로젝트 이름>` | **되돌릴 수 없는** 삭제 (DB·파일 전부). `confirm` 이 이름과 같아야 함 |

```bash
curl -X POST $B/admin/projects -H "$A" -H "Content-Type: application/json" -d '{"name":"my-app"}'
```

발급된 키 확인:

```bash
curl $B/whoami -H "apikey: <anon 또는 service_role 키>"
# {"project":{"id":"...","name":"my-app"},"role":"anon"}
```

- `anon` : 공개용. Phase 3 이후 정책이 허용한 것만 가능 (정책이 없으면 거부).
- `service_role` : 서버 전용. **절대 브라우저/확장 프로그램에 넣지 마세요.**

### 테이블

| 메서드 | 경로 | 설명 |
|---|---|---|
| `GET` | `/admin/projects/:id/tables` | 목록 + 컬럼 |
| `POST` | `/admin/projects/:id/tables` | 생성 (201) |
| `GET` | `/admin/projects/:id/tables/:table` | 상세 |
| `PATCH` | `/admin/projects/:id/tables/:table` | 수정 |
| `DELETE` | `/admin/projects/:id/tables/:table` | 삭제 (204) |

생성 예:

```bash
curl -X POST $B/admin/projects/$ID/tables -H "$A" -H "Content-Type: application/json" -d '{
  "name": "todos",
  "columns": [
    { "name": "id",         "type": "uuid",      "primary_key": true, "default": { "fn": "uuid" } },
    { "name": "title",      "type": "text",      "not_null": true },
    { "name": "done",       "type": "boolean",   "not_null": true, "default": false },
    { "name": "created_at", "type": "timestamp", "default": { "fn": "now" } }
  ]
}'
```

수정 예 (적용 순서: `add_columns` → `rename_columns` → `drop_columns` → `rename_to`, 하나의 트랜잭션):

```bash
curl -X PATCH $B/admin/projects/$ID/tables/todos -H "$A" -H "Content-Type: application/json" -d '{
  "add_columns":    [{ "name": "priority", "type": "integer", "default": 0 }],
  "rename_columns": [{ "from": "title", "to": "name" }],
  "drop_columns":   ["created_at"],
  "rename_to":      "tasks"
}'
```

**컬럼 타입:** `text`, `integer`, `real`, `boolean`, `json`, `timestamp`(ISO-8601 문자열), `uuid`.
**기본값:** 리터럴(문자열/숫자/불리언/`null`) 또는 `{"fn":"now"}`(timestamp), `{"fn":"uuid"}`(uuid).
**이름 규칙:** 테이블/컬럼 모두 `^[a-z][a-z0-9_]{0,62}$` (소문자로 시작, `sqlite_` 접두사 금지).

## REST API (Phase 1b)

`apikey` 헤더의 키로 프로젝트가 결정되므로 URL에는 프로젝트 id가 없습니다.
`anon` / 로그인한 사용자는 아래 [접근 제어](#접근-제어--정책-phase-3) 정책이 허용한 것만 할 수 있습니다 (정책이 없으면 **403**).

```bash
export R="apikey: <service_role 키>"
curl -X POST "$B/rest/todos" -H "$R" -H "Content-Type: application/json" -H "Prefer: return=representation" \
     -d '[{"title":"buy milk"},{"title":"write code","done":true}]'
curl "$B/rest/todos?done=eq.false&order=id.desc&limit=10&select=id,title" -H "$R"
curl -X PATCH "$B/rest/todos?id=eq.1" -H "$R" -H "Content-Type: application/json" -d '{"done":true}'
curl -X DELETE "$B/rest/todos?id=eq.1" -H "$R"
```

| 항목 | 문법 |
|---|---|
| 필터 | `?col=op.value` — `eq` `neq` `gt` `gte` `lt` `lte` `like` `ilike` `in.(a,b)` `is.null`/`is.true`/`is.false`. 앞에 `not.` 로 부정. 같은 컬럼을 여러 번 쓰면 AND |
| `like` | `*` 가 와일드카드. `%`, `_` 는 문자 그대로 취급 (SQLite 의 LIKE 는 ASCII 대소문자를 구분하지 않음) |
| 컬럼 | `select=id,title` (기본 `*`) |
| 정렬 | `order=priority.desc,id` , `.nullsfirst` / `.nullslast` |
| 페이징 | `limit` (기본·최대 1000), `offset`. 정렬 끝에 항상 PK 가 붙어 페이징이 결정적 |
| 개수 | `Prefer: count=exact` → `Content-Range: 0-9/42` |
| 쓰기 응답 | 기본은 본문 없음(POST 201 / PATCH·DELETE 204). `Prefer: return=representation` 이면 행을 반환 |
| 일괄 INSERT | 본문이 배열이면 (최대 1000행) 한 트랜잭션 — 하나라도 실패하면 전부 취소 |
| Upsert | `Prefer: resolution=merge-duplicates` (+ `?on_conflict=<PK 또는 UNIQUE 컬럼>`, 기본 PK) / `resolution=ignore-duplicates` |

**안전장치**

- 값은 전부 바인딩 파라미터이고, 테이블/컬럼 이름은 실제 스키마에 존재하는 것만 통과합니다.
- `PATCH` / `DELETE` 는 **필터가 최소 하나 필수**입니다. 전체 대상이면 `?id=not.is.null` 처럼 명시하세요.
- 쓰기 요청에서 `limit` / `order` / `offset` 은 무시하지 않고 **400으로 거부**합니다 (`?limit=1` 이 무시되어 전체가 수정되는 사고 방지).
- 타입이 엄격합니다: `"1"` 을 integer 컬럼에, `1` 을 boolean 컬럼에 넣으면 400.
- UNIQUE 위반 409 · NOT NULL 위반 400 으로 응답하고 DB 내부 메시지는 노출하지 않습니다.

## 사용자 인증 API (Phase 2)

프로젝트별로 완전히 분리된 이메일+비밀번호 인증입니다. 모든 요청에 `apikey` 헤더(anon 키)가 필요하고,
로그인 후에는 `Authorization: Bearer <access_token>` 을 함께 보냅니다 (REST·스토리지에서 `authenticated` 역할이 됨).

| 메서드 | 경로 | 설명 |
|---|---|---|
| `POST` | `/auth/signup` | `{email, password, data?}` → 세션 (201). 이미 있는 이메일은 409 |
| `POST` | `/auth/login` | `{email, password}` → 세션 |
| `POST` | `/auth/refresh` | `{refresh_token}` → 새 세션 (refresh token 회전) |
| `POST` | `/auth/logout` | (Bearer) `{scope?: "local" \| "global"}` → 204. 기본은 현재 기기만 |
| `GET` / `PUT` | `/auth/user` | (Bearer) 내 정보 / `{data?, password?, current_password?}` 수정 |
| `POST` | `/auth/recover` | `{email}` → 항상 200. 재설정 토큰을 메일로 전송 |
| `POST` | `/auth/reset` | `{token, password}` → 204. 모든 세션 로그아웃 |

세션 응답: `{access_token, token_type, expires_in, expires_at, refresh_token, user}`

```bash
curl -X POST $B/auth/signup -H "apikey: $ANON" -H "Content-Type: application/json" \
     -d '{"email":"me@example.com","password":"correct horse battery","data":{"name":"Me"}}'
```

**설계**

- 비밀번호는 **argon2id**(OWASP 권장 파라미터). 8~128자, 별도 조합 규칙 없음.
- **Access token** 은 15분짜리 JWT(HS256, 프로젝트별 시크릿)이고 `sid`(세션 id)를 담습니다. 서버는 **요청마다 세션이 폐기되지 않았는지 확인**하므로
  로그아웃·비밀번호 변경·계정 삭제가 즉시 반영됩니다 (요청당 인덱스 조회 1회).
- **Refresh token** 은 256비트 난수이고 DB 에는 SHA-256 해시만 저장됩니다. 사용할 때마다 **회전**하며,
  이미 회전된 토큰을 10초 뒤에 다시 쓰면 탈취로 보고 **해당 세션 전체를 폐기**합니다 (두 탭이 동시에 갱신하는 경우를 위해 10초 유예).
- 로그인은 **3중 rate limit**: IP(실패 30회/15분), 이메일+IP(실패 5회/15분), 이메일(실패 40회/15분). 성공하면 이메일 카운터는 초기화됩니다.
  낯선 사람이 남의 계정을 잠가 버릴 수 없도록 "이메일+IP" 조합을 씁니다. 가입(IP당 10회/시간)·재설정 요청(IP당 5회, 계정당 3회/시간)·`/admin` 실패(IP당 10회/15분)도 제한됩니다. 초과 시 `429` + `Retry-After`.
- 존재하지 않는 이메일로 로그인해도 같은 시간·같은 응답이 나옵니다 (더미 해시 검증). `/auth/recover` 는 등록 여부와 무관하게 항상 같은 응답입니다.
- 비밀번호 재설정 메일은 `Mailer` 인터페이스([mailer.ts](packages/server/src/auth/mailer.ts))로 보냅니다. 지금은 **콘솔 출력**(`ConsoleMailer`)이 기본입니다.

> **Rate limit 의 IP** — 기본값(`TRUST_PROXY_HOPS=0`)에서는 소켓 주소만 쓰고 `X-Forwarded-For` 는 무시합니다.
> Caddy/nginx/cloudflared 같은 리버스 프록시 뒤에서 돌린다면 그 개수만큼 `TRUST_PROXY_HOPS` 를 설정하세요.
> 프록시가 있는데 0 이면 모든 사용자가 하나의 IP 로 보이고, 프록시가 없는데 1 이상이면 클라이언트가 IP 를 위조할 수 있습니다.

## 접근 제어 — 정책 (Phase 3)

Supabase 의 Row Level Security 를 JSON 정책으로 대체합니다. **정책이 없는 테이블은 anon·로그인 사용자 모두 403 (deny by default)** 이고,
`service_role` 키만 정책을 우회합니다.

### 정책 관리 (관리자 API)

| 메서드 | 경로 | 설명 |
|---|---|---|
| `PUT` | `/admin/projects/:id/policies/:table` | 정책 등록/교체. 실제 테이블 컬럼과 대조해 검증하며, 틀리면 `400 invalid_policy` + 오류 위치(path) |
| `GET` | `/admin/projects/:id/policies` · `/:table` | 목록 / 단건 |
| `DELETE` | `/admin/projects/:id/policies/:table` | 삭제 (다시 전부 거부) |

정책은 **다음 요청부터 즉시** 적용됩니다.

### 정책 형식

```json
{
  "select": { "roles": ["anon", "authenticated"], "where": { "or": [{ "shared": true }, { "owner": "$uid" }] } },
  "insert": { "roles": ["authenticated"], "set": { "owner": "$uid" }, "check": { "column": "level", "op": "lte", "value": 5 } },
  "update": { "roles": ["authenticated"], "where": { "owner": "$uid" } },
  "delete": { "roles": ["authenticated"], "where": { "owner": "$uid" } }
}
```

| 동작 | 키 | 의미 |
|---|---|---|
| 공통 | `roles` | `anon` / `authenticated` 중 허용할 역할 (필수). 목록에 없으면 403 |
| `select` `delete` | `where` | 대상이 될 수 있는 행. 사용자 필터에 **AND** 로 자동 추가됨 |
| `update` | `where` | 수정할 수 있는 기존 행 |
| | `check` | 수정 **후** 행이 만족해야 하는 조건 (생략하면 `where` 와 동일 → 소유자 변경 불가) |
| `insert` | `set` | 서버가 강제로 채우는 컬럼 (`{"owner":"$uid"}`). 클라이언트가 보낸 값을 덮어씀 |
| | `check` | 저장된 행(기본값 포함)이 만족해야 하는 조건 |

**조건 문법** — `true`(전체) · 단축형 `{"owner":"$uid","archived":false}`(모두 일치) ·
`{"column":"level","op":"gte","value":3}` (`eq neq gt gte lt lte in is`, `is` 는 `null` 만) · `{"and":[...]}` `{"or":[...]}` `{"not":{...}}`.
변수는 `"$uid"`(로그인한 사용자 id, anon 이면 NULL) 하나뿐이며, NULL 은 어떤 값과도 같지 않습니다 (SQL 과 동일: `owner = NULL` 은 거짓).

**동작 방식**

- 조회/수정/삭제의 `where` 는 **SQL 에 주입**되어 DB 가 필터링합니다 (`Content-Range` 의 count 도 보이는 행만 셉니다).
- `check` 는 쓰기 직후 DB 가 돌려준 **실제 저장 행**에 대해 검사하고, 위반하면 **트랜잭션 전체를 롤백**하며 `403 policy_violation` 을 돌려줍니다 (일괄 INSERT 도 전부 취소).
- 다른 사람의 행을 `PATCH`/`DELETE` 하면 에러가 아니라 "일치하는 행 없음"으로 처리됩니다 (Postgres RLS 와 동일).
- `Prefer: return=representation` 은 **select 규칙도 필요**하며 돌려주는 행은 select 규칙으로 걸러집니다. 쓰기를 통해 읽을 수 없는 행을 엿볼 수 없습니다.
- upsert(`resolution=merge-duplicates`)는 insert **와** update 규칙이 모두 있어야 하고, 결과 행이 두 `check` 를 모두 만족해야 합니다. 남의 행과 키가 충돌하면 403.
- 정책이 참조하는 컬럼을 삭제하거나 이름을 바꾸는 변경은 `422 column_in_use_by_policy` 로 거부됩니다. 테이블 이름을 바꾸면 정책이 따라가고, 테이블을 삭제하면 정책도 삭제됩니다 (같은 이름으로 다시 만든 테이블이 옛 정책을 물려받지 않도록).

예: 리더보드 (누구나 읽기, 로그인한 사용자만 기록, 본인 기록만 삭제, 수정 불가)

```json
{
  "select": { "roles": ["anon", "authenticated"], "where": true },
  "insert": { "roles": ["authenticated"], "set": { "user_id": "$uid" }, "check": { "column": "time_ms", "op": "gte", "value": 1000 } },
  "delete": { "roles": ["authenticated"], "where": { "user_id": "$uid" } }
}
```

## 파일 스토리지 (Phase 4)

버킷 + 파일. 바이트는 `data/projects/<id>/storage/<랜덤 uuid>` 에 저장되고 **사용자가 정한 경로는 DB 의 이름표**일 뿐이라
경로를 이용한 파일시스템 접근이 불가능합니다. 저장소는 `StorageBackend` 인터페이스([backend.ts](packages/server/src/storage/backend.ts))
뒤에 있어 S3 호환 구현으로 교체할 수 있습니다 (구현할 메서드는 `put` `read` `remove` 세 개).

### 접근 규칙 (고정, 파일별 정책 없음)

| 동작 | 누가 |
|---|---|
| 버킷 생성·수정·삭제·목록 | `service_role` (또는 관리자 API) 만 |
| 업로드 | 로그인한 사용자(→ 업로더가 **소유자**), `service_role`. anon 은 403 |
| 다운로드 | **public 버킷**: 누구나 / **private 버킷**: 소유자와 `service_role` 만 |
| 덮어쓰기·삭제 | 소유자, `service_role` |
| 목록 | 로그인한 사용자는 **자기 파일만**, `service_role` 은 전부. anon 은 403 |

권한이 없는 파일은 403 이 아니라 **404** 입니다 (존재 여부를 알려주지 않기 위해).

### API

| 메서드 | 경로 | 설명 |
|---|---|---|
| `POST` `GET` | `/storage/buckets` | 생성 `{name, public?, file_size_limit?, allowed_mime_types?}` / 목록 |
| `GET` `PATCH` `DELETE` | `/storage/buckets/:name` | 파일이 있는 버킷은 `?force=true` 여야 삭제 (파일 바이트도 함께 삭제) |
| `POST` | `/storage/object/:bucket/<경로>` | 업로드. **본문 = 파일 원본 바이트**, `Content-Type` = 파일 타입. 이미 있으면 409, `x-upsert: true` 면 소유자가 교체 |
| `GET` | `/storage/object/:bucket/<경로>` | 다운로드 (`apikey` 필요, 로그인 사용자는 `Authorization` 도). `?download` 면 강제 다운로드 |
| `DELETE` | `/storage/object/:bucket/<경로>` | 삭제 |
| `POST` | `/storage/list/:bucket` | `{prefix?, search?, limit?, offset?, sort_by?: path\|created_at\|size, descending?}` |
| `GET` | `/storage/public/<프로젝트id>/<버킷>/<경로>` | **apikey 없이** public 버킷 파일 다운로드 (`<img src>` 용). 프로젝트 id 는 URL 에 포함 |

```bash
curl -X POST "$B/storage/buckets" -H "apikey: $SERVICE" -H "Content-Type: application/json" -d '{"name":"avatars","public":true,"allowed_mime_types":["image/*"],"file_size_limit":2097152}'
curl -X POST "$B/storage/object/avatars/me/photo.png" -H "apikey: $ANON" -H "Authorization: Bearer $ACCESS" -H "Content-Type: image/png" --data-binary @photo.png
# 브라우저에서: <img src="http://localhost:8787/storage/public/<프로젝트id>/avatars/me/photo.png">
```

### 제한과 방어

- **크기**: 버킷의 `file_size_limit` 과 서버의 `MAX_UPLOAD_BYTES`(기본 50 MiB) 중 작은 값. `Content-Length` 가 있으면 본문을 읽기 전에 413,
  없으면(청크 전송) **스트리밍 중에** 초과 시 중단하고 임시 파일을 지웁니다.
- **쿼터**: 로그인 사용자 1명당 `STORAGE_USER_QUOTA_BYTES`(100 MiB), 프로젝트 전체 `STORAGE_PROJECT_QUOTA_BYTES`(2 GiB). 쿼터가 없으면 가입만 하면 누구나 디스크를 채울 수 있습니다. `service_role` 은 면제. 업로드는 사용자당 10분에 60회로 제한.
- **타입**: 버킷의 `allowed_mime_types`(`image/*` 와일드카드 가능)와 대조(415). PNG/JPEG/GIF/WebP/PDF 는 **파일 시그니처도 확인**해서 HTML 을 `image/png` 로 올리는 것을 막습니다. 그 외 타입은 클라이언트가 선언한 값을 신뢰합니다.
- **XSS 방어**: 모든 응답에 `X-Content-Type-Options: nosniff` + `Content-Security-Policy: default-src 'none'; sandbox`. 브라우저가 안전하게 그릴 수 있는 타입(래스터 이미지, 오디오/비디오, PDF, text/plain)만 `inline` 이고, HTML·SVG·XML 등은 **항상 다운로드**로 내려갑니다.
- 업로드 본문은 JSON 용 1 MiB 제한(`MAX_JSON_BYTES`)을 받지 않습니다. 스트리밍 + 위 파일 크기 제한이 적용됩니다.
- 다운로드는 `ETag`(교체하면 바뀜)·`If-None-Match`(304)·`Range`(206, 오디오/비디오 탐색용)를 지원합니다. public 은 `Cache-Control: public, max-age=60`, private 은 `no-store`.
- 공개 URL 에서만 `Cross-Origin-Resource-Policy: cross-origin` (다른 사이트의 `<img>` 허용). 다른 응답은 `same-origin`.

**알려진 한계**: 서명된 임시 URL(private 파일을 `<img>` 로 쓰려면 아직 `fetch` + blob 필요), 폴더 개념/이동/복사, 이미지 리사이즈, 업로드 재개(resumable)는 없습니다.
`x-upsert` 로 덮어쓸 때 새 파일을 먼저 완전히 저장한 뒤 교체하므로 중간에 실패해도 기존 파일이 유지됩니다.

## 실시간 (Phase 5)

WebSocket 으로 테이블의 INSERT / UPDATE / DELETE 를 구독합니다. 엔드포인트: `ws://<host>/realtime`

```js
const ws = new WebSocket('ws://localhost:8787/realtime');
ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', apikey: ANON_KEY, access_token: SESSION_ACCESS_TOKEN /* 선택 */ }));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === 'auth_ok') ws.send(JSON.stringify({ type: 'subscribe', id: 'lb', table: 'scores', events: ['INSERT'], filter: 'mode=eq.rush' }));
  if (m.type === 'event') console.log(m.event, m.new, m.old);
};
```

| 방향 | 메시지 |
|---|---|
| 클라이언트 → 서버 | `{type:"auth", apikey, access_token?}` — **반드시 첫 메시지** (5초 안에). 토큰 갱신 시 다시 보내면 구독은 유지됨 |
| | `{type:"subscribe", id, table, events?, filter?}` — `events`: `INSERT` `UPDATE` `DELETE` `*`(기본), `filter`: REST 필터 문법 `col=eq.v&col2=gt.3` (최대 5개, AND) |
| | `{type:"unsubscribe", id}` · `{type:"ping"}` |
| 서버 → 클라이언트 | `{type:"auth_ok", role, user_id, expires_at}` · `{type:"subscribed"\|"unsubscribed", id}` · `{type:"pong"}` |
| | `{type:"event", subscription, event, table, new?, old?, commit_timestamp}` — 행은 REST 와 같은 형태(boolean·JSON 복원) |
| | `{type:"error", id?, code, message}` — 구독 하나가 거부돼도 연결은 유지됨 |

종료 코드: `4400` 잘못된 메시지 · `4401` 인증 실패/만료/세션 종료 · `1008` 메시지 과다 · `1009` 메시지 너무 큼 · `1013` 수신이 느림 · `1001` 서버 종료.

**보안 모델**

- apikey·토큰은 URL 이 아니라 **첫 메시지**로 보냅니다 (URL 은 로그에 남습니다). 쿠키는 쓰지 않으므로 다른 사이트가 연결해도 인증 정보를 가져갈 수 없습니다.
- 구독하려면 REST 의 SELECT 와 같은 규칙이 필요합니다: `service_role` 이거나 테이블 정책에 내 역할이 들어간 `select` 규칙이 있어야 합니다. 없으면 `forbidden` (존재하지 않는 테이블도 같은 응답).
- **이벤트마다** 구독자의 select 정책을 다시 평가합니다. 정책을 바꾸면 이미 열린 구독에도 바로 적용됩니다. `UPDATE` 의 `old` 는 이전 행도 볼 수 있는 구독자에게만 포함됩니다.
- 이벤트는 **트랜잭션이 커밋된 뒤에만** 발행됩니다. 롤백된 쓰기(정책 위반, UNIQUE 위반, 일괄 INSERT 실패)는 아무에게도 전달되지 않습니다.
- 로그인한 연결은 access token 이 만료되면 닫힙니다 (`4401 token_expired`). 만료 전에 새 토큰으로 `auth` 를 다시 보내면 유지됩니다. 약 1분마다 세션이 폐기됐는지도 확인합니다 (로그아웃 → `4401 session_revoked`).
- 제한: 서버 전체 연결 수(`REALTIME_MAX_CONNECTIONS`, 기본 500), IP 당 20개, 연결당 구독 20개, 메시지 16 KiB, 10초에 100개 메시지. 못 받아가는 느린 클라이언트는 메모리를 키우지 않고 끊습니다. 압축은 끕니다.
- `CORS_ORIGINS` 에 특정 origin 을 지정했다면 그 외 브라우저 origin 의 연결은 403 입니다 (Origin 헤더가 없는 서버 클라이언트는 허용).
- 리버스 프록시(Caddy/nginx/cloudflared)는 WebSocket 업그레이드를 통과시켜야 하고, 유휴 연결을 너무 일찍 끊지 않도록 타임아웃을 넉넉히 설정하세요. 서버는 15초마다 ping 을 보냅니다.

**알려진 한계**

- **이 서버를 거친 쓰기만** 이벤트가 됩니다 (REST). SQLite 에는 LISTEN/NOTIFY 가 없어서 DB 파일을 직접 수정하거나 다른 프로세스가 쓴 변경은 감지하지 못합니다.
- 행이 구독자에게 **보이지 않게 바뀐 경우**(예: `shared` 를 true → false)에는 이벤트가 가지 않습니다. 구독자는 그 행이 사라졌다는 것을 알 수 없습니다. 필요하면 "비공개로 바꾸기" 대신 DELETE 후 재생성하거나, 별도 플래그 컬럼을 두세요.
- 메시지 전달은 **최대 한 번**입니다. 연결이 끊긴 동안의 이벤트는 재전송되지 않으므로, 재연결하면 REST 로 현재 상태를 다시 읽으세요.
- 단일 프로세스 전용입니다 (이벤트 버스가 메모리). 서버를 여러 대로 늘리면 다른 인스턴스의 변경을 받지 못합니다.
- 구독자가 있는 테이블에 쓸 때만 변경 전 행 조회 같은 추가 작업이 생깁니다. 구독자가 없으면 쓰기 성능은 그대로입니다.

## 클라이언트 SDK (Phase 6)

`packages/client` — supabase-js 와 비슷하게 쓰는 JS/TS SDK. **의존성 0**, 브라우저 · Node 22+ · 브라우저 확장 프로그램에서 동작합니다.

| 쓰는 곳 | 방법 |
|---|---|
| 일반 웹페이지 (`<script>` 한 줄, ES 모듈 없는 게임 포함) | `packages/client/dist/index.global.min.js` (23 KB) 를 복사해 `<script src>` → 전역 `supabasebutno` |
| 번들러 · Node (ESM / CJS) | `import { createClient } from '@supabasebutno/client'` (워크스페이스) 또는 `dist/index.js` / `dist/index.cjs` |
| 브라우저 확장 (MV2/MV3) | `createChromeStorage()` 로 세션을 `chrome.storage` 에 저장 (아래) |

빌드: `npm run build -w @supabasebutno/client` → `dist/` (`index.js` `index.cjs` `index.global.js` `index.global.min.js` `types/`)

```html
<script src="supabasebutno.min.js"></script>
<script>
  const client = supabasebutno.createClient('https://api.example.com', 'ANON_KEY');
  client.from('scores').select('player,time_ms').order('time_ms').limit(10).then(({ data, error }) => { /* ... */ });
</script>
```

```ts
import { createClient } from '@supabasebutno/client';
const client = createClient(url, anonKey);

// 데이터 — 서버가 던지지 않고 항상 { data, error } 를 돌려줍니다
await client.from('todos').select('id,title').eq('done', false).order('id', { ascending: false }).range(0, 9);
await client.from('todos').insert({ title: 'milk' }).select();          // .select() 를 붙여야 저장된 행이 돌아옴
await client.from('todos').update({ done: true }).eq('id', 1);
await client.from('todos').upsert({ id: 1, title: 'x' });               // { onConflict: 'email' } 도 가능
await client.from('todos').delete().in('id', [1, 2]);
await client.from('todos').select().eq('id', 1).single();                // 정확히 한 행이 아니면 error.code === 'not_single'

// 인증 — 세션은 자동 저장·갱신됩니다
await client.auth.signUp({ email, password, data: { name: 'Ada' } });
await client.auth.signInWithPassword({ email, password });
const { data: { session } } = await client.auth.getSession();
client.auth.onAuthStateChange((event, session) => { /* INITIAL_SESSION | SIGNED_IN | SIGNED_OUT | TOKEN_REFRESHED | USER_UPDATED */ });
await client.auth.signOut();                                              // { scope: 'global' } 면 모든 기기

// 스토리지
await client.storage.from('avatars').upload('me/photo.png', fileOrBlob, { upsert: true });
const { data: { publicUrl } } = client.storage.from('avatars').getPublicUrl('me/photo.png');  // <img src> 용
const { data: blob } = await client.storage.from('avatars').download('me/photo.png');

// 실시간
const channel = client.channel('board')
  .on('postgres_changes', { event: 'INSERT', table: 'scores', filter: 'mode=eq.rush' }, (p) => console.log(p.new))
  .subscribe((status) => { if (status === 'SUBSCRIBED') reloadScores(); });
await channel.unsubscribe();
client.dispose();   // 타이머와 연결 정리
```

**에러**: 모든 호출은 `{ data, error }` 를 돌려주고 예상 가능한 실패로는 던지지 않습니다. `error` 는 `SbbError` 이고 `code`(`forbidden` `unique_violation` `invalid_credentials` …, 서버와 같은 코드), `status`(HTTP, 네트워크 실패는 `0` + `network_error`), `requestId` 를 가집니다.
쿼리 빌더는 잘못된 인자(`.eq('a', null)` 등)도 호출 시점이 아니라 `await` 결과의 `error` 로 알려줍니다.

**옵션** (`createClient(url, key, options)`)

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `auth.storage` | `localStorage`, 없으면 메모리 | 세션 저장소 `{getItem,setItem,removeItem}` (동기·비동기 모두 가능) |
| `auth.storageKey` | `sbb.auth.<프로젝트id>` | |
| `auth.persistSession` | `true` | `false` 면 페이지를 닫으면 로그아웃 |
| `auth.autoRefreshToken` | `true` | 만료 직전에 백그라운드로 갱신 (실시간처럼 요청이 없는 경우에 필요) |
| `auth.refreshMarginSeconds` | `60` | 만료 몇 초 전에 갱신할지 |
| `realtime.WebSocket` | 전역 `WebSocket` | 전역이 없는 환경(Node 22 미만)에서는 `ws` 패키지를 넘기세요 |
| `realtime.reconnectDelayMs` / `maxReconnectDelayMs` / `heartbeatMs` | `1000` / `30000` / `25000` | |
| `fetch` | 전역 `fetch` | |

**브라우저 확장 프로그램**

```js
import { createClient, createChromeStorage } from '@supabasebutno/client';
const client = createClient(URL, ANON_KEY, { auth: { storage: createChromeStorage() } });   // manifest 에 "storage" 권한 필요
```
`chrome.storage.local`(Firefox 는 `browser.storage.local`)에 저장하며 콜백/프로미스 방식 모두 지원합니다. 브라우저를 닫으면 지우려면 `createChromeStorage(chrome.storage.session)`.
서비스 워커(MV3)는 수시로 종료되므로 세션이 저장소에서 복원됩니다 — 새로 만든 클라이언트가 같은 저장소를 쓰면 로그인 상태가 이어집니다.

**세션 관리가 하는 일**

- 요청 직전에 만료가 임박했으면 갱신하고, 동시에 여러 요청이 와도 **갱신은 한 번만** 합니다.
- 서버가 `token_expired` 라고 하면(기기 시계가 틀린 경우 등) 갱신 후 **한 번 재시도**합니다. 스트림 본문은 재전송할 수 없으므로 세션만 갱신하고 에러를 돌려줍니다.
- 네트워크가 끊겨서 갱신에 실패하면 세션은 **유지**하고 나중에 다시 시도합니다. 서버가 refresh token 을 거부하면(다른 기기에서 로그아웃 등) 로컬 세션을 지우고 `SIGNED_OUT` 을 알립니다.
- 같은 브라우저의 다른 탭에서 로그인/로그아웃/갱신하면 `storage` 이벤트로 따라갑니다.
- 실시간 연결은 로그인·로그아웃·토큰 갱신 때 새 자격 증명을 서버에 다시 보내고, 끊기면 지수 백오프로 재연결해 구독을 복원합니다 (`SUBSCRIBED` 가 다시 옵니다 — 끊긴 동안의 이벤트는 오지 않으니 그때 현재 상태를 다시 읽으세요).

**supabase-js 와 다른 점**

- `like`/`ilike` 의 `_` 는 **문자 그대로** 입니다 (Postgres 처럼 한 글자 와일드카드가 아님). `%` 와 `*` 가 와일드카드입니다. SQLite 이므로 `like` 는 ASCII 만 대소문자를 구분하지 않습니다.
- `or()`, 조인(`select('*, other(*)')`), `rpc()`, presence/broadcast 는 없습니다.
- `update()`/`delete()` 는 필터가 필수이고, **`limit()`/`range()`/`order()` 를 붙이면 요청을 보내지 않고 에러**(`unsupported_modifier`)를 돌려줍니다 — 조용히 무시하면 "한 행 수정"이 "일치하는 전부 수정"으로 바뀌기 때문입니다.
- `insert`/`update`/`delete` 는 기본적으로 행을 돌려주지 않습니다 (`.select()` 를 붙이면 돌려줌). supabase-js 와 같습니다.
- 채널은 `postgres_changes` 만 지원합니다. 페이로드는 supabase-js 와 같은 모양(`eventType`, `new`, `old`)입니다.

**보안 주의**

- **`service_role` 키는 브라우저/확장 프로그램/게임 클라이언트에 넣지 마세요.** 모든 정책을 우회합니다. 클라이언트에는 `anon` 키만 쓰고, 접근 제어는 [정책](#접근-제어--정책-phase-3)으로 하세요.
- 세션(토큰)을 `localStorage` 에 저장하므로 사이트에 XSS 가 있으면 토큰이 유출될 수 있습니다. 사용자 입력은 항상 이스케이프하고, 민감한 앱은 `persistSession: false` 를 고려하세요.
- 클라이언트가 보낸 값(리더보드 점수 등)은 위조할 수 있습니다. 정책의 `check` 로 터무니없는 값만 걸러낼 수 있습니다.

### 오류 형식

```json
{ "error": { "code": "validation_error", "message": "Invalid request", "details": [...], "request_id": "..." } }
```

내부 오류는 항상 일반적인 `500 internal_error` 로만 응답하며, 상세 내용은 서버 로그에서 `request_id` 로 찾습니다.

## 알려진 제한 (Phase 1a)

- 테이블은 **정확히 1개의 단일 컬럼 primary key** 가 필요합니다 (복합 PK 불가). integer PK 는 `AUTOINCREMENT` 입니다.
- `UNIQUE` 는 테이블 **생성 시에만** 지정할 수 있습니다. 기존 테이블에 UNIQUE/PK 컬럼을 추가하거나 UNIQUE 컬럼을 삭제할 수 없습니다 (SQLite 제약).
- 기존 테이블에 컬럼을 추가할 때는 `now`/`uuid` 기본값을 쓸 수 없고, `not_null` 이면 null 이 아닌 기본값이 필요합니다 (SQLite 제약).
- 컬럼 **타입 변경**, 외래 키, 인덱스 관리 API 는 없습니다.
- 프로젝트 DB 핸들은 처음 쓸 때 열리고 계속 열려 있습니다 (수십 개 수준의 프로젝트 가정).
- 임의 SQL 실행 엔드포인트는 **의도적으로** 없습니다.
- `/admin` 은 실패한 토큰 시도가 IP 당 10회/15분을 넘으면 429 를 돌려주지만, 그래도 `ADMIN_TOKEN` 은 길고 무작위여야 합니다 (32자↑ 강제).

## 알려진 제한 (Phase 2)

- **이메일 인증이 없습니다.** 가입 즉시 로그인되고, 이메일 소유 확인을 하지 않습니다. 가입 시 이메일 존재 여부가 409 로 드러납니다 (확인 메일 없이는 숨길 방법이 없음).
- 이메일 주소 변경, 계정 자기 삭제 API 는 없습니다 (대시보드의 사용자 탭 / 관리자 API 로 삭제).
- Rate limit 은 메모리 기반이라 **서버 재시작 시 초기화**되고 여러 인스턴스 간에 공유되지 않습니다.
- Access token 은 서명·만료를 검증한 뒤 세션 폐기 여부를 DB 에서 한 번 더 확인합니다 (요청당 조회 1회). 완전한 무상태 JWT 는 아닙니다.
- `user_metadata` 는 사용자가 직접 수정할 수 있으므로 **권한 판단에 쓰면 안 됩니다** (4KB 제한).
- 재설정 메일이 콘솔에 찍히므로 로그를 볼 수 있는 사람은 복구 중인 계정을 탈취할 수 있습니다. 운영에서는 `Mailer` 를 교체하세요.

## 백업과 복원

```bash
npm run build
npm run backup -- ./backups                         # ./backups/backup-<UTC 시각>/ 생성 (서버가 켜져 있어도 됨)
npm run restore -- ./backups/backup-20261011-131153 --verify   # 검사만: 체크섬 + SQLite 무결성
# 복원 (서버를 먼저 끄세요)
npm run restore -- ./backups/backup-20261011-131153 --force    # --force: 기존 데이터는 지우지 않고 옆으로 옮김
```

- SQLite **온라인 백업 API** 로 DB 를 복사하므로 서버가 쓰는 도중에도 일관된 스냅샷이 만들어집니다. 업로드 파일은 복사하되 업로드 중인 임시 파일은 건너뜁니다.
- 백업 폴더: `admin.sqlite`, `projects/<id>/db.sqlite`, `projects/<id>/storage/*`, `manifest.json`(프로젝트 목록 + **DB 파일의 SHA-256**).
- 복원은 먼저 **모든 DB 를 체크섬과 `PRAGMA integrity_check` 로 검증**하고, 새 데이터를 `<DATA_DIR>.restoring` 에 완성한 뒤 `rename` 으로 교체합니다. 중간에 실패해도 기존 데이터는 그대로입니다. 데이터가 이미 있으면 `--force` 가 필요하고, 그때도 **삭제하지 않고** `<DATA_DIR>.before-restore-<시각>` 으로 옮겨 둡니다. 위조된 manifest(경로 이탈 이름)는 거부합니다.
- **백업에 들어 있지 않은 것: `JWT_MASTER_SECRET`, `ADMIN_TOKEN`.** 마스터 시크릿을 잃으면 복원해도 발급했던 API 키가 전부 달라집니다 (키는 마스터 시크릿에서 파생됨). `.env` 를 비밀번호 관리자 등에 따로 보관하세요.
- 백업에는 **비밀번호 해시와 사용자 데이터**가 들어 있습니다. 민감한 파일로 취급하고 (암호화된 위치에 보관) 저장소에 올리지 마세요.
- 정기 백업은 아래 [정기 백업](#정기-백업-날짜별-압축--최근-7개)을 쓰세요. **복원 연습을 한 번은 해 보세요.**

### 정기 백업 (날짜별 압축 + 최근 7개)

```bash
npm run build
npm run backup:rotate                 # ./backups/backup-<날짜-시각>.tar.gz 를 만들고 최근 7개만 남김
npm run backup:rotate -- --keep 14    # 14개 보관 (또는 .env 에 BACKUP_KEEP=14)
npm run backup:rotate -- --dir D:\backups     # 다른 폴더에 저장
npm run backup:rotate -- --docker     # Docker Compose 로 실행 중인 서버 (docker compose --profile tools run --rm backup 사용)
```

- 압축은 시스템의 `tar` 를 씁니다 (Windows 10+, macOS, Linux 기본 제공). 압축 파일이 만들어진 것을 확인한 **뒤에만** 원본 폴더를 지우고, 오래된 `.tar.gz` 부터 삭제합니다. `backups/` 는 `.gitignore` 에 들어 있습니다 (비밀번호 해시가 들어 있으므로 절대 커밋하지 마세요).
- **압축 파일에서 복원**: 풀고 → 검사 → 복원 (서버를 먼저 끄세요).

```bash
tar -xzf backups/backup-20261015-143034.tar.gz -C backups
npm run restore -- backups/backup-20261015-143034 --verify
npm run restore -- backups/backup-20261015-143034 --force
```

**Linux / macOS / VM — cron 등록** (`crontab -e`, 매일 새벽 3시):

```cron
0 3 * * * cd /home/ubuntu/supabasebutno && /usr/bin/npm run backup:rotate >> backups/cron.log 2>&1
# Docker Compose 로 실행 중이면:
# 0 3 * * * cd /home/ubuntu/supabasebutno && /usr/bin/npm run backup:rotate -- --docker >> backups/cron.log 2>&1
```

호스트에 Node 가 없는 서버라면 같은 일을 셸로 할 수 있습니다 (`./backups` 는 uid 1000 이 쓸 수 있어야 함: `mkdir -p backups && sudo chown 1000:1000 backups`):

```bash
cd ~/supabasebutno && docker compose --profile tools run --rm backup \
  && cd backups && for d in backup-*/; do tar -czf "${d%/}.tar.gz" "${d%/}" && rm -rf "$d"; done \
  && ls -1 backup-*.tar.gz | sort | head -n -7 | xargs -r rm --
```

**Windows — 작업 스케줄러** (PowerShell, 매일 새벽 3시):

```powershell
$a = New-ScheduledTaskAction -Execute "npm.cmd" -Argument "run backup:rotate" -WorkingDirectory "C:\Users\<사용자>\Desktop\VScode\supabasebutno"
$t = New-ScheduledTaskTrigger -Daily -At 3am
Register-ScheduledTask -TaskName "supabasebutno-backup" -Action $a -Trigger $t
```

- 같은 PC 의 디스크에만 두면 디스크가 고장 날 때 같이 사라집니다. 최근 백업 하나는 **다른 곳**(외장 디스크, 클라우드 드라이브 등)에도 복사해 두세요.

## 배포 (Docker)

```bash
cp .env.example .env            # ADMIN_TOKEN, JWT_MASTER_SECRET 채우기. CORS_ORIGINS 는 호출할 사이트만
docker compose up -d --build    # 127.0.0.1:8787 에서만 열림
docker compose logs -f
docker compose --profile tools run --rm backup        # ./backups 에 백업 (이 폴더는 uid 1000 이 쓸 수 있어야 함)
docker compose stop sbb && docker compose --profile tools run --rm restore /backups/backup-<시각> --force && docker compose start sbb
```

- 이미지: `node:22-bookworm-slim` 기반 멀티 스테이지. 런타임에는 **운영 의존성만** 설치하고(컴파일러 없음), 비루트 `node` 사용자로 실행합니다. 데이터는 `/data` 볼륨입니다. 컨테이너는 읽기 전용 파일시스템 + `cap_drop: ALL` + `no-new-privileges` 로 돌립니다.
- Alpine 이 아니라 Debian 인 이유: `better-sqlite3`, `argon2` 가 glibc 용 미리 빌드된 바이너리(x64, arm64)를 패키지에 담아 배포하기 때문입니다. `npm ci --ignore-scripts` 로 컴파일을 시도하지 않게 했습니다.
- 재시작 정책은 `restart: always` 입니다 (프로세스가 죽거나 서버가 재부팅돼도 항상 다시 시작). 데이터는 이름 있는 볼륨 `sbb-data`(`/data`)에 있어 컨테이너를 다시 만들어도 남습니다. 볼륨을 지우는 `docker compose down -v` 는 **데이터가 사라지므로 쓰지 마세요.**
- 헬스체크는 `GET /health`. `docker stop` 의 SIGTERM 에서 연결을 닫고 DB 를 정리한 뒤 종료합니다.
- **TLS 는 직접 처리하지 않습니다.** 인터넷에 열려면 Caddy/nginx/Cloudflare Tunnel 등을 앞에 두세요. 예: [deploy/Caddyfile.example](deploy/Caddyfile.example) (자동 HTTPS, WebSocket 통과). 프록시를 두면 `.env` 에 `TRUST_PROXY_HOPS=1` 을 설정해야 rate limit 이 실제 클라이언트 IP 를 봅니다.
- 이 저장소의 Dockerfile 은 Docker 가 설치되지 않은 PC 에서 작성했습니다. 이미지를 직접 빌드해 본 것은 아니고, 같은 단계(운영 의존성만 설치 → 빌드 결과물로 서버·대시보드·백업 실행)를 임시 폴더에서 재현해 확인했습니다. 첫 빌드에서 문제가 있으면 이슈로 알려 주세요.

## 상시 운영으로 옮기기

지금은 "내 PC + ngrok" 입니다. 이 방식은 **PC 가 꺼지면 서비스도 꺼집니다.** 다음 두 가지 중 하나로 옮길 수 있고, 코드는 그대로이며 `.env` 와 터널/프록시만 바뀝니다.

| | (a) Cloudflare Tunnel | (b) Oracle/GCP 무료 VM + Caddy |
|---|---|---|
| 서버가 도는 곳 | **내 PC (또는 집 서버)** — 꺼져 있으면 서비스도 꺼짐 | 클라우드 VM — **PC 와 무관하게 24시간** |
| HTTPS | Cloudflare 가 처리 | Caddy 가 Let's Encrypt 로 자동 |
| 포트 개방 | 필요 없음 (바깥으로 나가는 연결만 사용) | 80/443 열어야 함 |
| 고정 주소 | **내 도메인 필요** (Cloudflare 에 등록) | 도메인 필요 (VM 의 고정 IP 로 연결) |
| 비용 | 도메인 값(연 1~2만 원대) | 도메인 값 + 무료 VM (결제 수단 등록 필요) |
| 난이도 | 쉬움 | 중간 |

공통 준비:

1. `.env` 에서 `CORS_ORIGINS` 를 **내 프론트엔드 주소만** 적으세요 (예: `https://jangwoo0827.github.io`). `*` 는 쓰지 마세요.
2. 프록시/터널 뒤에서는 `TRUST_PROXY_HOPS=1` (속도 제한이 실제 접속자 IP 를 보게 함).
3. `PUBLIC_URL=https://api.내도메인.com` 을 적어 두면 `start-online.cmd` 안내에 표시됩니다 (코드가 이 값에 의존하지는 않음).
4. 앱/게임의 서버 주소만 새 주소로 바꾸면 됩니다 (SDK 의 `createClient(url, anonKey)` 첫 번째 인자). **API 키는 서버의 `JWT_MASTER_SECRET` 에서 나오므로, 같은 값을 쓰면 기존 anon 키가 그대로 유효합니다.**

### (a) Cloudflare Tunnel 로 옮기기

> 아래 단계 중 **계정 만들기·도메인 등록·대시보드 조작은 직접** 하셔야 합니다 (화면 이름은 Cloudflare 가 바꿀 수 있어 약간 다를 수 있습니다).

1. Cloudflare 계정을 만들고 **도메인을 추가**합니다 (도메인 등록 업체에서 네임서버를 Cloudflare 것으로 바꿈). 도메인이 없으면 고정 주소를 쓸 수 없고, 7번의 임시 주소만 가능합니다.
2. Cloudflare **Zero Trust** 대시보드(https://one.dash.cloudflare.com) → **Networks → Tunnels → Create a tunnel** → **Cloudflared** → 이름 입력(예: `sbb`).
3. 설치 방법 화면에서 **Docker** 를 고르면 명령에 `--token eyJ...` 가 보입니다. **그 토큰만** 복사하세요 (비밀번호처럼 취급).
4. `.env` 에 추가:
   ```
   TUNNEL=cloudflared
   CLOUDFLARE_TUNNEL_TOKEN=<복사한 토큰>
   TRUST_PROXY_HOPS=1
   ```
5. 터널 화면의 **Public Hostname** 탭에서 `api.내도메인.com` 을 추가하고 서비스는 `HTTP` / 주소는 아래 중 하나로 설정:
   - Docker Compose 로 실행: `sbb:8787`
   - 호스트에서 직접 실행 (`npm run local`): `localhost:8787`
6. 실행 (둘 중 하나):
   ```bash
   # Docker Compose (서버 + 터널이 함께 항상 재시작)
   docker compose --profile cloudflare up -d --build
   # Docker 없이: Windows PowerShell 에서 cloudflared 를 서비스로 설치 (재부팅해도 자동 시작)
   winget install Cloudflare.cloudflared
   cloudflared service install <토큰>
   # Linux 는:  sudo cloudflared service install <토큰>
   ```
7. (테스트용) 도메인 없이 임시 주소만 시험: `.env` 에 `TUNNEL=cloudflared` 만 두고 `npm run tunnel` → 화면에 `https://무작위.trycloudflare.com` 이 나옵니다. 실행할 때마다 바뀝니다.
8. 확인 (다른 네트워크, 예를 들어 휴대폰 데이터에서도 해 보세요):
   ```bash
   curl https://api.내도메인.com/health          # {"status":"ok"}
   curl -i https://api.내도메인.com/dashboard/   # 404 여야 함 (아래 "관리자 접근 제한" 설정 후)
   ```
9. ngrok 정리: 실행 중인 ngrok 창을 닫고, 앱의 서버 주소를 새 주소로 교체합니다. `.env` 의 `TUNNEL` 을 `cloudflared` 로 바꿔 두면 `start-online.cmd` 도 그대로 동작합니다.

- Cloudflare 쪽에는 ngrok 의 `deploy/ngrok-policy.yml` 같은 경로 차단이 없으므로 **관리자 보호는 서버의 `ADMIN_ALLOWED_IPS`** 로 합니다 ([보안 체크리스트](#보안-체크리스트-상시-운영)). 더 강하게 하려면 Cloudflare **Access** 로 `api.내도메인.com/admin*`, `/dashboard*` 에 로그인(이메일 인증)을 걸 수 있습니다.
- 이 방식도 **서버가 도는 PC 가 켜져 있어야** 합니다. PC 와 무관하게 24시간 돌리려면 (b) 입니다.

### (b) Oracle/GCP 무료 VM + Caddy 로 옮기기

> **계정 생성·결제 수단 등록·VM 만들기·DNS 설정은 직접** 하셔야 합니다. 무료 한도와 조건은 바뀔 수 있으니 가입 화면의 안내를 확인하세요.

1. **VM 만들기**: Oracle Cloud *Always Free* (Ampere A1 또는 AMD Micro) 또는 GCP *e2-micro* (무료 리전)에서 **Ubuntu 22.04 이상** VM 을 만들고 SSH 키를 등록합니다. **고정(예약) 공인 IP** 를 붙이세요.
2. **방화벽**: 인바운드는 **22(SSH, 가능하면 내 IP 만) · 80 · 443 만** 엽니다. **8787 은 절대 열지 않습니다.** (Oracle 은 VCN 의 Security List/NSG 와 VM 안의 iptables 두 곳, GCP 는 VPC 방화벽 규칙)
3. **DNS**: 도메인의 `A` 레코드 `api` → VM 의 공인 IP.
4. **VM 에 접속해 Docker 설치**:
   ```bash
   ssh ubuntu@<VM 공인 IP>
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER && newgrp docker
   ```
5. **코드와 설정**:
   ```bash
   git clone https://github.com/Jangwoo0827/supabasebutno.git && cd supabasebutno
   cp .env.example .env && chmod 600 .env
   openssl rand -base64 32 | tr '+/' '-_' | tr -d '='     # 비밀값 생성 (두 번 실행해서 각각 다른 값 사용)
   nano .env     # ADMIN_TOKEN, JWT_MASTER_SECRET(두 값은 서로 달라야 함), CORS_ORIGINS, TRUST_PROXY_HOPS=1, ADMIN_ALLOWED_IPS
   ```
   기존 PC 의 데이터를 옮길 거라면 `JWT_MASTER_SECRET` 은 **PC 의 `.env` 값과 같게** 하세요 (7번).
6. **Caddy 설치와 HTTPS**:
   ```bash
   sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
   sudo apt update && sudo apt install -y caddy
   sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile
   sudo nano /etc/caddy/Caddyfile        # api.example.com → 내 도메인, 203.0.113.10 → 내 공인 IP
   sudo systemctl reload caddy
   ```
7. **서버 실행** (Compose 가 `restart: always` 라 VM 이 재부팅돼도 자동 시작) — 그리고 **기존 데이터 옮기기**:
   ```bash
   docker compose up -d --build
   # (PC 에서) npm run backup:rotate  →  backups/backup-<시각>.tar.gz 를 VM 으로 복사
   scp backups/backup-20261015-143034.tar.gz ubuntu@<VM IP>:~/supabasebutno/backups/
   # (VM 에서)
   cd ~/supabasebutno/backups && tar -xzf backup-20261015-143034.tar.gz && cd ..
   docker compose stop sbb
   docker compose --profile tools run --rm restore /backups/backup-20261015-143034 --force
   docker compose start sbb
   ```
8. **확인**: `curl https://api.내도메인.com/health` → `{"status":"ok"}`. 다른 네트워크에서 `/dashboard/` 가 404 인지도 확인.
9. **정기 백업 등록**: 위 [정기 백업](#정기-백업-날짜별-압축--최근-7개)의 cron 줄을 VM 에 등록.
10. 앱의 서버 주소를 새 주소로 바꾸고, PC 의 ngrok/로컬 서버는 끕니다.

## 보안 체크리스트 (상시 운영)

**관리자 접근 제한**
- [ ] `.env` 의 `ADMIN_ALLOWED_IPS=내공인IP` 로 `/admin`, `/dashboard` 를 내 IP 에서만 열기. 다른 IP 는 (올바른 토큰이 있어도) 평범한 404 를 받습니다. **`TRUST_PROXY_HOPS` 가 프록시 수와 맞아야** 진짜 접속자 IP 로 판단합니다 (터널/Caddy 뒤 = 1). 내 PC 에서 `127.0.0.1` 로 직접 열 때도 쓰려면 `127.0.0.1` 도 같이 적으세요. 집 인터넷은 공인 IP 가 바뀔 수 있으니, 접속이 막히면 서버에 SSH/직접 접속해서 값을 고치세요.
- [ ] 프록시에서도 한 번 더 막기: Caddy 는 `deploy/Caddyfile.example`, ngrok 은 `deploy/ngrok-policy.yml`, Cloudflare 는 Access.
- [ ] `ADMIN_CORS_ORIGINS` 는 비워 두기 (GitHub Pages 대시보드를 쓸 때만 그 주소 하나).
- [ ] `ADMIN_TOKEN` 은 32바이트↑ 무작위 값. 유출됐다면 `.env` 를 바꾸고 서버를 다시 시작하세요.

**CORS**
- [ ] `CORS_ORIGINS` 에 **내 프론트엔드 주소만** (예: `https://jangwoo0827.github.io`). `*` 금지. 포트나 `http://` 가 다르면 다른 출처이므로, 로컬 테스트 주소(`http://127.0.0.1:8765`)는 **테스트할 때만** 추가하고 끝나면 빼세요.

**포트와 네트워크**
- [ ] 서버 포트(8787)는 인터넷에 직접 열지 않습니다. Compose 는 `127.0.0.1:8787` 으로만 게시합니다 (**`ports: "8787:8787"` 로 바꾸지 마세요** — Docker 는 ufw 를 우회해 포트를 엽니다).
- [ ] VM 방화벽은 22(내 IP) · 80 · 443 만. 터널을 쓰면 80/443 도 필요 없습니다.
- [ ] `HOST` 는 호스트에서 직접 실행할 때 `127.0.0.1` (Docker 안에서만 `0.0.0.0`).

**가입과 계정**
- [ ] 공개 가입이 필요 없는 앱이면 `SIGNUP_ENABLED=false` (기존 사용자는 로그인 가능). 가입에는 IP 당 시간당 10회 제한이 있지만 완벽한 스팸 방지는 아닙니다.
- [ ] 비밀번호 재설정 메일: 기본 `ConsoleMailer` 는 토큰을 로그에 찍습니다. 메일을 쓰려면 `Mailer` 구현을 교체하세요 (지금은 재설정 기능을 쓰지 않는 것을 권장).

**비밀값과 백업**
- [ ] `.env`, `backups/`, 서버 로그를 저장소에 올리지 않기 (`.gitignore` 에 들어 있음). `chmod 600 .env`.
- [ ] 정기 백업이 돌고, 복원을 한 번 연습했고, 최근 백업 하나는 다른 장소에도 있다.
- [ ] `JWT_MASTER_SECRET` 은 백업에 없으므로 비밀번호 관리자 등에 따로 보관 (잃으면 모든 API 키가 바뀜).

## 프로덕션 체크리스트

1. `ADMIN_TOKEN` 과 `JWT_MASTER_SECRET` 은 각각 따로 만든 무작위 값(32바이트↑)이고 서로 다릅니다. `.env` 는 저장소에 올리지 않았고, 따로 백업했습니다.
2. 앞단에 **HTTPS** 리버스 프록시가 있고 `TRUST_PROXY_HOPS` 가 프록시 수와 같습니다. 서버 포트(8787)는 인터넷에 직접 열려 있지 않습니다.
3. `CORS_ORIGINS` 는 `*` 가 아니라 실제로 호출하는 사이트 목록입니다.
4. 모든 테이블에 **접근 정책**을 의도대로 설정했습니다. 정책이 없으면 `anon`/로그인 사용자는 거부되고 `service_role` 만 접근합니다. 공개 읽기(`where: true`)는 정말 공개해도 되는 테이블에만 쓰세요.
5. 브라우저·앱·게임·확장 프로그램에는 **anon 키만** 넣었습니다. `service_role` 키는 서버에서만 쓰고 어디에도 커밋하지 않았습니다. 키가 유출되면 대시보드에서 "키 다시 발급".
6. 비밀번호 재설정 메일을 보내려면 `Mailer` 를 실제 구현으로 교체했습니다 (기본 `ConsoleMailer` 는 토큰을 로그에 찍습니다).
7. `/admin`, `/dashboard` 는 프록시에서 내 IP 로 제한했습니다 (가능하다면).
8. 정기 백업이 돌고, **복원을 한 번 연습했습니다.**
9. 디스크 여유와 업로드 한도(`MAX_UPLOAD_BYTES`, 쿼터)를 확인했습니다. SQLite 는 한 서버에서만 쓰세요 (여러 인스턴스 금지).
10. 서버 로그에서 `unhandled error` 를 가끔 확인합니다 (`request_id` 로 클라이언트 오류와 연결).

## 라이선스

TBD
