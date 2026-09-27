# 上線後 crawler 停擺：根因鑑定（2026-09-26）

> 本文件只寫**我自己實測**到的結論。凡引用他人留下的說法，一律標明來源，並與我的量測分開。
> 撰寫者：DeepSeek Harness（DSH）。Owner 質疑過第 2 點的出處，因此本文逐條附出處。

## 零、2026-09-27 00:35Z 第二次上線：**修正了 reconcile 查詢，首次檢查仍然失敗**

Owner 核准「先送 A」後，修正版（master `bd10d885`、image digest `sha256:a6b94ce2…`）
已完成 build / predeploy / deploy，但：

- 部署後首次檢查**仍然失敗**，簽章與上次一模一樣：
  ```
  00:34:51  容器啟動
  00:35:11  第一次檢查：19 組覆蓋條件
  00:35:22  居住數據自動更新：6 筆          ← 期間有寫入成功
  00:35:41  第一次檢查失敗： Connection terminated unexpectedly
  ```
- **00:35:11 → 00:35:41 正好 30 秒。**
- `listings.last_seen_at` 停在 `00:34:31`（＝舊容器最後一次寫入），新版上線後**沒有寫入任何房源**。
- 已於 00:37Z 回滾至 `9c6b7b04`；回滾後 `max(last_seen_at)` 與 `now()` 只差 **0.5 秒**，crawling 立即恢復。

### 新找到的關鍵事實：HAProxy 有 30 秒逾時

`5151-haproxy`（`haproxy:2.9-alpine`，CasaOS）設定：

```
timeout connect 5s
timeout client  30s
timeout server  30s
backend pg_primary
    server pg-b 192.168.0.220:15432 check inter 3s fall 3 rise 2
    server pg-a 192.168.0.140:15432 check inter 3s fall 3 rise 2 backup
```

**App → HAProxy(`192.168.0.140:25433`) → PG primary。** 這兩個 30 秒是**閒置逾時**：

- `timeout server 30s`：PG 端 30 秒沒有吐出任何資料 → HAProxy 切斷連線。
- `timeout client 30s`：App 端 30 秒沒有送出任何資料 → HAProxy 切斷連線。

`Connection terminated unexpectedly` 正是 node-postgres 在「連線已被對方關掉、但自己不知道」
時丟出的訊息（`node_modules/pg/lib/client.js:204`）。

**因此這個錯誤的本質是「逾時」，不是崩潰。** 但**我還沒有證明**是哪一邊、以及是哪個操作造成：

- 假設 (a)：首次檢查裡有一個查詢本身跑超過 30 秒（`timeout server`）。
- 假設 (b)：連線閒置超過 30 秒（App 在做不碰 DB 的長工作），之後再拿同一條連線用（`timeout client`）。

我唯一一次 `pg_stat_activity` 快照（失敗後約 2 分鐘）看到的是**全部 idle、沒有任何長查詢**，
所以那次快照**不足以區分 (a) 與 (b)**，兩者都還沒有被證實。

### 為什麼重點變了

我先前把停擺歸因於 reconcile 的 127k 全表掃描（993 次／5 分鐘）。那**確實是一個真問題**
（已修、已建索引、已用 EXPLAIN 證明），但**它顯然不是首次檢查失敗的原因**——
修正後首次檢查依然在 30 秒失敗。所以：

- **已經修好的**：reconcile 候選查詢的全表掃描（300ms → 36ms，BitmapOr 生效）。
- **還沒找到的**：首次檢查中超過 30 秒（或造成連線閒置超過 30 秒）的那個操作。
  這才是 crawler 起不來的直接原因。

### 另一個必須修的觀察性缺口

`v3/src/server.js:3591` 的常規迴圈是：

```js
timer = setInterval(() => { tick("schedule").catch(() => {}); }, 60 * 1000);
```

**錯誤被 `.catch(() => {})` 完全吞掉。** 所以 `tick("schedule")` 每 60 秒失敗一次也不會留下
任何日誌——這正是上一次能夠安靜地死 5 小時、而我在日誌裡只看到一行啟動失敗的原因。
`startStartupWork()`（`server.js:4302`）也是一次性嘗試，失敗只 `console.warn`，不重試。

## 一、結論（先講）

失敗版本（PR #497 + #501，image digest `sha256:913da82c…`）上線後，crawler 的
「第一次檢查」在 **container 重啟後可 100% 重現**地失敗，且 ~5 小時無任何房源更新。

根因是**單一查詢**：同屋重複評估（same-house reconcile）的候選查詢，在 PostgreSQL 上
**每次執行都是 127k 筆全表掃描（約 300ms）**，而它被放在 crawler 的**逐筆熱路徑**上。
crawler 的每一個 tick 幾乎全被這個查詢吃掉，週期永遠跑不完 → 看起來像「crawler 壞掉」。

