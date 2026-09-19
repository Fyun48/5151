# 5151 Runtime HA + Performance Modernization — 進度

整合分支：`deepseek/ha-runtime-modernization`
BASE_SHA：`c60a4f084bc5a01df0858eb669527f074bf22d8a`

## 主機存取（已確認）

| 主機 | SSH | 身份 | Docker |
|---|---|---|---|
| CasaOS `192.168.0.140` | `114.34.73.76:54722` | root | ✅ docker（production `591-tracker-v3` + `5151-ops`） |
| Synology `192.168.0.220`（TORI_NAS01, DSM r1000） | `114.34.73.76:58722` | tori（docker group） | ✅ `/usr/local/bin/docker`（`5151-ops`） |

- 兩台同一內網 `192.168.0.0/24`，TCP 互通（Synology→CasaOS:5432 已通）→ streaming replication 可行。
- 注意：`5151-ops` 兩台都有（CasaOS 與 Synology 各一），正式 v3 在 CasaOS。

## 已完成

### Phase 0 — 保護 Production / 建立分支
- fetch master、記錄 BASE_SHA、建立 integration branch。

### Phase 2 — Performance Baseline（第一優先）
- `v3/benchmark-runtime.mjs` + `v3/run-baseline.mjs`，量測 1k/10k/50k p50/p95/p99 + stage。
- `evidence/runtime-modernization/baseline.{json,md}`（50k fit_desc p95 ≈ 684ms，符 section 21 標準）。

### Cross-platform test harness（Windows + Linux）
- `pathToFileURL(...).href` 修正 38 個測試檔；`.gitattributes` 加 `*.yml eol=lf`。

### Phase 4 — Durable job queue（完成，SQLite 可測 + PostgreSQL SQL 就緒）
- 新增 `v3/src/jobQueue.js`：共用 durable queue 核心（lease / retry / exponential backoff /
  dead-letter / idempotency / expired-lease reclaim / 排程互斥）。
- Schema（PostgreSQL DDL + SQLite DDL）：`id, job_type, payload, priority, state, attempts,
  max_attempts, available_at, leased_at, lease_until, lease_owner, idempotency_key, created_at,
  updated_at, last_error`。priority 100/90/80/60/20/5 已定義（`JOB_PRIORITY`）。
- Claim：PostgreSQL 用 `SELECT ... FOR UPDATE SKIP LOCKED`；SQLite 用 `BEGIN IMMEDIATE` 交易模擬。
- Recurring scheduler 互斥：PostgreSQL `pg_try_advisory_lock`；SQLite `scheduler_locks` lease 表。
- 測試 `job-queue.test.js`（7 項）。
- 尚未：把現有 geo/enrich/notification/CRM/OPS/wish 各 queue 實際收斂到共用 queue。

### Phase 5/6 — DB driver 抽象 + Migration framework（完成核心）
- `v3/src/dbDriver.js`：`DB_DRIVER=sqlite|postgres` 選擇（`resolveDbDriver()`），`createDb()` 工廠、
  `dialectOf()`/`nowExpr()` dialect helpers；SQLite 走 node:sqlite（同步），PostgreSQL 走 `pg`（非同步，
  stub，需 `npm install pg` 後接線）。
- `v3/src/migrate.js`：ordered/versioned migration framework，取代 `ALTER TABLE try/catch`。
  `schema_migrations` 表、transactional forward migration、`down`（rollback）、safety classification、
  `verifyMigrations()`、idempotent re-run、duplicate version 偵測；`addColumnIfMissing`/`addColumnsIfMissing`
  為取代 try/catch 的 idempotent helper。
- **`db.js` 已把 `listings`（57 欄）與 `route_cache`（6 欄）的 `ALTER TABLE try/catch` 全部收斂成
  `addColumnsIfMissing`**（資料 backfill 保留原位）。schema 等價經 73 個 db 相關測試驗證。
- 測試 `migrate-driver.test.js`（8 項）+ db 測試全綠。
- **SQLite→PostgreSQL 資料搬遷 tool**（`v3/src/sqliteToPostgres.js`）：`snapshotTables` / `tableHash` /
  `copyTable`（idempotent，重跑不重複）/ `verifyMigration`（row count + hash）/ `planMigration`（dry-run）/
  `runMigration`（dry-run + resume checkpoint）。測試 5 項。
- 尚未：把 `ensureXxxSchema`（personal/demand/feedback/crm/... 各模組）也納入 runner；把 domain 查詢
  抽成 repository interface；安裝 `pg` 接線真實 PostgreSQL target。



### Phase 3 — Web/Crawler/Worker split（完成）

- 新增 `v3/src/appRole.js`：`APP_ROLE=web|crawler|worker|all`（`all` 為本地/向後相容預設），
  `resolveAppRole()` + `roleRunsWeb/Crawler/Worker()` predicates。
