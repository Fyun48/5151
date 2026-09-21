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
3. **寫入分流**：目前只有 listings 搜尋有 PG 路徑；爬蟲入庫、會員標記、通知、許願房等寫入仍打 SQLite。
4. **PG 端 EXPLAIN regression evidence**（目前 baseline 只有 SQLite）。
5. **遷移工具效率**：`pgSchema.importTable` 是逐列 INSERT，108k listings 會跑很久；
   正式切換要用 `COPY` 或分批 commit 的版本，並決定 cutover 的**寫入凍結視窗**。

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
