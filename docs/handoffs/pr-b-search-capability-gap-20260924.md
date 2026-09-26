# PR-B：搜尋能力缺口清單（F3）與補齊順序（2026-09-24）

> 基準 commit `9c6b7b04f9801717cb6696e8e095fde4c309473f`。行號為該版本。
> 目的：ChatGPT 指令文件 F3 要求「關掉錯誤 fallback 還不夠，必須補齊現有產品查詢能力」。
> 本文件把「PG SQL 路徑目前實際支援什麼」逐條列出，作為補齊與驗收的依據。

## 1. PG 路徑目前的外框（`v3/src/listingSearchSql.js`）

`buildListingSearchSql()`（L54–）遇到以下任一條件就 `outOfEnvelope(...)` → 呼叫端回退 SQLite：

| # | 條件 | 行號 | 目前 | 說明 |
|---|---|---|---|---|
| 1 | `filter !== "all"` | L71 | ✗ 不支援 | 未瀏覽／特別關注／同屋源更新／疑似同屋源／已隱藏／下架等**全部分頁篩選** |
| 2 | `kind` 或 `sources` 或 `q` | L72 | ✗ 不支援 | 房屋類型、來源、**文字搜尋** |
| 3 | `sort` ∉ `["newest","price_asc","price_desc"]` | L73／L15 | ✗ 不支援 | 缺 **`fit_desc`（較適合）**、`commute_asc`／`commute_desc`（離公司近／遠） |
| 4 | `settings.priceMin`／`priceMax` > 0 | L79 | ✗ 不支援 | 會員租金範圍 |
| 5 | `settings.minBuildingFloors` > 0 | L80 | ✗ 不支援 | 最低樓層（建物） |
| 6 | `settings.areaMax` > 0 | L80 | ✗ 不支援 | 面積上限 |
| 7 | `settings.wholeFloorOnly === true` | L81 | ✗ 不支援 | 只要整層 |
| 8 | `settings.excludeKeywords` 非空 | L82 | ✗ 不支援 | 排除關鍵字 |
| 9 | `settings.excludeAgents`／`excludeAgentIds` 非空 | L82–83 | ✗ 不支援 | 排除房仲 |
| 10 | `settings.excludeBoxes` 非空 | L83 | ✗ 不支援 | 排除盒子／特殊類型 |
| 11 | `settings.commuteKm` > 0 | L84 | ✗ 不支援 | 通勤距離上限 |
| 12 | `districts` 空且非 allowAllDistricts | L98 | ✗ 回退 | 會員沒選區時的展開規則 |

**目前真正走 PG SQL 的只有**：`filter=all` ＋ 無 kind／sources／q ＋ 三種排序之一 ＋ 無上述 settings ＋ 行政區可解析
（加上已支援的顯示型篩選：`low_floor`／`rooftop`／`parking`，L21–25；價格上限含額外費用 `priceMaxIncludesExtras`，L121–131）。
公開路徑另有 `buildPublicListingSearchSql()`（L227–），同樣在 `kind || sources || q` 時回退。

## 2. 影響（與 F1／F2 一致）

- 會員搜尋在絕大多數真實使用情境（選了類型／來源／打關鍵字／用「較適合」排序／設了租金或排除條件）**都會回退 SQLite** →
  PG 模式下 = 讀凍結的節點資料庫（F2）；訪客搜尋更直接由 `listPublicListingsFast()` 走同步 Node／SQLite（F1）。
- 因此**不可先移除 fallback**（會讓上述情境直接 503 或錯誤），順序必須是「先補能力、再關 fallback」。

## 3. 補齊順序（建議）

1. **投影層**：確認 `listing_search_projection` 是否已具備上述篩選所需欄位（現有欄位見投影查核：`district/source/kind/rent/total_monthly_cost/area/floor/total_floors/elevator/parking/rooftop/low_floor/lat/lng/location_class/primary_listing_id/offline_state/commute_km/updated_at`）。
   - 已有：`kind`／`source`／`district`／`rent`／`total_monthly_cost`／`area`／`floor`／`total_floors`／`parking`／`rooftop`／`low_floor`／`elevator`／`commute_km`／`offline_state`。
   - 可能需要補：文字搜尋欄位（標題／地址的檢索欄位或 trigram）、`fit` 分數、排除關鍵字／房仲的判定欄位、`whole_floor`。
2. **SQL 層**：把 L71–87 的外框條件逐項實作（每項都要有 parity 測試，做法沿用 `listings-search-repository.test.js`）。
3. **排序**：`fit_desc` 與 `commute_asc/desc` 需要對應欄位與索引；計畫 §2.5 已註明 commute／fit 屬「優化非阻塞」，但本輪要求是**能力等價**，所以必須完成或明確標示不一致。
4. **移除 fallback**：等 1–3 完成、且以真實 API 驗證同一查詢在兩邊得到相同 ID 集合／排序／total 後，才移除
   `listingSearchAsync` 的「查詢不支援 → SQLite」與「例外 → SQLite」（F2）。
