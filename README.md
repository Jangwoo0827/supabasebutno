# supabasebutno

Supabase의 핵심 기능 중 실제로 쓰는 것만 가볍게 구현한 **셀프호스팅 멀티 프로젝트 BaaS**입니다.
Node.js + TypeScript, [Hono](https://hono.dev), SQLite(better-sqlite3).

> **진행 상황** — 완료: 프로젝트 · API 키 · 테이블 DDL(1a), REST CRUD(1b), 사용자 인증(2), 접근 제어 정책(3).
> 아직 없음: 스토리지(4), 실시간(5), SDK(6), 대시보드(7).

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

서버는 기본적으로 `http://127.0.0.1:8787` 에서 뜹니다.

| 스크립트 | 설명 |
|---|---|
| `npm run dev` | tsx watch 로 개발 서버 실행 |
| `npm run build` / `npm start` | `dist/` 로 빌드 후 실행 |
| `npm test` | vitest (DB 드라이버, 스키마, 키, 관리자 API 통합 테스트) |
| `npm run typecheck` | `tsc --noEmit` |

## 환경변수

| 이름 | 기본값 | 설명 |
|---|---|---|
| `ADMIN_TOKEN` | (필수, 32자↑) | `/admin` API 의 Bearer 토큰. **모든 프로젝트에 대한 전체 권한** |
| `JWT_MASTER_SECRET` | (필수, 32자↑) | 프로젝트별 API 키 서명 시크릿의 원본. `ADMIN_TOKEN` 과 달라야 함. **바꾸면 발급된 모든 키가 무효화** |
| `PORT` | `8787` | |
| `HOST` | `127.0.0.1` | Docker 안에서는 `0.0.0.0`, 앞단에 TLS 리버스 프록시 필수 |
| `DATA_DIR` | `<repo>/data` | `admin.sqlite` 와 프로젝트별 데이터 위치 |
| `CORS_ORIGINS` | (빈 값 = CORS 꺼짐) | 데이터 API 를 호출할 수 있는 origin 목록(쉼표 구분) 또는 `*`. `/admin` 에는 적용되지 않음 |
| `MAX_JSON_BYTES` | `1048576` | JSON 요청 본문 최대 크기 |

## 구조

```
data/
├─ admin.sqlite                    # 프로젝트 목록 (control plane)
└─ projects/<id>/
   ├─ db.sqlite                    # 프로젝트 전용 DB (사용자 테이블 + 예약된 _테이블)
   └─ storage/                     # (Phase 4)
```

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
- 이메일 주소 변경, 계정 자기 삭제 API 는 없습니다 (관리자 API 로 삭제 — Phase 7).
- Rate limit 은 메모리 기반이라 **서버 재시작 시 초기화**되고 여러 인스턴스 간에 공유되지 않습니다.
- Access token 은 서명·만료를 검증한 뒤 세션 폐기 여부를 DB 에서 한 번 더 확인합니다 (요청당 조회 1회). 완전한 무상태 JWT 는 아닙니다.
- `user_metadata` 는 사용자가 직접 수정할 수 있으므로 **권한 판단에 쓰면 안 됩니다** (4KB 제한).
- 재설정 메일이 콘솔에 찍히므로 로그를 볼 수 있는 사람은 복구 중인 계정을 탈취할 수 있습니다. 운영에서는 `Mailer` 를 교체하세요.

## 라이선스

TBD
