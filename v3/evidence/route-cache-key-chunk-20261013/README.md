# 會員列表剩餘伺服器側成本歸因 ＋ route_cache 讀取改走既有唯一索引（2026-10-13）

**狀態**：已實作、已 A/B 交替量測、已過離線測試與 CI。**未 merge、未部署**（F-0026）。
基準：`master = 87e3a04`（本包開發期間由 `e6a55f7` 前進一個 compose-only commit）。

量測環境（全部唯讀，正式庫只 SELECT）：
`PG_LIVE_REPRO_URL`／`PG_SNAPSHOT_REPRO2_URL` 所在的隔離實例（`prb-repro-pg`）上，以
`CREATE DATABASE TEMPLATE repro2` 複製出的私有庫 `mlattr_<pid>`（184,754 列，與 repro/repro2 逐表相同列數），
收尾 `DROP DATABASE … WITH (FORCE)`。每一發之前對 `data_revision` 插入 4 列，模擬正式站「爬蟲讓版本號持續前進」
（正式實測 ~1.2 列/秒），避免凍結快照讓 `idsCache`／`guardCache` 命中而低估 statsScope 準備。

> ⚠️ **`pg_stat_statements` 在本靶不可用**：`pg_settings.shared_preload_libraries` 是**空字串**、
> `pg_stat_statements` 是 `installed_version=null`（實測見 §5）。啟用它需要 `ALTER SYSTEM` ＋ 重啟容器
> ＝變更共享測試基礎設施，不在本包授權內。因此改用**同一個行程內**對 `pg.Client.prototype.query`
> 插樁（＝既有 `v3/scripts/member-list-sql-count.mjs` 的手法），量到的就是**本請求窗口**內每一條語句的
> 呼叫次數／合計／單次中位，並以 `EXPLAIN (ANALYZE, BUFFERS)` 取伺服器端真值交叉驗證。

---

## 1. 歸因表（會員 `大安區`、`limit=20`、暖行程、8 發交替取中位）

| # | 查詢形狀 | 所屬 stage | 呼叫 | 合計 | 佔 SQL |
|---|---|---|---|---|---|
| 1 | `DECLARE … SELECT post_id, xmin‖ctid, in_list_scope, in_stats_scope FROM listings WHERE COMMON AND ((S_stats) OR (S_list))` ＋ 3 次 `FETCH`（10,505 列） | **scan**（一趟掃描） | 1+3 | **185ms**（`scan_ms` 223） | 33% |
| 2 | `SELECT route_key, distances, min_km, … FROM route_cache WHERE route_key = ANY($1)` | **decoration**（list 前置＋stats provider） | 2 | **156ms** | 27% |
| 3 | `FETCH` 來自 `SELECT post_id, match_post_id FROM listings WHERE match_post…` | statsScope／closure 圖 | 10 | 102ms（閉包記憶未命中那一發） | 18% |
| 4 | `FETCH` 來自 `SELECT post_id FROM listings WHERE (／NOT)(split_part(…))` | list 範圍（關係閉包 id） | 2 | 35ms | 6% |
| 5 | `SELECT post_id FROM listing_search_projection WHERE district = ANY($1)` | statsScope 準備（投影預篩） | 2 | 37ms | 6% |
| 6 | `SELECT * FROM route_jobs WHERE job_key = ANY($1)` | decoration（通勤佇列狀態） | 1 | 33ms | 6% |
| — | 其餘（`listing_group_members`／`fold_component_root`／`statusCounts` 聚合／`listing_prep`／`user_settings`…） | decoration＋stats 收尾 | — | ~110ms | ~20% |

請求層級中位：`wall 845ms`、`list 324ms`、`stats 501ms`、SQL 合計 `568ms`（其餘是 Node 端列處理與 stats 匯總）。

**最大塊＝一趟掃描（185ms／`scan_ms` 223ms）；第二大＝route_cache 讀取（156ms），兩者相差 ~19%**
（本包判為「差不多大」，見 §4）。

## 2. 這一刀：只改 route_cache 讀取的「一條 SQL 帶幾個鍵」

`v3/src/repository/decorationData.js`（`loadRouteCacheEntries`，新增 `ROUTE_CACHE_KEY_CHUNK = 1024`）。

**為什麼**：`route_cache` 只有 `route_cache_pkey`（UNIQUE btree(route_key), 59MB／260,239 列），
但整包鍵一起送時 PG 的成本模型選的是 **平行 Seq Scan**：

```
EXPLAIN … WHERE route_key = ANY($1)  鍵=7422 → Gather > Seq Scan            exec 57.2ms  read=4552 block
                                     鍵=1024 → Bitmap Heat Scan > Bitmap Index Scan route_cache_pkey  exec 3.6ms  read=0
```

