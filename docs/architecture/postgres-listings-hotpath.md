# PostgreSQL Listings Hot Path（v1）

> 狀態：`pg` 已接線、listings 搜尋已在**真實 PostgreSQL** 上通過 parity 驗證；
> 尚未做 Production cutover（`DB_DRIVER` 預設仍是 `sqlite`，公開站不受影響）。

## 這一版做了什麼

原本 `v3/src/db.js` 的 SQL-first 搜尋只綁 `node:sqlite`（同步）。這次把
「statement 產生」與「driver 執行」拆開：

```
GET /api/listings
  └─ await searchListingsAsync(args)        v3/src/listingSearchAsync.js
       ├─ driver=sqlite（預設/正式）→ listListingsSqlFirst ∥ Commute ∥ Fit ∥ listListings   （行為不變）
       └─ driver=postgres          → repository/listings.js
                                       └─ listingSearchSql.js（共用 builder，同一份 SQL）
                                       └─ sqlDialect.js（? → $n、IFNULL → COALESCE、instr → strpos）
```

重點：**兩種 driver 執行的是同一份 SQL 文字**，所以排序／分頁／envelope 不可能各自漂移。
`v3/src/listingSearchSql.js` 由 `db.js`（SQLite 路徑）與 PostgreSQL repository 共用，
db.js 以 `listingSearchBuildContext()` 注入它原本的私有 helper。

| 模組 | 角色 |
|---|---|
| `v3/src/listingSearchSql.js` | SQL-first statement builder（WHERE/ORDER BY/keyset cursor/display filter），driver-agnostic |
| `v3/src/sqlDialect.js` | SQLite→PostgreSQL 的文字轉換（string/comment aware） |
| `v3/src/dbDriverPostgres.js` | 真正的 pg adapter：pool、query/queryOne/exec/withTransaction/healthCheck、紅acted config |
| `v3/src/repository/listings.js` | `createListingsRepository({driver})`，SQLite 與 PostgreSQL 兩個 adapter（同一介面） |
| `v3/src/listingSearchAsync.js` | app 的 async 入口，driver dispatch + 安全 fallback |
| `v3/src/listingStatsAsync.js` | 列表頁統計的 async 入口（同一套 dispatch；PG 由 repository 供料、跑共用純管線） |
| `v3/src/repository/listingStats.js` | stats 的 PostgreSQL 讀取層（candidates／statusCounts／watchedTotal／dbTotal／failedRouteJobs＋flag map） |
| `v3/src/pgSchema.js` | SQLite schema → PostgreSQL DDL + 冪等 import（parity 測試與未來遷移用） |

## 安全性設計（避免「一半的 PostgreSQL 上線」）

listings 的**裝飾**已移植（Slice 1／2a／2b：`v3/src/repository/decorationData.js` 與 `db.js` 的
`preloadDecorationProviderAsync`／`decorateRowsWithProvider`）。`DB_DRIVER=postgres` 時
`searchListingsAsync` 回傳的是**完整裝飾**的卡片（`queryDetails.decoration = "full"`）——
SQLite 與 PostgreSQL 跑同一批裝飾函式。只剩兩種 fail-safe 回退，不會有「半裝飾」的回應上線：

- SQL-first envelope 外的查詢（commute／fit 排序等）→ 回 SQLite 鏈；
- 預載或裝飾丟錯（缺表、連線中斷）→ 回 SQLite 鏈。

`PG_LISTINGS_UNDECORATED=1` 仍保留，但只為遷移診斷（回傳未裝飾列，`decoration = "skipped"`）。

同一條原則用在**列表頁統計**：`stats()` 的「純管線」由兩個 driver 共用
（`db.js` 的 `buildListingStatsRows`／`summarizeListingStats`），PG 端
（`listingStatsAsync.js` ＋ `repository/listingStats.js`）從同一套 PostgreSQL 讀同一批輸入，
所以卡片與計數器不會各說各話。證據：`v3/evidence/listing-stats-pg-20260921/`。

## 怎麼驗證

```bash
# 1) 不需資料庫的單元測試
node --test v3/test/sql-dialect.test.js v3/test/pg-driver.test.js
node --test v3/test/listings-search-repository.test.js        # SQLite adapter 與既有 fast path 逐項相同
node --test v3/test/listing-stats-parity.test.js              # 列表頁統計：同一條管線（live PG 子測試需 PG_TEST_URL）

# 2) 真實 PostgreSQL（shadow HA；測試自建/自刪自己的 schema，不碰既有表）
PG_TEST_URL='postgres://postgres:<pw>@192.168.0.220:15432/5151_shadow' \
PG_TEST_STANDBY_URL='postgres://postgres:<pw>@192.168.0.140:15432/5151_shadow' \
node --test v3/test/pg-live-integration.test.js
```

未設 `PG_TEST_URL` 時 live 測試自動 skip，CI 不需 PostgreSQL 也能全綠。

live 測試涵蓋：driver health check（含 `pg_is_in_recovery()`）、SQLite schema 鏡射到 PostgreSQL
（row count 一致）、重跑匯入不重複、**六種排序中的三種（newest/price_asc/price_desc × offset × cursor）
與 SQLite 路徑 id 集合/順序/total/hasMore/nextCursor 完全一致**、envelope 外的 fallback、
**兩個 worker 併發 claim 不重複（`FOR UPDATE SKIP LOCKED`）**、**lease 過期由另一台回收後再被 claim 同一筆 job**、
idempotency key 去重、以及 **standby 上可見同一 schema（串流複寫）**。

## 環境變數

| 變數 | 預設 | 用途 |
|---|---|---|
| `DB_DRIVER` | `sqlite` | `sqlite` / `postgres` |
| `PG_URL`（或 `DATABASE_URL` / `POSTGRES_URL`） | 無 | 連線字串；未設時 `pg` 會讀 `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE` |
| `PG_POOL_MAX` | `10` | pool 上限 |
| `PG_STATEMENT_TIMEOUT_MS` | `15000` | statement timeout |
| `PG_CONNECT_TIMEOUT_MS` | `5000` | 連線逾時 |
| `PG_POOL_IDLE_MS` | `10000` | idle 回收 |
| `PG_APPLICATION_NAME` | `5151-v3` | `application_name`（`pg_stat_activity` 可辨識） |
| `PG_LISTINGS_UNDECORATED` | 未設 | `1` = 允許 PostgreSQL 回傳未裝飾的 listings（僅供遷移驗證） |

連線字串**不會**出現在 `driver.config`（只有 host/port/db/user 與 `hasConnectionString`），
避免密碼經 log／診斷輸出外洩。

## 還沒做（下一段）

1. **commute／fit 排序的 SQL 化與 cursor**：目前仍在 PG 的 SQL-first envelope 外（安全，但切到 PG 後這兩種排序吃 SQLite）。
2. **EXPLAIN evidence**：已有 newest／price_asc／price_desc（`v3/evidence/pg-explain-20260921/`，0 個 Seq Scan）；commute／fit 尚未。
3. **`/api/state`（初始載入）** 仍是 `listListings()` ＋ SQLite `stats()`，PG 模式下與 `/api/listings` 不同源。
4. **其餘 domain 讀寫**：列表路徑以外的旗標／路線讀取、`enqueueSimilaritySafe`（pHash 佇列）、`listing_prep`、通知／CRM 佇列仍 SQLite-only。
5. **PG schema bootstrap 與遷移工具效率**：app 只會 ensure SQLite schema；`pgSchema.importTable` 仍是逐列 INSERT（108k 筆 listings 需要 COPY／分批版），cutover 還需要寫入凍結視窗。
