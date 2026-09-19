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
- **Worker 收斂 reference**（`v3/src/jobWorker.js`）：`runWorkerBatch`（reclaim expired → claim → process →
  complete/fail）+ `startWorkerLoop`；證明兩 worker 不重複執行、失敗不丟 job。測試 4 項。
- **Jobs repository**（`createJobQueue` 工廠 + SQLite/PostgreSQL 兩個 adapter）：PostgreSQL claim 真正
  wired `FOR UPDATE SKIP LOCKED` + `$n` 佔位符 + `ON CONFLICT (idempotency_key)`。測試 3 項。
- 尚未：把現有 geo/enrich/notification/CRM/OPS/wish 各 worker 逐一改接 `runWorkerBatch`（漸進遷移）。

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
- **`ensureXxxSchema` 已納入 runner**（`v3/src/schemaMigrations.js`）：把 personal/demand/feedback/crm/...
  等 26 個 domain module 的 `ensureXxxSchema` 包成 5 個 ordered migration（`runMigrations(db, SCHEMA_MIGRATIONS)`），
  data backfill/binding 保留原位。160 項測試驗證 schema 等價。
- 尚未：把 domain 查詢抽成 repository interface；安裝 `pg` 接線真實 PostgreSQL target。



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
- **cursor/keyset pagination**（Phase 8）：`listListingsSqlFirst` 支援 `newest`/`price_asc`/`price_desc`
  的 cursor（negated-tuple row-value 比較處理 ASC/DESC 混合），回 `nextCursor`；測試驗證三種排序跨頁
  無 gap/overlap（與 offset 全量一致）。
- 尚未：commute/fit 排序的 SQL 化（依賴 route_cache，跨使用者）、commute 的 cursor、EXPLAIN evidence。

### Phase 7 收尾 — commute sort SQL 化

- `listListingsCommuteSqlFirst()`：通勤距離是**每個使用者的**（`route_cache` 以 work point + mode +
  direction 為 key），所以不能沿用 projection 的 `commute_km`（該欄在 upsert 時是 null）。改用
  **INNER JOIN route_cache on v2 to_work key**（`ROUND(lat*1e5)/1e5` 字串拼 key，與 `makeRouteKey`
  一致，實測字串格式化與 JS `String()` 完全相同），並複製 `listListings` 的 strict geo filter
  （usable road + trusted coords + `listingNotifyMeters` 預算），回傳集合/順序與 JS 一致。
- `geocode` 且 `location_class` 空的 case 會用到 JS 的 quality/address inference，SQL 無法複製，
  以 guard query 偵測後回 `null`（退回 Node 路徑）。
- 差異測試 `commute-sql-first.test.js`（2 項）：同 fixture 下 `listListingsCommuteSqlFirst` 與
  `listListings` 回傳相同 id 順序（含超出預算/無路線被過濾）；envelope 外回 null。
- **實測 10k**：`commute_asc` p50 143→61ms（2.4x）、p95 263→64ms（4.1x）；
  `commute_desc` p50 140→61ms（2.3x）。
- **已接進 `/api/listings`**（server.js）：`listListingsSqlFirst(args) || listListingsCommuteSqlFirst(args)
  || listListings(args)` 回退鏈；兩個 fast path 都支援 `matchVoteUserId`（與 server 的 `matchVoteUserId=uid`
  裝飾一致）。超出 envelope 回 `null` → 退回 Node 路徑。`queryVersion` 2→3 標示走 fast path。
- **顯示篩選 envelope 擴充**（重要）：預設設定 `excludeLowFloors=true` + `excludeRooftop=true`
  （`settingsState.js` 的 `!== false` 正規化）原本讓 SQL-first 對**預設使用者 dormant**（envelope 直接 reject）。
  現在改用 projection 既有的 `low_floor`/`rooftop`/`parking`（用同批 `isAtOrBelowFirstFloor`/
  `isRooftopAddition`/`listingHasParking` 算）在 SQL 內套 `AND p.low_floor=0 / p.rooftop=0 / p.parking=1`，
  不再 reject。`wholeFloorOnly` 仍需 `kind_name`（projection 只有 `housingTypeLabel`），暫留 fallback。
- 尚未：`fit_desc` 的 SQL 化（`listingFitScore` 公式含樓層/電梯/價格/route，較複雜）、
  commute 的 cursor、EXPLAIN evidence。

### Phase 7 收尾 — fit_desc SQL 化

