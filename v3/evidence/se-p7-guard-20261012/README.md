# se-p7-guard：會員列表的「每請求全表級探測」改成「增量驗證 ＋ 有界全掃」

包名 `se-p7-guard`（代號）。基準 `c12f45b`（＝`origin/master`，已含 #729）。

## 0. 一句話

會員列表每請求要付的**三條全表級探測**，兩條改成「只驗證上次 watermark 之後被指名變更過的
`post_id`」，一條改成 loose index scan；**判定式與結果集完全不動**（三個情境的 `totalMatched`
前後逐筆相同）。第三條（`fixture_namespace` 的精確總數）依指示不動，列為待裁決。

## 1. 第 1 步查證：`data_revision` 的真實形狀與寫入時機（結論）

| 問題 | 結論 | 出處（逐字查證） |
|---|---|---|
| 是「每次變更一行（含被動 post_id）」還是「只有全域計數」？ | **每次變更一行，`entity_id` 就是受影響的 `post_id`** | `v3/src/dataRevisionPgSchema.js:17-21` 欄位 `(id, entity_type, entity_id, event_type, created_at)`；`v3/src/repository/writePath.js:395-401` `INSERT INTO data_revision (entity_type, entity_id, event_type, created_at)` |
| 寫入端是否與 `listings` 寫入**同交易**？ | **是**。`persistListing()` 用 `pool.withTransaction` 包住「主列 upsert → backfill → 投影 → fold → 變更紀錄」 | `v3/src/db.js:4893-4932`（`const applied = await pool.withTransaction(async (client) => { … writer.syncProjection(canonical); … writer.bumpRevision({entityType:"listing", entityId: postId, eventType: event}) })`） |
| 有沒有「無法指名受影響列」的變更？ | 有：`listing_offline_confirmed`（`crawlerWrites.js:341-345` 不帶 `entityId` ⇒ `entity_id IS NULL`）。正式庫現況：2,219,105 列裡 `entity_id IS NULL` 只有 109 列 | 生產唯讀實查：`SELECT entity_type, count(*), count(entity_id) FROM data_revision GROUP BY 1` ⇒ `listing` 2,219,105 ／ 有 id 2,218,996 ／ NULL 109；事件分佈 `listing_updated` 2,136,092、`listing_added` 81,067、`listing_offline_confirmed` 30 |
| 寫入頻率（正式庫 5 分鐘窗口） | `listing_updated` 376 筆／5min（≈1.25/s）、`listing_added` 12／5min、`listing_offline_confirmed` 3／5min | 唯讀 `pg_stat_statements` 同庫查詢（見 §6 指令） |

**這決定了選 (b)＋(a) 的混合**：`data_revision` 帶得出受影響列 ⇒ 用它當增量來源；同時保留
有界週期全掃（因為上表最後一列那種列無法逐一列舉，且 `entity_id` 也可能因為 SAVEPOINT
隔離而整批缺席 ⇒ 不能只靠它）。

> 補充（為什麼「快取鑰是 revision」本來就會一直 miss）：同一份實查顯示 `data_revision.MAX(id)`
> 在寫入活躍期幾乎每秒換代；`db.js:4500` 的 `pgStoredSearchKeysCache` 與
> `listingDistrictPrefilter.js:122-125` 的 `guardCache` 都以它當 key ⇒ 每個請求都重算。

## 2. 改動一：行政區投影守門改增量（`v3/src/listingDistrictPrefilter.js`）

### 2.1 快取從「整份答案」變成「已驗證範圍（watermark）」

* 起點：**全掃一次**，判定式逐字沿用舊版（`missing` ＋ `mismatched` 兩項證明、NULL 處理不變，
  只多了 `if (!(await projectionTablesPresent(one))) return false;` 這個原本就有的缺表前置）。
* 之後只重驗 `(watermark, 目前 MAX(id)]` 之間**由 `data_revision` 指名變更過的 `post_id`**：
  同一組判定式加上 `post_id = ANY($1／$2::bigint[])` 的**範圍限制**（不是另一套寫法）。
