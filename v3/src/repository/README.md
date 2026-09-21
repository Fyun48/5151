# Repository Layer（Phase 5）

把 domain 與資料驅動解耦：domain 只依賴 repository interface，不綁 `node:sqlite`
或 SQLite 專屬語法。SQLite 現在可跑，PostgreSQL 是目標，透過 `DB_DRIVER` 切換。

```
Domain
  ↓
Repository interface（async，driver-agnostic）
  ↓
SQLite adapter（node:sqlite，今日） | PostgreSQL adapter（pg，目標）
```

## 已完成示範

- `settings.js`：`createSettingsRepository({ driver, sqliteDb, pgPool })` 工廠 +
  `createSqliteSettingsRepository` / `createPostgresSettingsRepository`。
- 介面：`get` / `set`（upsert）/ `delete` / `all`。
- SQLite 用 `?` + `ON CONFLICT(key)`；PostgreSQL 用 `$n` + `ON CONFLICT (key) ... EXCLUDED`。
- `flags.js`：`createFlagsRepository({ driver, sqliteDb, pgPool })` 工廠 +
  `createSqliteFlagsRepository` / `createPostgresFlagsRepository`。
- 介面：`get(userId, postId)` / `set(userId, postId, flags)`（upsert）/ `map(userId)` / `delete(userId, postId)`。
  示範**複合主鍵**（user_id + post_id）與 `map` 集合查詢，超出 key-value 的單鍵形態。
- `routeCache.js`：`createRouteCacheRepository({ driver, sqliteDb, pgPool })` 工廠 +
  `createSqliteRouteCacheRepository` / `createPostgresRouteCacheRepository`。
- 介面：`get(routeKey)` / `set(routeKey, route)`（upsert）/ `delete(routeKey)`。示範**寬欄位** key-value
  （rush 分鐘、公尺、location class、route version），對應 `route_cache` 表。
- `users.js`：`createUsersRepository({ driver, sqliteDb, pgPool })` 工廠 +
  `createSqliteUsersRepository` / `createPostgresUsersRepository`。
- 介面：`findByEmail` / `findById` / `create`（INSERT … RETURNING）/ `setPasswordHash` / `list`。
  示範 **auth/CRUD 形態**（email 查詢、create、密碼雜湊更新），與 key-value 完全不同；密碼
  hash/verify 留在 domain（`password.js`/`members.js`），repository 只存 hash。
- `listings.js`：`createListingsRepository({ driver, sqliteDb, pgDriver, deps, schema })` 工廠 +
  `createSqliteListingsRepository` / `createPostgresListingsRepository`。
  介面：`searchPage(args)`（回 `{ ids, totalMatched, hasMore, nextOffset, nextCursor, useCursor, queryVersion }`，
  envelope 外回 `null`，呼叫端沿用 Node 路徑）/ `hydrate(ids)` / `ensureProjection()`。
  **示範 hot-path 形態**：兩個 adapter 都執行 `listingSearchSql.js` 產生的**同一份 SQL**，
  差別只在 `sqlDialect.js` 的 `?`→`$n`、`IFNULL`→`COALESCE`、`instr`→`strpos` 與 BIGINT 正規化。
  PostgreSQL 端以連線的 `search_path` 決定 schema（`schema` 參數只用於 `ensureProjection()` 的 DDL），
  因為 builder 的 SQL 也會引用 repository 不知道的表（例如 `listing_prep`）。
  domain 入口是 `v3/src/listingSearchAsync.js`（async，driver dispatch + 安全 fallback）。
- `listingStats.js`：`createListingStatsRepository({ driver, pgDriver, exec, deps })`。
  介面：`loadInputs({ searchKeys, userId, settings })`（candidates／statusCounts／watchedTotal／
  dbTotal／failedRouteJobs ＋ flag map）。它不是「重寫一份統計」，而是把 `db.js` 的 clause builder
  與純管線（`listingStatsBuildContext()`）拿來用，所以 PG 與 SQLite 的計數器定義只有一份。
  domain 入口是 `v3/src/listingStatsAsync.js`（`/api/listings` 用）。
  注意：注入的 `exec` 一律回 row array，單列讀取由 repository 的 `runOne()` 自己 unwrap。

## domain 入口（async）

`/api/listings` 不再直接串 SQL-first 函式，而是 `await searchListingsAsync(args)`：

- `DB_DRIVER=sqlite`（預設）：與改動前**完全相同的鏈**
  （`listListingsSqlFirst ∥ listListingsCommuteSqlFirst ∥ listListingsFitSqlFirst ∥ listListings`）。
- `DB_DRIVER=postgres`：`searchListingsAsync` 回傳**完整裝飾**的卡片（裝飾已移植），
  只在 SQL-first envelope 外或裝飾失敗時回 SQLite 鏈；`PG_LISTINGS_UNDECORATED=1` 僅供遷移診斷。
- 同一個 handler 的列表頁統計走 `await listingStatsAsync(...)`：PG 模式由 `repository/listingStats.js`
  從同一套 PostgreSQL 讀輸入，再跑 `db.js` 的純管線，因此列表與計數器同源。
- 設計與實測證據：`docs/architecture/postgres-listings-hotpath.md`、
  `v3/evidence/listing-stats-pg-20260921/`。

## 遷移路徑（其餘 domain）

依同樣 pattern 逐一抽出 `listings / users / flags / settings / search / geo / route /
jobs / notifications / wishes / matching / OPS-CRM outbox`。

注意：現有 `db.js` 是**同步**（node:sqlite `DatabaseSync`），PostgreSQL 是**非同步**。
遷移時需把呼叫端逐步改成 async；SQLite adapter 用 async 包裝同步底層，讓兩邊介面一致。
