# 同屋源主卡／次卡（affiliate）折疊 — 讀取端現行語意完整還原規格

> 最後校對：2026-10-12（Owner 當日裁示已併入：五項定案見 §6、(B) 方案落地見 §6.3~§6.6；
> **Owner 2026-10-12 群內代表裁決（零容差）已併入 §1.4／§1.5／§6.7／§6.8**）
>
> 本文件是「把 same_house_role 折疊變成 SQL 可表達」的**唯一語意權威**。
> 每條都附 `檔:行`。SQL 折疊（視窗函式／遞歸 CTE）與寫入端固化欄都必須以本文件為準，
> 與讀取端逐位元一致（含 fallback 與處理順序）。

## 0. 結論摘要（訪客路徑 uid=0）

- 訪客路徑 `splitPairs` 為空（`loadUserSplitPairSet(0)` → 空 Set，`db.js:3567-3579`）、
  `personalIndex` 為空（`attachSameHouseRoleSteps` 的 `hasPersonal = voteUserId && personal.size !== 0`
  → false，`db.js:3641`）。
- **2026-10-12 起改為「一群一主」＋「群內代表」**：分組鍵＝全域固化欄
  `listings.fold_component_root`（NULL ⇒ 自己一群，用 `post_id` 當鍵）；**代表列在「本次符合
  篩選條件的候選列」之內**用既有比較式 `sortGroupListings(...)[0]` 選出（`match.js:468`），
  同群其他候選列＝affiliate 被折疊。兩條路徑（Node `db.js attachSameHouseRoleSteps`／
  SQL `listingSearchSql.js foldRoleCte`）用**同一個定義**；Node 端**不再做 1-hop 走訪**。
- 單節點群（自身一群、沒有同群的第二個候選列）維持「無 role」＝留在主列表。
- SQL 折疊只有 `buildPublicListingsFoldSql` 在用（`listingSearchSql.js`）；`fold-role-sql-parity.mjs`
  是角色級守門腳本，`fold-endpoint-parity.mjs` / `fold-endpoint-symmetric-diff.mjs` /
  `fold-endpoint-pagination.mjs` 是端點級守門腳本（§6.8 兩層防線）。

## 1. 分組與鏈：有向邊、無向比較、先到先贏

### 1.1 邊的定義（有向）
- 每個 `listings` 列只有一個 `match_post_id`（指向「同屋源 peer」）。
- `linked` 集合＝候選集內「`match_post_id` 為真值 **且** `match_verdict !== "no"`」的列
  （`db.js:3600`）。
- 邊是**有向**的 `src → dst`（`src.post_id → src.match_post_id`）。實測 repro：
  41,210 條有效邊中 **37,518 條單向、3,692 條雙向**（一側存 match_post_id、另一側沒有）。
- 邊的「處理順序鍵」＝ **src.post_id**（`linked` 以候選集 `ORDER BY post_id` 升序建立，
  `publicListingSearchAsync.js:34` → `attachSameHouseRoleSteps` 依序迭代 `db.js:3637`）。

### 1.2 peer 解析（resolve）
- `resolve(id) = byId.get(id) || extras.get(id) || null`（`db.js:3634`）。
- `byId`＝候選集（post_id → row）；`extras`＝候選集外、但被 match_post_id 指到的列
  （`missing` 集合，`db.js:3612-3629` → `source.extras([...missing])`，`db.js:3630-3633`）。
- `extras` 列**不會被標 role**（`assignRole(byId.get(mid))` 只對 byId 內有效，`db.js:3660`），
  但它參與 `preferPrimaryListing(row, peer)` 的比較（影響 `row` 的 role）。

### 1.3 邊「effective」與否（整條 pair 一起跳過）
迴圈內對每條邊先做三個閘（`db.js:3640-3647`）：
1. `!peer || peer.match_verdict === "no"` → skip（`db.js:3642`）。
2. `housepriceNotDisplayReady(peer) || housepriceNotDisplayReady(row)` → skip **整條**（`db.js:3643`）。
3. `splits.has(votePairKey(row.post_id, mid))` → 只標 `row.same_house_split = true` 並 skip；
   訪客 splits 為空，永不發生（`db.js:3644-3647`）。

### 1.4 role 指派（2026-10-12 起：一群一主 ＋ 群內代表）
```
// db.js attachSameHouseRoleSteps（PG 讀取端）
groups = groupBy(候選列, rootKey)          // rootKey = fold_component_root（NULL ⇒ s<post_id>）
if (hasPersonal) union(同一 personal.groupKey 的候選列的 rootKey)   // 個人併組不固化（§6.5）
for 每個群 G（|G| ≥ 2 個候選列）:
  eligible = G 中 offline_confirmed ≠ 1 且 !housepriceNotDisplayReady 的成員（Owner③）  // db.js:3783
  primary  = sortGroupListings(eligible, now)[0]        // 唯一比較式（match.js:468，未改）
  role     = (post_id === primary.post_id) ? "primary" : "affiliate"
  same_house_primary_offline = Number(primary.offline) === 1
  same_house_group_watched / _hidden = 群內候選列的聯集（Owner③，§6.6）
```
```
-- listingSearchSql.js foldRoleCte（SQL 讀取端；同一個定義）
cand  = listings WHERE <本次篩選>                     -- 本次符合篩選的候選列
elig  = cand ∩ (offline_confirmed ≠ 1) ∩ display_ready，且 fold_component_root IS NOT NULL
winner= row_number() OVER (PARTITION BY fold_component_root ORDER BY <§4.3 排名>) = 1
fold_role = cand LEFT JOIN winner → rn=1 → 'primary'，同群其他 cand 列 → 'affiliate'
```
- **代表列一定在候選列之內**：`ranked` 的輸入是 `cand`／`elig`，**不再掃整個分量**。
  這消除了兩個既存成因：(1) SQL「全域主卡不符本次篩選 ⇒ 整群消失」（實測 套房 −1,032 列
  ＝−5.0%、baseline −1,059）；(2) Node「候選集＋1-hop ⇒ 鏈狀分量被切開」（實證
  `root=22075220`：33 列同租金 10999 的線狀鏈，舊 SQL 出 1 列、舊 Node 出 9 列／7 個 primary）。
- 群內若沒有任何合格候選（全 `offline_confirmed=1`／未就緒）⇒ 該群 role 一律 NULL（不折疊）。
- `same_house_split`：PG 讀取端沿用 §1.3 第 3 條，split 列不進圖、維持無 role、留在主列表；
  個人 split／併組**不固化**（§6.5），只在 Node 讀取端疊加。