* 兩道兜底：
  1. **結構指紋**：`pg_stat_user_tables` 的 `n_tup_ins + n_tup_del`（`listings` ＋投影表，
     `schemaname = ANY(current_schemas(false))`）。刻意**不含 `n_tup_upd`**：實測 5 次
     `INSERT … ON CONFLICT DO UPDATE`（爬蟲式 upsert）讓這個和變化 = **0**，含 update 就等於
     每個請求都要全掃。這一項會抓到「沒有 `data_revision` 紀錄的列增減」。
  2. **有界週期全掃**：`MEMBER_DISTRICT_GUARD_FULL_SCAN_MS`（預設 300000＝5 分鐘）。
* **不確定就全掃**（fail-safe）：delta 超過 `MEMBER_DISTRICT_GUARD_DELTA_LIMIT`（預設 4000）、
  出現 `entity_id IS NULL`／非 `listing` 的 entity_type、指紋讀不到、版本號倒退 —— 一律全掃。

### 2.2 為什麼快取不會掩蓋漂移（論證）

1. 只有**完整驗證通過**（兩項證明皆 0）的狀態才寫進快取，而且記的是「驗證到哪個 revision」。
2. 要沿用快取，必須**同時**成立：版本沒倒退、指紋一模一樣、且距上次全掃不到 5 分鐘。
   任何一項不成立就退回全掃；判到漂移時**不推進 watermark、不寫快取** ⇒ 下一個請求必須重驗。
3. 增量那一段是「上次全掃為 0 」＋「這一段的變更都在 S 內重驗為 0」⇒ 全量仍為 0。這是
   **歸納**，不是取樣；`S` 來自 `data_revision`，範圍限制只是把同一個述詞縮到 `S`：
   `∀l P(l) ⟺ (∀l∉S P(l)) ∧ (∀l∈S P(l))`。
4. 唯一沒有信號的變更類別（沒有 bump、沒有列增減的**純更新**，例如有人直接
   `UPDATE listing_search_projection SET district=…`）由**週期全掃**兜底，上限
   `MEMBER_DISTRICT_GUARD_FULL_SCAN_MS`＝5 分鐘；`MEMBER_DISTRICT_PREFILTER=0` 仍可整條關掉。

### 2.3 紅線測試（必加，且**要能殺掉**）

* 檔名：`v3/test/listing-district-prefilter-drift.test.js`
* 測試名：**「紅線：listings 有列、投影沒有、data_revision 也沒動 ⇒ 下一個請求的守門仍必須判 ok=false（快取不得掩蓋漂移）」**
* 內容：乾淨狀態先驗證通過 → 用**專用連線**（`client.end()` 讓統計落地）在 `listings` 造一列
  人造 `post_id`、**不寫投影、不 bump `data_revision`** → 斷言版本沒前進 → 下一個請求必須
  `false` → 再問一次仍 `false` → 補上投影列 → 必須回到 `true` → 清理。
* 失敗訊息（實跑）：`紅線破了：listings 有一列而投影沒有、data_revision 沒有前進時，守門卻回 ok=true（＝篩選會靜默少算，預篩把這一列濾掉了）`
* 會擋誤寫：DB 名不在 `{repro, tracker_test, repro2, crawl_sandbox}` 就**拒絕執行**（同
  `member-listing-cache-live-pg.test.js` 的 gate）。

## 3. 改動二：`DISTINCT search_key` 改 loose index scan（`v3/src/db.js`）

* `pg_indexes` **實查**（repro 靶，非猜測）：
  `idx_listings_search` ＝ `CREATE INDEX idx_listings_search ON public.listings USING btree (search_key)`
* 新形狀（`WITH RECURSIVE t(k) … min(search_key) WHERE search_key > t.k …`）：
  repro 實測 execution **0.76ms**、回 39 個 key；原 `SELECT DISTINCT` 在 repro 是 54ms
  （正式庫 142ms／次）。**先探 `to_regclass('idx_listings_search')`**，沒有索引就退回原
  `DISTINCT`（正確、只是慢）——避免在沒有索引的環境變成 39 次整表掃描。
