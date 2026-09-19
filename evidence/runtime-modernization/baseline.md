# 5151 Runtime 搜尋效能基準（baseline）

- 產生時間：2026-09-19T11:43:32.826Z
- BASE_SHA：`c60a4f084bc5a01df0858eb669527f074bf22d8a`
- FINAL_HEAD：`c60a4f084bc5a01df0858eb669527f074bf22d8a`
- 平台：win32/x64，Node v24.13.0
- 引擎：node:sqlite (DatabaseSync)

## 方法

Synthetic listings seeded via upsertListing into a fresh temporary SQLite DB. listListings() + stats() measured with the Node perf_hooks monotonic clock across multiple sorts and repeated iterations; p50/p95/p99 reported per sort.

commuteKm=0 isolates the pure SQL candidate -> Node filter -> sort -> hydrate path without external route/geo provider calls (see section 21: geo/route must never block the API).

## 結果（listListings，毫秒）

| dataset | sort | p50 | p95 | p99 | candidates | matched |
|---|---|---|---|---|---|---|
| 1000 | newest | 10.75 | 21.65 | 21.65 | 667 | 667 |
| 1000 | price_asc | 11.87 | 16.35 | 16.35 | 667 | 667 |
| 1000 | commute_asc | 10.18 | 12.97 | 12.97 | 667 | 667 |
| 1000 | fit_desc | 17.92 | 19.99 | 19.99 | 667 | 667 |
| 10000 | newest | 61.23 | 87.71 | 87.71 | 6667 | 6667 |
| 10000 | price_asc | 83.99 | 98.22 | 98.22 | 6667 | 6667 |
| 10000 | commute_asc | 62.6 | 70.08 | 70.08 | 6667 | 6667 |
| 10000 | fit_desc | 134.86 | 141.05 | 141.05 | 6667 | 6667 |
| 50000 | newest | 342.73 | 400.69 | 400.69 | 33334 | 33334 |
| 50000 | price_asc | 426.25 | 469.76 | 469.76 | 33334 | 33334 |
| 50000 | commute_asc | 338.25 | 364.48 | 364.48 | 33334 | 33334 |
| 50000 | fit_desc | 673.82 | 683.9 | 683.9 | 33334 | 33334 |

## stats（毫秒）

| dataset | p50 | p95 | p99 |
|---|---|---|---|
| 1000 | 0.05 | 6.84 | 6.84 |
| 10000 | 0.06 | 65.68 | 65.68 |
| 50000 | 0.06 | 338.06 | 338.06 |

## 接受標準（對照 section 21）

- 10k：warm p95 ≤ 500ms / cold p95 ≤ 1000ms
- 50k：warm p95 ≤ 1200ms

