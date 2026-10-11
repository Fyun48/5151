# 會員列表「每請求輔助查詢瘦身」（第三刀）證據包

- 日期：2026-10-11（隔離量測庫 repro，`192.168.0.220:15434`；全程唯讀，`EXPLAIN` 用交易內
  `CREATE INDEX` + `ROLLBACK`，不落地）
- 分支：`member-list-aux-query-diet`（起點 `master=b2b19eae`）
- 量測庫資料量：`listings` 184,245 列（可見 184,237）、`listing_search_projection` 184,246、
  `route_cache` 260,205、`data_revision` 2,217,745（MAX(id)=2,217,831）、`settings` 31、
  `user_listing_flags` 865、`user_events` 9,502、`listing_enrich_jobs` 11,156、`crawl_covers` 40。

---

## 0. 前提更正：四組「N+1 逐列查詢」不屬於會員列表請求路徑

planner 在正式站 180 秒窗口看到的四條高頻指紋，**不是**會員列表每請求產生的。用
`v3/scripts/member-list-sql-count.mjs`（patch `pg.Client.prototype.query`，記錄**一次
`loadListingPage()`**裡每一條 SQL 與參數）在 repro 跑 8 個會員情境，逐條數出來的結果：

| planner 窗口指紋 | 窗口次數 | **會員列表每請求次數（實測）** | 實際呼叫端（grep 回查，L-0684） |
|---|---|---|---|
| `SELECT * FROM listing_enrich_jobs WHERE post_id = $1` | 480 | **0.0** | 補欄位佇列：`v3/src/listingEnrichQueueAsync.js:424`（每列一次；一輪 60 列 ⇒ 8 輪） |
| `SELECT detail FROM user_events WHERE user_id=$1 AND post_id=$2 AND type=$3` | 507 | **0.0** | 通知入列：`v3/src/repository/notifyEnqueue.js:70`（每事件 × 每會員一次） |
| `SELECT * FROM user_listing_flags WHERE user_id = $1` | 1,100 | **3.0 → 1.0**（本包 P1） | `repository/decorationData.js:64` 的 `loadPersonalFlagMap`；list／stats 各一份 loader |
| `SELECT key, value FROM settings` | 1,846 | **1.0** | `db.js:buildListRequestContextFromPg`；其餘來自通知／排程路徑 |

算術檢查：8 個會員請求最多貢獻 `1,100 × 8/…`、`1,846 × …` 的量遠遠小於窗口值（8 個請求
若每請求 1 次 `settings` ⇒ 8 次，窗口是 1,846 次），所以窗口裡有 99% 以上來自背景迴圈
（爬蟲／補欄位／通知）。**會員列表路徑的「每請求輔助查詢」是另一組指紋**，見下節。

> 若要把窗口那四條真正瘦下來，要動的是 `listingEnrichQueueAsync.js` 與
> `repository/notifyEnqueue.js`（以 `= ANY($1::bigint[])` 一次取整批）。那條路徑會影響
> 通知與補欄位語意，且不在本次交付的 40 案例矩陣可證範圍內 ⇒ 另開一包，見 §4。

---

## 1. P1：每請求 SQL 次數前後表（8 情境平均，repro）

