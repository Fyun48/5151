# 會員列表「一趟掃描」（A 方案）證據包（2026-10-11 第二輪）

隔離量測庫：`postgres/5151-live-repro.env` 的 `PG_LIVE_REPRO_URL`（`192.168.0.220:15434/repro`）。
改動前＝`origin/master`（`ced3fc09`）的 `MEMBER_LIST_ONEPASS=0`（＝原本兩趟），
改動後＝本分支預設（共趟）。**同一支腳本、同一輪交錯量測。**

---

## 1. 生產窗口榜首那條 2.69s 查詢的歸屬（項目 1 的結論）

**不是會員列表路徑發的，也不是 #714 的窄載體被發了兩次。**

| 證據 | 內容 |
|---|---|
| SQL 指紋 | `db.js:5209 geo591ScanQuery()`：`SELECT post_id, community_id, source_key, lat, lng, geo_source FROM listings WHERE IFNULL(hidden,0)=0 AND IFNULL(offline,0)=0 AND <591 source> ORDER BY <watched first>, last_seen_at DESC`。全 repo `grep -rn "community_id, source_key" v3/src` 只有這一個產生點 |
| 會員列表頁的完整 SQL log | 在 repro 上 patch `pg.Client.prototype.query` 逐條記下**一次 `loadListingPage`（allkeys、預設）**的 115 條 SQL：**6 欄 geo 掃描出現 0 次**。頁面實際送的是 `listing_read_1`（候選內容版本預讀，10,373 列）、`listing_read_2`（**42 欄窄載體，只有一次**）、`listing_read_7`（list 的 `SELECT post_id …`，10,114 列） |
| 唯一呼叫鏈 | `needing591GeoAsync`（crawlerReads.js:193）→ `select591GeoCandidates` → `geo591ScanQuery`；`backfillListingCoords`（watcher.js:1332）← `queueGeoBackfill`（server.js:4477）← `/api/listings/:id/flags`（POST）／`/api/commute/focus`／`/api/settings`／admin maps／watcher 輪次／startup。`GET /api/listings` 的手把只有 `loadListingPage(args)` |
| 直接復現 | patch pool 後呼叫 `needing591GeoAsync({limit:20})`，記錄出現 `POOL:: SELECT post_id, community_id, source_key, lat, lng, geo_source FROM listings …` |
| 成本來源 | **SQL 沒有 LIMIT**：repro 實測 1,275–1,393ms／每次回 157,627 列，計畫 `Sort … external merge Disk: 19016kB`，只為了在 Node 端挑 20 筆。正式站 2,686ms × 15／180s ＝ +40,296ms（31% 窗口 SQL 時間） |

因此 **A 方案不會動到那條 2.69s**；它是外部抓取／補定位路徑（紅線：不准動），
只放進 runbook 當選項（`docs/runbooks/member-listing-onepass-and-window-queries.md` §3）。

另外回答「窄載體是不是被發了兩次」：**沒有**。42 欄窄載體每請求只有一次（`listing_read_2`）；
第二次掃描是 list 自己的 **id-only**（`listing_read_7`，1 欄）。A 方案拿掉的就是這一趟。

## 2. 三向等價（項目 2 的斷言）

`node v3/scripts/member-list-parity-matrix.mjs --three-way --out …`（40 案例）
對**每個案例**分別用三種方式算一次：

1. `list-only`：只跑 list 管線（沒有 stats 的 `reusableCandidates`，自己下候選查詢）
2. `stats-only`：只跑 stats 管線（自己掃自己的範圍）
3. `one-pass`：共趟（`MEMBER_LIST_ONEPASS=1` 的完整頁面）

逐案例比對三件事：**`totalMatched`**、**stats 的 16 個 bucket**（`unseen`／`watched`／
`same_source`／`hidden`／`offline`／`offlineConfirmed`／`suspected`／`suspectedPending`／
`elevator`／`stored`／`filteredOut`／`missingGeo`／`missingRoute`／`dbTotal`／`total`／
`watchedTotal`）、**第一頁 post_id 序列**。

結果（`matrix-onepass-3way.json`）：

```
cases 40  threeWay true  distinctTotalMatched 21  → 全部相同，0 個 failure
```

（任何一項不同，腳本會直接 throw 並列出案例與差異。）

## 3. 效能（5 輪交錯 median，`limit=80`、allkeys、uid 1）

| | wall | FETCH 趟數／時間 | list | stats |
|---|---|---|---|---|
| 兩趟（`MEMBER_LIST_ONEPASS=0`） | 1677ms | 25 趟／438ms | 1198ms | 539ms |
| 共趟（預設） | 1678ms | **20 趟／391ms** | 702ms | 942ms |

`member-list-benchmark.mjs`（`RUNS=3 BENCH_ALL_KEYS=1`，2 輪交錯取中位數）的總時間
（cold+warm、5 情境合計）：**12,921ms → 12,969ms（+0.4%）⇒ 打平**。

**兩個 mode 的 `list`／`stats` 不可直接比**：共趟掃描與 list 的 prepare 都跑在
`statsPrepareMs` 之內，時間從 `list;dur` 移到 `stats;dur`（相加才是可比的總量）。
要判斷快慢請看 `total_ms` 或正式站窗口增量。

**為什麼打平**：共趟要多讀 740 列（list 的關係閉包把跨行政區的同戶／配對分量拉進 union，
10,373 → 11,113 列）並對每列多算兩次述詞；被拿掉的 id-only 掃描只有 1 欄。
若沒有把旗標掛進**版本預讀**（`pgCandidateContent` 的 `extraColumns`），共趟還會失去
內容備忘而**反而慢 ~110ms**（FETCH 25 → 39 趟）——這一版已經處理。

## 4. 重跑指令

```bash
set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
export PG_URL="$PG_LIVE_REPRO_URL" MEMBER_UID=1

# 三向等價（40 案例）
node v3/scripts/member-list-parity-matrix.mjs --three-way \
  --out v3/evidence/member-list-onepass/matrix-onepass-3way.json

# 效能：兩趟 vs 共趟（交錯）
MEMBER_LIST_ONEPASS=0 node v3/scripts/member-list-benchmark.mjs
MEMBER_LIST_ONEPASS=1 node v3/scripts/member-list-benchmark.mjs

# 回退（一行，不需要改程式）
MEMBER_LIST_ONEPASS=0
```
