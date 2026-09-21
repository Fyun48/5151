# 5151 Runtime HA + Performance Modernization — 進度

整合分支：`deepseek/ha-runtime-modernization`
BASE_SHA：`c60a4f084bc5a01df0858eb669527f074bf22d8a`
FINAL_HEAD：`9bc92604df435be73bdff43b8271c25edddc9792`（code/test 收尾；整合回報 commit 在其上）

## 主機存取（已確認）

| 主機 | SSH | 身份 | Docker |
|---|---|---|---|
| CasaOS `192.168.0.140` | `114.34.73.76:54722` | root | ✅ docker（production `591-tracker-v3` + `5151-ops`） |
| Synology `192.168.0.220`（TORI_NAS01, DSM r1000） | `114.34.73.76:58722` | tori（docker group） | ✅ `/usr/local/bin/docker`（`5151-ops`） |

- 兩台同一內網 `192.168.0.0/24`，TCP 互通（Synology→CasaOS:5432 已通）→ streaming replication 可行。
- 注意：`5151-ops` 兩台都有（CasaOS 與 Synology 各一），正式 v3 在 CasaOS。

## 已完成

### Phase 39 — Final Gate 整合回報（完成）
- `evidence/runtime-modernization/FINAL-REPORT.md`：BASE_SHA / FINAL_HEAD / branch /
  commits-by-phase（41 commits）/ 效能 before-after / 測試（1462/1463 pass，唯一 fail 為 Windows
  CRLF 跨平台問題）/ 各 phase 狀態 / EXTERNAL_SETUP_REQUIRED / NOT_COMPLETED，交回 Owner Final Gate。
- 收尾：修掉 Phase 6 留下的陳舊斷言（`offline-report.test.js` 仍斷言 `ADD COLUMN alive_checked_at
  TEXT`，更新為 `addColumnsIfMissing` 的 `["alive_checked_at","TEXT"]`）。

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
- **Worker convergence**（Phase 4 收尾）：`jobWorker.js` 新增 `runWorkerBatchAsync`（async handler 版，
  給 enrich/notify/CRM 這類 fetch 型 worker）；`jobQueue.js` 的 `failJob` 支援 `retryAfterMs`（source-specific
  回退覆蓋，預設維持 generic exponential backoff）；`workerConvergence.js` 提供 CRM（`enqueueCrmDeliveryJob` +
  `runCrmDeliveryConvergedBatch`）與 enrich（`enqueueEnrichJob` + `runEnrichConvergedBatch` + `enrichRetryError`，
  `via` → priority mapping + `source_limited`/`parse_failed` cooldown）兩種 producer/consumer 橋接。
  測試 `worker-convergence.test.js`（6 項：deliver+complete、idempotency、retry→dead-letter、
  enrich priority、enrich idempotency、12h cooldown）。
- 尚未：enrich 的 supersession（request_seq/run_seq 舊 run 失效偵測）+ `processOneEnrichJob` 完全收斂
  （現以 producer/consumer 橋接示範 priority/backoff/idempotency，production loop 仍用 `listing_enrich_jobs`）；
  notification/OPS/wish 遷移。

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

### Phase 8 收尾 — cursor 接前端

- server `/api/listings` 現在解析 `?cursor=`（JSON）並回 `nextCursor`；前端 `loadList` 用
  `listCursor` 做 keyset 分頁（`append` 時帶 `cursor`，回 `nextCursor` 就沿用，否則回退 `offset`）。
- 測試 `list-sql-first-wiring.test.js`（3 項）：server 接線 source assertion、`matchVoteUserId` 差異、
  前端 cursor 接線 source assertion。
- 尚未：commute/fit 的 cursor（需 route distance/fit_score 的 sort key 編碼）、client-state 前端接入、
  SSE delta events 前端接入（仍 broadcast 整包）。


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
- **server.js SSE 已接 delta event**（Phase 10 收尾）：geo/route backfill 現會額外 broadcast
  `commute_updated`（`{ postIds, fingerprint }`，只針對 located listings）+ `stats_invalidated`；
  前端 SSE 對應處理 `commute_updated → refreshCommuteSnapshot()`、`stats_invalidated → loadList`。
  原 `listing_updated`（click refresh 補抓）早已接上。測試 `delta-events-wiring.test.js`（2 項）。