| SQL 指紋（正規化後前 72 字） | 前 次/請求 | 後 次/請求 | 前 ms/請求 | 後 ms/請求 |
|---|---|---|---|---|
| `SELECT route_key, distances, min_km, min_m, rush_am_min, rush_pm_min, ru` | 3.0 | 2.0 | 210.1 | 149.6 |
| `FETCH FORWARD ? FROM listing_read_5` | 3.5 | 3.5 | 199.9 | 201.5 |
| `FETCH FORWARD ? FROM listing_read_1` | 11.0 | 11.0 | 127.5 | 117.7 |
| `DECLARE listing_read_5 NO SCROLL CURSOR WITHOUT HOLD FOR SELECT post_id,` | 1.0 | 1.0 | 85.8 | 80.1 |
| `SELECT (SELECT COUNT(*) FROM listings l WHERE NOT EXISTS ( SELECT ? FROM` | 0.5 | 0.5 | 79.4 | 71.2 |
| `FETCH FORWARD ? FROM listing_read_6` | 4.4 | 4.4 | 59.9 | 46.3 |
| `FETCH FORWARD ? FROM listing_read_3` | 2.8 | 2.8 | 50.4 | 47.9 |
| `SELECT * FROM route_jobs WHERE job_key = ANY($?::text[])` | 2.0 | **1.0** | 49.1 | 45.5 |
| `SELECT SUM(CASE WHEN COALESCE(offline, ?) != ? AND COALESCE(offline_conf` | 1.0 | 1.0 | 23.5 | 24.4 |
| `FETCH FORWARD ? FROM listing_read_4` | 2.0 | 2.0 | 20.6 | 21.0 |
| `SELECT post_id FROM listing_search_projection WHERE district = ANY($?::t` | 0.5 | 0.5 | 13.5 | 13.5 |
| `SELECT * FROM listing_prep WHERE post_id = ANY($?::bigint[])` | 2.0 | 2.0 | 10.7 | 14.2 |
| `SELECT * FROM user_listing_flags WHERE user_id = $?` | 2.0 | **1.0** | 9.2 | 3.2 |
| `SELECT post_id, source, source_id, url, price, price_num, extra_fee, ext` | 1.9 | 1.9 | 8.2 | 8.0 |
| `DECLARE listing_read_4 NO SCROLL CURSOR WITHOUT HOLD FOR SELECT post_id ` | 1.0 | 1.0 | 8.0 | 7.2 |
| `SELECT user_id, key, value FROM user_settings` | 1.0 | 1.0 | 6.1 | 5.9 |
| `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY` | 1.0 | 1.0 | 6.0 | 7.3 |
| `SELECT geo_key, station, walk_km, walk_min, ride_km, ride_min, source, c` | 2.0 | **1.0** | 4.8 | 5.9 |
| `SELECT job_key FROM route_jobs WHERE job_state = ?` | 1.0 | 1.0 | 4.5 | 4.5 |
| `DECLARE listing_read_2 NO SCROLL CURSOR WITHOUT HOLD FOR SELECT post_id,` | 1.0 | 1.0 | 3.9 | 1.9 |
| `SELECT post_id, source, source_id, source_key, url, price, price_num, ex` | 1.0 | 1.0 | 3.8 | 1.3 |
| `DECLARE listing_read_6 NO SCROLL CURSOR WITHOUT HOLD FOR SELECT post_id,` | 0.4 | 0.4 | 3.2 | 3.6 |
| `SELECT COUNT(*) AS n FROM listings WHERE (fixture_namespace IS NULL OR f` | 0.1 | 0.1 | 2.8 | 4.1 |
| `SELECT to_regclass(?) IS NOT NULL AS has_table` | 5.0 | 5.0 | 2.7 | 2.4 |
| **合計** | **78.1** | **74.1** | | |

- 移除的 4 條＝**每個請求固定少 4 個往返**：`route_cache` 3→2、`route_jobs(ANY)` 2→1、
  `user_listing_flags` 2→1、`mrt_cache` 2→1。
- 原因：一個請求原本有**兩個**裝飾資料載入器（list 管線一個、stats 管線一個），
  而且 `routeCacheMap`／`mrtCacheMap`／`routeJobsMap` 以「整組 key」當 memo key ⇒
  頁面階段（數十個 key，通常是候選階段的子集）又各查一次。改成
  **一個請求一個 loader ＋ 以 key 為單位的快取**（`rowsByKeys`），子集情境零查詢。
- 每請求省下約 **65 ms**（`route_cache` 60 ms ＋ `route_jobs` 4 ms ＋ `flags` 6 ms ＋ `mrt` 0 ms）；
  正式站的 key 集合更大（近萬個 route key），實際省下的比例會更高。
- 逐字等價：`member-list-sql-count.mjs --compare` 證明 8 情境的 `totalMatched`、第一頁
  `post_id` 序列、payload 頂層欄位集合、`timing` 欄位集合全部相同（`identical: true`）。
- 沒動的東西（量了但決定不動）：`MAX(id) FROM data_revision` ×5 ＋ `to_regclass` ×5
  每請求共 10 個往返，合計約 **2.7 ms** ⇒ 效益不足以承擔跨模組的請求脈絡改裝。

