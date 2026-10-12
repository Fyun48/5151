# 同屋源主卡／次卡（affiliate）折疊 — 讀取端現行語意完整還原規格

> 最後校對：2026-10-12（Owner 當日裁示已併入：五項定案見 §6、(B) 方案落地見 §6.3~§6.6）
>
> 本文件是「把 same_house_role 折疊變成 SQL 可表達」的**唯一語意權威**。
> 每條都附 `檔:行`。SQL 折疊（視窗函式／遞歸 CTE）與寫入端固化欄都必須以本文件為準，
> 與讀取端逐位元一致（含 fallback 與處理順序）。

## 0. 結論摘要（訪客路徑 uid=0）

- 訪客路徑 `splitPairs` 為空（`loadUserSplitPairSet(0)` → 空 Set，`db.js:3567-3579`）、
  `personalIndex` 為空（`attachSameHouseRoleSteps` 的 `hasPersonal = voteUserId && personal.size !== 0`
  → false，`db.js:3641`）。
- **2026-10-12 起改為「一群一主」**：role 不再由「第一個碰到該列的 effective pair」決定，
  而是先對 `候選列 ∪ extras` 建無向連通分量（① match 邊 ② `listing_group_members` 群組
  ③ `user_same_house_members` 個人併組），再對每個 |C| ≥ 2 的分量用
  `sortGroupListings(...)[0]` 選出**恰好一個** primary（`db.js:3682-3796`）。
  選主比較式本身沒有改（§2），改的是「誰跟誰同一群」與「一群只能有一個贏家」。
- 單節點分量（沒有任何邊、也不是任何 ≥2 群組的成員）維持「無 role」＝留在主列表。
- SQL 折疊只有 `buildPublicListingsFoldSql` 在用（`listingSearchSql.js:592`），
  它目前仍是舊的 first-incident-edge 視窗函式 ⇒ **與 Node 路徑已不一致**，
  需要用固化的分量欄（§6.3 的 (B) 方案）補齊；`fold-role-sql-parity.mjs` 是守門腳本。

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

### 1.4 role 指派（2026-10-12 起：一群一主／連通分量）
```
// db.js:3682-3796（attachSameHouseRoleSteps）
universe = byId（候選列）∪ extras（被指到但不在此請求內的列）
union-find:
  ① for row of linked：三道閘（§1.3）通過後 compUnion(row.post_id, mid)          // db.js:3709-3722
  ② 同一個 listing_group_members.group_id 的可用成員兩兩連通                      // db.js:3725-3747
  ③ 同一個 user_same_house_members.group_key 的宇宙成員連通（personalIndex）      // db.js:3748-3770
for 每個分量 C（|C| ≥ 2）:                                                      // db.js:3772-3796
  eligible = C 中 offline_confirmed ≠ 1 的成員（Owner③：確認下架不參與選主）
  primary  = sortGroupListings(eligible, now)[0]        // 唯一比較式（match.js:468）
  role     = (post_id === primary.post_id) ? "primary" : "affiliate"
  same_house_primary_offline = Number(primary.offline) === 1
```
- 只有「在候選列內」的成員會被寫回 role（`extras` 只參與比較，不輸出），與舊版一致。
- `same_house_split` 的列**完全不進圖**（沿用 §1.3 第 3 條），因此維持無 role、留在主列表。
- 補償條款保留：`listingIsMainListAffiliate`（`personalFlags.js:301-306`）仍讓
  「primary 已下架（`offline=1`）而自己還在線」的 affiliate 留在列表。

### 1.5 鏈（transitive closure）——已修
舊版（first-incident-edge）在鏈 A→B→C 上會讓 B 的 role 由「兩條 edge 中 src.post_id 較小者」
決定，同一連通群因此可以出現**多個 primary**（`docs/same-house-fold-spec.md` 舊版 §4.1 自己
承認這個不一致）。2026-10-12 起分量是 union-find 的連通分量，一個分量只有一個贏家；
`v3/test/same-house-fold-component.test.js` 第 1、2 條測試釘住這件事。

## 2. `preferPrimaryListing(a, b, now)` 比較式（`match.js:451-466`；`sortGroupListings` `match.js:468-475`）

逐層比較，**第一層分出勝負即回傳**：

| # | 層 | 規則 | 出處 |
|---|---|---|---|
| 1 | 可比較租金 | 一方 null 另一方非 null → 非 null 贏；兩者非 null 且不等 → **較小**贏 | `match.js:366-370` |
| 2 | 刷新時間 | `listingRefreshAt(a) - listingRefreshAt(b)`；`>0` → a 贏（較新贏） | `match.js:371-372` |
| 3 | last_seen_at 字串 | `String(b.last_seen_at).localeCompare(String(a.last_seen_at))`；`<0` → a 贏 | `match.js:373-374` |
| 4 | tie-break key | `listingTieBreakKey(a).localeCompare(listingTieBreakKey(b))`；較小贏 | `match.js:375-376` |
| 5 | post_id | `Number(a.post_id) <= Number(b.post_id)` → a 贏 | `match.js:377` |

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
  `personalFlags.js:307`；實務 44 筆）。