- **Web reconnect 靠 `dataRevision`**（Phase 11 收尾）：`upsertListing` 現在 `bumpRevision`
  （新增→`listing_added`、更新→`listing_updated`，best-effort）；新增 `/api/events/revision?since=N`
  回 `{ revision, changes }`，斷線重連的 client 只補 delta。測試 `data-revision-wiring.test.js`（2 項）。
- **前端重連補 delta**（Phase 11 閉環）：`es.onopen` 去問 `/api/events/revision?since=lastRevision`，
  有變更就 `loadList({ silent, keep })`，並更新 `lastRevision`（首次連線只設 baseline 不重查）。
- 尚未：跨 Web-A/Web-B 的 `eventBus`（postgres LISTEN/NOTIFY）需多節點部署後才生效。


### Phase 12 — Client state（schema + versioning 完成，前端接入完成）
- `v3/src/clientState.js`：versioned client state schema（filter/district/sort/panel/moreCondition/
  currentProfile/pagination cursor/scroll）+ `normalizeClientState`（coerce + v0→v1 migration）+
  `serialize/deserialize`。F5 不重設搜尋條件；server 仍 authoritative。
- 測試 `client-state.test.js`（5 項）。
- **前端 `v3/public/index.html` 已接 schema**（Phase 12 收尾）：新增 `CLIENT_STATE_KEY`（`5151-client-state-v1`）+
  `readClientState`/`writeClientState`/`persistSearchState`/`restoreSearchState`（鏡射 `clientState.js`）；
  `filter`/`sort`/`district` 在 change handler 寫入、boot 時 `restoreSearchState()` 還原（F5 不再重設）。
  測試 `client-state-wiring.test.js`（1 項 source assertion）。
- 尚未：`panel`/`moreCondition`/`pagination`/`scroll` 仍走舊的分散 key（`PANEL_KEY`/`FILTER_COMPACT_KEY`/
  `VIEW_KEY`），尚未遷入 versioned schema（漸進）。

### Phase 5 — Repository layer（settings + flags 示範，其餘 domain 漸進）

- `v3/src/repository/settings.js`：`createSettingsRepository({ driver, sqliteDb, pgPool })` 工廠 +
  SQLite/PostgreSQL 兩個 adapter；介面 `get/set/delete/all`（async）。示範 Domain → Repository → adapter。
- `v3/src/repository/flags.js`：`createFlagsRepository({ driver, sqliteDb, pgPool })` 工廠 +
  SQLite/PostgreSQL 兩個 adapter；介面 `get(userId, postId)/set(upsert)/map/delete`。示範**複合主鍵**
  （user_id + post_id）與 `map` 集合查詢，超出 settings 的單鍵 key-value 形態。
- `v3/src/repository/routeCache.js`：`createRouteCacheRepository({ driver, sqliteDb, pgPool })` 工廠 +
  SQLite/PostgreSQL 兩個 adapter；介面 `get/set(upsert)/delete`。示範**寬欄位** key-value
  （rush 分鐘/公尺/location class/route version），對應 `route_cache` 表。
- `v3/src/repository/users.js`：`createUsersRepository({ driver, sqliteDb, pgPool })` 工廠 +
  SQLite/PostgreSQL 兩個 adapter；介面 `findByEmail/findById/create/setPasswordHash/list`。示範
  **auth/CRUD 形態**（email 查詢、INSERT … RETURNING、密碼雜湊更新），密碼 hash/verify 留 domain。
- SQLite 用 `?` + `ON CONFLICT`/`RETURNING`；PostgreSQL 用 `$n` + `ON CONFLICT ... EXCLUDED`/`RETURNING`。
- 測試 `settings-repository.test.js`（3 項）+ `flags-repository.test.js`（3 項）+
  `route-cache-repository.test.js`（3 項）+ `users-repository.test.js`（3 項）。
