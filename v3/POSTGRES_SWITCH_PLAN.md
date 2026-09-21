# PostgreSQL 切換計畫（v1，2026-09-21）

> 狀態：**driver 與 listings 搜尋已在真實 PostgreSQL 上驗證通過**；**Production 尚未切換**
> （`DB_DRIVER` 預設仍是 `sqlite`，公開站不受影響）。本文件列出已就緒的部分、還缺什麼、
> 切換步驟、回復方案，以及它跟「公開流量切 HAProxy」的先後關係。

## 1. 已就緒並已驗證

| 元件 | 狀態 | 驗證 |
|---|---|---|
| `v3/src/dbDriverPostgres.js` | 真正的 `pg` pool driver：async、`query/queryOne/exec/withTransaction/healthCheck`、pool error capture、**config 不含連線字串**（只有 host/port/db/user） | `v3/test/pg-driver.test.js` |
| `v3/src/sqlDialect.js` | SQLite → PostgreSQL 文字轉換（string/comment aware）：`?`→`$n`、`IFNULL`→`COALESCE`、`GROUP_CONCAT`→`string_agg`、`instr`→`strpos`、`datetime('now')`→`now()`、`INSERT OR IGNORE`→`ON CONFLICT DO NOTHING` | `v3/test/sql-dialect.test.js` |
| `v3/src/pgSchema.js` | SQLite schema → PG DDL ＋ 冪等匯入（`ensurePgSchema` / `importTable` / `countRows`） | `v3/test/pg-live-integration.test.js` |
| `v3/src/repository/listings.js`、`listingSearchAsync.js`、`listingSearchSql.js` | driver-agnostic listings repository；`/api/listings` 改走 async 入口（SQLite 行為不變） | `listings-search-repository.test.js`、`list-sql-first-wiring.test.js` |
| shadow HA PG 叢集 | primary = Synology `5151-postgres-B`、hot standby = CasaOS `5151-postgres-A`、串流複寫、HAProxy `pg-rw`/`pg-ro` | 2026-09-21 failover 來回演練（`A4-HA-DRILL-20260921.md`） |
| **真實 PG 整合測試** | **tests 10 / pass 10 / fail 0**（5.7s）：driver 健檢含 `pg_is_in_recovery()`、SQLite schema 鏡射且 row count 一致、重跑匯入不重複、三種排序（newest/price_asc/price_desc × offset × cursor）與 SQLite **id 集合/順序/total/hasMore/nextCursor 完全一致**、envelope 外 fallback、`FOR UPDATE SKIP LOCKED` 兩 worker 併發 claim 不重複、lease 過期回收、idempotency key 去重、standby 可見同一 schema | 2026-09-21 於 shadow 叢集實跑 |
| **列表頁統計 `stats()`** | **同一條純管線、兩個 store 各自供料**：`listingStatsAsync.js`（dispatch）＋`repository/listingStats.js`（PG 讀取）＋ `db.js` 的 `buildListingStatsRows`／`summarizeListingStats`（純計算，SQLite 也走同一支）；PG 模式下列表與統計**同源** | `v3/test/listing-stats-parity.test.js`（本機 1/1；shadow PG **5/5**，逐欄 deepEqual）；`v3/evidence/listing-stats-pg-20260921/` |
| **`/api/state` 同源 ＋ 兩 driver 的數值語意** | 初始載入也走 `listingStatsAsync()`＋`searchListingsAsync()`（那 500 筆頁面逐欄 deepEqual）；`dbDriverPostgres` 把 BIGINT 以**數字**回傳，與 SQLite 的 INTEGER 語意一致（先前 PG 卡片是 `post_id: "900001"`） | 同上 live 子測試（shadow PG 5/5）＋ `pg-driver.test.js`；證據同上 |

## 2. 還缺什麼（切換的前置條件）

