# 會員列表：一趟掃描（A 方案）與窗口內前五名 SQL 的收斂選項

**狀態**：A 方案已實作並通過等價驗證，效能實測為**打平**（見 §2），預設**開啟**但可用
`MEMBER_LIST_ONEPASS=0` 一行回退。§3 的五條**只列選項、未動程式**。

量測環境：正式站＝casa-nas 上的 `5151_shadow`（唯讀 `pg_stat_statements` 窗口增量，工具
`/tmp/delta.sh` ＋ `/tmp/dparse.mjs`）；開發迴圈＝隔離庫 `PG_LIVE_REPRO_URL`。

---

## 1. A 方案（一趟掃描）是什麼

原本每個會員列表請求對 `listings` 掃**兩次**：

1. `stats` 先掃「會員整體池」的寬候選（42 欄窄載體，`listing_read_2`）。
2. `list` 再下 `SELECT post_id FROM listings WHERE <list_where>`（`listing_read_7`）把範圍縮到
   本請求的行政區／篩選。

A 方案把它變成**一趟**：

```sql
SELECT <42 欄候選> FROM listings
 WHERE <COMMON> AND ((<S_stats>) OR (<S_list>))
```

`COMMON` ＝ `searchWhere` ＋ `listingVisibilityClauses`（兩邊逐字相同，由 `sharedPrefixLength` 驗證）；
兩個旗標 `in_list_scope`／`in_stats_scope` 掛在**版本預讀**那一趟（`extraColumns`），
讓主查詢仍以 `SELECT <42 欄> FROM listings ` 開頭 ⇒ 內容備忘（`pgCandidateContent`）照樣命中。
呼叫端各自只取自己那一側的列（`stats` 用 `in_stats_scope`、`list` 用 `in_list_scope`）。

**紅線遵守**：沒有 LIMIT、沒有抽樣；`WHERE (S_stats OR S_list)` 是兩個範圍的**聯集**，
任一邊的完整候選集合都在結果裡；`totalMatched` 仍由完整候選集合決定。

**回退**：`MEMBER_LIST_ONEPASS=0` 走原本兩趟，程式路徑逐字不變。

## 2. 等價與效能的實測（隔離庫 repro）

等價（`node v3/scripts/member-list-parity-matrix.mjs --three-way`，40 案例 × 5 組會員設定 × 8 組條件）：
每個案例都用「只做 list」「只做 stats」「共趟」三種方式各算一次，比對
**`totalMatched`、`stats` 的 16 個 bucket、第一頁 post_id 序列**——全部相同（40/40，無 failure）。

效能（5 輪交錯 median，`limit=80`、allkeys）：

| | wall | FETCH 趟數／時間 | list | stats |
|---|---|---|---|---|
| 兩趟（`MEMBER_LIST_ONEPASS=0`） | 1677ms | 25 趟／438ms | 1198ms | 539ms |
| 共趟（預設） | 1678ms | **20 趟／391ms** | 702ms | 942ms |

**結論：wall 打平（±1ms）**，但**少一趟 cursor 掃描**（−5 趟 `FETCH`／−47ms）。
原因是共趟掃描要多讀 740 列（list 的關係閉包把它們拉進 union，10,373 → 11,113 列）並對每列
多算兩次述詞，剛好抵掉被拿掉的那趟 id-only 掃描（10,114 列、只有 1 欄）。

`list`／`stats` 兩個數字在共趟模式下**不再可比**：共趟掃描與 list 的 prepare（閉區間＋預篩）
都跑在 `statsPrepareMs` 之內，所以時間從 `list;dur` 移到 `stats;dur`（兩者相加才是可比的總量）。
`cand`／`prepare` 階段在共趟模式下接近 0（工作已經在 `stats` 之前做完）。
**要判斷有沒有變快，看 `total_ms` 或窗口增量，不要只看 `list;dur`。**

## 3. 窗口內前五名 SQL 的收斂選項（**只列，未動程式**）