- 尚未：把 `db.js` 其餘 domain（listings/search/geo/jobs/...）逐一抽成 repository
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

### Gitea Actions CI（Gitea 取代 GitHub，2026-09-20）

- Gitea（Synology，`jgitea01.reversalplay.me` → `127.0.0.1:5251`）接手：repo `JimmyGOD/5151`
  （匯入時 30 分支完整）、local repo `origin` → Gitea、`github` remote 保留為參考；
  `.gitea/workflows/ci.yml`（checkout + `npm ci` + `npm test`）。
- runner（`gitea/act_runner:latest`）在 Synology kernel 4.4.302 上**不能用 DinD**
  （nested overlayfs 不支援），改 **host docker socket**；且必須設
  `CONFIG_FILE=/data/config.yaml`（否則 config 不生效）+ `container.network: "5151-gitea_default"`
  （job 容器才解析得到 `gitea:3000`）。`actions/setup-node` 已移除（runner 映像自帶 Node v24，
  從 GitHub 下載 Node 會卡住）。
- 第一次 CI：2358 tests / 1 fail —
  `v3/test/list-query-regression.test.js` 的「every sorted page uses the complete filtered set …」
  回 `spawnSync /opt/acttoolcache/node/24.19.0/x64/bin/node ETIMEDOUT`（30048ms 撞到硬寫的
  `timeout: 30_000`）。判定為**環境時序**（Synology CPU 慢 + `node --test` 多檔並行），非程式錯誤：
  同批測試在 CI 的耗時分布為 8–20s，已貼近 30s 上限（`cursor/keyset pagination …` 12759ms、
  `sql-first returns identical id set …` 20132ms、`listListings attaches same-house only on the
  returned page` 16181ms）。
- 修正：9 個 v3 測試檔的隔離子程序上限改為 `ISOLATED_TIMEOUT_MS`
  = `Math.max(30_000, Number(process.env.V3_ISOLATED_TEST_TIMEOUT_MS) || 180_000)`——
  只保留「防真卡死」的寬鬆上限，必要時可用環境變數收緊；**未動任何產品程式碼與斷言**。
  `diagnose-rakuya.test.js` 的 20000 維持不動（該測試在 CI 上為毫秒級）。
- CI job `timeout-minutes` 20 → 30（慢速 runner 的餘裕）；本機驗證：9 個受影響測試檔
  96 tests / 0 fail。
- **CI 實證（commit `7c6ef37`）**：`tests 2358 / suites 0 / pass 2358 / fail 0 / cancelled 0 /
  skipped 0 / duration_ms 622923`（約 10.4 分鐘），步驟 `Success - Main Run Test Suite`、
  job「Job succeeded」；修正前 `50f33f3` 為 `fail 1` + 「Job failed」。
  其後 docs-only commit `dd3b565` 再跑一次亦為 `pass 2358 / fail 0`（job succeeded）
  → **連續兩次綠燈**，確認非僥倖。
- 追 CI log 的方法（後續維運用）：完整 job 輸出在 runner stdout → `docker logs gitea-runner-ci`；
  Gitea 端另有 log store（容器 `gitea` 內 `/data/gitea/actions_log/<owner>/<repo>/<run>/<n>.log`，
  只保留部分）。Synology 的 scp 需加 `-O`（sftp subsystem 未開）；PowerShell 5.1 對 ssh 傳參時
  不可用內嵌雙引號（會被吃掉），改用單引號或先落暫存檔。

### Build pipeline（buildx 加速 + smoke 拓撲修正，2026-09-20）

