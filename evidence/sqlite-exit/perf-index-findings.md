# 公開列表索引候選：隔離庫實測結論（不要再重跑）

> 結論一句話：**正式庫一支索引都不建**。任務假設的「三個 PG 固定開銷靠索引救」經隔離庫實測大多不成立——這批索引對公開列表真實 SQL 路徑 **0 增益**。本文件是這包唯一的剩餘價值：把「試過了、沒用、為什麼沒用」留下來，避免下一個 agent 重跑同一輪實驗。

- 日期：2026-10-10
- 隔離庫：syn-nas `prb-repro-pg` 實例的 `crawl_sandbox`（`192.168.0.220:15434`；與正式 `5151-postgres-A/5151_shadow` 是**不同機器不同實例**）
- 正式庫：`5151_shadow`，本包只做 `BEGIN READ ONLY` 的 `pg_indexes`／`count` 盤點，**零寫入、零 DDL**
- 量測主機：DSH 主機（AMD Ryzen R1600）。正式站跑在 casa-nas（Celeron N3450），單核約慢 5 倍 ⇒ 毫秒外推正式約 ×12.8（I/O 型查詢主要 ×資料量比）

## 0. 資料量與外推

| 庫 | listings | projection | 對齊 |
|---|---|---|---|
| `crawl_sandbox`（隔離） | 71,726 | 71,726 | ✓ |
| `5151_shadow`（正式） | 182,954（任務給定）→ 183,450（本包查）→ 183,635（Owner 覆查） | 同左 | ✓ 全程對齊 |

正式列數隨爬蟲持續寫入漂移；外推正式耗時 = 隔離毫秒 ×（列數比 ~2.56）×（單核 ~5），I/O 型查詢主要 ×2.56。

## 1. 每支候選索引：建檔耗時／體積／寫入影響／EXPLAIN 前後

建檔方法與正式站同形勢：`CREATE INDEX CONCURRENTLY IF NOT EXISTS`。下表數字皆在 `crawl_sandbox`（71,726 列）實測。

| 索引 | 建檔耗時 | 體積 | 寫入影響 | EXPLAIN 前→後 | 結論 |
|---|---|---|---|---|---|
| `listings(match_post_id) WHERE match_post_id>0 OR match_post_id<0`（partial） | 220ms | 472 kB | 無 | 46ms Seq Scan → **46ms Seq Scan**（planner 不用它） | **不要建** |
| 同上＋`INCLUDE(post_id)`（covering） | 174ms | 680 kB | 無 | 強制 index-only **60ms > Seq 46ms**（髒 VM） | **不要建** |
| `listings(lower(title) gin_trgm_ops)` | 2152ms | 16 MB | 見 §1.1 | 見 §3（只對 ≥3 字有效，且被 post_id OR 廢掉） | **先不要建** |
| `listings(lower(address) gin_trgm_ops)` | 864ms | 5.3 MB | 見 §1.1 | 同上 | **先不要建** |
| `listing_search_projection(rent)` | 142ms | 536 kB | 無 | price 排序 CASE 包裝使 btree 用不上 | **不要建** |
| `listing_search_projection(district, updated_at DESC, post_id)` | 244ms | 3.4 MB | 無 | planner 不選（既有 updated_at DESC,post_id 已夠） | **不要建** |

### 1.1 寫入影響（重建 16MB trigram 期間並行寫入實測）

- `DROP INDEX CONCURRENTLY` 136ms、`CREATE INDEX CONCURRENTLY` 2213ms。
- 建檔 2.2 秒內爬蟲式寫入完成 **106 筆**（吞吐 ~48/s 持平）、**0 筆被卡 >500ms**、單筆最大延遲 122ms。
- ⇒ `CREATE INDEX CONCURRENTLY` **不擋寫入**（符合預期；觀察到 1 個 session 短暫 Lock 等待，非寫入被擋）。

