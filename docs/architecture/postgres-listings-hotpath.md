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
| `v3/src/pgSchema.js` | SQLite schema → PostgreSQL DDL + 冪等 import（parity 測試與未來遷移用） |

## 安全性設計（避免「一半的 PostgreSQL 上線」）

listings 的**裝飾**（flags overlay、same-house peer、per-user commute 標籤、settings 相關顯示）
目前仍由 SQLite 形狀的 helper 執行，尚未移植。因此：

- `DB_DRIVER=postgres` 時 `searchListingsAsync` **預設仍走 SQLite 鏈**；
- 只有在明確設定 `PG_LISTINGS_UNDECORATED=1` 時才會回傳 PostgreSQL 的**未裝飾**資料列
  （`queryDetails.decoration = "pending"`），不會有「半裝飾」的回應悄悄上線。

## 怎麼驗證

```bash
# 1) 不需資料庫的單元測試
node --test v3/test/sql-dialect.test.js v3/test/pg-driver.test.js
node --test v3/test/listings-search-repository.test.js        # SQLite adapter 與既有 fast path 逐項相同

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

1. **裝飾管線移植**：`decorateListingLite` / `finalizeListingDecorate` / `overlayRowsPersonal` /
   `loadFlagMap` / same-house peers / per-user commute 需要 async 化，才能讓 PostgreSQL 路徑回傳完整回應。
2. **其餘 domain 查詢**（settings/flags 已有 repository 示範，其餘仍在 sqlite 形狀）。
3. `listing_prep`（以及任何 visibility clause 依賴的表）在 PostgreSQL 端要一起建立與維護。
4. EXPLAIN (ANALYZE, BUFFERS) 的 PostgreSQL 版 regression evidence（目前 baseline 仍是 SQLite）。