- **加速已生效（約 8×）**：`setup-buildx-action` 預設 `cleanup: true`（每個 job 結束就刪 builder）是慢的主因
  → 加 `name: nas-5151-builder` + `cleanup: false`（builder 名稱**必須字母開頭**，`5151-builder` 會被拒）
  並加 registry cache（`:buildcache`）。實測 run 57（UI `#54`，sha `10817d6`）：**整個 job 4 分 28 秒**
  （其中 `build-push` 步驟 68 秒），對比先前 **32–38 分鐘**。
- **smoke 步驟一直紅的真因是拓撲、不是啟動慢**：本 runner 的 job 容器在 `5151-gitea_default` 橋接網路上，
  它裡面的 `127.0.0.1:<host_port>` 指的是它自己；而 `-p 127.0.0.1::5153` 只綁 host loopback
  → curl 150 次全部 `Failed to connect to 127.0.0.1 port 32771`（run 57/#54），但 app 實測 **4–5 秒**
  就 ready（`docker logs` 有正常啟動訊息）→ 長等待窗只是在延後失敗。
  修法：smoke 容器**不發佈任何 host port**、改 `--network <job 的網路>` 並用**容器名**
  （`http://$NAME:5153`）；等待窗 150 → 60 秒，並加「容器中途死掉就立刻紅燈並印 log」。
- **smoke 的最後一關是 SQLite WAL 陷阱（不是啟動慢）**：smoke 拿掉 host port 之後，
  `/api/health`、`/`、`/login.html` 全部 200、sharp 與 sha256 等價性都過，卻連續三次
  （run 62/#59、63/#60、65/#62）卡在 `{"integrity_check":"ok","tables":[]}`。
  真因是 DB 以 **WAL 模式**運作：`/data` 裡 `v3.db` 只有 **4 KB**，資料在 **2.5 MB 的 `v3.db-wal`**
  → **只 `docker cp v3.db` 永遠拿到 0 張表**；用 `docker exec` 讀同一個檔則**開機 6 秒**就有 98 張表。
  把等待窗 150 → 300 秒完全治不了這件事（先前那個「~93 秒才有表」是量測腳本自己的 bug，已更正）。
  → smoke 的 DB 檢查改成 `docker exec` 在容器內讀。
  **教訓（適用於所有備份/搬遷）：取 SQLite 一定要連 `-wal`/`-shm` 或用 online backup**
  （`production-predeploy-remote.sh` 用的是 `sqlite3 .backup`，方向是對的）。
- 診斷可重跑：NAS 上 `bash deploy/gitea/smoke-topology-diag.sh <image:tag>`
  （會實測 A/B 兩種拓撲：舊 `-p 127.0.0.1::` vs 新「同網路＋容器名」）。


### Shadow HA config 校正（對齊實際佈署，2026-09-20）

shadow stack 實際已在兩台 NAS 上跑（`5151-web-A/B`、`5151-haproxy`、`5151-crawler`、
`5151-worker`、`5151-cloudflared-A/B`、`5151-postgres-A/B` 皆 Up 10h+），但
`deploy/shadow-ha/` 的設定與實際可用版本有落差 —— 照 repo 直接 `compose up` 會壞。已修正：

| 項目 | 原本（repo） | 修正後（對齊 live） |
|---|---|---|
| haproxy health check | `GET /api/public/health`（端點不存在 → 404） | `GET /api/health`（`v3/src/server.js`） |
| haproxy web backend | `${HOST}:5153`（未對外發佈的容器埠） | `${HOST}:15153`（主機發佈埠） |
| haproxy web 對外埠 | `15153:15153`（與同機 Web-A 的主機 15153 衝突） | `25153:15153` |
| web node 綁定 | `127.0.0.1:15153`（另一台連不到 loopback） | `0.0.0.0:15153` |
| haproxy.cfg 變數 | 直接把含 `${CASAOS_HOST}` 的檔掛進去（compose 不替換掛載檔內容） | 新增 `render-and-run.sh` 啟動時 sed 展開，未展開就 fail fast |