- **同群只顯示 1 列＝代表列（Owner 2026-10-16 裁示，已取代舊的補償條款）**：兩邊一致 ——
  `listingIsMainListAffiliate`（`personalFlags.js:312-316`）與 SQL 的 `affiliateExclusion`
  （`listingSearchSql.js:459`，`(f.role IS DISTINCT FROM 'affiliate')`）都只保留非 affiliate 的列。
  舊的補償條款（「代表列已下架（`offline=1`）而自己還在線」的 affiliate 留列表）**已移除**：
  代表列若只是「暫離」（`offline=1` 且 `offline_confirmed=0`），依 §6 定案 3b 自己就會顯示
  ⇒ 再補償次卡只會變成同群兩列。線上次卡改由展開面板觸達（資料面 `same_house.peers` 仍帶著它們，
  只是不進清單列）。完整裁示與量測見 §6.11。
- SQLite 沒有固化欄（也沒有折疊固化欄的寫入漏斗）⇒ 讀取端走 legacy union-find
  （`foldComponentRoot.js buildSameHouseComponents`，由 `yield*` 共用），**同一批列上兩條路徑
  逐列一致**由 `fold-shape-fixtures.mjs` 釘住。

### 1.5 代表列＝本次結果集內按比較式選出的群代表（**2026-10-12 Owner 定案**）
- 定義：`代表列(group) = sortGroupListings(候選列 ∩ 群 ∩ 合格, now)[0]`。分組鍵是全域固化欄，
  但**選誰當代表只用本次結果集內的那群候選列**。
- 這取代了舊的「全域主卡」語意（整群只有一個固定代表，主卡不符篩選就把整群吃掉）。
- **明碼代價**：同一個群在**不同篩選**下可能露出**不同代表列**（例如「一般」看到 25,000 元那列、
  「kind=whole」看到 21,000 元那列）。這是刻意的：讀者看到的代表列一定是「這次篩選真的看得見的
  最便宜列」，而不是一則被篩掉、點進去也看不到的主卡。連帶影響：
  1. `共 N 則` 仍是**全域** `peer_count`（不受篩選影響，Owner 定案 4）。
  2. 「特別關注／已隱藏」以**該群代表列**列示（§6.6）；逐則操作仍走展開面板既有端點。
  3. 分頁必須是「同一份有序集合的切段」（代表列在單一請求內是固定的）——實測見 §6.7。
- 鏈狀分量（≥15 列同群、橋式與非橋式）與「代表列隨篩選變動」兩類 fixture 見
  `v3/scripts/fold-shape-fixtures.mjs` 的 ⑥⑦⑧（`allOk:true`）。
- 舊的 first-incident-edge 會在同一連通群出現多個 primary；2026-10-12 起一個群只有一個贏家，
  `v3/test/same-house-fold-component.test.js` 第 1、2 條測試釘住這件事。

## 2. `preferPrimaryListing(a, b, now)` 比較式（`match.js:457-480`；`sortGroupListings` `match.js:482-489`）

逐層比較，**第一層分出勝負即回傳**：

| # | 層 | 規則 | 出處 |
|---|---|---|---|
| 1 | 可比較租金 | 一方 null 另一方非 null → 非 null 贏；兩者非 null 且不等 → **較小**贏 | `match.js:460-464` |
| 2 | 刷新時間 | `listingRefreshAt(a) - listingRefreshAt(b)`；`>0` → a 贏（較新贏） | `match.js:465-466` |
| 3 | last_seen_at 字串 | `String(b.last_seen_at).localeCompare(String(a.last_seen_at))`；`<0` → a 贏 | `match.js:467-468` |
| 4 | **591 平台優先**（Owner 2026-10-16） | `String(a.source \|\| "591") === "591"` 與對側不同 → 是 591 的那一側贏 | `match.js:469-476` |
| 5 | tie-break key | `listingTieBreakKey(a).localeCompare(listingTieBreakKey(b))`；較小贏 | `match.js:477-478` |
| 6 | post_id | `Number(a.post_id) <= Number(b.post_id)` → a 贏 | `match.js:479` |

**Owner 2026-10-16 的完整規則**：「租金便宜優先 → 更新時間較近 → **有 591 就用 591** → 都沒有就任選」。
本專案把最後一句「任選」實作成長度 5、6 的**固定序**（tie-break key → post_id），**不引入隨機**：
清單分頁是「同一份有序集合的切段」（§6.7），隨機挑會讓同一群在換頁之間換代表列。
這是對 Owner 原句的**刻意偏離**，偏離的只有「完全平手時選誰」這一段，不影響前三層。

SQL 側的同一個順序在 `listingSearchSql.js` 的 `foldRoleCte` `ranked` ORDER BY
（`listingSearchSql.js:649-665`）：`(rent IS NULL) ASC, rent ASC, refresh DESC, last_seen_at DESC,
(591 層) DESC, tie_key ASC, post_id ASC`；591 層寫成
`(COALESCE(NULLIF(e.source, ''), '591') = '591') DESC`（`listingSearchSql.js:657`），
來源正規化沿用 §6.10。**兩邊必須同序**，只改一邊就是「一群兩主」的來源。

### 2.1 `comparableRent(listing)`（`match.js:103-106`，行號已核對，未位移）
- `n = listingCompareCost(listing, { includeExtras: true })`；`Number.isFinite(n) && n > 0 ? n : null`。
- `listingCompareCost`（`listingCost.js:216-221`）：`rent = rentAmount(listing)`；
  `rent <= 0 → 0`；否則 `rent + extraMonthlyAmount(listing)`。
- `rentAmount`（`listingCost.js:205-214`）：`price_num >= 1000` 直接取整；否則解析 `price` 文字；
  若 `0 < price_num < 1000` 視為「萬」乘 10000；再失敗回 0。
- `extraMonthlyAmount`（`listingCost.js:151-174`）：`parseJsonFees(extra_fees)` 各行
  `feeRowMonthlyAmount` 加總；否則 `extra_fee` 欄；再否則 `extra_fee_text`／`listingBlob`
  named 月費。結果可能為 undefined（無額外費用）→ 加總時視 0。

