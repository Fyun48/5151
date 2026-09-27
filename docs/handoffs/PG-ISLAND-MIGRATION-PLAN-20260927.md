# PG 島嶼遷移：現況、做法、剩下的工作（2026-09-27）

這份是交接文件。目的是讓下一個 session（或另一個人）**不需要重新發現任何事**就能接手。

## 一、現況（可重跑數字）

```
node v3/scripts/route-data-map.mjs
```

| 判定 | 條數 |
|---|---:|
| 無直接DB | 117 |
| **SQLite（缺口）** | **81** |
| MIXED | 39 |
| **PG** | **51** |

起點是 SQLite 95 / PG 22（2026-09-27 盤點時）。

### 2026-09-27 修正：分析器加上 driver-aware 規則

先前的 tally **過度回報缺口**：driver-aware 的 helper（例如 `auditReq` 保留同步
`appendAdminAudit` 給非 PG 分支用）會讓已轉換的路由一直顯示 MIXED。這個限制我記錄過三次。

現在規則改為：**函式本文含 `resolveDbDriver` 者，其 SQLite 分支不計入缺口**（因為
`DB_DRIVER=postgres` 時不會走那條）。效果：**MIXED 55 → 39、PG 35 → 51，而 SQLite 維持 81 不變**
——只重新分類了確實有 PG 路徑的路由。

抽驗確認（修正後）：

| 路由 | 判定 | 為什麼正確 |
|---|---|---|
| `GET/PUT /api/admin/crawl-sources` | **PG** | 先前只因 `auditReq` 而顯示 MIXED |
| `POST /api/admin/same-house/confirm` | **PG** | 管理員分支已於 2026-09-27 移植 |
| `GET/PUT /api/admin/legal-copy` | SQLite | 真的還沒轉換 |
| `POST /api/listings/:id/reject-match` | SQLite | 真的還沒轉換 |

> ⚠️ **取捨**：這是用保守度換可用度。若某個 driver-aware 函式在**兩個分支都**呼叫了只走
> SQLite 的 helper，這裡會低估。判定仍標「機械判定」，據此動手前須人工確認。

> ⚠️ **這個 tally 不是精確的進度表。** 分析器是**靜態**追蹤引用，判定「函式**可達**」而不是
> 「在 `DB_DRIVER=postgres` 下會執行」。所以 driver-aware 的 helper（例如 `auditReq` 保留
> SQLite 分支）會讓路由一直顯示 MIXED，即使執行期已經走 PG。

## 二、已完成

### 橫向模組（投報率最高，先做這些才對）

| 模組 | 解鎖 | PR |
|---|---|---|
| `settingsKvAsync.js`（通用單鍵存取器） | settings 類數十條路由 | #517 |
| `adminAuditAsync.js` | **20 個 `auditReq` 呼叫點**的稽核寫入 | #521 |
| `adminOverviewAsync.js` | crawl-sources 健康度 | #520 |
| `memberMailAsync.js` | 會員 SMTP 設定（含兩節點已分歧的資料） | #511 |
| `personalFlagsAsync.js` 的 `hideMany` | 批次隱藏 | #516 |

### 路由批次

| 批次 | 路由 | PR |
|---|---|---|
| 站台內容 | housingData、spirit（6 條） | #518 |
| 站台內容 2 | helpQa、crawlSources（5 條） | #519 |
| 通訊設定 | commsConfig | #522 |

## 三、做法（照這個做，不要發明新的）

1. **挑標的**：從對照表挑，**優先挑被多條路由共用的同步函式或模組**（見第二節的橫向模組）。
2. **寫 `*Async.js` 模組**：照既有島嶼模式。
   - SQLite 分支：直接呼叫 `db.js`（或原模組）的同步函式，**行為完全不變**
   - PG 分支：`repository/*.js` 的語句 ＋ `pgSharedDriver`，值一律 `JSON.stringify`
   - **純判斷留在原本的模組**（兩個 driver 共用），只換「跑語句的人」
3. **接線**：路由 handler 改 `async` 並 `await`；把三個 driver-aware 入口匯入 `server.js`。
4. **寫 parity 測試**：最強的形式是**比較兩邊實際落地的位元組**，不是只比回傳值。
   - 用注入式 `exec`（in-memory SQLite 當 PG 替身），不需要真 PG
   - 讀取 parity：把 SQLite 實際存的位元組**鏡射**進 PG 夾具再比