1. **裝飾管線 async 化（最大缺口）**：`decorateListingLite` / `finalizeListingDecorate` /
   `overlayRowsPersonal` / `loadFlagMap` / same-house peers / per-user commute 仍走 SQLite 形狀。
   現在 `DB_DRIVER=postgres` 時 `searchListingsAsync` **預設仍回 SQLite 鏈**，只有明確設
   `PG_LISTINGS_UNDECORATED=1` 才會回 PG 的未裝飾資料（刻意避免「半裝飾」上線）。
   - **進度（2026-09-21，Slice 1＋2a 完成）**：`v3/src/repository/decorationData.js` 已覆蓋**整條列表裝飾
     會用到的資料面**（10 張表、13 個載入器）：`user_listing_flags`（個人／任何人）、
     `user_same_house_members`（索引＋`system_agrees`）、`listing_group_members`、`listing_prep`、
     `listings`（同屋源 peers ＋ 卡片 extras）、`user_match_votes`（split 票）、`route_cache`、
     `mrt_cache`、`route_jobs`。同一份 SQL 文字跑兩個 driver，並在載入層把 PG 的 BIGINT 字串正規化
     （否則 `display_ready` 之類會以 `"1"` 漏進回應）；`createDecorationDataLoader()` 提供 promise 記憶化
     （並發共用一次查詢、失敗不快取）。`v3/test/decoration-data.test.js` 在 SQLite fixture 與
     **真實 shadow PostgreSQL** 上比對同一組值（兩邊皆 3/3）。過程中抓到 2 個真差異：
     同一個 id 清單出現兩次時的 `$n` 編號、以及 PG 的 int8→string。
   - **完成（Slice 2b，2026-09-21）**：`db.js` 的裝飾函式全部改走**同步 getter provider**
     （`sqliteDecorationProvider`＝今天的語句；`preloadedDecorationProvider`＝讀預載 maps），並新增
     `preloadDecorationProviderAsync()`（用 `repository/decorationData.js` 預載、含 2-hop peers 與
     route/mrt/job key 計算）與 `decorateRowsWithProvider()`。`searchListingsAsync` 的 PG 路徑現在
     **回傳完整裝飾過的卡片**（`decoration: "full"`）：`pending` 與預設 fallback 已移除，只剩兩種
     fail-safe 回退（SQL-first envelope 外、或預載／裝飾丟錯 → 回 SQLite 鏈）。
     驗證：`decoration-data.test.js`（SQLite fixture ＋ 真實 PG parity）與新的
     `decoration-provider-parity.test.js`（**同一 fixture 下 provider 路徑與 SQLite pipeline 的卡片
     逐欄相等**，含個人同屋源 `same_house_status: "personal"` 與 peers）。
   - **下一步（Slice 3）**：PG 端 EXPLAIN evidence（現有 108,539 筆真實資料可量）＋ commute／fit 的 cursor；
     再來是 Slice 4 的其餘 domain 與寫入分流，最後才是 cutover 與 HA。
   - **下一步（Slice 2）**：讓 `db.js` 的 `decorateListingLite` / `attachListingPeers` /
     `housepriceNotDisplayReady` 接受「預先載入的裝飾資料」（context），SQLite 與 PG 共用同一條
     純裝飾路徑；再把 `searchListingsAsync` 的 `decoration: "pending"` 拿掉。
2. **其餘 domain**：settings / flags / routeCache / users 已有 repository 示範；
   `demand`、`feedback`、`crm`、`geo`、`jobs`、`listing_prep`… 仍在 SQLite 形狀。