### 2.2 `listingRefreshAt(listing, now)`（`match.js:406-409`；解析器 `listingRefreshParts` `match.js:419-439`）
解析 `refresh_time`（**相對字串**，例「16 小時內更新」），越新越大：
- `剛剛` → `now`；`N 秒前` → `now - N*1000`；`N 分鐘前` → `now - N*60_000`；
  `N 小時(前|內)` → `now - N*3_600_000`；`今日|今天` → `now`；`昨日|昨天` → `now - 86_400_000`；
  `N 天前` → `now - N*86_400_000`；其餘 `Date.parse(raw)`（絕對時間）。
- fallback：`Date.parse(last_seen_at)` 有限則用之，否則 **0**。

> ⚠️ **關鍵**：`refresh_time` 同時存在「相對字串」與「絕對字串／空」三種（repro 實測：
> 小時 74,964、空 20,133、絕對 14,644、天前 12,032、昨日 5,175、分鐘前 140）。
> 因此固化時**不能只存一個「烘焙的絕對時間戳」**：相對字串烘焙時用寫入當下的 `now`，
> 讀取時用讀取當下的 `now`，兩者相減（相對 vs 絕對混比）會漂移、破壞 100% parity。
> 必須拆成「相對 offset（ms）」＋「絕對 ms」＋「kind」三欄（見 §4.2），讀取時以 `now` 參數還原。

### 2.3 `listingTieBreakKey(listing)`（`match.js:441-445`）
- `` `${source}:${source_id || url || post_id}:${post_id}` ``（source_id 空則依序退 url、post_id）。

## 3. 旁路條件與過濾

### 3.1 `housepriceNotDisplayReady(row, provider)`（`db.js:3022-3032`）
- `!decorationSourceEnabled(source, provider)` → true（not ready）。
- 非 houseprice 來源 → false（ready）。
- houseprice：`listingIsDisplayable({...row, source_enabled:true}, prep)`；`prep` 取
  `listingPrepRow(row.post_id, provider)`（`db.js:3062` → `provider.prep(id)`）。
  `listingIsDisplayable`（`listingPrep.js:32-41`）：`prep.display_ready === 1` 才可顯示。
- `decorationSourceEnabled`（`db.js:2969-2975`）：PG 路徑用 `provider.sourceEnabled(source)`
  （enabled crawl sources 集合）。

### 3.2 `listingIsMainListAffiliate(row)`（`personalFlags.js:312-316`）
```
!same_house_split && same_house_role === "affiliate"      // 2026-10-16 起沒有其他例外
```
（函式**沒有 `filter` 參數**：折疊判定與清單無關，三個清單一致；2026-10-12 定案①。
舊的補償條款 `&& !(same_house_primary_offline && Number(row.offline) !== 1)` 已於 2026-10-16 移除，見 §6.11。）

### 3.3 `listingMatchesListFilter(row, "all")`（`personalFlags.js:326-365`）
```
if (listingIsMainListAffiliate) return false;   // 次卡從主列表排除
dup(match_verdict==='yes') || confirmed(offline && offline_confirmed) || hidden → false
return !watched（2026-10-14 Owner 裁決：一般清單改為包含已瀏覽，僅排除特別關注；「未看過」語意自 2026-10-14 起不再適用於一般清單，實作見 v3/src/personalFlags.js 與 #751）;                     // 訪客 watched/viewed 皆 0
```

## 4. SQL 折疊的等價形式（本包實作依據）

### 4.1 role 的無順序等價（⚠️ 2026-10-12 起已過時：這是舊的 first-incident-edge 語意）
對每個**候選列** `X`：
1. `effective_edge(X)` ＝ 所有與 `X` 相接（`X` 是 src 或 dst）的邊中，滿足
   「src 在候選集、dst 可 resolve、兩端 verdict ≠ no、兩端 display-ready」者。
2. 取其中 **src.post_id 最小**的那條 `(src, dst)`。
3. `role(X) = X === prefer(src, dst) ? "primary" : "affiliate"`；無相接邊 → 無 role。
- 證明與 §1.4 逐對一致：`linked` 依 src.post_id 升序迭代，每條邊對其兩端做
  assignRole（各自先到先贏）；對固定 `X`，「第一條碰到 X 的邊」＝「X 相接邊中 src 最小」。
  該邊的贏家決定 X 的 role，與其他列是否已被指派無關（assignRole 是 per-target 檢查）。

### 4.2 需固化的數值欄（寫入端，值一律由既有解析函式算）
| 欄 | 型別 | 值（出處） |
|---|---|---|
| `fold_rent_num` | double precision | `comparableRent(row)`（`match.js:103`）；不可比較 → NULL |
| `fold_refresh_kind` | smallint | 0=missing、1=relative、2=absolute（由 `listingRefreshAt` 的解析分支決定） |
| `fold_refresh_rel_ms` | bigint | relative 的 offset ms（`剛剛/今日`→0）；非 relative → NULL |
| `fold_refresh_abs_ms` | bigint | absolute 的絕對 ms（或 last_seen_at fallback）；missing → 0；relative → NULL |

讀取端還原：`refresh(x) = CASE WHEN fold_refresh_kind=1 THEN $now - fold_refresh_rel_ms ELSE fold_refresh_abs_ms END`
（與 `listingRefreshAt(x, $now)` 逐位元一致，含 fallback 0）。

> 需把 `match.js` 的 `listingRefreshAt` 重構為「內部單一解析器 + 匯出 parts」，
> **不新增第二套解析**；`listingRefreshAt` 保持對外行為不變。

### 4.3 `preferPrimaryListing` 的 SQL 贏家判定（兩列 a、b）
```
win(a,b) =
  a.fold_rent_num NOT NULL 且 b 為 NULL            → a
  b.fold_rent_num NOT NULL 且 a 為 NULL            → b
  兩者非 NULL 且不等                                → fold_rent_num 較小者
  refresh(a) <> refresh(b)                         → refresh 較大者（較新）
  b.last_seen_at <> a.last_seen_at（字串比）         → b 較小者 = a 贏（即 last_seen_at 較大者贏）
  tie(a) <> tie(b)（`source:source_id/url/post_id:post_id`）→ 較小者
  否則 post_id 較小者
```
- 上述所有欄位除了 fold_* 之外均為 `listings` 原欄（`last_seen_at`、`source`、`source_id`、
  `url`、`post_id`、`offline`）。

## 5. 待 SQL 一併補齊的兩個反向缺口（非本文件核心，但同包交付）
- **searchKeys 訪客＝[]**：`buildPublicListingsClauses` 用 `searchWhere([], …)`（`db.js:8061`），
  而 `buildPublicListingSearchSql` 未傳 `searchKeys=[]` → 展開成 28 鍵（少算 2,265 筆）。