- 附帶：`.gitattributes` 加 `*.cfg text eol=lf`（cfg 會掛進 Linux 容器，CRLF 會讓 haproxy 解析出錯）；
  `fix-pg-hba.sh` 改由 `docker inspect` 推導資料目錄（不再硬編 CasaOS 專屬的
  `/mnt/Storage1/docker_data/...`）；兩份 README 校正埠號／container 名稱／上線狀態，
  並釐清 `SESSION_SECRET` 確實讀 env（`auth.js`/`env.js`；未設時每台各自生成隨機值 → 跨節點 session 失效）。
- 驗證（在 CasaOS 用 throwaway 容器，**未動 live**）：
  - 修正版：容器 `Up`、log `Loading success.`、經 HAProxy `GET /api/health` = **200**。
  - 舊設定（`/api/public/health` + `:5153`）：同條件 = **000**（無可用 backend）。
  - 跨主機探測（Synology → CasaOS）：`:15153/api/health` = **200**、`:5153` = **000**、
    `/api/public/health` = **404** → 三個症狀完全對得上。
  - `ss -ltnp`：CasaOS 主機 `15153` 已由 `5151-web-A` 持有 → 舊的 `15153:15153` 必定
    `address already in use`。

### A4 — Backup / Manual Failover drill（完成，2026-09-20）

- **backup drill**：`pg_dump -Fc` + manifest（pg 版本 / size / sha256）→ 隔離還原到
  `5151_restore_test`（`exit=0`、逐表 row count）→ 異地副本到 Synology `~/backups/5151/`（sha256 一致）。
- **manual failover drill**：A（CasaOS）fence → B（Synology）promote → 驗證可寫與 HAProxy 自動改道 →
  A 以 base backup 重建成 standby → 再 fence B、promote A、B 重建回 standby。
  **RPO = 0**（marker 4 筆在兩次切換後完整保留）、**RTO ≈ 17s（首次，含人工判讀）／5s（已熟悉）**。
- **演練抓到 8 個真問題並修進 repo**：`restore.sh` 識別字未加引號（還原演練從來沒成功過）、
  驗證假設 production 的 `listings` 表、runbook `pg_ctl promote` 少 `-u postgres`、pg_hba 缺 docker
  私有網段（peer 主機上的容器做 `pg_basebackup` 被拒，來源是 bridge gateway `172.21.0.1`）、
  Synology 主機端改 volume 檔 `Permission denied`（改為容器內改）、腳本不可攜（`docker` 路徑 + 硬寫容器名）、
  rejoin 步驟缺 slot 與 volume 說明、異地備份路徑不可寫。
- 憑證落差（**僅記錄、未變更任何密碼**）：live `5151-postgres-A` 的 `POSTGRES_PASSWORD` env 是被黏在
  一起的兩行值 → 文件上的密碼在 TCP 上驗證失敗；建議下次重建 shadow pg-A 時直接套 repo 的 primary compose。
  ✅ 2026-09-20 已解決（Owner 指示重建 A）：實際落差有**三處** —— CasaOS `.env` 的兩個 24 字元錯值、
  primary 的 `replicator` 角色密碼、primary 的 `postgres` 密碼（文件值與舊 .env 值都登不進去）；
  全部 `ALTER ROLE` / 改 `.env` 對齊文件值後逐項 TCP 驗證通過，並實走一次 runbook §8 rejoin
  （basebackup 38 MB → standby 串流 → 端到端複寫驗證 → HAProxy `25433` 全路徑回 `f`）。
  詳見 `evidence/runtime-modernization/A4-HA-DRILL-20260920.md` §4.1。
- 🔧 **#2（Owner 指示）runner/CI 佇列調整**：`runner.capacity` 1 → 2、`runner.timeout` 60m → 90m；
  `ci.yml` 的 `cancel-in-progress` 改 `false`（master 的 run 不再被新 push 取消 —— 先前 run 24/27 被標
  cancelled，那兩個 commit 就沒有 CI 結論）；build workflow `timeout-minutes` 60 → 90。
  **不用 `paths-ignore: *.md`**：測試會讀 markdown（`README.md`、`design-system/.../MASTER.md`、
  `v3/RELEASE-READINESS.md`）→ 會漏測。live runner 設定等 run 30 結束後套用；見
  `GITEA-MIGRATION.md` §2.12。