3. **寫入分流（切換的真正阻塞項）**：目前只有 listings 搜尋有 PG 路徑；爬蟲入庫、會員標記（`user_listing_flags`）、
   通知、許願房等寫入仍全部打 SQLite。**一旦讀取改走 PG，寫入還在 SQLite，兩邊就會分叉**，所以這是 cutover 前
   必須先處理的一項（順序上比通勤／fit 排序重要）。
   - 做法：先把寫入路徑逐一抽成 repository（upsertListing / flags / route_cache / route_jobs / listing_prep…），
     再讓 `DB_DRIVER=postgres` 時寫入也走 PG；每一項都要有「同一份 payload 在兩個 driver 寫入後讀回相同」的測試。
   - **進度（2026-09-21，第一批完成）**：`v3/src/repository/writePath.js` 把三個 hot-path 寫入改成
     driver-agnostic —— `user_listing_flags`（含 `watched_at`／`hidden_at` 的 CASE 邏輯）、
     `route_cache`（含 rush 變體與 `ON CONFLICT` 更新）、`route_jobs`。SQL 逐字沿用 SQLite 版，
     PG 端只經 `sqlDialect` 轉換。驗證：`v3/test/write-path-parity.test.js` 在 SQLite 與
     **真實 shadow PG** 上跑同一段 payload，讀回（用 `decorationData.js` 的同一組 loaders）必須完全相同
     —— **2/2 通過**；開發中還抓到 `Number(null) === 0` 會把 `min_km` 寫成 0 的真 bug（會讓通勤排序算錯）。
   - **第四批（2026-09-21）：接線完成** —— `db.js` 匯出 `persistListing()`，依 `DB_DRIVER` 分派：
     `sqlite` 走原本的 `upsertListing()`（同步、行為不變），`postgres` 走 writePath 的完整序列
     （列 upsert → backfill → projection → change-log，事件型別比照 production 的
     `listing_added`／`listing_updated`）。`watcher.js` 的**三個寫入呼叫點**都改走它，且共用 PG pool
     抽到 `pgSharedDriver.js`（讀取與寫入共用同一個 pool）。驗證：SQLite 模式下 facade 與 production
     產生的列／投影／change-log 完全相同（**預設部署不受影響**）；PG 模式下走 facade 也能被列表查詢找到。
   - **尚未做（PG 模式）**：`enqueueSimilaritySafe`（pHash／相似度佇列）與 `listing_prep`、其餘 domain
     的寫入 —— 這些在 `DB_DRIVER=postgres` 時目前不會執行，屬已知落差。
   - **第三批（2026-09-21）**：`upsertListing` 的後續步驟也移植了 —— `backfillListing()`（source／
     source_id、kit 欄位、content_seq、geo_source）、`syncProjection()`（`listing_search_projection`，
     用 `computeListingProjection` 同一組純函式）、`bumpRevision()`（`data_revision` change-log）。
     驗證：SQLite 的 projection／change-log 列與 production 相同；PG 端更進一步做**閉環測試** ——
     用 adapter 寫完後，跑**應用同一條列表查詢**（`repository.searchPage`）確認新物件**查得到**。
   - **第二批（2026-09-21）**：`writePath.upsertListingRow()` —— 爬蟲主寫入的 `listings` 列 upsert
     （含寫入前的既有列預讀，供 `preferListingAddress`／`sanitizeFloorName` 回退用）。
     驗證方式是把 production 實際送出的 SQL／參數**攔截下來當基準**：adapter 的 SQL 必須與它
     （去空白後）完全相同、參數逐項相同，且兩條路徑寫出的列**35 個欄位完全相同** —— SQLite 與
     **真實 shadow PG** 都通過。
   - **因此抓到的真 blocker（累計 2 個，都已修）**：`pgSchema` 從 SQLite 推導 DDL 時原本
     ①**不帶 DEFAULT**（缺欄位的 INSERT 撞 `NOT NULL`）、②**沒有把 `INTEGER PRIMARY KEY` 轉成 PG 的
     identity 欄位**（`data_revision.id` 撞 `NOT NULL`）。**cutover 前必須驗證 PG schema 的
     default／自動流水號與 SQLite 一致**，否則寫入會在 runtime 失敗。