- **hidden**：候選 `where` 補 `COALESCE(hidden,0) != 1`（`listingMatchesListFilter` 的 hidden 分支，
  `personalFlags.js:347`；實務 44 筆）。

## 6. 2026-10-12 Owner 五項定案（本節優先於上面各節）

| # | 定案 | 實作位置 | 驗收測試 |
|---|---|---|---|
| 1 | 三個清單（一般／特別關注／已隱藏）呈現規則一致：**不再豁免折疊** | `personalFlags.js:312-316`（移除 `filter === "hidden" \|\| filter === "watched"` 的豁免） | `same-house-fold-component.test.js`「watched list folds…」 |
| 1b | 逐則「取消關注／解除隱藏」改由展開面板提供（不新增端點） | `public/index.html` `sameHouseGoneBtn()`；`POST /api/listings/:id/flags`（`server.js:5033`）body `{watched:false}`／`{hidden:false}` | 同上「same-house panel offers per-post…」（靜態斷言面板按鈕與端點契約） |
| 2 | **一般清單**排除 `watched ∪ hidden`（以「該列自己的個人旗標」為準），解除後回到一般清單 | `personalFlags.js:326-365`（`filter === "all"` → `!watched`，在 `personalFlags.js:358`；且 `hidden` 於上方即 return false） | 「general list excludes watched and hidden…」 |
| 3 | 確認下架（`offline_confirmed = 1`）**三個清單都不顯示**、**不參與選主** | 顯示：`personalFlags.js:337`；選主：`db.js:3816-3818`；群組成員集合：`listingCompare.js:9-13` | 「offline_confirmed rows are never primary…」 |
| 3b | **定案（2026-10-12 Owner）**：「尚（未）確認下架」＝`offline = 1` 且 `offline_confirmed = 0`（可能空號）**可以**當 primary，也**計入**「共 N 則」；**程式碼維持現況**（現況就是允許，不另改）。可比價／可顯示／可參與比較 | 未改（上述三處都只排除 `offline_confirmed`；「共 N 則」的 `peer_count` 在 `listingCompare.js:384`） | 「one row per same-house group: the representative stays listed even when temporarily offline」 |
| 3c | **定案（2026-10-16 Owner）**：同一個同屋源群在清單上**只顯示 1 列＝代表列**；代表列即使「暫離」（`offline=1`、`offline_confirmed=0`，依 3b）也照樣顯示；線上次卡只能從展開面板觸達。**舊的補償條款移除** | `personalFlags.js:312-316`（`listingIsMainListAffiliate`）；`listingSearchSql.js:459`（`affiliateExclusion`） | 「one row per same-house group…」（Node 端）；`fold-ci-parity.mjs` ⑮（端點級、Node＝SQL） |
| 4 | 「共 N 則」＝**群組真實大小**（截斷只准用於「列出幾則」） | 資料：`listingCompare.js:384`（`peer_count`）；前端：`public/index.html` `sameHouseTag()`（`count = peer_count + 1`） | 「bundle exposes the true group size…」「frontend renders 共 N 則…」 |
| 5 | 篩選按鈕文案「全部」→「一般」 | `public/index.html`（`data-filter="all"` 按鈕、`renderStats` 標籤、空狀態文案）；`helpQa.js:73` | 「general filter chip is labelled 一般」 |

### 6.1 「主卡被關注、次卡沒被關注」的邊界（Owner②要求出臺說明）
判定一律以**該列自己的** `user_listing_flags` 為準，**不繼承同組其他列**：
- 一般清單：主卡被關注 → 主卡不在一般清單（`watched` 排除），次卡沒被關注且是 affiliate
  → 次卡也被折疊（`listingIsMainListAffiliate`），**兩則都不在一般清單**。
- 特別關注清單：主卡在（`watched=1`）、次卡不在（`watched=0`）⇒ 只顯示主卡一列；
  使用者仍可在展開面板對次卡按「關注」把它加進特別關注（面板逐則操作）。
- 已隱藏清單同理（`hidden` 為準）。
這是**刻意**的：Owner②明文要求「以該列自己的個人旗標為準」，所以不做「同組同步旗標」。

### 6.2 三個清單的 `totalMatched` 語意變化
折疊只會**減少** affiliate 的列數，減少筆數 = 被折疊的 affiliate 筆數；非群組列的
`totalMatched` 不變（見 PR 描述的實測對照表）。

### 6.3 SQL 折疊的缺口與 (B) 方案（**2026-10-12 Owner 核准、本包落地**）
`foldRoleCte`（`listingSearchSql.js`）原本用 window function 逐邊算「first-incident-edge」，
與讀取端（`db.js attachSameHouseRoleSteps` 的連通分量）不一致：**鏈狀分量會出現多個 primary**
（A–B–C 時舊 SQL 會有兩個 primary），repro 實測 `fold-role-sql-parity.mjs` 只有 87.1341%
（不一致 23,768＝affiliate_flipped 23,341／primary_flipped 175）。精確連通分量在 18.4 萬列上
無法用純 SQL 達成時間門檻（實測：直接遞迴 69.7s、免剪枝 MATERIALIZED 10.2s、群組塌縮虛擬圖 3.3s；
訪客 SQL-first p50 = 2.88s）⇒ 改成**固化欄** `listings.fold_component_root`（Owner 准 (B)）。

### 6.4 `listings.fold_component_root`：形狀、DDL、刷新鏈（唯一一條）
```sql
ALTER TABLE listings ADD COLUMN IF NOT EXISTS fold_component_root bigint;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_listings_fold_component_root
  ON listings (fold_component_root) WHERE fold_component_root IS NOT NULL;
-- 檔案：v3/migrations/007_listings_fold_component_root.sql（不接 SCHEMA_MIGRATIONS：CONCURRENTLY 不能在交易內）
```
- **形狀取舍**：值＝該列所屬連通分量的 canonical label（成員中最小 `post_id`）；NULL＝單節點分量／
  split 列／尚未回填。挑 label 而不是「贏家 post_id」的原因：選主比較式裡的相對更新時間
  （`fold_refresh_kind=1`）要用請求當下的 `now`，固化贏家會隨時間過期；固化 label ＋ 讀取端用
  同一組 `fold_*` 輸入排名則不受時間影響。代價是讀取端要**再排名一次**（見下）。