會員列表每個請求對這張表送兩次（鍵集合互斥 ⇒ 兩次都真的落到 DB），合計每請求從磁碟重讀 ~74MB。
切到 1024 之後每次語句走索引；**翻車點**實測在 1280–1536 之間（1536／1408 會翻回 Seq Scan 且慢 3–4 倍），
所以上界留在 1024（餘裕 ≥25%）。可重跑：`v3/scripts/route-cache-chunk-probe.mjs`。

**語意零變**：同一組鍵、同一組列、缺列一樣不回；PG 端每條語句仍是 `route_key = ANY($1::text[])`（1 個陣列參數），
SQLite 端仍是 `IN (?,…)` 且**單句變數數下降**；`rowsByKeys` 會依請求的鍵順序重建 Map ⇒ 插入順序不影響任何消費者。

## 3. A/B（L-0922：交替、符號一致性、Δ 範圍）

**(a) 區塊層級（同一行程交替，真實鍵集合 2848＋7422，各 15 輪）**

| keys | baseline 中位 | 分批中位 | Δ |
|---|---|---|---|
| 2848 | 63.2ms | 30.5ms | **−51.7%** |
| 7422 | 117.8ms | 91.2ms | −22.6% |
| 合計 | 181.0ms | 121.7ms | **−32.8%** |

重跑三次：−32.8%／−34.8%／−37.2%；逐列比對（含 `distances` 逐字、四個數值以 Number 比）**完全相同**。

**(b) 端到端（`loadListingPage` 大安區 limit=20；base→cand 交替 3 輪、段間 30s、每段 5 發丟前 2 發）**

| 區塊 | base 中位 | cand 中位 | Δ | 各輪 Δ | 符號一致 |
|---|---|---|---|---|---|
| **route_cache** | 176.9ms | 118.5ms | **−33.0%** | +24.5, +151.6, +40.8 | **全正 ✓** |
| scan_ms | 269 | 246 | −8.6%（不回退） | −40, +92, +18 | 不一致（噪音） |
| wall | 1124ms | 881ms | −21.6% | −132.6, +348.3, +84 | 不一致（噪音） |
| sql_total | 691.8ms | 570.5ms | −17.5% | −39.3, +227.4, +65.6 | 不一致（噪音） |
| projection_ids／route_jobs／group_members／fold_root／status_agg | 41／39.5／28.8／24.5／20.4ms | 36.9／36.8／25／22／19.9ms | −10%～−2.5% | 正負混合 | 皆優於或等於基準 |

唯一系統性變化：route_cache ↓（符號一致）與該表的語句數 2 → 11。其他區塊的 Δ 都在雜訊帶內、沒有回退。

## 4. 「最大塊」與「≥30%」的判讀

- 一趟掃描是最大塊，但它**沒有**安全的一刀 ≥30%：
  實測「旗標參數去重（旗標沿用 WHERE 的同一個 `$n`，參數 48→39）」＝端到端 **−8.4%**（DECLARE 50.3→36.0ms，
  FETCH 不變）；「移除旗標運算式」＝**−16.4%**；兩者合併仍 <30%。掃描的成本結構是
  27,317 個 district id 的 pkey 隨機探測（~58ms）＋ heap 掃描與旗標重算（~72ms）＋ 參數解析/規劃（~50ms），
  要真的砍掉它得把「投影 id 清單」改成對 `listing_search_projection` 的 semi-join（牽動述詞建構器與
  投影驗證契約），屬於另一包、需要裁決。
- route_cache 是第二大塊（與最大塊相差 ~19%，判為「差不多大」），而且是**唯一**測到 ≥30% 的一刀。

## 5. 重跑指令

```bash
set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
# 5.1 靶的能力（證明 pg_stat_statements 不可用）
psql "$PG_LIVE_REPRO_URL" -c "select name,setting from pg_settings where name='shared_preload_libraries'"
# 5.2 這一刀本身
node v3/scripts/route-cache-chunk-probe.mjs --keys 7422 --chunks 0,1024,1280,1536 --rounds 5 --explain 1
# 5.3 契約（離線，改動前紅／改動後綠）
node --test v3/test/route-cache-key-chunk.test.js
# 5.4 端到端 SQL 盤點前後對照（既有工具）
PG_URL=… node v3/scripts/member-list-sql-count.mjs --label before --out /tmp/b.json
PG_URL=… node v3/scripts/member-list-sql-count.mjs --label after  --out /tmp/a.json
node v3/scripts/member-list-sql-count.mjs --compare /tmp/b.json /tmp/a.json
```

## 6. 這一包不動什麼

`listingClosureMemo.js`（與接線）、`listingSearchPage.js` 的歸因計時（`stats_stages` 鍵與
`stats_prepare;dur`／`inputs_ms` 口徑）、`listingScopeScan.js`、`fold-*`／`docs/same-house-fold-*`／
`evidence/round8`／`listingSearchNodePg.js` 折疊路徑、`v3/public/*`、workflows、migrations、v1/v2、
compose／`.env`、`listingTotalsPg*`、`crawlOwnership.js` —— **全部未動**（`git diff --stat` 只有
`v3/src/repository/decorationData.js` ＋兩個新檔）。