4. ~~**PG 端 EXPLAIN regression evidence**~~ → **已有第一版（2026-09-21）**：`v3/evidence/pg-explain-20260921/`
   （真實資料 108,539 筆）。結論：newest／price_asc／price_desc 走 PG SQL-first；建 hot-path 索引後
   count/page 各 7–8 ms、**0 個 Seq Scan**（索引前是 20,324 筆的 seq scan、12–19 ms）。
   **commute／fit 排序仍在 envelope 外**（回退 SQLite；切換後仍可用，屬**優化**而非阻塞項）。
   尚未做：commute／fit 的 EXPLAIN、六種排序的 cursor evidence、正式機絕對延遲（cutover 後用
   `/api/listings` 的 `Server-Timing` 實測）。
5. **（優化，非阻塞）commute／fit 排序走 PG**：可移植，但要小心兩件事 —— (a) `route_cache` 的 key 是
   SQLite 端用 `ROUND(lat*1e5)/1e5 || ',' || …` 拼出來的（v2 格式），要驗證 PostgreSQL 的 float→text
   輸出與 `makeRouteKey()` 的 JS 格式化一致；(b) 那個 `geo_source='geocode'` 的 guard 需要多一個查詢，
   所以 `repository.searchPage()` 要能回報「需要退回 Node 路徑」。實作後用既有的 live parity 測試
   （id 集合／順序必須一致）把關。
