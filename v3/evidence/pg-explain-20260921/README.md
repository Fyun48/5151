# PostgreSQL EXPLAIN evidence（2026-09-21）

資料集：正式站 SQLite 快照匯入的 `5151_import_test`（**108,539** listings／98 表）。
方式：跑 PG hot path **實際送出的語句**（包裝 driver 的 `query` 捕捉），再對同一語句與參數跑
`EXPLAIN (ANALYZE, BUFFERS)`；全程唯讀。腳本：`pg-explain.mjs`；原始輸出：`report-5151_import_test.json`。

## 結果（district = 士林區、limit 50）

### 匯入後（未建索引）

| sort | envelope | matched | count 執行 | page 執行 | plan 形狀 |
|---|---|---|---|---|---|
| newest | sql-first | 182 | 12.7 ms | 12.7 ms | `Nested Loop Semi Join` ＋ **`Seq Scan on listing_search_projection`（掃 20,324 筆、district 命中 581）** |
| price_asc | sql-first | 182 | 11.8 ms | 18.8 ms | 同上 |
| price_desc | sql-first | 182 | 11.5 ms | 12.3 ms | 同上 |
| commute_asc | **outside（reason: `sort`）** | – | – | – | – |
| commute_desc | **outside（reason: `sort`）** | – | – | – | – |
| fit_desc | **outside（reason: `sort`）** | – | – | – | – |

### 建了 hot-path 索引之後（`deploy/shadow-ha/pg-indexes.sh`，7 個索引）

| sort | count 執行 | page 執行 | plan 形狀 |
|---|---|---|---|
| newest | **7.9 ms** | **8.0 ms** | `Index Scan using idx_proj_district`（581 筆、0.07 ms）＋ top-N heapsort |
| price_asc | **6.9 ms** | **7.1 ms** | 同上 |
| price_desc | **7.2 ms** | **7.8 ms** | 同上 |

- **整輪 0 個 `Seq Scan`**（先前每種排序都有一次 20,324 筆的掃描）。
- page 執行由 12.3–18.8 ms 降到 7.1–8.0 ms（**約快 40%**）。
- 原始輸出：`report-5151_import_test.json`（未建索引）、`report-5151_import_test-indexed.json`（建索引後）。

## 三個結論（都進 cutover 檢查表）

1. **通勤／fit 排序不在 PG 的 SQL-first envelope 內**：`LISTING_SEARCH_SQL_SORTS` 只有
   `newest`／`price_asc`／`price_desc`，其餘排序目前**回退到 SQLite 鏈**（安全，但沒有用到 PG）。
   → Slice 3 必須補上這三種排序的 SQL／cursor，否則切到 PG 後它們仍吃 SQLite。
2. **cutover 必須先建 PG 索引**：匯入（`pgSchema.ensurePgSchema(..., { indexes: false })`，因為 SQLite
   index DDL 可能含 SQLite-only 語法）只建表與 primary key。用 `deploy/shadow-ha/pg-indexes.sh`
   建好 7 個索引後，計畫從 seq scan 變成 `Index Scan using idx_proj_district`，**0 個 Seq Scan**。
3. **絕對量測**：這台是 shadow（兩台家用 NAS 的 PG container），數字只代表相對改善與計畫形狀；
   正式站的絕對延遲仍要在 cutover 後以 `/api/listings` 的 `Server-Timing` 實測。
