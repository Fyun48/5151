# 會員列表第二刀：`stats` 與 `prepare`（2026-10-11）

隔離量測庫：`postgres/5151-live-repro.env` 的 `PG_LIVE_REPRO_URL`（`192.168.0.220:15434/repro`）。
**不是** `5151_shadow`、**不是** `192.168.0.220:15432`、**不是**正式庫。全部唯讀（除了把 `004` 的
三顆索引套上去量測）。

改動前＝`27bc6f8`（`origin/master`，已含 #714），以 `git worktree` 檢出到
`/home/cline/lab/5151-stats-before`；改動後＝本分支。**兩邊跑同一支腳本**。

---

## 1. 逐情境 A/B（同一支 `member-list-benchmark.mjs`，3 輪交錯取中位數）

量測方式（避免兩次相隔很久的取樣被 NAS 負載差污染）：每一輪
**先切回 before（DROP 三顆索引）跑一次 → 再套上 `004`（CREATE ＋ ANALYZE）跑一次**，共 3 輪。
原始輸出：`bench-before-{1,2,3}.txt`、`bench-after-{1,2,3}.txt`（本目錄）。

```bash
set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
export PG_URL="$PG_LIVE_REPRO_URL" MEMBER_UID=1 RUNS=3 BENCH_ALL_KEYS=1
node v3/scripts/member-list-benchmark.mjs        # after（索引已套）
# before：cd /home/cline/lab/5151-stats-before && node v3/scripts/member-list-benchmark.mjs
```

| 情境 | stats 冷 | stats 暖 | **prepare 冷** | **prepare 暖** | list 暖 |
|---|---|---|---|---|---|
| 預設 | 1339 → 1289 | 521 → 535 | **747 → 410** | **495 → 333** | 1401 → 1239 |
| 中山區 | 514 → 478 | 533 → 533 | **692 → 390** | **447 → 282** | 1136 → 945 |
| rent 3000-8000 | 265 → 246 | 262 → 263 | **491 → 282** | **504 → 268** | 906 → 683 |
| q=新莊 | 522 → 619 | 507 → 533 | **505 → 358** | **505 → 334** | 781 → 655 |
| 多條件 | 475 → 585 | 553 → 606 | **447 → 349** | **487 → 317** | 690 → 487 |

（單位 ms。`stats 暖` 是 `warm_all_stats_ms` 的中位數；`stats 冷`／`prepare` 取該輪的 cold／warm 欄位。）

**結論**：

* `prepare`：**5 個情境全部達標**（門檻 0.4s）。暖 268–334ms（改前 447–505），冷 282–410ms
  （改前 447–747）。唯一略高的是預設情境的冷 410ms（首呼 JIT／page cache 效應）。
* `stats`：**暖 535ms ≤ 0.6s 達標**（改前 521，量測噪聲 ±30ms ⇒ 這一刀對 stats 沒有可辨識的改善）。
  **冷（首呼）1289ms 未達標**——原因見 §3，我沒有做到，不宣稱。

## 2. `prepare` 為什麼會降（成分量測，不是推論）

`prepare` 的成本幾乎全在 `districtClosureIds`；它的第一個述詞是行政區前綴的
**全表掃描**，而 PG 端一直沒有 SQLite 早就有的那顆索引（`listDistrictSql.js` 的
`ensureDistrictCandidateIndex`）。

| 查詢 | 改前 |
|---|---|
| `prefix IN (allowed) OR prefix NOT IN (allKeys)`（單一述詞） | 253–284ms（Seq Scan on listings） |
| 拆開：`prefix = ANY(allowed)` | 16.6ms（Bitmap Index Scan，1296 kB） |
| 拆開：`NOT (prefix = ANY(allKeys))` | 4.5ms（Index Scan，部分索引 56 kB，5,659 列） |

實際量到的 closure 總時間（同一支探針、同一份資料）：

