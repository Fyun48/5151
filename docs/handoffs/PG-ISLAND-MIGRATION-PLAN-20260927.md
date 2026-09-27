# PG 島嶼遷移：現況、做法、剩下的工作（2026-09-27）

這份是交接文件。目的是讓下一個 session（或另一個人）**不需要重新發現任何事**就能接手。

> 🚨 **2026-09-27 新增、優先度高於本文其他部分**：正式站 PG 有 **9 個 identity 序列落後**
> （下一個值 ≤ 目前最大值），任何「不指定 `id` 的 INSERT」都會撞主鍵。
> 其中 `admin_audit.id` **已經在造成損害**：`#521` 之後的每一筆管理員稽核都失敗，
> 而且被 `auditReq()` 的 fire-and-forget 吞掉，12 天來沒有人發現。
> 詳見 `docs/handoffs/PG-IDENTITY-SEQUENCE-DEFECT-20260927.md`。
> **那是本系列後續所有 PG 移植的前置條件**——沒修好，移植過去的路由會在第一次寫入就爆。

## 一、現況（可重跑數字）

```
node v3/scripts/route-data-map.mjs
```

**最新一次量測（2026-09-27，第二批之後；由下一個 session 自己重跑確認）：**

| 判定 | 條數 | 與第二批前相比 |
|---|---:|---|
| 無直接DB | 117 | — |
| **SQLite（缺口）** | **80** | −1 |
| MIXED | 36 | −3 |
| **PG** | **55** | +4 |

起點是 SQLite 95 / PG 22（2026-09-27 盤點時）。

> ⚠️ **判讀進度請用「SQLite ＋ MIXED」合計**，不要只看 SQLite 那一格。
> 一個 `*Async` 入口接上之後，路由通常是從 **MIXED** 移到 PG（不是從 SQLite），因為
> MIXED 代表「已經有 PG 路徑、但還有殘留的同步函式」。第二批前的合計是 81+39=120，
> 第二批後是 80+36=116。

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
| **同房源拆開／確認＋stats 橫向** | `reject-match`、`confirm-match`、`merge-same-house`、`watch`（4 條） | 本批 |

### 第二批（2026-09-27）：`rejectSuspectedMatch` ＋ `stats` 橫向解鎖

兩個獨立的洞一起收掉，4 條路由一次轉成 PG：

| 模組 | 內容 | 影響 |
|---|---|---|
| `rejectSuspectedMatchAsync()`（`sameHouseAsync.js`） | 拆開配對：`user_match_votes` upsert、`user_match_signals`、`user_events`、`listings` 升級、個人群組拆開 | `/api/listings/:id/reject-match` → **PG** |
| `adminSplitSameHouseAsync()`（同檔） | 管理員拆開：解除群組綁定 ＋ 寫 `listing_group_audits` | 同上（管理員分支） |
| `splitPersonalSameHouseAsync()`（`userSameHouseAsync.js`） | 個人同房源拆開（同步版的 `splitPersonalSameHouse` 對應） | 同上 |
| **`stats` → `listingStatsAsync`** | **既有的** PG 統計路徑，只是這 4 處沒接上 | 解鎖下面 3 條 |

**`stats` 是橫向缺口**：`stats(undefined, uid)` 是同步 SQLite 函式，而 PG 版本
`listingStatsAsync({ userId })` **早就存在**（`listingStatsAsync.js`，`/api/state`／`/api/listings`
已在用）。先前沒接上，導致這幾條路由一直掛在 MIXED。本批把 4 處換掉之後：

| 路由 | 換掉 `stats` 前 | 換掉之後 |
|---|---|---|
| `POST /api/listings/:id/confirm-match` | MIXED（只剩 `stats`） | **PG** |
| `POST /api/listings/merge-same-house` | MIXED（只剩 `stats`） | **PG** |
| `POST /api/watch` | MIXED（只剩 `stats`） | **PG** |
| `POST /api/listings/:id/reject-match` | SQLite | **PG** |

> **教訓**：動手前先查「這個卡點有沒有現成的 Async 版本」。`stats` 卡了 4 條路由，
> 而解法是 3 個字的替換——比新寫一個 `*Async.js` 便宜得多。下次先做這個盤點。