- Artifact：`evidence/runtime-modernization/A4-HA-DRILL-20260920.md`；兩份 runbook 同步更新；
  `OWNER-SETUP-CHECKLIST.md` A4 三項全勾（含 Gitea migration rehearsal：30 分支匯入 + CI 連 4 綠）。
- **同日後續（依 Owner 要求）**：把**預設 primary 改到 Synology**（`5151-postgres-B`），CasaOS 降為
  hot standby（fence→promote→重建 A，RTO ≈4s、資料 lag 0）；`haproxy.cfg`（live + repo）、兩份 compose、
  primary 端腳本預設值、README 與 runbook §6 全部同步 —— 其中 runbook 的「不需要 reload」修正為
  「只在舊 primary 還停機時成立；舊 primary 回來變 standby 後必須對調 backend 並 reload」。

### Gitea 遷移（repo + Actions，2026-09-20）

- **所有 GitHub repo 已搬到 Gitea（18/18）**：`github.com/Fyun48/*` → `jgitea01.reversalplay.me/JimmyGOD/*`。
  第一輪搬 **9 個 public**（5151 + your-remit-01 + your-remit-erpdev + ForumSeeksDLer + your-remit-erp01 +
  yourremit-accounting-system + hsihung_php + Fyun48 + HeyWorld），帶 issues/PRs/labels/milestones/releases/wiki；
  第二輪（2026-09-20，Owner 指出「我在 GitHub 上的專案不止這些」後）補搬 **9 個 private**
  （yourfavorestore[99 分支/96 PR] + your-remit-erp02 + my-erp-mobile + bnplloan + MBRIAPI + ECPAPI +
  cnndemo + hsihung_php2[空] + tori[空]），驗收 9/9 `ALL OK`（分支數/tip sha 兩邊相等、issues/PRs/releases 不少於
  GitHub、`private=true`）。工具：`deploy/gitea/migrate-github-repos.sh`。踩到的坑：Cloudflare 100s 上限
  （大型 repo 要從 NAS 內部呼叫 API）、GitHub 匿名 API 速率限制（`your-remit-01` GitHub 端 0 issues/無 wiki →
  改 `service=git` 完成）、PS 5.1 吃 JSON 雙引號、GitHub JSON 冒號後有空白（會讓 curl(3) malformed URL）、
  Link `rel="last"` 的 `page=` 會誤命中 `per_page=`、Synology 沒有 `git`、`set -e` 下 helper 必須回 0。
  詳見 `GITEA-MIGRATION.md` §1.1–§1.3。
- ⚠️ **已知落差**：`JimmyGOD/5151` 是第一輪的**純 git 遷移** → issues/pulls 都是 0（GitHub 有 19 issues + 354 PRs）；
  程式碼無落差（65/65 分支、master tip 一致）。要補需「刪掉 Gitea 5151 重遷」，會失去 Actions run 歷史與
  repo secrets（值有留存）→ **未執行，等 Owner 決定**（`GITEA-MIGRATION.md` §1.4）。
- **部署 workflow 移植**：`.gitea/workflows/` 新增 `build-production-image.yml`、
  `production-predeploy-check.yml`、`deploy-v3.yml`（全部維持 manual-only）。
  Gitea 相容性調整：移除 `jobs.<job_id>.environment`（Gitea 不支援 environments）、
  `vars.X` → `secrets.X`、docker login 改用 `GHCR_USER`/`GHCR_TOKEN`（Gitea 的 job token 不能推 OCI）、
  移除 `permissions.packages`、registry path/provenance 改用 `GHCR_REPO`/`SOURCE_REPO_URL`
  （Gitea 的 `github.repository` 是 JimmyGOD/5151）、`github.triggering_actor || github.actor`
  （實測 Gitea 該 context 為空，會讓 fail-closed 檢查全拒）。