6. **（PG 模式的已知落差，2026-09-21 演練實證）** 見 `v3/evidence/pg-rw-drill-20260921/`：
   `DB_DRIVER=postgres` 時「寫入 → 列表 → 裝飾 → 會員標記」都已走 PG（含 PG 寫入後列表查得到）。
   - ~~① `stats()` 列表頁統計~~ → **已接上（2026-09-21）**：`stats()` 拆成「純管線」＋「五個輸入」，
     PG 端由 `repository/listingStats.js`＋`listingStatsAsync.js` 從 PostgreSQL 讀同一批輸入、
     跑同一條管線（`db.js` 的 `buildListingStatsRows`／`summarizeListingStats`），
     `/api/listings` 改成 `await listingStatsAsync(...)`。實測：shadow 真實 PG 逐欄 parity **4/4**、
     回歸 `pg-live-integration` **10/10**、`write-path-parity` **2/2**；證據與踩到的坑見
     `v3/evidence/listing-stats-pg-20260921/`。
   - **爬蟲讀取已接上（2026-09-21）**：`crawlerReads.js` 提供三個 driver-aware 讀取
     —— `listingForWatchAsync`（那一列）、`watchSiblings`（同源指紋）、`matchCandidatesAsync`
     （配對候選，blocking 查詢與純過濾器由 `sameHouseReconcile.js` 匯出、與 SQLite 同一份）；
     `watcher.js` 的 13 個非同步呼叫點（crawl loop、geo、route、offline sweep、通知佇列、backfill）
     與 `listingEnrichQueue.js` 的 enrich worker（`loadListingForRun` 優先走 `loadListingAsync`）
     都改成 await。live parity：`v3/test/crawler-reads-parity.test.js` **5/5**
     （PG 寫入後回讀、指紋、配對候選的 block 與 fallback 兩條路徑）
     ＋ enrich worker 的 async loader 測試（`listing-prep-5168.test.js`，48 項）。
   - **背景迴圈的寫入已接上（2026-09-21）**：`crawlerWrites.js` ＋ `repository/listingState.js`
     把 `markListingOffline`／`restoreListingOnline`／`markListingAlive`／`touchListingChecked`／
     `invalidateListingLocation`（route_jobs）改成 driver-aware；`watcher.js` 的離線探測迴圈、
     enrich worker（`markGone`／`markAlive`／`invalidateLocation` 的 `...Async` 變體）與
     **會員的兩個動作**（`/api/listings/:id/recheck`、`/report-gone`）都改成 await。
     live parity：`v3/test/listing-state-writes.test.js` **4/4**（PG 寫入後以爬蟲入口回讀，
     offline／alive／restore／checked 逐欄等於 SQLite；invalidateLocation 清掉 route_jobs）。
   - **仍待接（切換前必須完成，已評估可機械化）**：
     ① **`listingsNeeding*` 掃描（9 個，進行中）**：`listingsNeeding{591Geo,AddressGeo,AddressEnrich,FeeDetail,
        SourceKit,Route,AliveCheck,OfflineRecheck,Mrt}` ＋ `getRouteJob`／`community_cache`／`route_jobs`
        的讀取。它們是背景迴圈的「待辦清單」，PG 模式下會掃到空的 SQLite → 迴圈空跑（不會壞，但站上
        的補齊／探測／下架偵測全部停止）。
        - **已完成（2026-09-21）**：`AliveCheck`／`OfflineRecheck` —— 語句抽成 `aliveCheckScanQuery()`／
          `offlineRecheckScanQuery()`（＋純過濾 `pickAliveCheckRows()`），由 `crawlerReadsBuildContext()`
          發佈、`repository/crawlerScans.js` 執行、`crawlerReads.needingAliveCheckAsync()`／
          `needingOfflineRecheckAsync()` 分派；`watcher.sweepOfflineListings()` 改成 await。
          live parity：`crawler-reads-parity.test.js` **6/6**（含兩條掃描的列與順序）。
          **離線／存活這條 loop 至此讀寫同源**（掃描 → 探測 → 狀態寫入）。
          同時發現並統一一個跨 driver 細節：`node:sqlite` 回傳 null-prototype 物件、node-postgres 回傳
          一般物件 → 掃描結果一律複製成一般物件（同 BIGINT 的處理）。
        - **已完成（2026-09-21，第二批）**：其餘 7 條 —— `FeeDetail`（兩段查詢，`feeDetailScanQuery()`／
          `feeDetailStaleScanQuery()`／`feeDetailStaleQueryLimit()`／`pickFeeDetailRows()`）、`SourceKit`
          （每來源一頁＋舊 schema fallback，`sourceKitScanQuery()`／`sourceKitLegacyScanQuery()`／
          `pickSourceKitRows()`）、`591Geo`（`geo591ScanQuery()` ＋ `communityCacheIdsQuery()`，把
          「社區已快取嗎」變成一次 `community_cache` 讀取）、`AddressGeo`、`AddressEnrich`、`Mrt`
          （`mrtCacheKeysQuery()` 同理）、`Route`（`routeScanPlan()` 提供 jobs/wantRush/cap/cursor，
          `routePriorityScanQuery()`／`routeWatchedScanQuery()`／`routePageScanQuery()`／`routeJobsQuery()`／
          `routeCacheQuery()` 是四段查詢，`routeRowNeed()` 是純決策；`repository/crawlerScans.selectRouteCandidates()`
          每頁只撈一次 `route_jobs`＋`route_cache` 就決定，回傳 `{ rows, cursor }`）。
          `watcher.js` 的 7 個 backfill 呼叫點全部改成 `await needingXxxAsync(...)`，同步 `listingsNeeding*`
          在 watcher 已無殘留（測試用 regex 釘住）。live parity：`crawler-reads-parity.test.js` **8/8**
          （含 7 條掃描逐列／逐序比對與 PG 分支覆蓋）。
        - **（已完成的 7 條，2026-09-21）** 原本列為「其餘 7 個」：`591Geo`（需要 `community_cache` 讀取）、
          `AddressGeo`、`AddressEnrich`、`FeeDetail`（兩段查詢）、`SourceKit`（每來源 + 舊 schema fallback）、
          `Route`（route_jobs join）、`Mrt`。做法同上；SQL 只有 IFNULL／LIKE／EXISTS／子查詢，沒有 SQLite-only
          函式。
     ② **已完成（2026-09-21，同批）**：迴圈套用的欄位寫入 —— `v3/src/repository/listingFields.js`
        ＋ `crawlerWrites.js` 的 async 分派（`setListingDetailAsync`／`persistHpListingFieldsAsync`／
        `setCachedMrtAsync`／`setCommunityCacheAsync`／`upsertListingPrepAsync`）。
        語句與值決策抽成 db.js 的純 planner（`listingDetailPlan()`／`hpFieldsPlan()`／`mrtCacheUpsert()`／
        `communityCacheUpsert()`／`listingLocationUpdate()`），由 `listingFieldsBuildContext()` 發佈；
        `watcher.js` 的 `applyFetchedDetail`／`applyCommunityPin`／SourceKit 迴圈／MRT 迴圈與
        `listingEnrichQueue.js` 的 `applyHpListingPatch`（`runHelper`）／`prepWrite`（`listing_prep` 同一條
        語句，`listingPrepPlan()`）都改走 async 分派。live parity：`v3/test/listing-fields-parity.test.js`
        **6/6**（`listings` 逐欄、`mrt_cache`、`community_cache`、`listing_prep` 都比對到 SQLite 的答案）。
        修掉三個跨 driver 的細節：`CASE WHEN ?` 在 PG 需要 boolean（node:sqlite 不能綁 boolean）→
        統一寫成 `CASE WHEN ? = 1`；`CAST(? AS DOUBLE PRECISION) IS NOT NULL`（PG 無法從 `IS NOT NULL`
        推參數型別）；`listingLocationUpdate()` 的 post_id 改由參數帶入（SQLite 端讀的 `current`
        是窄 SELECT，沒有 post_id）。
        一併修掉 `repository/decorationData.js` 的 `PEER_COLUMNS_QUALIFIED`：`split(",\n")` 只替每行
        第一個欄位加 `l.`，PG 在 `listing_group_members JOIN listings` 的查詢上會回
        `column reference "source" is ambiguous`（SQLite 容忍）—— 這是切換前就會踩到的既有 bug。
     ③ **通知／CRM 佇列的讀寫**（`pendingNotifyEvents`／`updateEventNotify`／`channelJobDone`／
        `user_events` 寫入、`crmOutbox`）：PG 模式下通知會寫進 SQLite、Web 讀 PG → 會員收不到通知。
     ④ **`enqueueSimilaritySafe`（pHash 佇列）**（§2.3 尾）。
     建議 ①＋② 同批（掃描與它對應的寫入）、③ 一批、④ 獨立；全部完成才切換。
     **①＋② 已於 2026-09-21 完成並以 shadow PG 實測（14/14）。**
   - **遷移工具**：identity sequence 的 re-sync 已納入 `importStore()`
     （PostgreSQL 不會為帶明確 id 的 INSERT 推進 identity sequence，漏了會在第一次自動編號時
     撞主鍵；案例見 `v3/evidence/pg-import-20260921/`）。
   - 詳情頁（`getListing`）**已接上**（2026-09-21）：`getListingAsync()` ＋ `/go`／history／recheck／
     report-gone 四個呼叫點，live parity 4/4（`v3/test/listing-detail-parity.test.js`）。
     `/api/state`（初始載入）也**已同源**（見上表）。