#### 測試與變異測試證據（可重跑）

```bash
node --test v3/test/reject-match-async.test.js          # 12 項，全綠
node v3/scripts/mutation-check.mjs v3/test/reject-match-async.test.js   # 16 條變異
```

`v3/scripts/mutation-check.mjs` 是**這批新寫的工具**：把修正逐條拿掉、確認對應那一項測試會失敗。
最新一次結果：**KILLED 16／SURVIVED 0／SKIP 0**。

`from` 字串必須在檔案中恰好出現一次，否則該條會標 SKIP（避免改錯地方）。
工具已註冊 `SIGINT`／`SIGTERM`／`exit` 還原——**這不是裝飾**：第一版沒有這段，
被 SIGTERM 之後原始碼停在「已變異」狀態，差一點把壞掉的修正當成完成品。
跑完務必 `diff` 對備份確認原始碼是乾淨的。

> ⚠️ **一個必須誠實記錄的插曲**：變異工具第一次完整跑出「5 條 SURVIVED」。
> 我沒有直接相信它，而是手動把同一條變異套上去重跑——結果那 3 項相關測試**都有失敗**，
> 與工具的報告相反。追查後確認是前一次被 SIGTERM 中斷留下的髒狀態污染了那一輪。
> 補上還原機制後重跑即為 16/16。**教訓：變異測試工具自己也要能被驗證**，
> 報告與手動重現不一致時，以手動重現為準。


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
| **（第二批新增）注入式 `exec` 不經過 `toPostgresSql`** | `pgExec(options)` 在 `options.exec` 有值時原封不動回傳它。所以**注入式測試看到的 SQL ≠ 正式站送出的 SQL**：正式站會轉譯 `IFNULL→COALESCE`，測試不會 | PG 分支的語句要寫**兩邊都合法、且轉譯器不會再改**的形式（`COALESCE`，不要 `IFNULL`）。這樣三條路徑看到同一句。本批就是這樣被夾具抓到 |
| **（第二批新增）夾具比本尊嚴格** | 夾具開了 `PRAGMA foreign_keys`，但實查 PG：`user_match_votes`／`user_match_signals`／`user_same_house_members` 上**一個 FK 都沒有** → 夾具製造假的 FK 失敗 | 夾具的嚴格度要**對齊本尊**（先查 `information_schema`），不是越嚴越好 |
| **（第二批新增）`DELETE` 不重置 AUTOINCREMENT** | 同檔多個 test 共用磁碟 v3.db，`DELETE` 後 id 繼續往上跑；記憶體夾具卻是全新 → 第二個 test 起 id 就兩邊不同 | 清表時一併 `DELETE FROM sqlite_sequence WHERE name IN (…)`，或別比 `id` |
| **（第二批新增）變異測試工具被中斷會留下變異過的原始碼** | 第一次跑變異測試被 SIGTERM，`v3/src/sameHouseAsync.js` 停在「已變異」狀態，差一點把壞掉的修正當完成品 | 變異工具必須註冊 `SIGINT`／`SIGTERM`／`exit` 還原（`v3/scripts/mutation-check.mjs` 已補）；跑完一定要 `diff` 對備份 |

## 四、剩下的工作（依建議順序）

### 深模組（速度取決於這些，不是路由數量）