> ⚠️ 上面這段是 2026-09-27 00:35Z 第二次上線**之前**寫的。第二次上線證明它**不足以解釋**
> 首次檢查失敗（見第零節）：reconcile 全表掃描是真的、已修好，但它不是 crawler 起不來的
> 直接原因。請以第零節為準。


**這是我自己的量測，不是 astra6 的殘留資料。**

## 二、證據鏈（全部為 DSH 實測）

### 2.1 生產 DB 的索引現況（本次新查出，最關鍵）

在生產 primary（Synology `5151-postgres-B`）對 `public.listings` 查 `pg_indexes`：

| indexname | 定義 |
|---|---|
| `listings_pkey` | UNIQUE btree (`post_id`) |
| `idx_listings_match_verdict` | btree (`match_verdict`) |
| `idx_listings_offline_state` | btree (`offline`, `offline_confirmed`) |

**只有這 3 個。** `address`、`community_name`、`lat`、`lng`、`last_seen_at`、`fixture_namespace`
**全部沒有索引**。所以候選查詢必然是全表掃描。

### 2.2 查詢形狀：三個 OR 分支全部無法走索引

`v3/src/sameHouseReconcile.js:89` `blockMatchCandidatesQuery()` 產生的 SQL（PG 方言）為：

```sql
SELECT * FROM listings
 WHERE post_id != $1
   AND ( (replace(replace(COALESCE(address,''),' ',''),'-','') LIKE '%'||$2||'%')   -- (a)
      OR (replace(COALESCE(community_name,''),' ','') = $3)                        -- (b)
      OR (lat IS NOT NULL AND lng IS NOT NULL
          AND ABS(lat - $4) < 0.002 AND ABS(lng - $5) < 0.002) )                   -- (c)
   AND (fixture_namespace IS NULL OR fixture_namespace = '')
   AND (COALESCE(address,'') LIKE '%'||$6||'%')                                    -- (d)
 ORDER BY COALESCE(offline,0) DESC, last_seen_at DESC
 LIMIT 80
```

無法索引的原因，逐條：
- (a) 欄位被 `replace()` 包住 ＋ `LIKE '%…%'` 前導萬用字元 → btree 完全無用。
- (b) 欄位被 `replace()` 包住 → btree 無法匹配。
- (c) `ABS(欄位 - 值)` 是對欄位做運算 → btree 無法匹配（且 lat/lng 本來也沒索引）。
- (d) 也是前導萬用字元，且它是 AND 條件，只能當過濾器。

### 2.3 執行頻率與耗時（隔離 PG 實測）

以隔離 PG（`prb-repro2-pg`，port 15434，還原 126,994 筆 listings，`log_statement=all`）
搭配失敗版本程式碼實跑，5 分鐘內該查詢執行 **993 次（≈3.31 次/秒）**，
每次約 300ms。以 127k 筆估算，跑完一輪要 **11 小時以上**。

### 2.4 呼叫路徑：它在熱路徑上，不是背景批次

- `v3/src/watcher.js:293`：
  `await reconcileListingByIdAsync(listing.post_id, { reason: "detail_enrichment" })`
  → **每一筆完成明細增強的房源都會執行一次候選查詢。**
- `v3/src/listingMatchAsync.js:66` 產生上述 SQL 並打到 PG。
- 對照：`runSameHouseBackfill()`（`db.js:7810`）是**同步路徑**、且只由
  admin `POST /api/admin/same-house/reconcile` 觸發，`RECONCILE_BATCH = 50`
  （`sameHouseReconcile.js:28`），**不是**生產上每 60 秒批次 50 筆的自動流程。

因此 3.3 次/秒的來源是 **watcher 逐筆熱路徑**，不是 backfill。這一點推翻了我自己先前的猜測。

### 2.5 對照組：回滾後立刻恢復

回滾至 `9c6b7b04` 後，crawling 立即恢復：`listings.last_seen_at` 由卡住的
`18:29:45Z` 前進到 `23:39:54Z`，`touched_since_deploy` 由 189 → 750。

## 三、被推翻的假設（避免重複浪費）

| 假設 | 出處 | 我的實測結果 |
|---|---|---|
| 巢狀交易（nested transaction）造成 | DSH 初判 | **不成立**。`reconcileListingByIdAsync` 在 `withPgCrawlOwner` 內對真 PG 執行正常。 |
| PG 32,767 參數上限導致 `08P01` | **astra6 留下的註記**（非我實測） | **不成立**。失敗版本整個時間窗的 PG log 中，`08P01`／`bind message`／`parameter formats` 出現 **0 次**。 |
| `Connection terminated unexpectedly` 是根因 | DSH 初判 | **未證實**。來源是 node-postgres `node_modules/pg/lib/client.js:204`，我**沒有**重現出這個錯誤本身。它可能是症狀（連線被長時間占用／逾時）而非原因。 |

## 四、修法