| 行政區組合 | 改前 | 改後 |
|---|---|---|
| 會員 7 區 | 603ms | 305ms |
| 中山區 | 481ms | 278ms |
| 中山＋大安 | 440ms | 245ms |
| 松山＋信義 | 394ms | 172ms |
| 三重區 | 541ms | 179ms |

三顆索引的效應（`indisvalid=true` 已驗證）：`idx_listings_district_prefix_pg`（1296 kB）、
`idx_listings_unknown_district_prefix_pg`（56 kB）、`idx_route_jobs_failed`（40 kB）。
`route_jobs` 那個讀取（`stats` 的 auxiliary）29–51ms → 12–18ms。

## 3. 沒做到的部分（明確列出）

1. **`stats` 的第二次掃描沒有拿掉。** 目前 `computeListingPage` 是「stats 先掃一份寬候選
   → list 用它當 `reusableCandidates`，再自己下一次 id-only 查詢」。要真正變一趟，必須讓
   stats 的掃描**同時帶回 list 範圍的旗標**（`SELECT …, (list_extra_pred) AS list_scope
   FROM listings WHERE (stats_where) OR (list_where)`），而這需要把 list 的
   `buildListListingsClauses`（含 `districtRelatedIds`／`districtProjectedIds`）**提到掃描之前**
   ——`districtClosureIds` 目前是在 `searchListingsNodePgInner` 掃描之後才算的，等於要把
   閉包與預篩整段搬到頁面層。這一包沒有動它（改動面大、風險高），
   因此 `list;dur` 裡的 `cand`（正式站 0.27–0.60s、repro 暖 ~180–240ms）**還在**。
2. **`stats` 的冷啟（首呼）1290ms 仍超過 0.6s。** 成分：`district_ms` 217–265ms
   （投影完整度驗證的第一呼成本）＋ `candidates_ms` 484–693ms（10,373 列寬載體的第一呼）
   ＋ provider／reduce 的 JIT 暖機（各多 60–120ms）。這些是首呼效應，不是可移除的計算量；
   在正式的長駐 process 上對應的是「revision 一直前進 ⇒ 版本化快取永遠不命中」，
   我沒有動 `memberListingCachePg.js` 或任何快取（紅線 2）。
3. **`route_cache` 的 20k 鍵查詢沒有動。** 它是 `route_cache` 的整表 seq scan（48.9ms 執行
   ＋ Node 端 20,746 個 `makeRouteKey`），表上已有 `route_cache_pkey(route_key)`，
   planner 在 20,000 個 `= ANY` 參數下仍選 seq scan（索引探測更貴）。
   `stats.provider_ms` 暖 181–205ms 就卡在這裡。

## 4. 輸出契約

* `payload` 頂層欄位集合、`timing` 欄位集合**逐字不變**（`matrix-{before,after}.json` 逐案例記錄、
  `--compare` 逐案例比對；`v3/test/listing-server-timing.test.js` 另有固定常數斷言）。
* 階段計時只出現在 `timing.stages`／`timing.stats_stages`（#714 既有）與 `Server-Timing` header；
  matrix 每個案例都會檢查 payload 其餘部分不含階段鍵名。

## 5. 矩陣（≥24 案例）

`matrix-before.json` / `matrix-after.json`（5 組會員設定 × 8 組 districts／filter／kind／sameHouse
＝ **40 案例**），比對結果 `matrix-compare.json`：

```json
{ "cases": 40, "compared": 40, "identical": true, "distinctTotalMatched": 21, "failures": [] }
```

`distinctTotalMatched = 21`（> 1）證明矩陣真的在篩選、不是空集合假通過；
`compared = 40 > 0` 證明比對的案例數不是 0。

```bash
node v3/scripts/member-list-parity-matrix.mjs \
  --compare v3/evidence/member-list-stats-prepare/matrix-before.json \
            v3/evidence/member-list-stats-prepare/matrix-after.json
```
