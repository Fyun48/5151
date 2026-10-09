# 公開列表搜尋 SQL-first vs Node 路徑 — parity 差分報告

日期：2026-10-09／10。隔離庫：`repro`（192.168.0.220:15434/repro，127,088 列，≠ 正式 182,954 列，僅相對幅度可外推）。
正式庫 `5151_shadow` **零寫入**（只 `BEGIN READ ONLY`／SELECT／EXPLAIN）。

## 一、差分工具怎麼跑

```bash
# 只連隔離庫（assertPgTargetAllowed 擋住非 repro/crawl_sandbox/tracker_test/repro2 的庫）
cd /tmp/ppd-wt
export PG_URL="$PG_LIVE_REPRO_URL"   # 來自 ~/.secrets/postgres/5151-live-repro.env
node v3/scripts/public-search-diff.mjs > parity-diff-30.jsonl          # 內建 30 combos
COMBO='{"kind":"whole","q":"套房","districts":["西屯區"]}' \
  node v3/scripts/public-search-diff.mjs                               # 單一 combo
```

每個 combo 輸出：`rawCount`（Node 候選數）、`nodeKeeps`（Node 全鏈存活數，= `totalMatched`）、
`sqlKeeps`（SQL-first keeps 數）、`sqlReason`（`out_of_envelope:*` 或 `sql_count_timeout`）、
`stages[]`（Node 每道過濾的 in/out/killed，`listingMatchesListFilter` 含 sub 分解
affiliate／hidden／dup／confirmed）、`diffSize`（SQL 留 Node 殺）、`nodeOnlySize`（Node 留 SQL 殺）、
`attribution`（差集每筆是被 Node 哪一道殺的）、`sample`（前 20 筆差集關鍵欄位）。

## 二、根因（照量到的數字，非猜測）

對 baseline（無關鍵字 kind=whole，`totalMatched=73,895`），SQL-first `totalMatched` 會算成 92,135。
差集拆成兩塊、方向相反：

| 差集 | 筆數 | 是哪一道 | 對應 SQL 缺口 |
|---|---|---|---|
| SQL 留、Node 殺（over-count） | **20,502** | `listingMatchesListFilter("all")` 的 **affiliate** 分支（`listingIsMainListAffiliate`，`same_house_role==="affiliate"`） | SQL-first 的 `where` **完全沒有**這道（同屋源「次卡」不該出現在主列表） |
| 同上（over-count，極小） | 3 | `passesDisplayFilters`（投影 low_floor/rooftop 極少數過時） | 投影值 vs 現列重算差 3 筆 |
| Node 留、SQL 殺（under-count） | **2,265** | SQL-first 多了 `search_key IN (28 keys) OR source='self'` | Node 公開路徑是 `searchWhere([])`（不篩 search_key）；SQL-first 卻用了 `context.searchKeys` |

`listingMatchesListFilter` 的 sub 分解（baseline）：`affiliate=23,364`、`hidden=0`、`dup=0`、`confirmed=0`
——即 dup／confirmed 已在候選查詢層排除、`listings.hidden` 在實務上不構成缺口（44 筆或已屬 affiliate），
**整道 23,364 的淘汰全部來自 affiliate**。此結論在 30 combo 全數一致（見下方表）。

## 三、30 combo 逐條件淘汰表（`raw/node/sql/diff(nodeOnly)`，affiliate 為 listingMatchesListFilter 的 sub）