- `listListingsFitSqlFirst()`：`listingFitScore` 的通勤項吃 per-user route 距離，所以只涵蓋
  `commuteKm=0` + `priceMin/Max=0` + `minBuildingFloors=0` 的 narrow envelope（就是 50k baseline
  最壞路徑的形狀）。剩餘項（整層 `isWholeFloorHome`、電梯、額外費用）對應 projection 欄位
  （`elevator`/`rent`/`total_monthly_cost`）＋一個 `listings` JOIN 拿 `kind_name`（LIKE 複製
  `isWholeFloorHome` 的正/負 regex）。`extra>0` ⟺ `total_monthly_cost > rent`（`rent<=0` 用 guard
  回退）。`excludeLowFloors` 走 display filter：低樓層先被濾掉，score penalty 恆 moot。
- 差異測試 `fit-sql-first.test.js`（2 項）：電梯/整層/額外費組合的 fit_score 排序與 JS 一致、
  envelope 外回 null。
- **實測 50k**：`fit_desc` p50 945→202ms（4.7x）、p95 993→204ms（4.9x）。此為 baseline 最後一個
  慢路徑，至此 `newest`/`price_asc`/`price_desc`/`commute_asc`/`commute_desc`/`fit_desc` 六種排序
  全部有 SQL-first fast path。
- 尚未：`fit_desc` 的 `commuteKm>0`（含 route 距離的 fit_score）、commute/fit 的 cursor、EXPLAIN evidence。


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

### Phase 16/17 — Web active/active + Cloudflare HA config（config 就緒，未上線）
- `deploy/shadow-ha/web/`：`web-a`/`web-b`（`APP_ROLE=web` + `cloudflared-A/B` 兩 connector 同一 tunnel）
  compose template；`SESSION_SECRET` 跨節點一致、`CASAOS_HOST`/`SYNOLOGY_HOST` env（不硬編碼 IP）。
- 尚未：實際 `docker compose up`（需 Owner 授權 + 測試 hostname）；`SESSION_SECRET` 注入 code 是否已讀 env 待查證。

### Phase 22–27 — Gitea + loop-engine（核心完成，未上線）
- `loop-engine/src/loopEngine.js`：task 狀態機（plan→code→test→fix→staging→implementation_complete→
  release_candidate），owner decision（FINAL_REVIEW / SKIP_REVIEW_AND_RELEASE / RETURN_TO_DEVELOPMENT），
  audit trail，budget/limits（max self-fix iterations / changed files / diff lines / tokens / cost / runtime）。
- `loop-engine/src/giteaWebhook.js`：Gitea webhook HMAC-SHA256 簽章驗證（constant-time）。
- 測試 `loop-engine/test/loop-engine.test.js`（6 項）。
- `deploy/gitea/`：gitea + PostgreSQL + gitea-runner-ci（隔離 DinD，**不掛 host docker.sock**）compose template。
- 尚未：實際 `docker compose up`；Gitea migration rehearsal（GitHub authoritative）；DeepSeek 實際串接 loop-engine；
  `.gitea/workflows/*` + `.agent/*` template（Phase 29）。

### Phase 10/11 — SSE delta events + 共用 event bus（完成核心）
- `v3/src/deltaEvents.js`：`listing_added/updated/removed/commute_updated/stats_invalidated/
  search_membership_changed` 六類 delta event；`classifyDeltaEvent`（enrichment 只 patch card，
  membership/order 變才 re-query）、`searchMembershipChanged`、`eventRequiresRelist`。
- `v3/src/eventBus.js`：共用 event bus；`local`（in-memory pub/sub，SQLite/dev）+ `postgres`
  （`pg_notify`/`LISTEN`，跨 Web-A/Web-B）。NOTIFY 只作 wake-up/cache invalidation，DB 仍是 source of truth。
- `v3/src/dataRevision.js`：`data_revision` change-log（`bumpRevision` / `currentRevision` / `changesSince`），
  Web reconnect 靠 DB revision 補回正確狀態。測試 2 項。
- 測試 `event-bus-delta.test.js`（5 項）。
- 尚未：把 server.js 的 SSE 廣播實際改接 delta event（現仍 broadcast 整包）；Web reconnect 靠 DB revision 補回狀態。


### Phase 12 — Client state（schema + versioning 完成，前端接入後續）
- `v3/src/clientState.js`：versioned client state schema（filter/district/sort/panel/moreCondition/
  currentProfile/pagination cursor/scroll）+ `normalizeClientState`（coerce + v0→v1 migration）+
  `serialize/deserialize`。F5 不重設搜尋條件；server 仍 authoritative。
- 測試 `client-state.test.js`（5 項）。
- 尚未：前端 `v3/public/index.html` 實際改接此 schema（現為分散 localStorage key）。

### Phase 5 — Repository layer（示範完成，其餘 domain 漸進）