| 模組 | 卡在哪 | 影響 | 狀態 |
|---|---|---|---|
| `userSameHouse.js` | `mergePersonalSameHouse(db, ...)` 是 `db.prepare` 的 SQLite 專屬寫法 | `/api/listings/:id/{reject,confirm}-match`、`merge-same-house`（3 條）。**這正是今天還在產生群組分歧的路徑** | **已解決**（第二批＋#524～#527） |
| `stats`（橫向） | 同步 `stats()` 是 SQLite 專屬；**PG 版 `listingStatsAsync` 早就存在**，只是沒接上 | 至少 4 條路由（`confirm-match`、`merge-same-house`、`watch`、`reject-match`） | **已解決**（第二批） |
| `contentDocuments.js` | CMS 的草稿／發佈／版本鏈（`getEffectiveDocumentOn`、`createDraftOn`、`publishDocumentOn`） | `saveLegalCopy` 等 | 未動 |
| `adminOverview.js` 其餘 | `adminOverview()` 內部仍呼叫多個同步函式 | 後台總覽相關 | 未動 |
| maps 設定 | `saveAdminMapsSettings` 寫 `auth.env` ＋ 跨多鍵 ＋ 碰 `maps_usage_daily` | `/api/admin/maps` | 未動 |
| `saveRentalMarketplaceFlags` | 在 `wish.lifecycle_enabled` 時於交易內跑 `migrateOpenWishesOnActivation()` | 租屋市集開關 | 未動 |
| `getListing`（橫向） | 同步 `getListing()` 被非常多條路由用到 | `recheck`、`report-gone`、`flags`、`commute/focus`、`maps`… | 未動。**建議下一個做這個**（PG 版 `getListingAsync` 已存在，與 `stats` 同一種「有現成的卻沒接」） |

### 已確認「不是淺層」的候選（不要浪費時間試通用存取器）

`rentalMarketplaceFlags`（有資料搬遷）、`adminMapsSettings`（寫 auth.env）、
`adminAdsSettings`（已停用路徑）、`GET /api/comms`（直接吃 SQLite handle）。

### 建議的下一個標的（有證據支持）

先做**盤點**而不是直接動手：把目前仍判 SQLite／MIXED 的路由，逐條列出「卡住的同步函式」，
再對照 `v3/src/*Async.js` 既有的 export，找出**已經有 PG 版本、只是呼叫端沒接**的那些。
第二批的 `stats` 就是這樣撿到的（3 個字的替換解鎖 3 條路由）。

從上面的表看，下一個最可能是 **`getListing` → `getListingAsync`**：
`getListingAsync` 已經存在且已被多條路由使用，而 `getListing` 仍出現在
`recheck`、`report-gone`、`flags`、`commute/focus`、`/api/admin/maps` 的 SQLite 欄位裡。

## 五、未決事項（**已由 Owner 於 2026-09-27 決定**）

1. **`auditReq` 的稽核遺失政策** → **Owner 決定：維持 fire-and-forget 的契約，但讓失敗看得見。**
   實測是 **19 處**呼叫點（不是先前寫的 20），其中 16 處在同步 handler 內、3 處已是 async。
   Owner 的取捨：不動 16 個同步 handler（含 delete／publish 等高風險路徑）以換零回歸風險。
   **但「吞掉錯誤」本身被推翻了**——因為它讓一個全損故障隱形了 12 天（見上方紅框）。
   已實作：`appendAdminAuditAsync()` 記數 + 寫 log（第 1 次、之後每 100 次），
   `/api/health` 新增 `audit_failures`（`ok` 不變）。
   測試 `v3/test/admin-audit-visibility.test.js`（4 項），變異測試 6/6 KILLED。
   **若之後要改成稽核不可遺失，就是把那 16 處改 async + await。**
2. **步驟 4 的 10 筆分歧資料** → **Owner 決定：分表裁決。**
   - `user_listing_flags`（2 筆）→ **以節點 SQLite 為準**（補進 PG）。理由：那是使用者直接意圖
     （例如 user 2 在 05:17 隱藏 `22075980`），不補會讓隱藏失效、通知照發。
   - `listing_groups`（1 筆）／`listing_group_members`（5+2 筆）→ **以 PG 為準**（不補）。
     理由：那是機器推導的聚合，PG 的 reconcile 在轉換後已重算；硬補會與 `lg_b9cf4fc4…` 的歸組衝突。
   - 順序不變：**先轉換（步驟 3）→ 再對帳（步驟 4）**，因為節點 SQLite 仍在被寫入。


## 六、後續步驟（步驟 4～7）

- **步驟 4（三邊對帳）**：轉換完成後再執行。工具已備：md5 比對三邊、主鍵集合比對。
- **步驟 5（功能等價驗證）**：對照測試。
- **步驟 6（cluster／雙備援運轉）**：**最後**才做。
- **步驟 7（移除 SQLite）**：`db.js` 的 SQLite 分支、`sqliteFallback`、本機檔案一併移除，
  屆時「雙路徑」「節點分歧」這整類問題會一起消失。