Owner 於 2026-09-26 決定 **A＋B 一起做**，並接受 B 的語意（只在 address／community_name／
lat／lng 真的變動時才重算 blocking）。

### 選項 A：讓查詢可用索引（治本）—— **程式已完成、索引已套用生產、待部署**

已完成：
1. `ABS(lat - ?) < 0.002` 改寫為等價的嚴格範圍條件
   `lat > ? AND lat < ? AND lng > ? AND lng < ?`（`ABS(x-L) < T ⟺ L-T < x < L+T`，兩邊皆嚴格；容差 0.002 不變）。
2. `v3/migrations/002_pg_reconcile_indexes.sql`：`pg_trgm` ＋ 三個索引。
3. 已套用至生產 primary（`5151-postgres-B` / `5151_shadow`），`CREATE INDEX CONCURRENTLY`
   未阻擋 crawler 寫入，之後 `ANALYZE listings`。

**實測證據**（`EXPLAIN (ANALYZE, BUFFERS)`，真實 127k 筆資料）：

```
BitmapOr
  ->  Bitmap Index Scan on idx_listings_addr_norm_trgm   (rows=1453)
  ->  Bitmap Index Scan on idx_listings_community_norm   (rows=19)
  ->  Bitmap Index Scan on idx_listings_lat_lng          (rows=18)
```

- **沒有 `Seq Scan on listings`**；三個分支都走索引 → `BitmapOr` 成立。
- 計畫會使用這些索引，**同時證明它們有效**（PostgreSQL 絕不使用 INVALID 索引）。
- 耗時 **300ms → 36ms（暖快取）**；索引大小 trgm 11MB、community 1888kB、lat/lng 3440kB。
- ⚠️ 目前**部署中的程式仍是回滾版 `9c6b7b04`，還不會用到這些索引**。
- ⚠️ `CREATE INDEX CONCURRENTLY` 若失敗會留下 **INVALID 索引**，而 `IF NOT EXISTS` 之後
  不會重建它（名字已佔用）。驗證必須看 `indisvalid`，不能只看 `pg_indexes`；有 INVALID 要先 DROP。

**未完成**：36ms/次仍不算便宜，且尚未部署。

### 選項 B：降到不需要索引（純程式）—— **尚未實作**

只在 address／community_name／lat／lng 真的變動時才呼叫 reconcile（Owner 已接受此語意）。
實作要點：`listingDetailPlan()` 已算出有效新值（`address`／`location`），
應以「寫入前後的實際資料列」或同一個 plan 判斷，避免邏輯漂移。
A 的實測結果（36ms 而非 ~1ms）讓 B 的必要性更高。

### 為什麼兩個都要

只做 A：每次明細增強仍要 36ms 的排序與掃描，量大時會再次擠壓 crawl。
只做 B：遇到大量地址變動（例如重爬整批）時仍會退化。


## 五、尚未解決／待辦

1. **選項 B 尚未實作**（Owner 已同意其語意）。
2. **必須補的防護**：一項「對真 PG 跑完整一個 crawl 週期且能完成」的整合測試——
   就是這個缺口讓本次停擺上線。目前測試全是離線單元測試，抓不到「查詢很慢」這種問題。
   目前已補的是**查詢形狀**守衛（`v3/test/reconcile-candidate-index.test.js`，6 項，
   已驗證非空測試），但那不能取代端到端週期測試。
3. 修正版**尚未部署**：需要重建映像 → predeploy → deploy，依 AGENTS.md §8.2 需 Owner 明確核准。
4. 15 筆 owner 決策衝突仍未決定（目前預設「保留 PG、不動作」）：
   `user_listing_flags` 7、`settings` 3、`user_settings` 3、`listing_group_members` 2。
5. `PG_SQLITE_FALLBACK=strict` 是否啟用（建議：穩定後再開）。
6. 上線前既有問題（非本次引進）：舊版約每 10 秒在 PG log 出現
   `function typeof(bigint) does not exist`；1 筆房源的 `source` 位元組字串損毀。
7. 部署修正版後，release plan 的 四B（雙節點 A/B 讀寫）與 四C（crawler 欄位級抽查）必須重做。

## 六、目前狀態

- Production 已回滾至 `9c6b7b04f9801717cb6696e8e095fde4c309473f`
  （registry digest `sha256:240791e52ffbd8a4f2fb727c11c9e814ba45d407f695e3aa2b9e7cd2349778a2`），
  健康、crawler 正常。**切換未完成。**
- 資料面：PG 的資料搬遷**仍然正確且已套用**（settings 29→30、user_listing_flags 705→745、
  listing_groups 14,486→14,511、listing_group_members 45,181→45,250，另 4 筆衝突 UPDATE）。
  回滾只回程式碼，沒有回資料。
- Schema 面：生產 primary 已新增 `pg_trgm` 與三個 reconcile 索引（見第四節）。
  這些是**附加**的，對回滾版程式只有少量寫入成本，不影響現行運作。