5. **錯誤語意**：PG 不可用時回 **503 ＋ 穩定錯誤碼**（不得顯示 0 間房源、不得偷偷回 SQLite）。

## 5. 修正與精確化（2026-09-24 補充，避免誤判缺口）

前一版把「PG 只涵蓋很窄的一片」寫得太寬。實讀 `listingSearchSql.js:100–140` 後確認，`filter=all` 這條路徑**已經實作**：

| 已實作 | 位置 |
|---|---|
| 搜尋鍵（`searchKeys`）與可見性條件 | L102–103（`deps.searchWhere`／`deps.listingVisibilityClauses`） |
| 行政區候選與價格上限候選 | L104–105（`appendDistrictCandidates`／`appendPriceCeilingCandidates`） |
| 已確認下架／`match_verdict='yes'`／被隱藏／已關注的排除 | L106–118 |
| 排序三種（`newest`／`price_asc`／`price_desc`）與 keyset 分頁、含「金額 0 視為無效」的處理 | L121–140 |
| 顯示型篩選（低樓層／頂加／車位） | L21–25 |
| 價格上限含額外費用（`priceMaxIncludesExtras`） | L121–131 |

→ 因此缺的是「**外框清單**（§1 的 12 項）」，不是整條路徑。

## 6. 每一項實作前必須先確認的語意（避免比不支援更糟）

不做「看起來像」的實作；下列每一項都要在實作前用 Node 路徑的同一份資料驗證語意（欄位單位、邊界、null 行為），再寫 SQL：

| 缺口 | 需要確認的事 |
|---|---|
| `settings.priceMin` | `cost` 的定義要與既有 `priceMaxIncludesExtras` 一致（L121）；`rent=0`（無效金額）要不要排除 |
| `settings.areaMax` | 單位是「坪」嗎？`area` 欄位的正規化方式與 null 行為 |
| `settings.minBuildingFloors` | 比較的是 `total_floors`（建物總樓層）還是 `floor`？`total_floors` 缺失時算不算通過 |
| `kind`（房屋類型） | Node 用 `kindsToQuery()` ＋ `listingMatchesKindKey()`（`floors.js:289–325`），而每個 key 可能看 `kind_name`／tags／標題（例如 `elevator` 看 `has_elevator`）。**設計決定**：在投影補一組「canonical kind keys」欄位（例如 `kind_keys text[]` 或對應的 bit/旗標欄位），由 `computeListingProjection()` 以**同一支** `listingMatchesKindKey()` 產生 → SQL 只做集合比對，才能保證與 Node 完全等價（不靠重寫一份判斷邏輯）。 |
| `sources` | `parseListingSources()` 的輸出面；`p.source` 是否即同一組 id（應可直接 `IN (...)`，但仍要驗一個 sample） |
| `q`（文字搜尋） | Node 搜尋哪些欄位（標題／地址／描述）、是否正規化（全半形、空白、大小寫）、是否用子字串比對；投影目前**沒有**這些欄位 → 需補檢索欄位（或 join `listings` ＋索引），並量測延遲 |
| `sort = fit_desc` | `fit` 分數怎麼算（`listingScore.js`）、是否 per-user（若是 per-user，投影不能存單一值 → 需改設計或維持 envelope 外） |
| `sort = commute_asc/desc` | 依賴使用者工作點與 `route_cache`／`route_jobs`（per-user）→ 投影的 `commute_km` 是否只對「主要使用者」有效？若 per-user 則必須在 SQL 以 join 計算 |
| `filter != "all"` | 各分頁（未瀏覽／已瀏覽／特別關注／同屋源更新／疑似同屋源／已隱藏／下架）目前的 Node 條件；多數可用既有 `user_listing_flags`／`listing_groups` 表在 PG 內表達 |
| `settings.wholeFloorOnly`／`excludeKeywords`／`excludeAgents`／`excludeAgentIds`／`excludeBoxes`／`commuteKm` | 各自的判定欄位來源（文字欄位需要投影補欄位；`commuteKm` 同 `commute` 排序的 per-user 問題） |

**順序不變**：先補能力（並以 parity 測試證明等價）→ 才移除 `listingSearchAsync` 的兩條回退（F2）→ 最後把 PG 不可用改成 503＋穩定錯誤碼。

- 每個篩選／排序條件都要有「Node 路徑 vs PG 路徑」的 ID 集合、順序、total、hasMore、nextCursor 完全相同。
- 真實 HTTP API：匿名與會員各跑一輪所有篩選與排序；PG 失聯時確認回 503（不回空清單）。
- 投影完整性前要先達成：`missing = 0`（回填中，見 `pr-b-projection-findings-20260924.md` §4）。