- `v3/src/repository/settings.js`：`createSettingsRepository({ driver, sqliteDb, pgPool })` 工廠 +
  SQLite/PostgreSQL 兩個 adapter；介面 `get/set/delete/all`（async）。示範 Domain → Repository → adapter。
- SQLite 用 `?` + `ON CONFLICT(key)`；PostgreSQL 用 `$n` + `ON CONFLICT (key) ... EXCLUDED`。
- 測試 `settings-repository.test.js`（3 項：SQLite CRUD、factory 選擇、PG SQL 結構）。
- 尚未：把 `db.js` 其餘 domain（listings/users/flags/search/geo/route/jobs/...）逐一抽成 repository
  interface（需把同步 hot path 逐步改 async）。


### Phase 18 — Media/File storage abstraction（完成，S3 標 EXTERNAL_SETUP_REQUIRED）

- `v3/src/storage.js`：`STORAGE_DRIVER=local|s3` 選擇（`resolveStorageDriver()`）+ `createStorage()` 工廠；
  local driver（put/get/delete/exists/getMetadata/list，向後相容）；S3 driver（S3-compatible，未給 credentials 時
  每個 method 丟 `OBJECT_STORAGE_EXTERNAL_SETUP_REQUIRED`）；`deterministicStorageKey`（content hash 為 key，冪等）。
- `v3/src/mediaMigration.js`：`migrateMedia`（local→S3，dry-run / verify / resume 冪等）+ `verifyMedia`（sha256 比對）。
- 測試 `storage.test.js`（6 項）。
- 尚未：把 member-media / self-photos 實際改接 storage driver（現仍直接寫 DATA_DIR）；S3 credentials。

### Phase 29 — Engineering Template（完成）
- `template/`：可複製的工程模板。`.gitea/workflows/`（ci/build/staging/predeploy/production，
  production **manual-only** + 精確 confirmation）、`.agent/`（policy.yml / limits.yml / context.md）、
  `ARCHITECTURE.md` / `SECURITY.md` / `OPERATIONS.md` / `RELEASE.md` / `AGENTS.md`。

### Backup / Restore（HA 收尾，SQLite 可測 + PG drill 就緒）

- `v3/src/backupRestore.js`：`backupSqlite`（`VACUUM INTO` 一致性快照）＋
  `verifySqliteBackup`（表覆蓋 + 全庫 digest）、`restoreSqlite`（資料還原 + 驗證）、
  `manifestOf`（表清單 + digest）；PostgreSQL 側 `pgDumpArgv` / `pgRestoreArgv` /
  `pgBasebackupArgv` / `pgVerifyArgv` 為純 argv 建構（無注入、可單測）。
- 測試 `backup-restore.test.js`（4 項：快照驗證、還原驗證、digest 變動、PG argv）。
- `docs/runbooks/postgres-backup-restore.md`：邏輯/實體備份、驗證、隔離還原演練、RPO/RTO。
- `deploy/shadow-ha/backup/{backup,restore,basebackup}.sh`：跑在 Primary host，唯讀備份＋
  manifest；restore 一律還原到隔離 database（不碰 `5151_shadow`）。**實際 drill 待 Owner 授權後執行。**

## EXTERNAL_SETUP_REQUIRED（仍需 Owner 提供）

- **HAProxy shadow container 上線**（config 已備好，未起容器）；Web-A/Web-B / crawler / worker shadow 容器上線。
- **Object storage（S3/R2）credentials**：storage abstraction 的 S3 driver。
- **Gitea token / 上線**：hostname 已知（`https://jgitea01.reversalplay.me` → `127.0.0.1:5251`），
  但 migration rehearsal + loop-engine 串接仍需 Gitea token 與實際 `docker compose up`。
- **OpenAI Reviewer API key**：optional Final Review flow。

## 尚未開始（依優先序）

1. Phase 16–17 Web active/active + Cloudflare HA：config 已備好，尚未上線容器。
2. Phase 22–27 Gitea + loop-engine：核心完成，尚未上線 + Gitea migration rehearsal。
3. 把 `db.js` 其餘 domain 逐一抽成 repository interface（已示範 settings，其餘 listings/users/search/... 漸進）
4. 安裝 `pg` 並接線 PostgreSQL adapter（同步 hot path 需先改 async）

## 注意（Windows 本機）

- 完整 `npm test` 本機 Windows 仍有環境差異：`activate-rental-marketplace-pra-workflow.test.js` 呼叫
  `python3`（Windows 為 `python`）、部分 `ops/test/*` 依賴 git/shell 路徑。Linux CI 不受影響。