| SQL | 窗口增量 | 現況 | 如果要收斂 | 風險 |
|---|---|---|---|---|
| `SELECT post_id, community_id, source_key, lat, lng, geo_source FROM listings WHERE … ORDER BY …`（`db.js:5209` `geo591ScanQuery`，591 座標／社區補齊） | +40,296ms／15 次（2,686ms 每次） | **SQL 沒有 LIMIT**：全表掃描＋`Sort … external merge Disk: 19MB`（repro 1,275–1,393ms、回 157,627 列），只為了在 Node 端 `pick591GeoRows` 挑 20 筆 | 把 `pick591GeoRows` 的挑選述詞（缺座標或可信來源、`community_id > 0 AND geo_source <> 'community' AND 不在 community_cache`）下推進 SQL，並加 `LIMIT`；`ORDER BY` 的 watched-first 若無法下推就先用 `last_seen_at DESC` 取一批再在 Node 端排序 | **屬外部抓取／補定位路徑**（紅線：不准動）；下推述詞會改變「哪 20 筆先被補」的順序 ⇒ 需要沙盒輪次驗證 |
| `SELECT (SELECT COUNT(*) … NOT EXISTS …)`（`listingDistrictPrefilter.districtProjectionVerified`） | +7,742ms／15 次（516ms） | 每次請求兩個完整度證明；`missing` 那一支要掃 `listings`（335MB） | 只快取「同一個 `data_revision`」——但正式庫 revision 每秒前進 ⇒ 結構上不會命中；要真的收斂得把 `missing` 換成「用主鍵 index-only 掃」的寫法或改成維護端寫標記 | 少算風險（投影滯後時必須退回完整掃描）；需要新的等價證明 |
| `SELECT SUM(CASE WHEN COALESCE(offline…`（`listingStats.loadInputs` 的 `statusCounts`） | +7,137ms／15 次（476ms） | 每請求一次、對「shared search pool」做聚合，與候選掃描分開 | 與候選掃描合併到同一趟（`FILTER` 聚合視窗）——但它的範圍比候選**寬**（未縮行政區／價格）⇒ 不能直接併 | 改了就是改 `offline`／`offlineConfirmed` 兩個計數的口徑 |
| `SELECT COUNT(*) AS n FROM listings WHERE (fixture_namespace IS NULL OR …)`（`countProductListings`） | +4,913ms／15 次（328ms） | 依 `data_revision` 版本化快取，但正式庫 revision 一直前進 ⇒ 每請求都跑（repro 暖 23ms；正式 328ms） | 已有 `idx_listings_fixture_namespace(fixture_namespace, post_id)`；可改成兩個 index-only `COUNT(*)`（`IS NULL` ＋ `= ''`，兩者互斥）— repro 實測 23ms → 21ms（**在這個庫沒有效益**，正式庫要另外量） | 幾乎無；但要在正式庫量過再決定 |
| `SELECT DISTINCT search_key FROM listings`（`buildSearchKeysFromPg` 的展開） | +4,166ms／15 次（278ms） | 每請求展開一次；`db.js` 的 SQLite 版有 8 秒 TTL，PG 版沒有 | 加一個 **短 TTL（例如 8 秒，與 SQLite 同一個值）的行程內快取**，鍵含 `data_revision`／表大小 | 新資料的 search_key 最多晚 8 秒被涵蓋（與 SQLite 行為一致）；要在 `crawlerWrites` 的寫入路徑確認不需要立刻可見 |

（`FROM settings` 3,856 次／`user_listing_flags` 2,007 次那兩條 N+1 不在窗口前五名，但單次
2–3ms 合計約 8.6%：要收斂就是把它們改成「一次讀回整份再在 Node 端過濾」——`buildSearchKeysFromPg`
已經讀過 `settings`／`user_settings`，把那兩份結果傳給後續每個呼叫點即可；風險是呼叫點分散，
漏傳會靜默退回 N+1。）

## 4. 索引（已套在正式庫，`004_member_listing_stats_indexes.sql`）

三顆索引由 Owner 以 `psql -X -w -v ON_ERROR_STOP=1`（無 `--single-transaction`）套用，
`indisvalid=true`（1,320kB／56kB／40kB）。

⚠️ **不要**把 `004` 接進 `db.js:877` 的 `SCHEMA_MIGRATIONS`：`runMigrations` 每條包在
`BEGIN/COMMIT`，`CREATE INDEX CONCURRENTLY` 會踩 `PreventInTransactionBlock`。
`v3/test/member-district-prefix-index.test.js` 會檢查遷移檔內烘進的 367 個行政區鍵與
`regions.js` 一致（順序也要一致，否則部分索引不會被採用）。