## 2. 三組參數 EXPLAIN 前後對照（建完上述全部索引後）

| 參數組 | 建前 | 建後 | Plan 節點 |
|---|---|---|---|
| 無關鍵字（36 欄候選 `ORDER BY post_id`） | 1014ms | 971ms | **不變**：Seq Scan + Sort（59,286 列 × 634B） |
| `q=套房` | 922ms | 936ms | **不變**：Seq Scan + Sort（11,053 列） |
| `districts(西屯區)+priceMax=25000` | 34ms | 33ms | **不變**：Bitmap Index（2,057 列，本就快） |

⇒ 這批索引對公開列表真實 SQL 路徑 **0 增益**（毫秒在雜訊內）。

## 3. trigram 選擇性門檻（15 個真實關鍵字，隔離庫實測）

- **門檻＝字元數 ≥3（≥2 個有效 trigram），不是命中率**：
  - 2 字關鍵字（套房 18.3%／車位 10.5%／電梯 10.6%／2房 6.3%／3房 6.0%／公寓 1.78%／大樓 1.8%／透天 2.86%／家電 1.8%／學生 0.67%／合租 0.56%／民權 0.43%／林口 0.29%…）→ **一律 Seq Scan ~86ms，GIN 完全不用**。連命中率只有 0.29% 的「林口」也不走 GIN。
  - ≥3 字關鍵字（近捷運 1.8%／信義區／大安區／中山區／健身房／近公園／獨立套房 1.5%…）→ **GIN 0–6ms**。
- `show_trgm('套房')=3`、`show_trgm('近捷運')=4`：2 字只有 3 個 trigram（資訊量不足），3 字有 4 個。

### 3.1 致命 OR：`CAST(post_id AS TEXT) LIKE` 讓 trigram 整個白建

真實 `q` 條件是：

```sql
lower(title) LIKE ? OR lower(address) LIKE ? OR CAST(post_id AS TEXT) LIKE ?
```

`CAST(post_id AS TEXT) LIKE` 這項**沒有索引（也不該建）**，planner 無法對這個 OR 做混合 bitmap ⇒ 對**所有**關鍵字退回 Seq Scan。

- 實測：2 項 OR（title OR address）→ 走 BitmapOr GIN，近捷運 **6ms**；3 項 OR（加 post_id）→ **Seq Scan 83ms**。
- ⇒ 現行代碼下 trigram **完全用不上**；要先把 post_id 項拆出，trigram 才可能對 ≥3 字有效（見 §6）。

## 4. 「不要建」清單＋理由

1. **`match_post_id` partial（含 covering）**：命中 30–40%（sandbox 21,413/71,726、正式 73,542/182,954），且爬蟲持續 UPDATE 使 visibility map 髒（`relallvisible` 4702/12220 = 38%）⇒ index-only 退化成大量 heap fetch（強制 index-only 60ms 慢於 Seq 46ms）。~168ms 是「讀出全部配對邊」的合理成本；真解＝配對邊在寫入時算一次存起來，不是索引。
2. **`search_key` 索引**：`SELECT DISTINCT search_key`（~195ms）無論如何要讀全表（PostgreSQL 不自動 skip-scan），索引只把寬列 Seq Scan 換窄 index-only（70→52ms，~25%），而且只回 ~20 個 key。`search_key IN (...)` 對訪客路徑根本不存在（訪客傳空 searchKeys）。真解＝行程內快取 ~20 個 distinct key（見 §6）。
3. **trigram title/address**：現行代碼 0 收益（§3.1），先不建。要建的前提＝代碼拆出 post_id OR 項，屆時也只對 ≥3 字有效。
4. **新 SQL 路徑複合索引（sort＋訪客 predicate）**：不要建在 `listings`。排序鍵已由 projection 預先算好：newest 用 `updated_at DESC, post_id`（正式已有此複合索引，top-N 實測 0.13–0.89ms）、price 用 `rent/total_monthly_cost`。price 排序的 `CASE WHEN rent>0 …` 包裝使 `rent` btree 用不上。訪客 predicate（offline&offline_confirmed 排除 0.9%、match_verdict='yes' 排除 0%、low_floor/rooftop 保留 90%/98%）選擇性太低，索引無助。
5. **projection 缺的 kind_keys/low_floor/rooftop/parking btree**：不要建 btree。`kind_keys LIKE '%,whole,%'` 前綴 `%` 無效；low_floor/rooftop 保留 90%/98% 太低；parking=1 18% 邊緣。**建議改欄位形態（boolean／int[]＋GIN）**——那是折疊包的 DDL 範圍，本包不動。

