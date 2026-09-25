# PR-B：PG 版 `searchKeys` 真實鏡像對等性實測（2026-09-25）

## 目的
astra6 §0.2 要求「request context 由 PG 建立」。`crawlSources`／`isolation` 之後，
`searchKeys` 是**最後且最大**的一筆 SQLite 讀取（`currentSearchKeys()` ＋ `expandSearchKeys()`
的 `SELECT DISTINCT search_key FROM listings` 全表掃描）。本檔記錄 PG 版 builder 的實測對等性。

## 實作（commit `9bf9e2e`）
零語意漂移：每一段都重用同一支純函式／同一個 predicate。

| 子句 | SQLite 原本 | PG 版 | 重用 |
|---|---|---|---|
| 使用者清單 | `members.listUserIds` | **同一句 WHERE**：`deleted_at IS NULL OR deleted_at = ''` `ORDER BY id` | 同一 predicate |
| 每／全域 `searchUrls` | `getSettings(id)` | `settings` ＋ `user_settings` ＋ `users(id,role,plan)` | `settingsFromRows`（pure）|
| system crawl | — | `settings` | `systemCrawlFromRows`（pure）|
| covers → URL | `listCrawlCovers` | `crawl_covers`（欄名與 `coverFromRow` 1:1）| `coverFromRow`、`coveringJobsFromMembers`（pure）|
| 展開 | `SELECT DISTINCT search_key`（SQLite ✗）| `SELECT DISTINCT search_key`（**PG** ✓）| `expandSearchKeysAgainst`（新抽出的 pure 函式）|

## 實測（`v3/scripts/search-keys-parity.mjs`，唯讀）

```
REMOTE_DIR=/app/tmpkk bash v3/scripts/run-in-container.sh v3/scripts/search-keys-parity.mjs

KEYS-SOURCES {"users":4,"userSettingsRows":233,"userSettingsWithUrls":3,"covers":38,"globalSettingsRows":28}
KEYS-PG      {"total":28}
KEYS-SQLITE  {"total":6}
KEYS-DIFF    {"onlyPg":22,"onlySqlite":0,"same":6}
```

## 判讀（重點）
- **`onlySqlite = 0`** ✓：PG builder 產出的是 SQLite 結果的**超集** ⇒ **零遺漏**，不會漏掉任何
  SQLite 路徑會產生的 `search_key`（這是「不得漂移」的硬性條件）。
- **`onlyPg = 22` 的來源已被證據解釋** ✓：容器內 SQLite 的 `users` 只有 **4** 列，而 PG 鏡像有
  **28** 列（`crawl_covers` 38 列）⇒ 容器 SQLite 是**殘缺／過期副本** ✗，不是 builder 缺陷 ✗。
- 展開確實生效 ✓：PG 產出的 key 含 `&order=posttime&orderType=desc` 變體（來自 `listings.search_key`
  的 DISTINCT 展開），與 SQLite 自身輸出中的同名變體一致 ✓。

## 執行環境教訓（已寫進 `run-in-container.sh` 標頭）
- `/app/src` 是**部署映像的舊碼** ✗ ⇒ 驗證新碼必須用同步後的目錄（`/tmp/kk` 或 `/app/tmpkk`）。
- 腳本若 import bare specifier（如 `pg`），**必須** `REMOTE_DIR=/app/tmpkk`：ESM 由「匯入檔所在
  目錄」向上找 `node_modules`，且**不吃 `NODE_PATH`** ⇒ 放 `/tmp/kk` 會找不到 `/app/node_modules/pg`。
- `toPostgresSql` **不在** `dbDriverPostgres.js` ⇒ builder 用 `?` 佔位符時，於腳本本地轉 `$n`。

## 待辦（後續）
- `onlyPg` 的逐項來源分解（users／covers 各貢獻幾個）—— 目前僅以總數與表列數解釋。
- 端對端：`node_pg` 路徑改為單一快照（`REPEATABLE READ READ ONLY`）後重跑本腳本。