---

## 2. P2：四條每請求全域統計的 `EXPLAIN (ANALYZE, BUFFERS)` 與選路

量測腳本：`v3/scripts/member-list-aux-explain.mjs`（`--json` 存證；比照請求內的讀取快照
下 `SET jit = off`——**這一點是關鍵**：Celeron 上 JIT 編譯本身就要 0.7–0.9 秒，
忘記關掉 JIT 會量到 873 ms 而不是真正的 20 ms）。

### 2.1 現況（repro 暖快取、jit off、真實請求參數）

| # | 查詢 | repro 計畫 | repro 實測 | 正式站（planner） |
|---|---|---|---|---|
| 1 | `SUM(CASE …) pending/confirmed` | `Bitmap Heap Scan` ← `BitmapAnd(idx_listings_offline_counts, BitmapOr(idx_listings_search, idx_listings_self))` | **15.4 ms**（hit=2242） | 425 ms |
| 2 | `COUNT(*) listings WHERE <isolation>` | `Parallel Index Only Scan using idx_listings_fixture_namespace`（已是最佳形狀） | **34.7 ms** | 274 ms |
| 3 | `SELECT DISTINCT search_key FROM listings` | `Unique` ← `Parallel Index Only Scan using idx_listings_search`，回 38 列 | **51.7 ms** | 252 ms |
| 4 | 投影兩項證明 `missing + mismatched` | ① `Parallel Hash Anti Join`（`Index Only Scan listings_pkey` × `Seq Scan listing_search_projection`）② `Parallel Hash Join`（`Seq Scan projection` × `Bitmap Heap Scan listings` via `idx_listings_district_prefix_pg`） | **120 ms**（missing 81 ＋ mismatched 48） | 533 ms |

### 2.2 逐條選路理由

**(1) status counts ⇒ (b) 新部分索引（已隨本 PR 附 `v3/migrations/005_…sql`）**
`idx_listings_offline_counts` 的選擇率估計與實際差 87 倍（估計 183,308、實際 2,109），
planner 因此多開一顆 1.8 MB／184,460 個 TID 的 `idx_listings_search` 來 BitmapAnd。
新索引把「offline <> 0」這 2,109 列單獨索引起來，實測（`member-list-aux-index-probe.mjs`，
同一支腳本可重跑，交易內建索引後 ROLLBACK）：

| 候選 | repro 實測 |
|---|---|
| ① 現況 | 15.4 ms（hit=2242，BitmapAnd） |
| ② 部分索引 `(search_key) WHERE COALESCE(offline,0)<>0` | 4.7–7.4 ms |
| ③ 部分覆蓋索引 `(search_key, source, self_status, self_expires_at, fixture_namespace, offline_confirmed) WHERE COALESCE(offline,0)<>0` | **4.6–4.8 ms（選它）** |

索引只涵蓋 2,109 列（`pg_stats`：offline=1 的頻率 1.18%），大小約數百 KB，寫入放大可忽略。

**(2) product count ⇒ 不改：(c) 實作後撤回（被既有不變量擋住）**
`EXPLAIN` 顯示它**已經**是 `Parallel Index Only Scan`（35 ms），沒有更好的索引可加；換句話說
正式站的 274 ms 不是計畫問題，而是**快取失效**問題：這條查詢靠 `data_revision.MAX(id)` 版本化，
而正式庫的爬蟲持續寫入 ⇒ 版本每個請求都在前進 ⇒ 版本化快取等於完全失效。

(c)「≤60 秒 TTL」在**合法性**上站得住（逐條）：`dbTotal` 不是 `totalMatched`（`stats.total`
由完整候選集合算出）；前端只把它當**非 0 的布林訊號**（`v3/public/index.html:8081` 的
`st.dbTotal > 0` 決定空清單文案），不是顯示數字。**但實作後整套測試出現紅燈**：

```
not ok 2348 - 同一個 data_revision 只 COUNT 一次，換代後重算
   （v3/test/listing-stats-product-count.test.js:61）
   assert.equal(countQueries(), 2, "revision 換代就必須重算");
```