- **讀取端（兩條路徑同一個定義；2026-10-12 Owner 裁決後）**：
  - SQL（`foldRoleCte`，不再算連通分量、也**不再掃整個分量**）：`cand`＝本次篩選的候選列
    （SELECT 清單一併帶出排名需要的 11 欄）→ `elig`＝`cand` 內合格者（`offline_confirmed ≠ 1`
    且 `source = ANY(enabledSources)` 且非「houseprice 無 `listing_prep.display_ready`」）→
    `ranked` 用與 `preferPrimaryListing` 逐條對應的 ORDER BY 取 `rn = 1` 當**代表列**；
    排名鍵順序＝`(rent IS NULL) ASC, rent ASC, refresh_ms DESC, last_seen_at DESC, tie_key ASC,
    post_id ASC`（§4.3 的 SQL 表達；`last_seen_at` **較大者贏**）。
  - Node（`db.js attachSameHouseRoleSteps`）：候選列已帶 `fold_component_root`（
    `listingCandidateRow.js` 的候選載體新增此欄；member list 與 public list 兩份都加）⇒
    **直接分組、不再 1-hop 走訪 match 邊**，同一段 `eligible`＋`sortGroupListings` 選代表。
    候選載體沒有這一欄時（SQLite）走 legacy union-find（§1.4）。
  - ⚠️ **讀取端硬依賴**：候選欄位含 `fold_component_root` ⇒ 欄位未部署時 SELECT 會 42703。
    部署順序因此是硬規則（見下／`docs/runbooks/5151_same_house_fold_deploy.md`）。
- **寫入端（唯一漏斗）**：`match.js refreshFoldColumns`（`d4854a0` 收斂出的同一條鏈）在 fold_* 寫完後
  呼叫 `foldComponentRoot.js refreshFoldComponentRoot(exec, postId)`；union-find **只有一份**
  （`foldComponentRoot.js buildSameHouseComponents`，`db.js` 的讀取端以 `yield*` 共用）。
  髒觸發＝群組成員進出、match 邊新增／撤銷（含 verdict 變 `no`）、`offline_confirmed` 變化、split 變化；
  閉包種子取「舊分量全體成員 ∪ 新舊 match 對端 ∪ 自己與鄰居的群組成員」，超過 20,000 節點就放棄
  （回報 `capped`，改跑全表回填；repro 實測最大分量 107）。
- **回填**：`v3/scripts/fold-root-backfill.mjs`（冪等：每次重算全表、只寫與現值不同的列；分批 2,000／批、
  每批一個交易；中斷後直接重跑）。落地順序硬規則（L-0595／L-0571）：ALTER → 回填 → **逐欄抽樣
  `columnMismatch = 0`**（`projection-freshness-check.mjs` 的 `foldRoot`）→ 才切讀取（部署新程式）。
- **髒事件 ⇒ 必須重跑回填**（完整清單與指令見 `docs/runbooks/5151_same_house_fold_deploy.md`：
  `crawlSources` 啟停、`listing_prep.display_ready`／`source`／`match_post_id`／`match_verdict`／
  `offline_confirmed`／`listing_group_members` 任一變更）。
- **權限**：DDL 與回填只跑隔離庫（`assertPgTargetAllowed`：repro／crawl_sandbox）。正式庫一律唯讀；
  正式庫回填屬發版動作，由 Owner 依 PR 描述的一次性指令清單執行。
- **部署閘門**：`refreshFoldColumns` 先用 `foldRootRefreshReady()` 探測（PG ＋ 欄位存在）才刷新 root；
  欄位還沒部署時不刷、也不計失敗（明確的部署閘門，不是吞錯）。

### 6.5 個人範圍輸入為什麼不固化（仍然正確的論證）
`fold_component_root` 只含**全域關係**：match 邊（三道跳過：verdict='no'／兩端 display-ready／split）＋
`listing_group_members`。不固化的是 uid 相關輸入：
1. `user_same_house_members`（會員自己併組）與 2. `user_match_votes` 的 split 票。
理由：(a) 一列只能存一個 root，而這兩者是 per-uid 的；(b) 訪客／SQL-first 路徑本來就沒有 uid 併組語意
（`fold-role-sql-parity.mjs` 的 ground truth 用 `userId = 0`，兩條路徑在 uid=0 下逐位元一致）；
(c) Node 讀取端（`attachSameHouseRoleSteps`）保留 per-request 併組，uid>0 的會員清單仍走 Node 路徑，
所以「SQL 讀固化欄」不會把它們的顯示改掉。
**2026-10-12 群內代表裁決後的狀態**：舊版「Node 用 `候選集 ∪ extras` 的分量、SQL 用全域分量」
造成的殘留差異（跨候選集邊界時主卡不同）**已消除**——兩條路徑現在都只在候選列內選代表
（Node 只多疊一層 per-uid 併組，SQL 端訪客 uid=0 本來就沒有這一層）。實測：端點級 35/35 全綠、
逐列對稱差兩個集合皆為空（§6.7）。

### 6.6 次卡跟著主卡走（Owner 2026-10-12 裁示③）
一群在清單裡**只有一列代表，且代表永远是群主卡**：
- **一般**：由**代表列（＝主卡）自己**的 `watched`／`hidden` 決定整群；次卡本來就被折疊
  （`listingIsMainListAffiliate` 先擋），所以不可能變成「逐則自判」。
- **特別關注**：群內**任一**成員 `watched` ⇒ 該群出現，出現的那一列是主卡（即使主卡自己沒被關注）。
- **已隱藏**：同上，任一成員 `hidden` ⇒ 以主卡列示。
- 實作：`db.js attachSameHouseRoleSteps` 在分量內算 `same_house_group_watched`／
  `same_house_group_hidden`（涵蓋這次候選集內所有成員），`personalFlags.js listingMatchesListFilter`
  用它決定 `watched`／`hidden` 清單是否以主卡列示。非對稱測試：
  `v3/test/same-house-fold-representative.test.js`（primary 未關注／affiliate 已關注 ⇒ 一般出現 primary；
  特別關注出現 **primary 而不是那則 affiliate**）。
- 逐則取消關注／解除隱藏仍走**既有**展開面板按鈕 `sameHouseGoneBtn()` → `POST /api/listings/:id/flags`
  （**不新增端點**）。
- 2026-10-12 群內代表裁決後，「特別關注／已隱藏」以**該群的代表列**列示（群級聚合仍是
  「群內任一候選列被關注／被隱藏 ⇒ 該群出現」，但出現的那一列是本次篩選選出的代表列）。
  「一般」由代表列自己的旗標決定（次卡本來就被折疊，不參與判斷）。