| combo | raw | node | sql | diff(SQL多) | nodeOnly(SQL少) | affiliate_killed | pdf_killed | kind_killed | sqlReason |
|---|---|---|---|---|---|---|---|---|---|
| baseline | 108083 | 73895 | 92135 | 20505 | 2265 | 23364 | 10824 | 0 | — |
| q=套房 | 20364 | 14905 | — | — | — | 3182 | 2277 | 0 | sql_count_timeout |
| q=大安 | 3063 | 1927 | 2511 | 658 | 74 | 770 | 366 | 0 | — |
| q=電梯 | 11688 | 8770 | — | — | — | 2564 | 354 | 0 | sql_count_timeout |
| q=編號 | 21 | 14 | 15 | 2 | 1 | 2 | 5 | 0 | — |
| district=西屯區 | 6994 | 4832 | 6601 | 1769 | 0 | 1877 | 234 | 0 | — |
| district=中正區 | 1664 | 1105 | 1287 | 242 | 60 | 331 | 197 | 0 | — |
| district=西屯區+中正區 | 8618 | 5937 | 7888 | 2011 | 60 | 2191 | 431 | 0 | — |
| kind=whole | 108083 | 41019 | 50177 | 12436 | 3278 | 23364 | 10824 | 32876 | — |
| kind=suite_shared | 108083 | 31241 | 36023 | 7911 | 3129 | 23364 | 10824 | 42654 | — |
| kind=apartment | 108083 | 71954 | 85865 | 20305 | 6394 | 23364 | 10824 | 1941 | — |
| kind=elevator | 108083 | 46873 | 57135 | 14125 | 3863 | 23364 | 10824 | 27022 | — |
| kind=shop | 108083 | 218 | 243 | 43 | 18 | 23364 | 10824 | 73677 | — |
| kind=suite | 108083 | 31144 | 35925 | 7900 | 3119 | 23364 | 10824 | 42751 | — |
| sort=price_asc | 108083 | 73895 | 92135 | 20505 | 2265 | 23364 | 10824 | 0 | — |
| sort=price_desc | 108083 | 73895 | 92135 | 20505 | 2265 | 23364 | 10824 | 0 | — |
| excludeRooftop=false | 108083 | 75523 | 94044 | 20935 | 2414 | 23364 | 9196 | 0 | — |
| excludeLowFloors=false | 108083 | 83043 | 102620 | 22088 | 2511 | 23364 | 1676 | 0 | — |
| hasParking=true | 108083 | 15691 | 19837 | 4556 | 410 | 23364 | 69028 | 0 | — |
| wholeFloorOnly=true | 108083 | 41031 | — | — | — | 23364 | 43688 | 0 | out_of_envelope:settings |
| priceMax=20000 | 57387 | 40306 | — | — | — | 11215 | 5865 | 0 | out_of_envelope:settings |
| areaMax=30 | 108083 | 59599 | — | — | — | 18713 | 7673 | 0 | out_of_envelope:settings |
| kind=whole+sort=price_asc | 108083 | 41019 | 50177 | 12436 | 3278 | 23364 | 10824 | 32876 | — |
| q=套房+kind=whole | 20364 | 764 | 812 | 123 | 75 | 3182 | 2277 | 14141 | — |
| q=套房+district=西屯區 | 726 | 560 | 667 | 107 | 0 | 117 | 44 | 0 | — |
| kind=whole+district=西屯區 | 6994 | 2710 | 3490 | 1026 | 246 | 1877 | 234 | 2122 | — |
| q=套房+kind=whole+district=西屯區 | 726 | 33 | 36 | 5 | 2 | 117 | 44 | 527 | — |
| district=西屯區+sort=price_asc | 6994 | 4832 | 6601 | 1769 | 0 | 1877 | 234 | 0 | — |
| kind=whole+q=電梯+district=中正區+price_desc | 137 | 44 | 52 | 11 | 3 | 31 | 4 | 51 | — |
| excludeLowFloors=false+hasParking=true | 108083 | 17622 | 22076 | 4916 | 462 | 23364 | 67097 | 0 | — |

觀察：**所有 combo 的 `diff` 歸因幾乎全落在 `listingMatchesListFilter(all)`（affiliate）**；
`passesDisplayFilters` 只差 0–3 筆（投影值幾乎全 fresh）；`nodeOnly`（SQL 少算）是 search_key 反向缺口。

## 四、差集抽樣（baseline，前 20 筆，關鍵欄位值）

差集 20,505 筆全部是「同屋源次卡」：`match_post_id` 有值、`same_house_role==="affiliate"`。
抽樣（post_id / match_post_id / source / floor_name / low_floor / rooftop / kind_keys）：