- `server.js`：抽出 `startWorkerLoops()`（housing/feedback 遞送/wish lifecycle/wish offer expiry/
  rental notify/CRM delivery）與 `startStartupWork()`（第一次爬取 + geo backfill）；`app.listen`
  依 `APP_ROLE` 決定：web 只開 HTTP，crawler 只跑 `schedule()`（爬蟲排程），worker 只跑背景迴圈；
  非 web 角色有獨立「不提供 HTTP」分支。
- 測試：`app-role.test.js`（role 解析 + predicates + server.js gating 結構）；既有結構測試
  （admin-members / list-unhang / commute-route-live）全數保留且通過。
- 尚未：Docker/compose 的 `APP_ROLE` 環境參數化與三 container 部署（crawler/worker shadow 上線）。


### Phase 7 — SQL-first search（部分完成，效能核心）

- 新增 `v3/src/listingSearchProjection.js`：`listing_search_projection` 表 + derived columns
  （district/source/kind/rent/total_monthly_cost/area/floor/total_floors/elevator/parking/rooftop/
  low_floor/lat/lng/location_class/primary_listing_id/offline_state/commute_km/updated_at）
  + 索引（updated_at / total_monthly_cost / district / commute_km）。derived 值用**既有同一批函式**算，保證語意一致。
- `db.js`：`upsertListing` 同步 projection；新增 `listListingsSqlFirst()`，把 district re-check +
  ORDER BY + LIMIT/OFFSET 推進 SQL（只回 page IDs 再 hydrate）。支援 `newest`/`price_asc`/`price_desc`
  且「無複雜過濾」的 envelope，超出範圍回 `null`（呼叫端退回 Node 路徑）。
- 差異測試 `list-sql-first.test.js`：同一 fixture 下 `listListingsSqlFirst` 與 `listListings`
  回傳**相同 id 集合/順序**（含 offset 分頁）。
- **實測 50k**：`newest` p50 331→100ms（3.3x）、`price_asc` p50 427→98ms（4.4x）。
- 尚未：commute/fit 排序的 SQL 化（依賴 route_cache，跨使用者）、cursor/keyset pagination、EXPLAIN evidence。


### Phase 13/14/15/19 — Shadow PostgreSQL Primary/Standby（已上線並驗證）

- `deploy/shadow-ha/postgres-primary/`：PostgreSQL-A（Primary, CasaOS `192.168.0.140:15432`）+ setup-replication.sh + fix-pg-hba.sh。
- `deploy/shadow-ha/postgres-standby/`：PostgreSQL-B（Hot Standby, Synology `192.168.0.220:15432`）+ setup-standby.sh。
- `deploy/shadow-ha/haproxy/`：`postgres-rw` / `postgres-ro` / `web` 三組路由（config，尚未上線 HAProxy 容器）。
- `docs/runbooks/postgres-manual-failover.md`：manual failover runbook（fence / split-brain prevention）。
- **已實際在兩台 NAS 起 shadow container 並驗證**：
  - `pg_stat_replication` = `192.168.0.220 | streaming | async`。
  - Standby `pg_is_in_recovery()` = `t`，寫入被拒（`cannot execute INSERT in a read-only transaction`）→ split-brain prevention OK。
  - 資料傳播：primary 寫入 1 筆 → standby 讀到 1 筆。
- 全部用 env（`CASAOS_HOST`/`SYNOLOGY_HOST`/`PG_*_PASSWORD`），獨立 name/port/volume，不碰 Production。

## EXTERNAL_SETUP_REQUIRED（仍需 Owner 提供）

- **HAProxy shadow container 上線**（config 已備好，未起容器）；Web-A/Web-B / crawler / worker shadow 容器上線。
- **Object storage（S3/R2）credentials**：storage abstraction 的 S3 driver。
- **Gitea instance hostname / token**：Gitea migration rehearsal + loop-engine。
- **OpenAI Reviewer API key**：optional Final Review flow。

## 尚未開始（依優先序）

1. Phase 7 SQL-first search（listing_search_projection、indexed ORDER BY、cursor pagination）
2. Phase 3 Web/Crawler/Worker split（APP_ROLE）
3. Phase 4 durable PostgreSQL job queue（FOR UPDATE SKIP LOCKED）
4. Phase 5/6 repository layer + PostgreSQL adapter + migration framework
5. Phase 16–17 Web active/active + Cloudflare HA（shadow config 未寫）
6. Phase 18 storage abstraction（local/s3）
7. Phase 22–27 Gitea + loop-engine + optional Final Review

## 注意（Windows 本機）

- 完整 `npm test` 本機 Windows 仍有環境差異：`activate-rental-marketplace-pra-workflow.test.js` 呼叫
  `python3`（Windows 為 `python`）、部分 `ops/test/*` 依賴 git/shell 路徑。Linux CI 不受影響。