### 6.7 分頁穩定性的**有條件**結論（Owner 2026-10-12 R1；不得寫成無條件保證）
代表列會隨篩選而變 ⇒ 分頁與結果集必須是「同一份有序集合的切段」。**可宣稱的條件**（四者同時成立）：

1. **同一個 read snapshot**：一次請求一條連線（`withPgReadSnapshot`），比對時兩邊都在同一顆快照上；
2. **同一組篩選**（`kind`／`q`／`districts`／`sort`／`settings` 逐字相同）；
3. **固定的 `now`**（`context.now`／`asOf` 一次決定，`fold_refresh_kind=1` 的相對時間因此不漂移）；
4. **唯一排序鍵**：`ORDER BY` 以 `post_id` 收尾 ⇒ 全域嚴格遞增，不存在同鍵並列（`newest`／
   `price_asc`／`price_desc` 三種都一樣，見 §4.3 的 `tie_key ASC, post_id ASC`）。

在四者成立的條件下，實測（`v3/scripts/fold-endpoint-pagination.mjs`）：
offset 翻頁與 cursor 翻頁各自的合併結果與同一支查詢的完整有序序列**逐筆相同**，
`duplicate=0`、`missing=0`、`extra=0`、每頁 `total_count` 相同；覆蓋三種排序鍵
（newest／price_asc／price_desc）與候選層篩選（`q=101`、`q=15000+kind=whole`、`district=西屯區`），
頁面大小 500（小集合另加 40／7，cursor 另加 500）。

**明確不在保證範圍**：**翻頁中途改篩選**（改篩選＝重開分頁；此時代表列本來就可能換人，舊頁的
offset／cursor 不再有意義）、**跨快照**（新快照的資料已變）、以及在**非唯一排序鍵**上的分頁
（本語意不使用）。因此本節的結論一律寫成「在上述四條件下」，不寫「分頁穩定」。

### 6.8 三層防線：CI 合成種子（會紅）＋ 全量 drift（部署前必要）＋ 全量快照 parity（merge 前人工）
1. **CI（自動、每次 PR）**：`v3/scripts/fold-ci-parity.mjs`（`test.yml` 的 test-postgres job，
   gating）用**合成種子資料**跑角色級＋端點級比對，斷言**群成員集合**與**代表列 id**（不是只有筆數）：
   線狀鏈 ≥15 列同群、橋式／非橋式、以及「篩掉原代表」後重新選代表。**不使用任何正式資料**。
2. **全量 drift（部署前必要，不是抽樣）**：`v3/scripts/fold-root-drift-check.mjs` 在部署當下的資料上
   把分量**整表重算**與固化欄逐列比對，輸出 mismatch 筆數與 `post_id`，目標 0；零差時才以 `--stamp`
   寫下 `settings.foldRootDriftStamp`（＝開閘前檢的依賴）。
3. **全量快照 parity（merge 前人工）**：對凍結快照跑 35/35 端點 parity ＋ 逐列對稱差（兩方向都必須
   是空集合，L-0845）＋ 有條件的分頁穩定性（§6.7）。18.4 萬列不可能進 CI（時間與資料主權）。

### 6.9 開閘前檢（fail-closed）與交易隔離（Owner 2026-10-12 R3）
- **探測在哪裡做**：`foldComponentRoot.js foldSqlGateReady(exec)`，由
  `publicListingSearchAsync.js tryPublicListingsSqlFirst()` 在
  `PUBLIC_LISTINGS_SQL_FIRST === "1"` **之後**、任何折疊 SQL **之前**呼叫。
- **用哪條連線／交易**：呼叫端傳進來的 `exec` 就是**這個請求自己的 read snapshot client**
  （`withPgReadSnapshot` 開的那條）；不另開連線、不碰寫入路徑的交易。
- **探什麼**：(1) `pg_attribute` ＋ `to_regclass('listings')` 的 `listings.fold_component_root`
  （與寫入端 `foldRootRefreshReady` 同一條「不會失敗的查詢」；**不用** `information_schema`——它是跨
  schema 的，同庫別的 schema 有同名表就誤判，L-0869）；(2) `settings.foldRootDriftStamp` 存在且
  `mismatches === 0`（由 `fold-root-drift-check.mjs --stamp` 在全量零差後寫入）；
  (3) **戳記綁的資料版本＝當前資料**（`dataVersion {rows, maxPostId}` 對線上
  `SELECT count(*) , max(post_id) FROM listings`；不符／缺欄 ⇒ reason=`fold_root_drift_stamp_stale`）。
  升級層 2026-10-12 21:24：「僅有 stamp 不足」。離線複核（`rootsMd5` 全表聚合）見 runbook §1.1／§1.2。
  (4) **戳記綁的寫入世代鍵＝當前值**（升級層 2026-10-13 開閘硬條件）：戳記的 `writeGen` 對
  `settings.foldRootWriteGen`——缺欄（升級前寫的舊式戳記）⇒ reason=`fold_root_drift_stamp_gen_missing`；
  對不上 ⇒ reason=`fold_root_drift_stamp_gen_stale`。這一條才抓得到**原地 UPDATE root**
  （rows／maxPostId 都不變的刷新）：每一條寫入路徑（刷新漏斗／回填／CI 種子／fixture）都在同一交易
  把它 +1（`foldComponentRoot.js bumpFoldRootWriteGen()`）。
- **缺欄時的回傳形狀**：`foldSqlGateReady` 回 `{ok:false, reason:"fold_component_root_missing",
  detail:null}`；呼叫端**丟 `ListingSearchUnavailableError`**（`code=SEARCH_UNAVAILABLE`，
  `listingSearchHttp.js` 映射成 **HTTP 503**）並 `console.error("[fold-gate] …")` 告警——
  **不退回 Node 路徑**（降級會讓「清單看到的資料」與固化欄的真相無聲分裂）。
- **快取語意**：**失敗永久記**（同一行程修好依賴後要重啟才放行，刻意的 fail-closed）；
  **成功只記 60 秒 TTL 且以寫入世代鍵為快取鍵**（`FOLD_SQL_GATE_OK_TTL_MS`，0＝每請求重驗）——
  否則「資料一變就失效」會被行程內快取永久蓋住；只比 TTL 的話，原地 UPDATE root 之後最長 60 秒
  仍會吃舊的成功判定（2026-10-13 修：快取鍵＝`writeGen`，鍵一變就重驗，不等 TTL）。