7. ~~**PG schema bootstrap**~~ → **已收進 repo 並可重現（2026-09-21）**：`v3/scripts/pg-import.mjs`
   ＋ `deploy/shadow-ha/pg-import-run.sh`（VACUUM INTO 快照 → schema 鏡射 → 匯入 → 逐表計時），
   切換步驟見 `docs/runbooks/postgres-cutover-bootstrap.md`。仍然成立的前提：**必須從完整初始化過的
   store 鏡射**（空的暫存 DB 會少掉延遲建立的表，例如 `data_revision`）。
8. ~~**遷移工具效率**~~ → **已改成批次＋串流並實測（2026-09-21）**：`pgSchema.importTable` 預設一次送
   `rowsPerStatement()` 列（受 65535 bind parameter 上限約束），`readTableChunks()` 用 rowid keyset
   一次讀 2000 列（記憶體有界）。正式站快照實測 `listings` **108,539 列 / 60.3 s**（multi-row），
   逐列模式明顯更慢 —— 證據 `v3/evidence/pg-import-20260921/`。`COPY` 仍可當後續優化，但目前不是阻塞項。

## 3. 怎麼驗證（今天實跑過的路徑）

```bash
# 1) 不需要資料庫的單元測試
node --test v3/test/sql-dialect.test.js v3/test/pg-driver.test.js v3/test/listings-search-repository.test.js

# 2) 真實 PostgreSQL（shadow HA；測試自建/自刪自己的 schema，不碰既有表）
PG_TEST_URL='postgres://postgres:<pw>@192.168.0.220:15432/5151_shadow' \
PG_TEST_STANDBY_URL='postgres://postgres:<pw>@192.168.0.140:15432/5151_shadow' \
node --test v3/test/pg-live-integration.test.js
# → 2026-09-21：tests 10 / pass 10 / fail 0

# 3) 正式站資料 dry-run 匯入（scratch DB；不碰正式站、也不碰 5151_shadow）
#    來源是 live SQLite 的 VACUUM INTO 快照（實測 108,539 listings / 98 tables）
sh ~/shadow-ha-tools/5151-pg-import-run.sh        # 在 CasaOS 跑；產出 5151_import_test
```