- **實測而非猜測**：建 throwaway repo 跑 probe（`action_run` 14/17）確認 Gitea 1.22.6 的
  context/vars/GITHUB_ENV/OUTPUT/SUMMARY/token/docker 行為，結果寫在
  `evidence/runtime-modernization/GITEA-MIGRATION.md` §2.5。
- repo secrets 已建立 8 個；**EXTERNAL_SETUP_REQUIRED**：`GHCR_TOKEN`（GitHub PAT，`write:packages`）
  —— 在那之前只有 build workflow 的 docker login 會失敗（見 checklist A6）。
- ⛔ **Blocker（2026-09-20 定位）**：`build-production-image` / `production-predeploy-check` / `deploy-v3`
  三個移植檔在 **Gitea 1.22.6 被 parser 直接忽略**（Gitea log：`[W] ignore invalid workflow "<file>":
  unknown on type: map[string]interface {}{...}`）。根因是 act fork（`gitea.com/gitea/act v0.259.1`）
  `pkg/jobparser/model.go` 的 `ParseRawOn()` 不接受 `workflow_dispatch.inputs` 這種 map 巢狀值；
  上游 go-gitea/gitea#30351 未 backport 到 1.22 系列。→ UI 沒有 `Run workflow` 按鈕，事件觸發也無效。
- **修法 = 升級 Gitea**（已實測，非推測）：在 throwaway `gitea/gitea:1.27.3` 容器（NAS port 5299）
  用**同一組檔 + 5151 真實的 4 個 workflow 檔**驗證，**全部解析成功**（1.22.6 上 c/e/i 三個變體則全數 invalid），
  且 1.27.3 有 dispatch API（`POST /actions/workflows/{id}/dispatches`；1.22.6 無此端點，帶 inputs 實測 HTTP 204）
  → 升級後可由 agent 直接觸發 build，不需要 Owner 手動按按鈕。詳見
  `evidence/runtime-modernization/GITEA-MIGRATION.md` §2.6；升級決策/步驟見 checklist A7。
- 測試環境已於當日清理（throwaway Gitea 1.27.3 容器 + `JimmyGOD/probe-on-shapes` probe repo + 本機暫存檔全刪）。


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

- ✅ **Gitea 已升級 1.22.6 → 1.27.3**（2026-09-20，Owner 指示直接升級；已實測驗收）：DB schema
  299 → 343、9 repos 與所有 secrets 保留、readiness 15s、只有 `gitea` 容器被重建。備份
  （pg_dump + 2 個 volume tar + compose/env/runner-config 快照）留在 NAS
  `~/gitea-backups/20260920T044702Z`，sha256 與完整流程見 `GITEA-MIGRATION.md` §2.8。
- ⚠️ **移植檔另有 2 個 Gitea-only 缺陷（實測抓到、已修）**：
  1. `actions/upload-artifact@v4` 在 act runner 直接失敗
     （`@actions/artifact v2.0.0+ ... not supported on GHES`）→ 讓整個 job 失敗、後面
     docker login/build/push 全被跳過 → 改成把 evidence 印進 run log + step summary。
  2. 新 step 名稱含 `: ` → **YAML plain scalar 不能含 colon+space**，3 個 workflow 全部變
     invalid（Gitea log：`mapping values are not allowed in this context`）→ 去掉冒號。
  build run 結果與後續見 `GITEA-MIGRATION.md` §2.9。
- 🔧 **run 26 真正原因是 runner 的 job timeout（更正 §2.9 的推測）**：`~/gitea/runner-config.yaml`
  的 `runner.timeout: 20m`，而 run 26 起跑→失敗正好 20m02s；`context deadline exceeded` 只是症狀。
  → 已把 `runner.timeout` 調到 **60m**（log level 同時由 debug 改 info、舊檔備份），
  repo 補上 `deploy/gitea/runner-config.yaml`，並把 build workflow 的 `timeout-minutes` 45 → 60。
  詳見 `GITEA-MIGRATION.md` §2.10。