正式庫的爬蟲讓 revision **每個請求都在前進** ⇒ 任何 TTL 都必然違反「換代就必須重算」。
放寬這條既有契約是產品決策（會讓 `dbTotal` 最多落後 60 秒），不是實作細節，
所以**程式改動已撤回**，只留註解說明，交由 planner 裁決（§4 待裁決點 2）。
：撤回後 repro 的 `COUNT(*) … fixture_namespace` 仍是 0.1 次/請求（量測庫 revision 不變 ⇒ 原本就命中）。

**(3) `DISTINCT search_key` ⇒ 不改**
它已是 index-only（`idx_listings_search` ＋ `Unique`，38 列）。`crawl_covers` **不能取代**：
covers 是「這一輪想抓哪些 URL」，不是「資料庫裡已存在哪些 search_key」，
而且 `expandSearchKeysAgainst()` 會用 `sameSearch()` 把**會員沒要求**但語意相同的 search_key
加進來（這是加列，不是減列）⇒ 拿掉會改變 `searchWhere` 的述詞。
TTL 也不可行：這份 key 清單直接進 `searchWhere` ⇒ **會影響 `totalMatched`**，違反不變量。

**(4) 投影兩項證明 ⇒ 不改，附設計建議**
兩條腿都已經吃到覆蓋索引：`missing` 走 `Index Only Scan listings_pkey`，
`mismatched` 走 `idx_listings_district_prefix_pg`。殘餘成本是 71 MB 的
`listing_search_projection` 全掃（兩條腿各一次）。試過的改寫都沒有變快：

| 候選 | repro 實測 |
|---|---|
| `mismatched` 現況（投影側驅動） | 48.5 ms |
| `mismatched` 改成 listings 側 JOIN 驅動 | 49.8 ms |
| 只數「前綴相符的 listings 列」（下界參考） | 6.1 ms |

TTL 不可行（這條查詢保護的是候選範圍 ⇒ 直接影響 `totalMatched`）。
**設計建議（另開一包）**：投影 refresh 完成時，把「這次覆蓋到的 `data_revision.id`」寫進
`settings`／投影中繼表；請求端只要比對版本號（O(1)）就不必每次重跑 120 ms 的證明。

**(a) 合併成一次掃描 ⇒ 實測更慢，否決**
把「產品總數」與「DISTINCT search_key」合成一句多聚合查詢：**112 ms**，
而分開跑是 34.7 ＋ 51.7 ＝ 86.4 ms（兩者用不同索引，合併後被迫共用一個掃描節點）。
`status counts` 的述詞是 baseClauses（`search_key IN …`），與 `isolation` 的
`fixture_namespace` 述詞不同集合，合併只會退化成全表掃描。

---

## 3. 等價性證據（40 案例矩陣 ＋ SQL 計數）

```
node v3/scripts/member-list-parity-matrix.mjs --label after  --out matrix-after.json     # 改動後
node v3/scripts/member-list-parity-matrix.mjs --label before --out matrix-before.json    # 改動前（stash src）
node v3/scripts/member-list-parity-matrix.mjs --compare matrix-before.json matrix-after.json
```
輸出：
```json
{ "cases": 40, "compared": 40, "identical": true, "distinctTotalMatched": 21, "failures": [] }
```

```
node v3/scripts/member-list-sql-count.mjs --compare sql-count-before.json sql-count-after.json
```
輸出：
```json
{ "scenarios": 8, "identical": true, "failures": [],
  "queriesBefore": 634, "queriesAfter": 602, "savedPerScenario": 4 }
```

---

## 4. 回報：套正式庫後該用窗口驗的具體預期

前提：`v3/migrations/005_member_listing_aux_indexes.sql` 由 planner 手動套用（`CONCURRENTLY`，
套完檢查 `indisvalid = true`），程式改動部署後才有效。

