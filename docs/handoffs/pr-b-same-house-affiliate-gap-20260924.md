# PR-B 發現：SQL 路徑缺少 same-house affiliate 排除（2026-09-24）

## 一、發現（附程式位置）

Node 的列表結果在 SQL 之後還會經過兩個**純 Node 後處理**：

```js
// db.js:6472-6475
rows = attachSameHouseRoles(rows, voteUid);                      // 推導 same_house_role／split 等
rows = rows.filter((row) => listingMatchesListFilter(row, filter));
```

`listingMatchesListFilter`（`personalFlags.js:299`）的**第一個條件**就是：

```js
if (listingIsMainListAffiliate(row, filter)) return false;       // personalFlags.js:300
// listingIsMainListAffiliate（personalFlags.js:291）：
//   filter 為 hidden／watched → 不適用；same_house_split → 不適用；
//   非 same_house_role === "affiliate" → 不適用；
//   same_house_primary_offline 且該列 offline !== 1 → 不適用；其餘 → 排除（return true）
```

**但 `listingSearchSql.js` 產生的 SQL 完全沒有對應條件** —— 它只有
`searchWhere`／可見性／行政區／價格上限／來源／areaMax／kind／wholeFloorOnly／q 這些子句。

⇒ 因此 **SQL-first 路徑（含已上線的 `filter=all`）可能回傳 Node 會排除的 affiliate 列**。
這不是本輪改動造成的，是既有路徑的語意缺口；但它屬於 PR-B／GATE-4（搜尋與投影）的範圍。

## 二、規模（生產 PG 實測，唯讀）

| 指標 | 數值 |
|---|---|
| 投影總列數 | 120,134 |
| **帶非零 `primary_listing_id`** | **30,195（約 25%）** |
| `listings` 有非零 `match_post_id` | 40,808 |
| `match_level` 非空 | 40,746 |
| `match_verdict = 'yes'`（重複確認） | 44 |
| `offline=1 且 offline_confirmed=0`（下架確認中） | 40 |

⇒ 潛在影響面很大（25%），**但實際排除與否取決於 `attachSameHouseRoles` 推導出的角色**，
因此**不能用這個數字直接推論差異量**；必須用等價性測試實際比對。

## 三、為什麼不能直接照抄到 SQL

- `attachSameHouseRoles(rows, voteUserId, provider)`（`db.js:3353`）需要 **provider**（裝飾資料）
  ⇒ 不是純函式，無法只在建構 SQL 時就算出角色。
- 角色還牽涉 `same_house_split`、`same_house_primary_offline` 等欄位，其中「primary 是否已下架」
  需要跨列查詢（投影有 `primary_listing_id` 與 `offline_state`，理論上可表達，但要先確認語意）。

## 四、處置計畫（依序，先驗證再改）

1. **先量測**：用 repo 既有的 Node↔PG parity 框架（`withMirroredSchema` + `strict: true`），
   建一個**含 same-house affiliate 列的 fixture**，比較 `filter=all` 的 `totalMatched` 與 `listings`：
   - 若兩邊一致 ⇒ 代表 affiliate 在現行資料／推導下不會出現在 SQL 結果（缺口只存在於理論）；
   - 若不一致 ⇒ 取得**具體差異樣本**（哪些 post_id、被誰排除）。
2. **再修正**（依量測結果擇一）：
   - (a) 在 SQL 加入等價條件（以 `primary_listing_id` + primary 的 `offline_state` 表達）；或
   - (b) 若語意無法在 SQL 精確表達 ⇒ **把含 affiliate 風險的查詢留在外框外**（維持 Node 回退），
     並在文件中明確標記，而不是用近似條件造成靜默差異。
3. **回歸**：把第 1 步的比對固化成測試，避免未來回歸。

## 五、這對 `filter≠all` 的意義

`filter` 各變體（`hidden`／`offline`／`suspected`／`unseen`／`viewed`）在 Node 端**同樣**要過
`attachSameHouseRoles` + `listingMatchesListFilter` ⇒ 四之 1 的比對是它們的**共同前置條件**。
在此之前，`filter≠all` 維持回退 Node 路徑（現況），不逐一硬推。

## 六、附帶確認（同一次調查）

- `listingMatchesListFilter` 其餘條件都是**純述詞**（`hidden`／`watched`／`viewed`／`offline`／
  `offline_confirmed`／`match_verdict`／`match_level`／`last_event`）⇒ 只要四之 1 確認清楚，
  這些都能以 SQL 表達。
- `filter=watched` 另有完全不同的管線（`applyBrowseIsolation`，且跳過行政區／價格上限／顯示篩選）
  ⇒ 獨立處理。