* 逐筆相同：原版在 JS 端 `.filter(Boolean)` 濾掉 `NULL`／`''`，新寫法直接在 SQL 濾；
  實測同一個 39 筆集合（`same_set true`）。
* **`v3/src/crawlerReads.js:100` 那一條刻意沒改**（原本也想一起換）：
  1. 它自己有 **8 秒 TTL 備忘**（`searchKeyCountMemo`），不是每請求成本 —— 本包靶上 10 次請求
     實測 **0 次**（快照裡那 10–11 次 `SELECT DISTINCT search_key` 全部來自 `db.js`）。
  2. 它是 #729（`c12f45b`）剛釘住的路徑：`v3/test/sqlite-exit-p7-sandbox-gate.test.js:128／148／179`
     逐字斷言「只發 `DISTINCT` ＋ `COUNT` 兩條查詢、第一條是 `DISTINCT`」。硬要換就得動別人
     剛合併的測試檔（該檔不屬於本包），換到的量測收益是 0 ⇒ **改成只動 `db.js`**。

## 4. 改動三（**待裁決**）：`fixture_namespace` 的精確總數

`repository/listingStats.js:122-131` 的 `countProductListings()` = `SELECT COUNT(*) AS n FROM listings
WHERE (fixture_namespace IS NULL OR fixture_namespace = '')`，值走
`summarizeListingStats()` 的 `counts.dbTotal`（`db.js:7828`）＝**給使用者看的精確總數**，
不是「是否存在」。依指示**不改估算值**，列為待裁決點。

## 5. 量測（repro 靶，同一支 `/tmp/pstat.sql` ＋ `/tmp/snap.sh` ＋ `/tmp/pdiff.py`）

* 靶：`192.168.0.220:15444`，DB `5151_shadow`（**我自己起的隔離容器 `5151-se-p7-pg`**，
  由 `prb-repro-pg` 的 `repro` 還原；**沒有**碰 `192.168.0.220:15432`），已 `VACUUM (ANALYZE)`。
* 請求路徑：`loadListingPage()`（與 `v3/scripts/member-list-benchmark.mjs` 同一條服務層），
  10 次請求；同時跑一個寫入器模擬正式庫爬蟲（約每 0.8 秒 `upsert listings` ＋ `bump data_revision`）
  —— 這是「快取被寫入打穿」的必要條件。
* 每組：`pg_stat_statements_reset()` → 10 次請求 → `snap.sh` → `pdiff.py`。

### 5.0 結果集不變（最硬的斷言）

**三個情境、前後各 10 次請求，`matched` 逐筆相同**：`中山區,大安區`＝816×10、`大里區`＝0×10、
`西屯區`＝0×10（`大里區`／`西屯區` 在那個會員的 search key 下本來就是 0；`totalMatched`／`matched`
都不是用 `stats.total` 那個未篩選全量）。增量驗證**沒有**改變結果集。

### 5.1 「全表級計數族群」＝ `stats_count;dur` 的對應成本

Owner 的公網基線把成敗指標定在 `Server-Timing` 的 `stats_count;dur`（大里區 545ms／西屯區 543ms），
它裡面就是本包處理的那三條指紋。以同一對快照把它們逐 queryid 加總：

| | before（10 次請求合計／每請求） | after | 
|---|---|---|
| 守門 anti-join（`listingDistrictPrefilter`，兩個 key 數變體） | 2821.6ms／282ms | 255.2ms／26ms（只剩開頭那一次全掃） |
| `SELECT DISTINCT search_key FROM listings` | 439.1ms／44ms | **0** |
| `SELECT COUNT(*) … fixture_namespace …`（dbTotal，未動） | 204.6ms／20ms | 204.6ms／20ms |
| 本包新增的探測（指紋＋delta＋增量證明） | 0 | 6ms／0.6ms |
| **合計** | **3465ms／346ms** | **466ms／47ms** |