- **交易隔離**：探測全部用不會拋錯的查詢（`pg_attribute`／`settings`；資料版本那條是普通 SELECT）
  ⇒ 不會把交易打成 aborted（25P02）。
  可重跑證據：`v3/test/fold-gate-transaction-live-pg.test.js`（BEGIN → 探測 → 同交易 CREATE TEMP
  TABLE ＋ INSERT → ROLLBACK；任何一步失敗就 25P02 紅），CI 的拋棄式 PG（沒有這一欄）走缺欄分支。
- **人工作業腳本**：`v3/scripts/fold-gate-stamp-verify.mjs`（唯讀）一次驗 runbook §1.1 的四項並
  用真 PG exec 呼叫 `foldSqlGateReady()`，全過才 rc=0。
- **關閘隔離**：`PUBLIC_LISTINGS_SQL_FIRST !== "1"` 時函式**第一行就 return null**（不碰折疊程式碼、
  不呼叫開閘前檢）⇒ 新路徑的任何損壞都傳染不到舊路徑；`v3/test/fold-sql-gate.test.js` 靜態釘住順序。

### 6.10 tie-break 邊界：空字串 source（零容差加固，2026-10-12）
- **規則**：SQL 端（`listingSearchSql.js foldRoleCte` 內 ranked 的 ORDER BY 第 6 鍵；2026-10-16 起
  第 5 鍵是「591 平台優先」，見 §2／§6.11）必須與
  `match.js listingTieBreakKey(listing)` **逐字等價**：
  1. 來源段：Node 是 `String(listing.source || "591")` ⇒ `source` 為空字串或 NULL 一律當 `591`。
  2. origin 段：Node 是 `String(source_id || url || post_id || "")`（三者都 falsy 才退到空字串）。
  3. 尾段：Node 是 `Number(post_id) || 0`（NULL／0 都寫成 `"0"`）。
  SQL 端因此寫成
  `COALESCE(NULLIF(e.source, ''), '591') || ':' || COALESCE(NULLIF(e.source_id, ''), NULLIF(e.url, ''), NULLIF(e.post_id, 0)::text, '') || ':' || COALESCE(e.post_id, 0)::text`。
- **為什麼一定要改**：舊式寫成 `(e.source || ':' || …)`。`source = ''` 時整串變成 `':<origin>:<post_id>'`，
  而 `':'`（0x3A）大於 `'5'`（0x35）⇒ 這一列排在任何 `'591:…'` 之後，**Node 卻把它當 `'591:…'` 排在前面**。
  平手（租金／更新時間／last_seen_at 全同）時兩條路徑就會選出不同代表列 ⇒ 一群兩主。
- **現況**：凍結基準（repro2／repro3，184,754 列）上 `source = ''` 為 **0 列**（NULL 亦為 0 列）⇒ 現況碰不到；
  但 schema 允許空字串（寫入端也有 `UPDATE listings SET source = ?`），屬零容差該釘住的邊界。
- **證據（可重跑）**：`v3/scripts/fold-shape-fixtures.mjs` 的 ⑨ 兩條 fixture——
  ⑨b tie-break 軸（TE：10 位數 post_id、`source=''`、`source_id`／`url` 皆空；TN：9 位數、`source='591'`），
  租金／更新時間／last_seen_at 全同 ⇒ 斷言 Node 與 SQL 選出的代表列 id 相同、且必為 TE；舊式表達式下這條
  會紅（SQL 選 TN）。指令：`PG_URL=… node v3/scripts/fold-shape-fixtures.mjs` ⇒ `allOk:true`、`rc=0`。
- **軸一（資格判定的 source 預設）＝已修，只改 SQL 側**：Node 資格（`db.js housepriceNotDisplayReady`）走
  `String(source || "591")` ⇒ 空字串／NULL 算「已啟用」；舊 SQL 的 elig 用原始 `c.source = ANY(?::text[])`
  ⇒ 空字串算「未啟用」⇒ 同一列在 Node 是**次卡**、在 SQL 是**整列從列表消失**。修法
  （`v3/src/listingSearchSql.js` foldRoleCte 的 elig；**`v3/src/match.js` 一行未動，比較式仍是權威**）：
  `COALESCE(NULLIF(c.source,''),'591') = ANY(?::text[])`，同段的 `<> 'houseprice'` 也套同一個正規化（NULL
  source 在 SQL 原本連 WHERE 都過不了，Node 卻當 `'591'` 合格）。資格軸與 tie-break 軸必須共用同一個正規化，
  否則兩軸會各自分岔。**為什麼改 SQL 不改 Node**：改 Node 會動到目前正式在跑的真實路徑，而 SQL 路徑預設 off；
  且 SQL 側排除該列會讓房子「從列表消失」，比 Node 側多列一筆更糟。**先前 D-0160 的「以 SQL 為準」初判作廢。**
  證據：fixture 內「把 `''` 塞進啟用清單」的 trick 已移除；⑨a（XE：`source=''`＋`source_id` 有值＋租金 10000；
  對端 `source='591'`＋租金 30000）在**自然啟用清單**下斷言 Node 代表列 id ＝ SQL 代表列 id ＝ XE
  （租金先分勝負 ⇒ 只測資格軸）⇒ `allOk:true`、`rc=0`。**反向對照（證明斷言會擋）**：把
  `listingSearchSql.js` 還原成修前版本再跑同一支 ⇒ `allOk:false`、`rc=1`，⑨a 選到 XN、⑨b 選到 TN。
  **真實資料零影響（強證明）**：`repro3`（184,754 列，`source` 空字串或 NULL 共 0 列）重跑
  `fold-endpoint-parity.mjs` ⇒ **35 個 combo 的 totalMatched 與修前逐筆相同**。
