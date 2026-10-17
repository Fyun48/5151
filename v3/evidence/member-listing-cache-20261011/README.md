# 會員列表路徑的版本化快取（2026-10-11）

`GET /api/listings`／`GET /api/state` → `loadListingPage()` 的回傳結果加一層
per-process、以 `data_revision` 為世代（generation）的快取。預設**關閉**。

- 程式：`v3/src/memberListingCachePg.js`（新）、`v3/src/listingSearchPage.js`（接線處）、
  `v3/src/runtimeGuards.js`（開關名稱與說明）。
- 量測：`v3/scripts/member-listing-cache-bench.mjs`。
- 測試：`v3/test/member-listing-cache.test.js`（離線，14 條）、
  `v3/test/member-listing-cache-live-pg.test.js`（真 PG）。

## 為什麼是快取、不是把過濾鏈 SQL 化

`totalMatched` 必須由**完整候選集合**決定（`v3/src/listingSearchNodePg.js:9-11` 的不變式），
不能加 LIMIT 或改走 SQL-first 捷徑。今日 #710 已經證明「窄查詢先定 `totalMatched`」在現有結構下
不可達（候選 141,570 vs Node 過濾後 3,378）。所以同一個請求重複打，成本就是重複付——
只能靠「同一份資料、同一組參數，不要算第二次」來省。

## key 的組成

| # | 進 key 的東西 | 來源 | 為什麼一定要在裡面 |
|---|---|---|---|
| ① | `data_revision.MAX(id)` | PG | 爬蟲寫入／同戶／配對／站內刊登都會 bump，是**主要失效來源** |
| ② | `pg_stat_user_tables` 對 `listings`／`route_cache`／`route_jobs`／`mrt_cache`／`community_cache` 的 `n_tup_ins+n_tup_upd+n_tup_del` 總和 | PG | 這些表**不走 `data_revision`**；`commuteKm>0` 時路線距離會決定物件出不出得來（`db.js:6899`） |
| ③ | 會員狀態簽章：`user_settings`（key=value 全集）、`user_listing_flags`（viewed／watched／hidden／watch_note／watch_group_id）、`user_same_house_members`、`users.role/plan`、全域 `settings`、`crawl_covers` | PG | 這些表**不 bump `data_revision`**（`personalFlagsAsync.js` 沒有任何 bump）。不進 key ⇒「剛按不再顯示」會被回舊值 |
| ④ | 請求參數：filter／kind／sources／q／sort／limit／offset／cursor／districts（排序後）／sameHouse／searchKeys／`args.settings`／**呼叫端明確給的 `asOf`** | 呼叫端 | 不同篩選、不同分頁就是不同結果 |
| ⑤ | `uid` | 呼叫端 | 候選集是**這個會員的** search_key 展開結果 |
| ⑥ | key 格式版本 `member:v1` | 常數 | key 組成改變時，不要拿舊格式的 key 去命中新格式的 entry |

③ 的每一項都是 `COUNT(*)` ＋ `md5(string_agg(... ORDER BY ...))` 的**有序集合雜湊**，
不是 `MAX(md5)`（後者抓不到刪除與部分更新）。②③ 全部放在**同一個 statement** 裡
（再加一句 `to_regclass('data_revision')` 探測）⇒ 一次 round trip，隔離庫實測 3ms 上下。

**刻意不進 key**：`listingRequestTime()` 自動產生的 `now`／`asOf`。那是每個請求都不同的時鐘，
放進去等於永遠不命中（`loadListingPage` 會把 `{now, asOf}` 併進 args，key 只挑明確傳入的 `asOf`）。

## 什麼時候作廢

- ①～⑤ 任何一項變動 ⇒ key 不同 ⇒ 未命中（舊 entry 留著等容量淘汰，不會被誤用）。
- entry 年齡 > `MEMBER_LISTING_CACHE_FRESH_MS`（預設 30 秒）⇒ 未命中。這是**上限**不是失效機制：
  `pg_stat_user_tables` 的計數有約 1 秒的統計落後，新鮮窗口讓「沒被版本號涵蓋到的周邊資料」
  的陳舊上限有界（比訪客快取的 `MAX_STALE_MS` 嚴格；當時訪客快取是 45s，
  **2026-10-16 起放寬為 600s**，見 `docs/handoffs/20261016-guest-swr-stale-window.md`）。
- **與訪客快取的關鍵差別**：訪客快取有 SWR（版本換代時先回舊值、背景重算）；
  **會員快取沒有 SWR**——版本一換就是硬性未命中，寧可重算也不回舊代。