⇒ 這個族群在靶上 **346ms → 47ms**。換算到公網那 545ms 的 `stats_count`，扣掉未動的
`fixture_namespace`（133ms）與同樣未動的部分之後，預期落在 **~230–250ms**（＝545−300）。

### 5.2 `stats` 扣掉 `scan`（Server-Timing 的 `stats;dur` 減 `scan;dur`）

| 情境 | before（`0acb1f4`） | after（本包） | Δ |
|---|---|---|---|
| `districts=中山區,大安區`（`totalMatched=816`） | 1006ms | 701ms | **−305ms** |
| `districts=大里區` | 860ms | 639ms | −221ms |
| `districts=西屯區` | 1079ms | 724ms | −355ms |

`totalMatched` 在每一個情境、前後 10 次**逐筆相同**（中山區,大安區＝816×10；
大里區／西屯區在這個靶的會員 key 下本來就是 0），行為等價沒有變。

> ⚠️ 三個情境都**還沒到 ≤0.5s**（639–724ms）。剩下的量能見 §5.3 與 §7。

### 5.3 `pdiff.py` 輸出（本包「新增」的查詢成本＝合計 6ms）

```
窗口內新增查詢耗時合計＝6ms（6 種 queryid）
 Δ 2.9ms｜ 20 次｜ 0.1ms｜SELECT COALESCE(SUM(n_tup_ins + n_tup_del), $1)::text AS churn, COUNT(*)::int AS tables
 Δ 1.1ms｜  9 次｜ 0.1ms｜SELECT (SELECT COUNT(*) FROM listings l WHERE l.post_id = ANY($1::bigint[] …
 Δ 1.0ms｜  1 次｜ 1.0ms｜WITH RECURSIVE t(k) AS ( SELECT min(search_key) FROM listings WHERE COALES
 Δ 0.6ms｜  9 次｜ 0.1ms｜SELECT (SELECT COUNT(*) FROM listings l WHERE l.post_id = ANY($1::bigint[] …
 Δ 0.4ms｜ 18 次｜ 0.0ms｜SELECT entity_type, entity_id FROM data_revision WHERE id > $1 AND id <= $2 …
 Δ 0.1ms｜  1 次｜ 0.1ms｜SELECT to_regclass($1) IS NOT NULL AS has_table, to_regclass($2) IS NOT NU …
```

⚠️ `pdiff.py` 只列「**calls 增加**」的 queryid（原始碼：`if dc > 0 and dt > 0`），所以「省下來的」
不會出現在上面。同一對快照檔依 queryid 相減（同一個 `pdiff.py` 的資料來源）得到：

| 查詢 | before calls | after calls | 省下（10 次請求） |
|---|---|---|---|
| 守門 anti-join（`listingDistrictPrefilter` 全掃，兩個 key 數變體） | 10 ＋ 10 | 1 ＋ 1 | 1732.9ms ＋ 1263.6ms（西屯區）／1480.8 ＋ 1340.8（中山區,大安區）／1525.6 ＋ 645.1（大里區） |
| `SELECT DISTINCT search_key FROM listings` | 10–11 | **0** | 404–446ms |
| `SELECT post_id FROM listing_search_projection WHERE district = ANY($1::text[])`（投影預篩 id） | 20 | 20 | **0（未動）** |
| `SELECT COUNT(*) … fixture_namespace …`（dbTotal） | 10 | 10 | **0（未動，見 §4）** |

> 註：**queryid 會隨資料庫的 relation OID 改變**（本靶是還原庫），所以正式庫的
> `-451862832782765475`／`-1058412334999276296` 這兩個 id 不會出現在本靶快照裡；對照請以
> SQL 文字為準（同一支 `pdiff.py`、同一組欄位）。

### 5.4 量測環境可重跑（自我揭露）

