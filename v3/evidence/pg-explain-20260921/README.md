# PostgreSQL EXPLAIN evidence（2026-09-21）

資料集：正式站 SQLite 快照匯入的 `5151_import_test`（**108,539** listings／98 表）。
方式：跑 PG hot path **實際送出的語句**（包裝 driver 的 `query` 捕捉），再對同一語句與參數跑
`EXPLAIN (ANALYZE, BUFFERS)`；全程唯讀。腳本：`pg-explain.mjs`；原始輸出：`report-5151_import_test.json`。

## 結果（district = 士林區、limit 50）

| sort | envelope | matched | count 執行 | page 執行 | plan 形狀 |
|---|---|---|---|---|---|
| newest | sql-first | 182 | 12.7 ms | 12.7 ms | `Nested Loop Semi Join` over `listing_search_projection`（district 過濾）＋ top-N heapsort |
| price_asc | sql-first | 182 | 11.8 ms | 18.8 ms | 同上 |
| price_desc | sql-first | 182 | 11.5 ms | 12.3 ms | 同上 |
| commute_asc | **outside（reason: `sort`）** | – | – | – | – |
| commute_desc | **outside（reason: `sort`）** | – | – | – | – |
| fit_desc | **outside（reason: `sort`）** | – | – | – | – |

## 兩個結論（都進 cutover 檢查表）

1. **通勤／fit 排序不在 PG 的 SQL-first envelope 內**：`LISTING_SEARCH_SQL_SORTS` 只有
   `newest`／`price_asc`／`price_desc`，其餘排序目前**回退到 SQLite 鏈**（安全，但沒有用到 PG）。
   → Slice 3 必須補上這三種排序的 SQL／cursor，否則切到 PG 後它們仍吃 SQLite。
2. **索引**：這次匯入刻意沒建索引（`pgSchema.ensurePgSchema(..., { indexes: false })`，因為 SQLite 的
   index DDL 可能含 SQLite-only 語法），所以計畫是掃 `listing_search_projection` 再過濾 district
   （掃 20,324 筆、命中 581 筆）。**即便如此 count + page 各只有 12–19 ms、且沒有 `Seq Scan on listings`。**
   → 正式 cutover **必須**先建立 PG 索引（`district`／`updated_at`／`total_monthly_cost`／`commute_km`
   等；`repository/listings.js` 的 `ensureProjection()` 內有對應的 PG DDL），並重跑本證據做前後比較。