## 6. 2026-10-12 Owner 五項定案（本節優先於上面各節）

| # | 定案 | 實作位置 | 驗收測試 |
|---|---|---|---|
| 1 | 三個清單（一般／特別關注／已隱藏）呈現規則一致：**不再豁免折疊** | `personalFlags.js:301-306`（移除 `filter === "hidden" \|\| filter === "watched"` 的豁免） | `same-house-fold-component.test.js`「watched list folds…」 |
| 1b | 逐則「取消關注／解除隱藏」改由展開面板提供（不新增端點） | `public/index.html` `sameHouseGoneBtn()`；`POST /api/listings/:id/flags`（`server.js:5033`）body `{watched:false}`／`{hidden:false}` | 同上「same-house panel offers per-post…」（靜態斷言面板按鈕與端點契約） |
| 2 | **一般清單**排除 `watched ∪ hidden`（以「該列自己的個人旗標」為準），解除後回到一般清單 | `personalFlags.js:308-331`（`filter === "all"` → `!watched && !viewed`，且 `hidden` 於上方即 return false） | 「general list excludes watched and hidden…」 |
| 3 | 確認下架（`offline_confirmed = 1`）**三個清單都不顯示**、**不參與選主** | 顯示：`personalFlags.js:316-318`；選主：`db.js:3783-3785`；群組成員集合：`listingCompare.js:9-13` | 「offline_confirmed rows are never primary…」 |
| 3b | **定案（2026-10-12 Owner）**：「尚（未）確認下架」＝`offline = 1` 且 `offline_confirmed = 0`（可能空號）**可以**當 primary，也**計入**「共 N 則」；**程式碼維持現況**（現況就是允許，不另改）。可比價／可顯示／可參與比較 | 未改（上述三處都只排除 `offline_confirmed`；「共 N 則」的 `peer_count` 在 `listingCompare.js:379`） | 「compensation clause keeps the live affiliate…」 |
| 4 | 「共 N 則」＝**群組真實大小**（截斷只准用於「列出幾則」） | 資料：`listingCompare.js:379`（`peer_count`）；前端：`public/index.html` `sameHouseTag()`（`count = peer_count + 1`） | 「bundle exposes the true group size…」「frontend renders 共 N 則…」 |
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
- **讀取端**（`foldRoleCte`，SQL 端不再算連通分量）：`roots`（候選列的相異 root）→
  `comp`＝`JOIN listings ON fold_component_root = root` 的**一次索引查詢**（取回同分量所有列，
  含不在候選集者）→ `ranked` 用與 `preferPrimaryListing` 逐條對應的 ORDER BY 取 `rn = 1`；
  排名鍵順序＝`(rent IS NULL) ASC, rent ASC, refresh_ms DESC, last_seen_at DESC, tie_key ASC,
  post_id ASC`（§4.3 的 SQL 表達；`last_seen_at` **較大者贏**）。
- **寫入端（唯一漏斗）**：`match.js refreshFoldColumns`（`d4854a0` 收斂出的同一條鏈）在 fold_* 寫完後
  呼叫 `foldComponentRoot.js refreshFoldComponentRoot(exec, postId)`；union-find **只有一份**
  （`foldComponentRoot.js buildSameHouseComponents`，`db.js` 的讀取端以 `yield*` 共用）。
  髒觸發＝群組成員進出、match 邊新增／撤銷（含 verdict 變 `no`）、`offline_confirmed` 變化、split 變化；
  閉包種子取「舊分量全體成員 ∪ 新舊 match 對端 ∪ 自己與鄰居的群組成員」，超過 20,000 節點就放棄
  （回報 `capped`，改跑全表回填；repro 實測最大分量 107）。
- **回填**：`v3/scripts/fold-root-backfill.mjs`（冪等：每次重算全表、只寫與現值不同的列；分批 2,000／批、
  每批一個交易；中斷後直接重跑）。落地順序硬規則（L-0595／L-0571）：ALTER → 回填 → **逐欄抽樣
  `columnMismatch = 0`**（`projection-freshness-check.mjs` 的 `foldRoot`）→ 才切讀取（部署新程式）。
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
所以「SQL 讀固化欄」不會把它們的顯示改掉。**殘留差異（已知、已量測）**：Node 讀取端的分量是在
`候選集 ∪ extras` 上算的，SQL 讀的是全域分量；當分量跨越候選集邊界時，兩者的主卡可能不同
（正式庫唯讀的 parity 實測見 PR 描述）。這在「同一列只看一次折疊」的目標下是 SQL 端較嚴格的語意。

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
