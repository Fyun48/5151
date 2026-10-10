# 同屋源主卡／次卡（affiliate）折疊 — 讀取端現行語意完整還原規格

> 本文件是「把 same_house_role 折疊變成 SQL 可表達」的**唯一語意權威**。
> 每條都附 `檔:行`。SQL 折疊（視窗函式／遞歸 CTE）與寫入端固化欄都必須以本文件為準，
> 與讀取端逐位元一致（含 fallback 與處理順序）。

## 0. 結論摘要（訪客路徑 uid=0）

- 訪客路徑 `splitPairs` 為空（`loadUserSplitPairSet(0)` → 空 Set，`db.js:3570-3582`）、
  `personalIndex` 為空（`attachSameHouseRoleSteps` 的 `hasPersonal = voteUserId && personal.size !== 0`
  → false，`db.js:3593`）。
- 因此訪客路徑**只跑 pair 迴圈**（`db.js:3637-3661`），不跑 personal group 迴圈（`db.js:3663-3705`）。
- `same_house_role` 由「**第一個碰到該列的 effective pair**」決定（先到先贏），
  處理順序＝`linked` 清單的 `post_id` 升序。
- 這個「先到先贏」可以改寫成**等價的無順序形式**：
  對每個列 `X`，取「與 `X` 相接、且 src.post_id 最小」的 effective edge，`X` 的 role =
  `X` 是否為該 edge 的 `preferPrimaryListing` 贏家。此等價性是 SQL 折疊的基礎（見 §4）。

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

### 1.4 role 指派（先到先贏）
```
primary = preferPrimaryListing(row, peer, now)   // db.js:3648
primaryId = Number(primary.post_id)              // db.js:3649
primaryOffline = Number(primary.offline) === 1   // db.js:3650
assignRole(target):                               // db.js:3653-3658
  if (!target || target.same_house_split || target.same_house_role) return;
  target.same_house_role = (target.post_id === primaryId) ? "primary" : "affiliate";
  target.same_house_primary_id = primaryId;
  target.same_house_primary_offline = primaryOffline;
assignRole(row); assignRole(byId.get(mid));       // db.js:3659-3660
```
- `target.same_house_role` 已存在就不改（先到先贏）。

### 1.5 鏈（transitive closure）問題的來源
同屋源鏈 A→B→C：`A.match_post_id=B`、`B.match_post_id=C`。列 B 同時是 edge(A,B) 的 dst
與 edge(B,C) 的 src。B 的 role 由「兩條 edge 中 src.post_id 較小者」決定，**不是**由
「B 自己的 match_post_id 那對」決定。naive「只看自己那對」的回填因此在鏈上與讀取端不一致。

## 2. `preferPrimaryListing(a, b, now)` 比較式（`match.js:363-378`）

逐層比較，**第一層分出勝負即回傳**：

| # | 層 | 規則 | 出處 |
|---|---|---|---|
| 1 | 可比較租金 | 一方 null 另一方非 null → 非 null 贏；兩者非 null 且不等 → **較小**贏 | `match.js:366-370` |
| 2 | 刷新時間 | `listingRefreshAt(a) - listingRefreshAt(b)`；`>0` → a 贏（較新贏） | `match.js:371-372` |
| 3 | last_seen_at 字串 | `String(b.last_seen_at).localeCompare(String(a.last_seen_at))`；`<0` → a 贏 | `match.js:373-374` |
| 4 | tie-break key | `listingTieBreakKey(a).localeCompare(listingTieBreakKey(b))`；較小贏 | `match.js:375-376` |
| 5 | post_id | `Number(a.post_id) <= Number(b.post_id)` → a 贏 | `match.js:377` |

### 2.1 `comparableRent(listing)`（`match.js:103-106`）
- `n = listingCompareCost(listing, { includeExtras: true })`；`Number.isFinite(n) && n > 0 ? n : null`。
- `listingCompareCost`（`listingCost.js:216-221`）：`rent = rentAmount(listing)`；
  `rent <= 0 → 0`；否則 `rent + extraMonthlyAmount(listing)`。
- `rentAmount`（`listingCost.js:205-214`）：`price_num >= 1000` 直接取整；否則解析 `price` 文字；
  若 `0 < price_num < 1000` 視為「萬」乘 10000；再失敗回 0。
- `extraMonthlyAmount`（`listingCost.js:151-174`）：`parseJsonFees(extra_fees)` 各行
  `feeRowMonthlyAmount` 加總；否則 `extra_fee` 欄；再否則 `extra_fee_text`／`listingBlob`
  named 月費。結果可能為 undefined（無額外費用）→ 加總時視 0。

### 2.2 `listingRefreshAt(listing, now)`（`match.js:332-351`）
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

### 2.3 `listingTieBreakKey(listing)`（`match.js:353-357`）
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

### 3.2 `listingIsMainListAffiliate(row, "all")`（`personalFlags.js:298-304`）
```
filter 非 hidden/watched；
!same_house_split && same_house_role === "affiliate"
&& !(same_house_primary_offline && Number(row.offline) !== 1)
```

### 3.3 `listingMatchesListFilter(row, "all")`（`personalFlags.js:306-328`）
```
if (listingIsMainListAffiliate) return false;   // 次卡從主列表排除
dup(match_verdict==='yes') || confirmed(offline && offline_confirmed) || hidden → false
return !watched && !viewed;                     // 訪客 watched/viewed 皆 0
```

## 4. SQL 折疊的等價形式（本包實作依據）

### 4.1 role 的無順序等價
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
  `personalFlags.js:307`；實務 44 筆）。
