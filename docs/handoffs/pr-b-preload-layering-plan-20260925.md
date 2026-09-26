# PR-B：preload 分層（候選 vs 頁面）— 分析與計畫（2026-09-25）

## 現況（已釘住的證據）
`v3/src/listingSearchNodePg.js`（單一快照改動後的行號）：
- **207**：候選列 `SELECT ${candidateColumns} FROM listings ${built.where}` ✓
- **212**：`createDecorationDataLoader({ exec, driver: "postgres" })` ✓
- **215**：`preloadDecorationProviderAsync({ exec, rows: raw, settings, userId: uid, matchVoteUserId: voteUid, sameHouse })`
  ⇒ **對「全部候選」做完整 preload** ✗（這是熱點）
- **224**：`paginateListListingsRows(rows, …)` → `paged.page`／`paged.pageIds` ✓
- **227**：頁面列 `SELECT * FROM listings WHERE post_id IN (…pageIds)` ✓

`v3/src/db.js` 的 `preloadDecorationProviderAsync`（3146 起）：
- **3163**：`const pageIds = [...new Set(list.map(row => Number(row.post_id)))]`
  ⇒ ⚠️ 變數名叫 `pageIds`，但**實際是「全部候選」** ✗（命名誤導；應為 `candidateIds`）
- **3165-3167**：`loader.personalFlagMap(voteUid)`／`personalIndex(voteUid)`／`splitPairSet(voteUid)`
  ⇒ **以使用者為尺度**（O(user)，與候選數無關）⇒ 便宜 ✓
- **3169+**：peers／同戶（`if (sameHouse)`）⇒ **逐 post**（O(candidates) 或更大）⇒ 貴 ✗

## 分層方案（計畫）
| 層 | 內容 | 尺度 | 現況 | 目標 |
|---|---|---|---|---|
| 候選層 | `personalFlagMap`／`personalIndex`／`splitPairSet` | O(user) | 已在 215 一次載入 ✓ | 維持（便宜且候選篩選確實在用）✓ |
| 頁面層 | peers／同戶列（`loadPeerRows`） | 逐 post ✗ | **隨全部候選膨脹** ✗ | **只對 `paged.pageIds` 載入** ✓（並改為批量群組載入 ✓） |

## 實作前必須先證明的問題（**阻擋點** ✗）
候選階段是否真的需要 peers？初步證據（本輪查到）：
- `applyListingFilter(rows, settings, provider)`（db.js **6231**）以 **屬性篩選**為主
  （`passesAttributeFilters(row, settings)` ✓）⇒ 與 peers 無關 ✓。
- `listingMatchesListFilter(row, filter)` ✓、`keepSelfListingForViewer(row, uid, …)` ✓ 皆為 **row-local**
  （只讀該列的 flags ✓）⇒ 與 peers 無關 ✓。
- **真正在候選階段就吃 provider 的是 `attachSameHouseRoles(rows, voteUid, provider)`**
  （`listingSearchNodePg.js` relations 階段）✗ ⇒ **這就是阻擋點** ✓：
  它對「全部候選」建立同戶關係，若此關係必需以 peers 展開 ⇒ peers 不能只算頁面層 ✗。

⇒ 兩條可行路徑（待證明後選一）✓：
1. 若 `attachSameHouseRoles` 只用到 **user-scoped** 的三個 map（`personalIndex.peers` ✓ 來自
   `personalIndex(voteUid)`，O(user) ✓）⇒ peers **不需**逐 post 展開，可安全延後到頁面層 ✓✓
   （最可能的情況：3165-3167 已經載入 `personalIndex(voteUid)` ✓，`personalIndex.peers(row.post_id)`
   只是以記憶體索引查詢 ✓ ⇒ 完全沒有額外 I/O ✓）。
2. 若仍需逐 post I/O ⇒ 改為**批量群組載入**（一次查詢取回整批 peer 列 ✓）並限制在頁面層 ✓。

⇒ 下一步：確認 `personalIndex(voteUid)` 是否**完整**涵蓋 `attachSameHouseRoles` 所需
（即該階段是否還有 `loader.*` 的額外查詢 ✗）✓；證明後再動手 ✓。
**在證明之前不改行為** ✗（避免以效能之名換掉正確性）。


## 附帶（安全、確定要做的清理）
- `pageIds` → `candidateIds` 改名 ✓（純可讀性，行為不變 ✓）。