## 4. Production 切換步驟（草案；需要 Owner 指定窗口）

1. 先完成 §2.1–§2.4（裝飾管線、其餘 domain、寫入分流、EXPLAIN evidence）。
   - 統計與 `/api/state` 都已同源（§2.6 ① 完成）：PG 模式下 `/api/listings` 與 `/api/state` 的
     列表＋計數器都讀同一套 PostgreSQL。切換前仍要處理詳情頁（`getListing()`）等列表以外的讀取。
   - 同時**建立 PG 索引**：`sh deploy/shadow-ha/pg-indexes.sh <database>`（匯入只建表與 primary key；
     沒索引時每次查詢都是 20,324 筆的 seq scan）。
   - 同時**確認 PG schema 的 DEFAULT 與 SQLite 一致**：`pgSchema` 已會帶入可翻譯的 default，
     但函式／運算式型 default 仍會略過 —— 缺 default 會讓爬蟲的 INSERT 在 runtime 撞 `NOT NULL`。
2. 低流量時段 **freeze 寫入**（暫停爬蟲排程），跑最後一次增量匯入。
3. 先給 **web-A** 換上新設定（`DB_DRIVER=postgres`、PG 連 `pg-rw`），用 shadow hostname 驗證；
   通過後再切 **591-tracker-v3**（正式站）。
4. 觀察：`/api/health`、`/api/listings` 的 `Server-Timing`、`pg_stat_activity`、`pg_stat_replication`。
5. **回復**：把 `DB_DRIVER` 改回 `sqlite` 並以 `deploy-v3.yml` 回前一版 image digest；
   SQLite 檔在切換後仍保留 → 資料不丟，但 PG 端在切換期間的新寫入要人工評估（回復不自動回寫）。

## 5. 與「公開流量切 HAProxy」的先後關係

`5151-web-A` / `5151-web-B` 目前**各掛自己的 SQLite 目錄**
（`/opt/5151-shadow/web-a/data`、`/var/services/homes/tori/5151-shadow/web-b/data`），
而 SQLite 不能跨主機共用（WAL ＋ 檔案鎖）。因此**只有兩個 web 節點都改讀同一套 PostgreSQL**，
公開流量才能真正切到 `5151-haproxy` 的 `web` frontend（→ `web-a`/`web-b`）。

順序固定為：**PG 切換 → 兩個 web 節點跑 PG → 才改 tunnel ingress 到 HAProxy**。
在那之前切換只會讓公開站服務到空的 shadow 資料庫。
