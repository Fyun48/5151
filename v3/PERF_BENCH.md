# 搜尋列表效能基準（PR2）

資料：`v3/test/list-perf-bench.test.js` 合成 400 筆（實際 `listListings` 過濾後 320 筆，limit 500）。

條件：`filter=all`、`sort=price_asc`、同一行程先量「每個結果都做 same-house decorate」，再量「只在有 match 時 decorate」。

| 路徑 | dataset | matched | API/query p50 | p95 |
|---|---|---|---|---|
| 修改前（sameHouse 全開） | 400 | 320 | 22.84 ms | 37.04 ms |
| 修改後（只在需要時 decorate） | 400 | 320 | 17.37 ms | 28.44 ms |

前端：已有快取時 `loadList` 先 `renderList(listCache)`，再等 API；取消關注 280ms collapse，失敗還原。

座標：列表仍只用 `geo_cache`，不在主查詢裡 geocode。