```bash
# 1) 起靶（syn-nas；隔離容器，與 live 設定無關）
ssh syn-nas 'docker run -d --name 5151-se-p7-pg --env-file /tmp/.p7env -p 15444:5432 \
  -v p7pgdata:/var/lib/postgresql/data postgres:16-alpine -c shared_preload_libraries=pg_stat_statements'
# 2) 把 repro 還原進去（DB 名必須是 5151_shadow，pstat.sql 以它過濾 dbid）
docker exec prb-repro-pg pg_dump -U postgres -d repro -Fc -f /tmp/x.dump && … pg_restore …
# 3) 三次「重置 → 10 次請求 → 快照」
ssh syn-nas 'docker exec 5151-se-p7-pg psql -U postgres -d 5151_shadow -At -c "SELECT pg_stat_statements_reset()"'
P7_ROOT=<樹> P7_REQUESTS=10 P7_DISTRICTS=西屯區 node /tmp/p7_bench.mjs
ssh syn-nas 'bash /tmp/snap.sh 5151-se-p7-pg /tmp/after.txt'
python3 /tmp/pdiff.py /tmp/before.txt /tmp/after.txt
```

## 6. 驗證清單（全部可重跑）

```bash
cd <樹> && set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
export PG_TEST_URL="$PG_LIVE_REPRO_URL" PG_URL="$PG_LIVE_REPRO_URL" DB_DRIVER=postgres
node --test v3/test/listing-district-prefilter.test.js v3/test/listing-district-prefilter-drift.test.js \
            v3/test/listing-search-request-context-pg.test.js v3/test/sqlite-exit-p7-sandbox-gate.test.js
node --test v3/test/list-query-regression.test.js v3/test/list-sql-first.test.js v3/test/search-contract-regression.test.js
```

* 實跑：`# tests 34 / # pass 34 / # fail 0`（prefilter 系列 ＋ list-query-regression ＋
  list-sql-first ＋ search-contract-regression）；`v3/test/sqlite-exit-p7-sandbox-gate.test.js`（#729
  釘住的落地讀路徑契約）另跑 7/7 pass；突變後重跑見 §7。
* 變異驗證：`node v3/scripts/mutation-check.mjs <測試檔>` —— **該工具目前沒有本包檔案的
  mutation set**（`v3/scripts/mutation-check.mjs` 內 `MUTATIONS` 只涵蓋
  `sameHouseAsync.js`／`userSameHouseAsync.js`／`adminAuditAsync.js`／`supportWrite*`；
  grep `listingDistrictPrefilter`＝0 筆）。**沒有**為了綠燈去膨脹那支工具（D-0042 的教訓）。
  改用等價的手動殺傷驗證（§7）。

## 7. 殺傷驗證（等價突變，兩條都實跑）

| 突變 | 指令 | 結果 |
|---|---|---|
| A：拿掉結構指紋比較（`sentinel === entry.sentinel` → 永真） | `node --test v3/test/listing-district-prefilter-drift.test.js` | **not ok 1**（紅線測試殺掉它） |
| B：增量證明永遠回 `true`（忽略 `missing`／`mismatched`） | `node --test v3/test/listing-district-prefilter.test.js` | **not ok 7**「增量驗證抓到漂移：不推進 watermark、不快取」 |

## 8. 沒有動 / 待裁決

1. **沒有** migration、**沒有**改判定式、**沒有**碰 `v3/migrations/**`、手動 workflow、
   `deploy/**`、`docs/runbooks/sqlite-gate-flip.md`、`v3/scripts/pg-island-inventory.mjs`。
2. 待裁決點 A：`dbTotal`（`fixture_namespace` 精確總數，正式庫實測 133ms／請求）要不要鬆綁？
   目前**未動**（維持精確）。
3. 待裁決點 B：投影預篩 id 集合（`SELECT post_id FROM listing_search_projection WHERE district = ANY`
   正式庫 68ms／請求）要不要也吃同一套 watermark？**故意沒做**：它與守門不同——它一旦過期會
   **讓結果少算**（守門過期只是變慢），而「有人重建投影但不 bump revision」時 watermark 方案
   最長會錯到 5 分鐘。要做需要您明確裁決（或先確認所有投影寫入端都會 bump）。