| 指紋 | 現在（planner 窗口，8 請求） | 套用後預期 | 判準 |
|---|---|---|---|
| `SUM(CASE WHEN COALESCE(offline…` | 8 次 × 425 ms ＝ 3,404 ms | 次數**不變**，每次 **≤150 ms**（repro 3.3x；正式站含 IO，保守抓 3 倍） | 窗口增量 ≤1,200 ms |
| `…COUNT(*) … (fixture_namespace IS NULL OR …` | 8 次 × 274 ms ＝ 2,193 ms | **不變**（(c) 撤回，見 §2.2(2)） | — |
| `SELECT DISTINCT search_key FROM listings` | 8 次 × 252 ms | 不變（本次不動） | — |
| `SELECT (SELECT COUNT(*) … NOT EXISTS …` | 8 次 × 533 ms | 不變（本次不動） | — |
| 會員列表請求的 SQL 條數 | 78.1 條/請求 | **74.1 條/請求**（−4） | `member-list-sql-count.mjs` 前後比對 |
| 窗口 SQL 總增量 | 42,453 ms | 預期 **≈ 40,250 ms**（−2,200 ms，約 −5%） | 端對端中位數應略低於 5,033 ms |

**感知層面的預期要說清楚**：本次只解掉窗口總量的約 5%（唯一可安全動的是 status counts）。
真正的大頭是 `NOT EXISTS` 證明（533 ms × 8）、`SUM(CASE)`（425 ms × 8，已解 3 倍）、
`DISTINCT search_key`（252 ms × 8）與 `COUNT(*)`（274 ms × 8）；後兩者與證明都被不變量擋住。
另外 4 條指紋（合計 +10,518 ms ≈ 25%）在背景路徑（§0），要另開一包處理。

### 需要裁決（≤2 點）

1. **§0 的四組背景 N+1** 要不要另開一包（`listingEnrichQueueAsync.js` 的
   `enrichJobByPostIdQuery`、`repository/notifyEnqueue.js` 的三條去重讀取）？
   這兩處改集合式查詢可消掉窗口約 10,518 ms 的 25%，但不在會員列表的 40 案例矩陣可證範圍，
   需要各自的等價測試。
2. **`dbTotal` 的版本化契約要不要放寬成「≤60 秒 TTL」**？(c) 的合法性論證見 §2.2(2)（不是
   `totalMatched`、前端只當布林訊號），但會讓 `v3/test/listing-stats-product-count.test.js:61`
   的「revision 換代就必須重算」失效，正式庫的爬蟲讓 revision 每請求前進 ⇒ 這是唯一能讓
   這條 274 ms 查詢降到「每 60 秒一次」的方法。放了就同時要改那條測試的斷言。

---

## 5. CI 證據（`gh run list --json`，**非空**才算綠）

節錄 `ci-runs.json`（本檔旁邊，完整 JSON）：

| run id | workflow | status | conclusion | head |
|---|---|---|---|---|
| 38159380549 | Tests | completed | **success** | `189d1c3e` |
| 38159380472 | Code review (advisory) | completed | success | `189d1c3e` |
| 38158310357 | Tests | completed | **success** | `eadd36f4` |

⚠️ 自我指涉說明：記錄 CI 的那個 commit 本身沒辦法被它自己的 CI 記錄在內（推上去才會產生 run）。
上表的 `189d1c3e` 是「只差本 README 文字」的那一棵樹；最終 head 的 `Tests` run 也會是 success
（同一份 `v3/src`／`v3/test`／`v3/migrations`）。要重新確認就對 PR head 重跑：

```
gh run list --repo Fyun48/5151 --branch member-list-aux-query-diet \
  --json databaseId,name,status,conclusion,headSha \
  -q '.[] | "\(.databaseId) \(.name) \(.status) \(.conclusion) \(.headSha[0:8])"'
```

`Tests` 這個 workflow 的兩個 job 都是 success：

```
Run Tests                      | completed | success
Run Tests (PostgreSQL integration) | completed | success
```

本機驗證（同一棵樹，`eadd36f4`）：

```
npm test        ⇒ # tests 4021 / # pass 3905 / # fail 0 / # skipped 116（含本包新增的 6 條離線測試）
mutation-check  ⇒ 共 16 條變異：KILLED 16、SURVIVED 0、SKIP 0
40 案例矩陣      ⇒ {"cases":40,"compared":40,"identical":true,"distinctTotalMatched":21,"failures":[]}
SQL 計數        ⇒ {"scenarios":8,"identical":true,"queriesBefore":634,"queriesAfter":602,"savedPerScenario":4}
```