| post_id | match_post_id | source | floor_name | low_floor | rooftop | kind_keys 前段 |
|---|---|---|---|---|---|---|
| 14691670 | 22042515 | 591 | 18F/26F | 0 | 0 | ,suite_shared,building,… |
| 15632000 | null | 591 | 8F/8F | 0 | 0 | ,whole,building,… |
| 16535661 | 22024113 | 591 | 4F/5F | 0 | 0 | ,suite_shared,… |
| 16616952 | 21898515 | 591 | 3F/3F | 0 | 1 | ,suite_shared,… |
| 17058040 | 17180875 | 591 | 2F/14F | 0 | 0 | ,whole,building,… |
| 17188138 | 21935008 | 591 | 2F/9F | 0 | 0 | ,whole,building,… |
| 17201969 | null | 591 | 2F/8F | 0 | 0 | ,suite_shared,… |
| 17267606 | 22041646 | 591 | 4F/5F | 0 | 0 | ,whole,… |
| 17494098 | null | 591 | 3F/3F | 0 | 0 | ,suite_shared,… |
| 17520178 | 22041512 | 591 | 3F/5F | 0 | 0 | ,suite_shared,… |
| 17575713 | 21967117 | 591 | 5F/5F | 0 | 0 | ,whole,… |
| 17784811 | null | 591 | 4F/5F | 0 | 1 | ,suite_shared,… |
| 17922818 | 21991747 | 591 | 2F/7F | 0 | 0 | ,suite_shared,… |
| 18055033 | 18912528 | 591 | 5F/5F | 0 | 0 | ,whole,… |
| 18151900 | null | 591 | 3F/5F | 0 | 0 | ,whole,… |
| 18566164 | 22030739 | 591 | 8F/11F | 0 | 0 | ,suite_shared,… |
| 18781506 | null | 591 | 11F/15F | 0 | 1 | ,whole,… |
| 21881044 | null | 591 | 6F/10F | 0 | 0 | ,suite_shared,… |
| 22028034 | 21886164 | 591 | 10F/13F | 0 | 0 | ,whole,… |
| 22039687 | 22038396 | 591 | 7F/14F | 0 | 0 | ,whole,… |

（`hidden` 全 0、`offline`/`offline_confirmed` 全 0、`match_verdict` null——證明差集不是 hidden/下架，是 affiliate。）

## 五、路甲 vs 路乙（選擇與理由）

要補的三個缺口，鏡射難度不同：

1. **search_key（反向，2,265 筆）＝路甲可解、且是 bug**：`buildPublicListingSearchSql` 應像 Node 公開路徑一樣
   傳 `searchKeys=[]`（`searchWhere([])`），而不是讓 `searchWhere(undefined)` 展開成 `context.searchKeys` 的 28 鍵。
2. **`listings.hidden`＝路甲可解（次要）**：`where` 補 `COALESCE(hidden,0) != 1`。實務上 44 筆多已屬 affiliate，影響小。
3. **affiliate（主因，20,502 筆）＝路甲不可行、路乙也達不到 100%（現況）**：
   - 路甲不可行：`listingIsMainListAffiliate` 依賴 `same_house_role`，而 `same_house_role` 是 `attachSameHouseRoleSteps`
     在**讀取時**用 `preferPrimaryListing`（`comparableRent`＋`listingRefreshAt` 解析 "16小時內更新" 這種**相對字串**
     ＋`last_seen_at`＋`tieBreakKey`）＋`splitPairs`（**逐使用者**票）＋`housepriceNotDisplayReady` 算出來的。
     `listingRefreshAt` 的相對時間字串解析**無法用 SQL 表達**，且 `splitPairs` 是 per-user 資料。
   - 路乙（把 `is_affiliate` 固化進投影）**pair-only 回填實測只有 92.89% 一致**（15,637/16,833，1196 筆不一致），
     **達不到要求的 100%**。不一致根因：`same_house_role` 不是「純 pair-local」——同屋源**鏈**（A→B→C）裡，
     一列的 role 是「第一個把它當 peer 的 pair」決定的，不是它自己的 `match_post_id` 決定的；
     naive pair-only 回填（看 row 自己的 match_post_id）會與讀取時（看 incoming peer 關係＋處理順序）不同。

**結論：parity 門沒過，維持 flag off、不開 PR、不 merge。** 下一包先把「affiliate 鏡射」這道硬骨頭定案
（要嘛照 `attachSameHouseRoleSteps` 的完整語意做寫入端固化＋鏈式重算，要嘛接受「affiliate 這道留在 Node、
其餘下推」的**部分下推**），search_key/hidden 兩個小洞可先修。

## 六、還剩什麼＋下一包

1. **search_key 反向缺口（bug，易修）**：`buildPublicListingSearchSql` 傳 `searchKeys=[]`，補單測。
2. **affiliate 鏡射（難）**：完整語意 = match chain＋`preferPrimaryListing`＋per-user split＋houseprice display-ready。
   建議先做「寫入端固化 + 鏈式重算」的設計與一致性證明，或評估「部分下推」。
3. **q 的 SQL-first count 逾時**（`q=套房`/`q=電梯` >25s）：`lower(title) LIKE '%…%'` 無 trigram；trigram 對非選擇性字無效，需另想。
4. **投影 `kind_keys`/`low_floor`/`rooftop`/`parking` 無索引**：kind 下推後 count 走投影 Seq Scan（~1s 可接受，但可再優化）。

（此檔＋差分工具 `v3/scripts/public-search-diff.mjs` 在 worktree `/tmp/ppd-wt` 分支 `perf-parity-differential`；共享 checkout 保持乾淨。）