- **軸二（`localeCompare` vs 資料庫 collation）＝已量化判定（不再寫「未經驗證」）**：`match.js:467`
  （`last_seen_at`）與 `:477`（tie-break key，2026-10-16 起；591 層在 `:474-476`）都用 `localeCompare`；`listingSearchSql.js` 的 `COLLATE`
  命中 **0**（＝走資料庫預設 `en_US.utf8`）。在 `repro3` 上唯讀實測：
  1. 多成員群 **27,638 群／95,322 列**；勝負由 **`last_seen_at` 字串層**決定的 **4,421 群／11,100 列**；
     由 **tie-break key 字串層**（租金＋更新時間＋last_seen_at 全平手）決定的 **0 群／0 列**。
  2. 這 27,638 群中，SQL 的 `ORDER BY` 改成 `COLLATE "C"` 與原本 `en_US.utf8` **選出的代表列不同者 = 0 群**；
     Node `localeCompare` vs PG 預設 = 0；vs `C` = 0；Node `localeCompare` vs code-point = 0（分歧清單為空）。
  3. 三方（JS 判定／PG 預設／`C`）**一致** ⇒ 字串層只在其他軸全平手時才表決，且已用全量實證一致。
  4. `last_seen_at` 格式：184,754 列**全部是 24 octets 定寬 ISO8601**（不合此形者 0 列，沒有任何群混用不同
     寬度）⇒ **字串序＝時間序**；這一層沒有比 collation 更嚴重的軸（若格式不齊才會有）。
  5. 非 ASCII：全庫含非 ASCII 的 key 欄位只有 **1 列**（`source_id`，`post_id=2414061000`，char_length 8／
     octet_length 12，`fold_component_root IS NULL` ＝孤列、不進群內排名）⇒ 不影響排序判定。
  可重跑指令（只 SELECT）：`set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a;`
  `PG_URL=<15435/repro> node v3/scripts/fold-tiebreak-collation-probe.mjs`
  ⇒ `winnerDiffs` 四個數字全 0、`divergencesTotal:0`、`last_seen_at_format.notIsoFixedWidth:0`。
  未防到的殘餘（**不是** collation）：`fold_refresh_kind=1` 的相對更新時間隨請求時間平移，但同群內一起平移、
  不改相對序；只有 kind=1 與絕對時間列混用時才會變，那是既有的 `fold_refresh_*` 語意。
- **這兩條軸＋collation 軸的 CI 守門**：`v3/scripts/fold-ci-parity.mjs`（`.github/workflows/test.yml:157`
  gating）新增三組合成種子，斷言 Node 代表列 id ＝ SQL 代表列 id：⑫ tie-break 軸（`source=''` ＋
  `source_id`／`url` 皆空 ＋ post_id 位數不同）、⑬ 資格軸（`source=''` ＋ `source_id` 有值 ＋ 租金不同）、
  ⑭ collation 軸（key 只差一個標點：`'A-B'` vs `'AB'`、`'x.y'` vs `'xy'`）。
  （2026-10-16 追加第 ⑮ 組：代表列 `offline=1` 未確認 ＋ 線上 affiliate ⇒ 端點恰好 1 列，見 §6.11。）

### 6.11 2026-10-16 Owner 裁示：同群只顯示 1 列（代表列）＋「591 平台優先」寫進比較式

**症狀**：同一個同屋源群在清單出現**兩列**，各自主物件不同。Owner 2026-10-16 截圖案例＝標題
`中山北路六段靜巷公寓2樓`：591 `post_id=22033530`（`offline=1`、`offline_confirmed=0`，暫離）與
住商 `hbhousing post_id=2246774123`（線上），兩列租金都是 30,000；群鍵 `fold_component_root=21969185`
（同群第三列 21969185 是 `offline_confirmed=1`，不顯示也不參與選主）。

**成因**：`personalFlags.js` 的 `listingIsMainListAffiliate` 與 `listingSearchSql.js` 的
`affiliateExclusion` 各有一條**補償條款**——「代表列是 `offline=1` 而這列 affiliate 的
`offline<>1` ⇒ 這列 affiliate 仍留列表」。那是 2026-10-12 定案 3b **之前**寫的（當時假設
代表列暫離就看不到代表列）；3b 之後代表列自己就會顯示 ⇒ 補償條款變成「代表列與次卡同時出現」。

**修正（三個檔）**：
1. 兩邊都只保留非 affiliate：`personalFlags.js:312-316`、`listingSearchSql.js:459`。
2. 「有 591 就用 591」明文寫進比較式：Node `match.js:469-476`、SQL `listingSearchSql.js:657`，
   位置都在 `last_seen_at` 之後、tie-break 之前（§2 比較式表）。
   這一層**不引入隨機**：清單分頁需要唯一全序（§6.7），末段仍用固定序。
3. 測試：`same-house-fold-component.test.js`「one row per same-house group…」（含展開面板仍可觸達）、
   `personal-flags.test.js` 的 `liveWhilePrimaryGone` 斷言反轉、`relist-match.test.js`「591 platform
   preference sits between last_seen_at and the tie-break key」、`same-house-fold-sql.test.js`（補償條款
   不得復辟＋591 層的位置）、`fold-ci-parity.mjs` 新增第 ⑮ 組種子（代表列 `offline=1` 未確認 ＋
   線上 affiliate ⇒ 端點恰好 1 列、Node 與 SQL 逐列一致）。

**量測（正式庫唯讀；資料持續被爬蟲寫入，數字會隨時間小幅變動）**：
- 修前 `q=中山北路六段靜巷公寓2樓` ⇒ **2 列**（22033530 primary、2246774123 affiliate 也在清單）。
- 修後同一條查詢 ⇒ **1 列**（22033530 primary），2246774123 仍出現在同一群的 `same_house.peers`。
- 因補償條款多出的列：planner 16:27 量測 8 群／27 列；本包 16:50 量測 **7 群／25 列**（同一時刻
  planner 的 `impact.mjs` 與本量測 SQL 逐項相同 ⇒ 差異來自正式庫持續更新）。修後 **0 列**、
  每群最多 1 列（33,118 群）。
- 591 層的影響：同一條查詢比較「加層前後」選出的代表列 id ⇒ **差異 0 群**（33,118 群，來源變動亦 0）。
  原因是現行來源（591／hbhousing／sinyi／houseprice／ddroom／housefun／self）在 tie-break key 的第一段
  就決定了同一件事（`'5'` < `'d'`／`'h'`／`'s'`）⇒ 這一層是保險，不是行為改變。
- 可重跑指令（只 SELECT）：
  `v3/scripts/fold-single-row-impact.mjs`（連線後立刻 `SET default_transaction_read_only = on`）。
  隔離庫：`set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a;`
  `PG_URL="$PG_LIVE_REPRO_URL" node v3/scripts/fold-single-row-impact.mjs` ⇒ `allOk:true`、`rc=0`。
  正式庫唯讀：`ALLOW_PRODUCTION_PG_TARGET=1 PGOPTIONS="-c default_transaction_read_only=on"`
  ＋正式庫 `PG_URL` ⇒ `v4_zero_diff.rep_changed:0`、`v5_compensation.new_groups_with_multiple:0`、`rc=0`。