- 寫入前**再確認一次**版本：算這一頁的期間若剛好有寫入，這份結果只服務這一個請求，不寫進快取。

## 故意不快取的情況（fail-closed）

| 情況 | 行為 |
|---|---|
| `MEMBER_LISTING_CACHE` 沒設／不是 `1`／`on`／`true` | 完全不經過這一層（**預設**） |
| 非 postgres driver（SQLite／測試替身） | 完全不經過這一層 |
| `data_revision` 不存在 | 不讀也不寫，每次現算（同 `storedSearchKeysFromPg` 的契約） |
| `data_revision` 是空表（`MAX(id) IS NULL`） | 同上（沒有可靠版本號就不做跨請求快取） |
| 版本號或會員簽章查詢拋錯（PG 半死、表被鎖） | 同上，且不得往上炸 |
| 單筆結果超過合計筆數預算 | 整筆不存（不要讓一筆把整池擠掉） |

## 輸出契約

回傳欄位、`totalMatched`、排序、分頁語意**逐字不變**。命中時只有 `timing` 不同：

- `query_ms`／`stats_ms` 一律 **0**（這一頁沒有真的算，`Server-Timing` 與量測腳本才不會說謊），
  `total_ms` 是這個請求真正花的時間。
- `timing.stages.cache_hit = true`、`cache_age_ms`（additive 欄位，前端不讀）。
- 冷算的階段明細（`sql_ms`／`candidates`…）保留，因為它們描述的是這份 payload 的來源。
- 命中回傳的 `stats`／`listings` 換成新的頂層容器：呼叫端就地改動（`server.js:4939` 會改
  `timing.total_ms`）不可以改到快取裡那一份。

## 記憶體

兩道護欄：`MEMBER_LISTING_CACHE_ENTRIES`（預設 24 筆）與
`MEMBER_LISTING_CACHE_MAX_LISTINGS`（預設 1200 筆物件合計）。
後者是必要的：`GET /api/state` 用 `limit=500` 走同一條路，隔離庫實測一頁 80 筆序列化 643KB
（≈8KB／筆）⇒ 24 頁 500 筆最壞可以吃掉近百 MB。1200 筆約 3～5MB（實測記憶體約為序列化的 1/2～1/3）。

## 怎麼開

```bash
MEMBER_LISTING_CACHE=1                 # 必要；預設關閉
MEMBER_LISTING_CACHE_FRESH_MS=30000    # 選用，預設 30000
MEMBER_LISTING_CACHE_ENTRIES=24        # 選用，預設 24
MEMBER_LISTING_CACHE_MAX_LISTINGS=1200 # 選用，預設 1200
```

## 實測（隔離庫 `repro`，uid=1，`node v3/scripts/member-listing-cache-bench.mjs`）

同一組參數連打兩次；PG 查詢次數是在 pool 層攔截（含快照交易裡的每一句）。

| 情境 | 關快取 #2 | 開快取 #2（命中） | 第二次省下 | 少掉的 PG 查詢 |
|---|---|---|---|---|
| default | 2742 ms／159 次 | **8 ms／2 次** | 2734 ms | 157 |
| district=中山區 | 2668 ms／154 次 | **8 ms／2 次** | 2660 ms | 152 |
| 租金 3000–8000 | 1566 ms／140 次 | **9 ms／2 次** | 1557 ms | 138 |
| q=新莊 | 2048 ms／146 次 | **8 ms／2 次** | 2040 ms | 144 |
| 多條件 | 1895 ms／135 次 | **7 ms／2 次** | 1888 ms | 133 |

命中時剩下的 2 次查詢＝`to_regclass` 探測 ＋ 版本號／簽章查詢。

### 正式站形狀（`BENCH_ALL_KEYS=1`：把全庫 search_key 都當成這個會員的已展開清單）

這一組的 `matched=3378` 正好等於正式站那位會員今日實測的 `totalMatched`（3,378），
候選集也拉到全庫（184,245 筆 `listings`）：

| 情境 | 關快取 #2 | 開快取 #2（命中） | 第二次省下 | 少掉的 PG 查詢 |
|---|---|---|---|---|
| default | 12924 ms／554 次 | **7 ms／2 次** | 12917 ms | 552 |
| district=中山區 | 9717 ms／508 次 | **11 ms／2 次** | 9706 ms | 506 |

**局限**：這是隔離量測庫（`repro`，184,245 筆 `listings`），
該會員的 search_key 在這裡只覆蓋到 `matched=803`，與正式站那位會員（候選 141,570／`matched` 3,378）
不同；這裡量到的只是「同一台、同一份資料、同一個 generation 內」的命中效果，
不是正式站的絕對秒數。機器的負載也不同。
