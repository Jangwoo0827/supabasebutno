# supabasebutno

Supabase의 핵심 기능 중 실제로 쓰는 것만 가볍게 구현한 **셀프호스팅 멀티 프로젝트 BaaS**입니다.
Node.js + TypeScript, [Hono](https://hono.dev), SQLite(better-sqlite3).

> **진행 상황** — Phase 1a 완료 (프로젝트 · API 키 · 테이블 DDL).
> 아직 없음: REST CRUD(1b), 인증(2), 접근 제어(3), 스토리지(4), 실시간(5), SDK(6), 대시보드(7).

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

`apikey` 헤더의 키로 프로젝트가 결정되므로 URL에는 프로젝트 id가 없습니다. 지금은 `service_role` 키만 허용되고,
`anon` 은 정책(Phase 3)이 생기기 전까지 **모든 테이블에서 403** 입니다.

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
- 관리자 토큰 무차별 대입 방지(rate limit)는 Phase 2 에서 추가됩니다. 그때까지는 길고 무작위인 토큰(32자↑ 강제)과 네트워크 격리에 의존합니다.

## 라이선스

TBD