5. **跑變異測試**：把修正拿掉，確認**對應那一項會失敗**。沒有這步的綠燈不能信任。
6. **用對照表驗證**：重跑 `route-data-map.mjs`，確認該路由的判定有變。

### 踩過的坑（每次都會再遇到）

| 坑 | 症狀 | 對策 |
|---|---|---|
| **SQLite 方言漏到 PG** | 例：`LIMIT -1 OFFSET ?` 是 SQLite 專屬，PG 直接拋錯，而 `toPostgresSql` 不轉譯 | 用兩邊都合法的寫法（`LIMIT 1 OFFSET ?`）；測試夾具要**主動拒絕** SQLite 專屬語法 |
| **測試夾具是空的** | 修正拿掉測試照樣過 | **一定要跑變異測試**。本系列已抓到 **4 次** |
| **資料形狀猜錯** | 例如誤以為 `crawlSources` 存 `{items}`（其實是純陣列） | 先讀實際落地的位元組，不要憑印象 |
| **測試之間互相污染** | 前一個測試改了 SQLite，後一個用全新 PG 夾具比 → 一定不同 | 讀取 parity 要鏡射位元組，不要假設起點相同 |
| **斷言了自己沒造成的資料** | 例：`first_seen_at` 全在過去卻斷言 `todayNew` 有值 | 期望值從夾具資料推導，不要硬編 |
| **測試資料沒踩到差異** | 例：用了不存在的欄位名，兩邊都回預設 → 合併與否結果相同 | 用**真實欄位**，且 patch 只改一部分、從非預設狀態出發 |

## 四、剩下的工作（依建議順序）

### 深模組（速度取決於這些，不是路由數量）

| 模組 | 卡在哪 | 影響 |
|---|---|---|
| `userSameHouse.js` | `mergePersonalSameHouse(db, ...)` 是 `db.prepare` 的 SQLite 專屬寫法 | `/api/listings/:id/{reject,confirm}-match`、`merge-same-house`（3 條）。**這正是今天還在產生群組分歧的路徑** |
| `contentDocuments.js` | CMS 的草稿／發佈／版本鏈（`getEffectiveDocumentOn`、`createDraftOn`、`publishDocumentOn`） | `saveLegalCopy` 等 |
| `adminOverview.js` 其餘 | `adminOverview()` 內部仍呼叫多個同步函式 | 後台總覽相關 |
| maps 設定 | `saveAdminMapsSettings` 寫 `auth.env` ＋ 跨多鍵 ＋ 碰 `maps_usage_daily` | `/api/admin/maps` |
| `saveRentalMarketplaceFlags` | 在 `wish.lifecycle_enabled` 時於交易內跑 `migrateOpenWishesOnActivation()` | 租屋市集開關 |

### 已確認「不是淺層」的候選（不要浪費時間試通用存取器）

`rentalMarketplaceFlags`（有資料搬遷）、`adminMapsSettings`（寫 auth.env）、
`adminAdsSettings`（已停用路徑）、`GET /api/comms`（直接吃 SQLite handle）。

## 五、未決事項（需要 Owner 決定）

1. **`auditReq` 目前是 fire-and-forget**（#521）。20 處 handler 多為同步，而原契約是
   「稽核失敗不得擋住管理操作」。若要求**稽核不可遺失**，需把那 20 處改成 async 並 await。
2. **步驟 4 的分歧資料**（10 筆：`listing_group_members` 5+2、`listing_groups` 1、
   `user_listing_flags` 2）要以哪一版為準。**先轉換、再對帳**，因為節點 SQLite 仍在被寫入。

## 六、後續步驟（步驟 4～7）

- **步驟 4（三邊對帳）**：轉換完成後再執行。工具已備：md5 比對三邊、主鍵集合比對。
- **步驟 5（功能等價驗證）**：對照測試。
- **步驟 6（cluster／雙備援運轉）**：**最後**才做。
- **步驟 7（移除 SQLite）**：`db.js` 的 SQLite 分支、`sqliteFallback`、本機檔案一併移除，
  屆時「雙路徑」「節點分歧」這整類問題會一起消失。