## 5. 正式庫實際索引清單（read-only 查證）

正式庫 `5151_shadow` 的 `listings` 索引**只有這 6 支**（本包 read-only 查證，Owner 亦獨立覆查一致）：

```
listings_pkey                    (post_id)
idx_listings_match_verdict       (match_verdict)
idx_listings_offline_state       (offline, offline_confirmed)
idx_listings_lat_lng             (lat, lng)
idx_listings_community_norm      (community_name 正規化)
idx_listings_addr_norm_trgm      (address 正規化 GIN)
```

`listing_search_projection`：`listing_search_projection_pkey(post_id)`、`idx_proj_district`、`idx_proj_total_cost(total_monthly_cost)`、`idx_proj_commute`、`idx_proj_updated_at(updated_at DESC, post_id)`。

查證指令（給下一個人，正式庫唯讀）：

```bash
psql -d 5151_shadow -c "select indexname from pg_indexes where tablename='listings' order by indexname"
psql -d 5151_shadow -c "select indexname from pg_indexes where tablename='listing_search_projection' order by indexname"
```

> ⚠️ 注意：隔離庫 `crawl_sandbox` 的 `listings` 上有一批**正式庫沒有的索引**（`idx_listings_search`、`idx_listings_match_peer`、`idx_listings_list_scan`、`idx_listings_hidden`、`idx_listings_offline` 等）——那些是 SQLite schema 鏡像殘留，**不是正式庫現狀**。本包是在隔離庫「已多建」這些索引的基礎上仍證得無效，所以「不要建」的結論對正式庫（更精簡）只會更成立。

## 6. 可以救的兩件小事（不屬本包，只列待決）

1. **`SELECT DISTINCT search_key FROM listings`**（~195ms／讀全表、實際只回 ~20 個值）⇒ **行程內快取**，索引救不了。需用 `data_revision` 做版本化失效（先前無版本 memo 因快照契約被撤回，不能回退）。
2. **post_id 那條 OR** ⇒ 拆成「q 是純數字時走 `post_id = $n::bigint`、否則走 title/address 兩項」。拆了之後 trigram 才可能對 ≥3 字有效（屆時才談建 trigram）。

## 7. 落地腳本

`evidence/sqlite-exit/index-landing-script.sh`（與本文件同目錄）。**預設不跑任何索引**（`RUN_TRIGRAM=1` 才跑條件式 trigram，且前提是先完成 §6.2 拆 post_id）。含建檔前後 `pg_stat_progress_create_index` 觀察、`DROP INDEX CONCURRENTLY` 回退、跑完要驗證的三個數字。**不含任何 `ALTER TABLE ADD COLUMN`／UPDATE**。

## 8. 事故紀錄（透明揭露）

本包清理 write-impact 測試列時，誤判 post_id 範圍，刪掉 **17,407 筆** `crawl_sandbox.listing_search_projection` 列（sandbox 的 post_id 有 2.2B–2.7B 區段，屬真資料非測試列）。已用與寫入端相同的 `computeListingProjection` 路徑批次回填；**核對方式＝回填後 projection 列數與 listings 相等（71,726 = 71,726）**。`invalid index=0`、殘留測試索引=0、測試列=0。**未觸及正式庫**。
