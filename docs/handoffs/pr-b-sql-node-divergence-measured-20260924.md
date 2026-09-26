# PR-B 量測：SQL-first 與 Node 的結果差異（same-house affiliate）2026-09-24

> ## ⚠️ 更正（依 astra6 決策文件 §1.1，2026-09-24）
>
> 本文件的量測是在**生產 SQLite 快照（`/data/v3.db`）**上做的，屬於「同一份 DB、兩條管線」的比較。
> 它是**有效的語意反例**（證明未完成同屋源語意的 SQL-first 不等價），
> **但不可解讀為「生產 PG 第一頁已有 30% 重複」的直接測量** ✗ —— 正式 PG 的影響須另行量測。
>
> **PG 端事實（同日唯讀實測，西屯區）**：候選 **6,226**、帶 peer 指標 **2,581（41.5%）**、
> peer 落在同一候選集合內 **2,526（40.6%）**⇒ 40.6% 是「可能被 Node 排除」的**上界**
> （實際排除數需 Node 角色推導，不做近似）。
>
> 另更正用語：`primary_listing_id` 的來源是 `Number(row.match_post_id) || 0`
> ⇒ 它只是 **peer 指標**，不是「已選出的 primary」。
>
> 後續處置見 `docs/handoffs/pr-b-plan-from-astra6-decisions-20260924.md`（先做 B：PG-fed Node，再做修正版 C）。


## 一、量測方法（可重跑）

同一組 args 分別跑兩條路徑，比較 post_id 集合與 `totalMatched`：

- Node：`listListings(args)` —— 完整管線（`attachSameHouseRoles` ＋ `listingMatchesListFilter` ＋ …）
- SQL ：`listListingsSqlFirst(args)` —— SQL-first（現行 builder）

```bash
# 腳本：/tmp/affiliate-diff.mjs（內容見本文件附錄），需先同步 src：
bash v3/scripts/run-in-container.sh /tmp/affiliate-diff.mjs
```

## 二、實測結果（生產 SQLite /data/v3.db，唯讀）

```json
{
  "district": "西屯區",
  "nodeCount": 300, "sqlCount": 300,
  "nodeTotalMatched": 4259,
  "sqlTotalMatched": 6023,
  "sqlOnlyCount": 91,
  "sqlOnlySample": [22053796, 22053892, 22054118, 22054159, 22054184, 22054221, 22053134, 22053142],
  "detail": {
    "22053134": {"match_post_id": 22029031, "match_verdict": null, "same_house_role": null},
    "22053142": {"match_post_id": 22029040, "match_verdict": null, "same_house_role": null},
    "22053796": {"match_post_id": 22012203, "match_verdict": null, "same_house_role": null}
  }
}
```

### 判讀

| 指標 | 數值 | 意義 |
|---|---|---|
| `totalMatched` | Node **4,259** vs SQL **6,023** | SQL 多 **41%** ✗ |
| 第一頁差異列 | **91 / 300（約 30%）** | SQL 有、Node 沒有的列 ✗ |
| 差異列的 `match_post_id` | **全部非空**（22029031／22029040／22012203 …）| 正是 **same-house 配對列** ✓ |

⇒ **結論：SQL-first 路徑（含已上線的 `filter=all`）會回傳 Node 會排除的同源配對列**，
第一頁即多出約 30%，`totalMatched` 多 41%。這**不是本輪改動造成**（既有路徑），但屬於 PR-B／GATE-4 範圍，
且 GATE-4 的「完整 ID 集合、total、下一頁一致」目前**不成立**。

## 三、修正方向（先讀語意，再用同一量測驗收）

1. `attachSameHouseRoles`（`db.js:3353`）以 `match_post_id` 成對配對，並且只有**兩側都在候選集合
   （或可由 provider extras 取得）**時才指派角色；分配用 `preferPrimaryListing(row, peer)` 決定誰是 primary。
2. `listingIsMainListAffiliate(row, filter)`（`personalFlags.js:291`）在 `filter=all` 下排除「非 primary 的那一側」
   （`same_house_split` 不適用、`primary_offline && offline !== 1` 不適用）。
3. ⇒ SQL 端要以 **self-join**（`listings.match_post_id` ↔ peer）表達，並以與 `preferPrimaryListing`
   相同的判斷挑出「應被排除的一側」；投影已有 `primary_listing_id` 可用，但**仍需確認 `preferPrimaryListing`
   的完整條件**（欄位優先序）才動手。
4. **驗收方式就是本文件的重跑**：修正後 `sqlOnlyCount` 應為 **0**、且 `nodeTotalMatched == sqlTotalMatched`。
   在那之前不得宣告 `filter=all` 的 SQL 路徑等價。

## 四、附錄：量測腳本

```js
// /tmp/affiliate-diff.mjs（重點節錄）
import { listListings, listListingsSqlFirst } from "./src/db.js";
// 取一個真實行政區（會員路徑的 builder 需要 districts 才算在 envelope 內）
const ARGS = { userId: 0, searchKeys: [], settings: {}, sort: "newest", limit: 300, offset: 0,
               filter: "all", districts: [district] };
const nodeRes = listListings({ ...ARGS });
const sqlRes  = listListingsSqlFirst({ ...ARGS });
// 比較 post_id 集合，列出 sqlOnly（SQL 有、Node 沒有）並印出其 match_post_id
```
