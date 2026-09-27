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

### 🚨 2026-09-27：分析器的兩個缺陷已修，**基準換了**——兩套數字並列

我先在下方保留**舊尺**的數字（那是所有舊文件引用的基準），再給**新尺**。
換尺的原因是舊尺有兩個方向相反的缺陷，**而且它已經實際誤導過一次優先順序**（見第三節）。

| 判定 | 舊尺 | 新尺 | 五批前 | 第四批 | 第五批 | 第六批 | 第七批 | 第八批 | **第九批** |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| SQLite | 80 | 189 | 179 | 173 | 170 | 169 | 169 | 169 | 165 | 164 | 161 | **160** |
| MIXED | 36 | 47 | 49 | 49 | 50 | 50 | 45 | 40 | 41 | 42 | 42 | **42** |
| 無直接DB | 117 | 26 | 26 | 26 | 26 | 26 | 26 | 26 | 26 | 26 | 26 | **26** |
| PG | 55 | 26 | 34 | 40 | 42 | 43 | 48 | 53 | 56 | 56 | 59 | **60** |
| **缺口合計** | **116** | **236** | **228** | **222** | **220** | **219** | **214** | **209** | **206** | **206** | **203** | **202** |

**這不是退化，是舊尺看不到。** 舊尺把 91 條「其實在讀寫 SQLite」的路由標成「無直接DB」、
把 29 條標成「PG」。新尺的每一項修正都在下面第五節有逐一驗證過的證據。

> ⚠️ 舊尺的數字仍然有用：`80／36／117／55` 是所有**舊 PR 與舊文件**引用的值，
> 要跟歷史紀錄對照時用它。**新的判斷與排優先順序一律用新尺。**

### 舊尺數字（2026-09-27 第二批之後）

| 判定 | 條數 |
|---|---:|
| 無直接DB | 117 |
| **SQLite（缺口）** | **80** |
| MIXED | 36 |
| **PG** | **55** |

起點是 SQLite 95 / PG 22（2026-09-27 盤點時）。

> ⚠️ **判讀進度請用「SQLite ＋ MIXED」合計**，不要只看 SQLite 那一格。
> 一個 `*Async` 入口接上之後，路由通常是從 **MIXED** 移到 PG（不是從 SQLite），因為
> MIXED 代表「已經有 PG 路徑、但還有殘留的同步函式」。第二批前的合計是 81+39=120，
> 第二批後是 80+36=116（舊尺）。

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


### 第三批（2026-09-27）：後台設定（郵件／OAuth／贊助／品牌）

**選這批的依據**：用修好的量尺排出「只有**一個**真卡點」的 101 條路由，再排除
session 讀取與 stage-1 fixture 鷹架之後，這幾個函式各卡 1～2 條，而且形狀幾乎一樣
（讀一個 settings 鍵 ＋ 一個純函式）——所以 port 很短，`settingsKvAsync.js` 已經把語句收斂好了。

新增 `v3/src/adminSettingsAsync.js`（11 個函式）：

| 類別 | 函式 |
|---|---|
| 郵件 | `getMailTemplatesAsync`、`getStoredSmtpAsync`、`getAdminMailSettingsAsync` |
| OAuth | `getStoredOauthAsync`、`getAdminOauthSettingsAsync`（唯讀） |
| 贊助 | `getSponsorConfigAsync`、`getAdminSponsorSettingsAsync`、`saveAdminSponsorSettingsAsync`、`publicSponsorSettingsAsync` |
| 品牌 | `getBrandMascotAsync`、`saveBrandMascotAsync` |

**轉成 PG 的路由（8 條）**：`GET /api/oauth`、`GET /api/admin/mail`、`GET /api/admin/oauth`、
`GET /api/admin/sponsor`、`PUT /api/admin/sponsor`、`GET /api/brand`、`GET /api/admin/brand`、
`PUT /api/admin/brand`。另外 `/api/me` 與 `/api/comms` 的卡點集合也因此縮小。

**量尺（新尺）**：SQLite 189→**179**、PG 26→**34**、MIXED 47→49、無直接DB 26。
缺口合計 236→**228**。

#### ⚠️ 刻意沒有移植的兩個（不是漏掉）

`saveAdminMailSettings()`（db.js:1164）與 `saveAdminOauthSettings()`（db.js:1195）
除了寫 `settings`，還會 **`persistSmtpToAuthEnv()`／`persistOauthToAuthEnv()` 寫節點本機的 `auth.env`**
——與 `saveAdminMapsSettings` 同一類陷阱。在 PG 模式下會變成「資料進 PG、檔案設定只留在回答你那台」。
**這需要一個刻意的決定（auth.env 在 PG 模式還要不要寫？由誰寫？），留給下一批。**
對應的 `PUT /api/admin/mail`、`PUT /api/admin/oauth` 因此仍在缺口裡。

#### 這批學到的三件事

1. **資料形狀又猜錯兩次**（同一類坑第 N 次）：`mailTemplates` 的鍵是
   `welcome／verify_expired／…`（我寫成 `verify`）、bootstrap 的 clip 欄位是 `title／body`
   （我寫成 `text`）。兩次都是先用探針問出真實形狀才寫對——
   **先讀真實資料，不要憑印象**。
2. **變異測試逼出一條漏掉的測試**：「拿掉 `publicBrandMascot`」這個變異**在儲存路徑上是等價的**
   （`normalizeBrandMascot` 會再正規化一次，落地結果不變），所以它活了下來。
   但它會改變**讀取**路徑的回傳形狀（少 `productName`）——於是我補了
   `getBrandMascotAsync` 的讀取測試。**活了下來不代表測試爛，有時是它指出了你沒測的那一面。**
3. **冗餘的 guard 是等價變異，不該硬塞進變異集**：這些 wrapper 的
   `if (!isPg(options)) return sync()` 是防禦性的——委派的 `getSiteSettingAsync()` 自己就會判斷
   driver 並回退，所以拿掉 guard 行為不變。**回退行為有測試（兩邊種不同的值），
   但殺不掉這個冗餘 guard**；我把它從變異集移除並註明原因，不留一條永遠 SURVIVED 的項目。

### 第四批（2026-09-27）：Support 後台列表 ＋ 量尺缺陷 (3)

#### 4.1 先做了「表面 vs 深層」的分類，才挑批

前三批學到的教訓是：**「卡住幾條路由」不等於「要花多少工」**。同一個函式，
若被 handler 直接呼叫就可以直接改；若被深層同步模組呼叫，就得先移植整個模組。
所以我把 207 條有真卡點的缺口路由分成三類（量測腳本在對話紀錄，方法寫在這裡）：

| 分類 | 條數 | 意義 |
|---|---:|---|
| 卡點**全部在 handler 內** | **77** | 直接改 handler 就能完成 |
| 部分在 handler、部分在深模組 | 66 | 要兩邊都做 |
| 卡點**全部在深模組** | 64 | 必須先移植模組 |

`support.js` 的後台列表是「全部在 handler 內」那一群裡最大的（9 個函式、約 10 條路由）。

#### 4.2 本批內容

新增 `v3/src/supportAsync.js`：`listSupportCostsAsync`、`listSupportTiersAsync`、
`listSupportProvidersAsync`、`listSupportSponsorsAsync`、`listCtaRulesAsync`、
`listSupportTransactionsAsync`。

為了讓兩個 driver 共用同一份純對應邏輯，把 `support.js` 的
`costRow`／`tierRow`／`sponsorRow`／`ctaRow`／`txRow` **加上 `export`**（只加 export，行為不變），
而不是在 PG 這邊複製一份——複製就會漂移。

SQLite 分支用 `sqliteHandle()`（`support.js` 的函式吃 `(db, ...)` 參數，不像 db.js 用模組全域），
這與 `listingGroupsAsync.js` 是同一個既有模式。

**5 條路由轉成 PG**：`GET /api/admin/support/{costs,tiers,providers,transactions,sponsors}`；
`GET /api/admin/support/cta-rules` 變成「無直接DB」（它本來只被這一個函式卡住）。

**量尺**：SQLite 179→**173**、PG 34→**40**、缺口 228→**222**。

#### 4.3 🚨 量尺缺陷 (3)：剝註解會弄壞正規表達式字面量

追查「`normalizeLineUrl` 是**純函式**卻出現在 18 條路由的 SQLite 欄」時找到的：

`stripComments` 原本用 regexp 移除 `//` 到行尾，**不辨識字串與正規表達式**。
`/^https:\/\/(line\.me|lin\.ee)\//i` 這種「跳脫斜線 ＋ 結尾斜線」會形成 `//`，
而它前面是 `\` 不是 `:`，所以 `(^|[^:])` 的保護沒生效 ⇒ **整行被刪掉**。
被刪的那段含 `))` ⇒ 括號配對失衡 ⇒ `sliceFunctionBody` 往後吞掉下一個函式 ⇒
誤判成 SQLite，再沿同模組呼叫擴散。**同樣的形狀全站有 16 處、散在 13 個檔案。**

修法：逐字元走訪，字串與正規表達式字面量整段照抄。**修好之後沒有任何判定改變**
（tally 仍是 173/49/26/40）——那 18 條路由本來就有其他真卡點，所以這次不需要換基準，
只有 19 條路由的卡點清單變得更誠實。守衛與變異測試都已補（4/4 KILLED）。

#### 4.4 ⚠️ 量尺**驗不出**「接到不存在的 export」

本批我把匯出命名為 `listSupportCtaRulesAsync`，卻在 `server.js` 匯入 `listCtaRulesAsync`。
`node --check` 只驗語法、**分析器只比對名字**（它看到 `*Async.js` 有這個名字就算 PG），
兩者都沒抓到——是**跑測試**時才炸出 `is not a function`。

**教訓：新增／改名 `*Async.js` 的匯出之後，要用執行期檢查確認「server.js 匯入的名字真的存在」**：

```bash
node -e 'import("./v3/src/supportAsync.js").then(m=>console.log(Object.keys(m)))'
```

這一項已列為新島嶼的收尾步驟。

### 第五批（2026-09-27）：站內刊登讀取（`getSelfListing`）

挑它的理由：在「唯一卡點」名單裡它是**最大的單一函式**（3 條路由），而且同時是另外
約 6 條 self-listings／listing-imports 路由的卡點之一——帳面投報率比看起來高。
它需要四個依賴，其中三個是**純函式可直接重用**：`decorateSelfListing`、
`listingVisibleOnSurface`／`LISTING_SURFACE`（`stage1FixtureIsolation.js`）、
`httpError`（為此把 `selfListings.js` 的區域版本加上 `export`，只加 export、行為不變）。

新增 `v3/src/selfListingsAsync.js`：`expireOpenSelfListingsAsync`、`getSelfRowAsync`、
`getSelfListingAsync`。**3 條路由**：`GET /api/self-listings/:id`（→MIXED，只剩 session 讀取）、
`GET /api/public/self-listing/:id` 與 `GET /media/lib/:file`（→**PG**）。

**量尺**：SQLite 173→**170**、PG 40→**42**、缺口 222→**220**。

> 註：`getSelfListing` 也被 `listingImport.js`／`listingTools.js` **深層呼叫**，
> 那些路徑仍未移植——所以 listing-imports 家族還在缺口裡。這是刻意只做 handler 層的結果。

#### 這批的三個發現（都由變異測試逼出來）

1. **`IFNULL` 陷阱再現**：過期清理的 UPDATE 同步版用 `IFNULL(self_expires_at, '')`，
   PG 不接受。而且它在 `try/catch` 裡**被吞掉**——寫錯方言的症狀是「過期清理永遠無聲失效」，
   不是拋錯。測試因此**比對落地的 `self_status`**，不是只比回傳值。
2. **🚨 我的測試資料沒踩到差異**（交接文件列過的坑，這次是我自己犯）：
   「拿掉 `COALESCE(self_expires_at,'') != ''` 這個判斷」的變異**活了下來**。
   原因是我用 `NULL` 當測試資料，而 `NULL <= '2020-…'` 在 SQLite／PG 都是 NULL（不成立），
   本來就不會被更新——**這個判斷真正擋的是空字串**（`'' <= '2020-…'` 是 TRUE）。
   實測：沒有 guard 改 1 列、有 guard 改 0 列。改用空字串當資料之後變異就被殺了。
3. **又一個等價變異**：把外層的「非 postgres 回退」guard 拿掉，行為不變——因為內層的
   `getSelfRowAsync()` 自己也有 `isPg()` 判斷並回退（與 `adminSettingsAsync` 那批同一類）。
   回退**行為**有測試，但殺不掉這個冗餘的 guard，所以從變異集移除並註明。

### 第六批（2026-09-27）：居住數據 ＋ 最後一哩的清單

#### 6.1 先問「哪些路由只差已經寫好的 Async 版本？」

我用一個腳本交叉比對「缺口路由的真卡點」與「`*Async.js` 既有的匯出」，答案只有 **3 條**。
其中：
- `POST /api/admin/housing-data/refresh` → 補 `getHousingDataRawAsync`／`writeHousingDataAsync`
- `POST /api/admin/mail/test` → 改用既有的 `getStoredSmtpAsync`（1 行）
- `PUT /api/admin/providers/site-budget` → **不需要動**（見 6.3，那是量尺的誤報）

#### 6.2 🚨 順手抓到一個**排程工作的真實分歧**（不只是指標）

`runHousingRefresh()`（server.js，啟動後 30 秒 ＋ 每 24 小時執行一次；日誌
「居住數據自動更新：N 筆」就是它）原本用**同步 SQLite** 的 `getHousingDataRaw`／`writeHousingData`。
也就是說 PG 模式下：**自動抓到的居住成本只寫進回答你那台的本機檔**，
另一台看不到、PG 永遠不會更新——而 `housingData` 本來就已經是「三個來源各一版」。
**這不是讓判定變綠，是真正修掉一個持續發生的分歧。**

連帶修掉一個容易漏的地方：`refreshHousingData()` 原本**同步呼叫**回呼
（`getData()`／`writeData(data)`，沒有 `await`）。一旦傳 async 版本進去，
`normalizeHousingData(getData())` 收到的是 Promise ⇒ **整份資料被換成預設值，而且不會拋錯**。
已改成 `await`（await 非 Promise 是 no-op，所以 sqlite 模式行為不變），並用測試專門守住這個 `await`。

#### 6.3 量尺缺陷 (4)：**已 driver-aware 的函式被算成 SQLite**（過度回報）

`PUT /api/admin/providers/site-budget` 被判成 SQLite，卡點是 `saveSiteBudget`。
但實際讀碼：db.js 的 `saveAdminSiteBudget()` 是 `budgetStore({ sqliteDb: db, options }).saveSiteBudget(...)`，
而 `budgetStore()`（budgetStore.js:53）**明確呼叫 `resolveDbDriver()`**，driver 是 postgres 時回 PG store。
**它早就是 driver-aware 的，這條路由不需要做任何事。**

原因：量尺的「driver-aware ⇒ 不計 SQLite」規則只看**函式自己的本文**有沒有 `resolveDbDriver(`，
看不到「委派給一個 driver-aware 的 factory」這種寫法。同一類還有
`getAdminProviderSettings`／`saveAdminProviderSettings`／`testAdminProvider`。

> **影響**：這一類是**過度回報**（虛增缺口）。要修的話得讓規則也檢查「被呼叫的 factory 是否 driver-aware」。
> 我沒有動它——本輪已經在別處修過三次，且這一項不影響我目前的工作排序（我改用「真卡點」清單來排）。

#### 6.4 量尺缺陷 (5)：**以參考傳遞的函式完全看不到**

`getHousingDataRaw`／`writeHousingData` 在 refresh 路由裡是**當參數傳**
（`{ getData: getHousingDataRaw, writeData: writeHousingData }`），不是被呼叫，
所以 `callsIn()`（要求 `NAME\s*\(`）抓不到——這條路由的卡點清單只列出 `getHousingData`，
**少算了兩個**。這與 7.4.1 的「中介層以參考傳遞」是同一個盲點。

> **實務影響**：**凡是靠「唯一卡點」清單挑出來的批次，都要人工再看一眼 handler**，
> 因為傳參考的呼叫不會出現在清單裡。本批就是這樣才發現另外兩個函式。

#### 6.5 又一個等價變異

「非 postgres 不回退」在這批**第三次**是等價變異（委派的 `getSiteSettingAsync` 自己會回退）。
一樣從變異集移除並註明——**同樣的形狀出現三次，代表這類 guard 在整個島嶼模式裡都是防禦性的**，
不該期待變異測試能守住它們；能守住的是**行為**（兩邊種不同的值）。

### 第七批（2026-09-27）：support.js 寫入段（costs／tiers／providers）

#### 7.1 選批依據：算「把一個模組補完能完成幾條路由」

「唯一卡點」清單已經進入長尾（多數是 1 條），所以換一個問題問：
**若把某個模組的相關函式全部移植，能「完成」幾條路由（＝該路由的真卡點全落在這個模組）？**

| 模組 | 可完成 | 涉及 |
|---|---:|---:|
| `db.js` | 33 | 109（**分散**，不是單一機會） |
| **`support.js`** | **21** | 21 |
| `comms.js` | 11 | 14 |
| `contentDocuments.js` | 10 | 22 |
| `listingTools.js` | 10 | 11 |
| `memberMedia.js` | 9 | 15 |

`support.js` 是**最集中的單一機會**：21 條路由的卡點全部落在它身上。本批先做最前面的一群。

#### 7.2 本批內容

`supportAsync.js` 新增 5 個寫入函式：`createSupportCostAsync`、`updateSupportCostAsync`、
`createSupportTierAsync`、`updateSupportTierAsync`、`updateSupportProviderAsync`。
純判斷（`cleanText`／`bool01`／`moneyAmount`／`iso`／`sanitizeHttpUrl`）留在原模組共用，
為此把 `support.js` 的 `cleanText`／`bool01` 加上 `export`（只加 export）。
同時把 5 個 PUT／POST handler 裡的「before 快照」改用**已經存在的** async 列表版本。

**5 條路由轉 PG**：`POST/PUT /api/admin/support/costs`、`POST/PUT /api/admin/support/tiers`、
`PUT /api/admin/support/providers/:id`。

**量尺**：MIXED 50→**45**、PG 43→**48**（SQLite 不變，因為這幾條本來就是 MIXED）、缺口 219→**214**。

#### 7.3 兩次「測試資料沒踩到差異」（變異測試抓到的）

這批的寫入有兩個**順序／邊界**的細節，而我的第一版測試資料**兩者都沒測到**：

1. **`is_default` 的「先歸零再寫入」**：第一版的兩張 tier 都是 `is_default=0`，
   所以「完全不歸零」也只會有一個預設 ⇒ 變異存活。改成先種一張 `is_default=1` 之後，
   「不歸零」與「把歸零搬到 INSERT 之後」兩種變異都被殺掉（後者是**複合變異**——
   單獨拿掉歸零只測到「有沒有做」，搬到後面才測到**順序**，而順序顛倒會讓剛建立的預設被清掉、
   **回傳值卻看起來正常**）。
2. **`end_date: null` 的「清掉」語意**：第一版種的成本 `end_date` 本來就是空的，
   所以「清掉」與「保留」結果相同 ⇒ 變異存活。改成先種一個 `end_date` 之後就殺得掉。
3. 另外 `sanitizeHttpUrl` 那一條也是同一類：第一版沒傳 `page_url`，兩邊都沿用現值。

> 三次都是**同一個坑**：測試資料沒有踩到差異，綠燈就沒有意義。
> 這正是「每個新測試都要跑變異測試」的理由——三次都不是靠讀碼看出來的。

#### 7.4 `createSupportTierAsync` 的 INSERT 後取值

同步版用 `lastInsertRowid` 拿回剛寫入的那一筆。PG 分支沒有等價物，
這裡用「`ORDER BY id DESC LIMIT 1`」取回，語意相同且不依賴 `RETURNING`。
第一版我用 `SQL.replace("WHERE id=?", "ORDER BY id DESC LIMIT 1")` 這種字串操作凑出來，
**已改掉**——那種寫法一旦原字串改了就會靜默取錯資料。

### 第八批（2026-09-27）：support.js 第二群（贊助商／支持紀錄／CTA 規則 ＋ 變異工具兩個 bug）

#### 8.1 內容

`supportAsync.js` 再補 5 個寫入函式：`createSupportSponsorAsync`、`updateSupportSponsorAsync`、
`createManualTransactionAsync`、`updateSupportTransactionAsync`、`updateCtaRuleAsync`。
5 個 handler 的 before 快照改用既有的 async 列表版本。

**5 條路由轉 PG**：`POST/PUT /api/admin/support/sponsors`、
`POST /api/admin/support/transactions/manual`、`PUT /api/admin/support/transactions/:id`、
`PUT /api/admin/support/cta-rules/:id`。

**量尺**：MIXED 45→**40**、PG 48→**53**、缺口 214→**209**。

照抄到位、由測試抓出來的細節：`createManualTransaction` 的**去重**（provider＋交易號重複要 409）、
`net_amount` 要隨 amount／fee 重算、`updateCtaRule` 的 `Math.max(1, …)` 下限、
sponsor 的 `amount` 空字串要寫 `null`（不是 0）。

#### 8.2 🚨 變異工具本身有兩個 bug，其中一個一直在騙我

**Bug A：`execFileSync` 的預設 `maxBuffer` 是 1 MiB ⇒ 輸出被截斷 ⇒ 失敗的 `not ok` 行消失 ⇒ 變異被誤判成 SURVIVED。**
這個測試檔的 `deepEqual` 差異很大，一超過就整批後面的失敗行不見。
實測：tier 的兩個變異明明各有兩條測試失敗，工具卻回報「沒有失敗」。
已把 `maxBuffer` 拉到 256 MiB。**這一項很可能也影響過前面幾輪的判讀。**

**Bug B：錨點找不到時只標 SKIP，看起來像「這條不用測」，其實是原始碼被改過。**
已改成**前置檢查**：任何 `from` 找不到就列出並**中止（不套用任何變異）**。

#### 8.3 ⚠️ 我一度在「原始碼已經被弄壞」的狀態下繼續工作（誠實記錄）

中斷的變異 run 讓 `supportAsync.js` 停在半變異狀態（`Math.max` 被拿掉），
而我當時的完整性檢查是**跟備份 diff**——那份備份是在損壞之後才拍的，**所以也繼承了同一個損壞**，
檢查於是形同虛設（顯示 INTACT，實際上那行是壞的）。

**往後的做法（已寫進工具）**：
1. 完整性用 **sha1** 比對，不要只用備份 diff（備份本身可能是壞的）。
2. 修任何東西時，**以同步版實作為唯一事實來源**（`support.js` 的 `Math.max(1, …)`），
   不要以「上一個備份」為準。
3. 變異工具加了前置檢查與自我修復備份（放 tmpdir、正常結束會刪）。

> 這個 bug 也解釋了為什麼「同一條變異上一輪 KILLED、這一輪 SURVIVED」——
> **不是原始碼變好了，是工具漏看了失敗**。看到不合理的變異結果時，先懷疑工具。

#### 8.4 全部變異集重新驗過（因為工具改了）

| 測試檔 | 變異數 | 結果 |
|---|---:|---|
| `reject-match-async` | 16 | 全 KILLED |
| `support-async` | 11 | 全 KILLED |
| `admin-audit-visibility` | 6 | 全 KILLED |
| `admin-settings-async` | 5 | 全 KILLED |
| `self-listings-async` | 5 | 全 KILLED |
| `route-data-map` | 4 | 全 KILLED |
| `housing-refresh-async` | 4 | 全 KILLED |
| **合計** | **51** | **0 SURVIVED、0 SKIP** |

### 第九批（2026-09-27）：後台設定（support_page_config）＋ 事件記錄

#### 9.1 內容

`supportAsync.js` 新增 5 個函式：`getSupportFlagsAsync`、`adminSupportConfigAsync`、
`saveSupportConfigAsync`、`publishSupportConfigAsync`、`recordSupportEventAsync`
（後者順便接上三個呼叫點：`/api/support/event`、checkout、cta/dismiss）。

**4 條路由**：`GET/PUT /api/admin/support/config`、`POST /api/admin/support/config/publish`
（→**PG**）、`POST /api/support/event`（→MIXED，只剩 session 讀取）；checkout 與 cta/dismiss
的卡點清單也少了 `recordSupportEvent`。

**量尺**：SQLite 169→**165**、PG 53→**56**、缺口 209→**206**。

#### 9.2 忠實照抄勝過「順手最佳化」

`adminSupportConfig()` 內部會呼叫 `configRow()` **四次**，而且**每次都重新 SELECT**。
PG 分支逐字照抄同樣的結構，**不做「查一次共用」的最佳化**——那是行為等價但形狀不同的改寫，
要做的話應該是有意為之、而不是順手。

#### 9.3 兩個「我的測試假設錯了」（不是程式錯）

1. `normalizePageCopy()` **只留 `DEFAULT_PAGE_COPY` 白名單內的鍵**。
   我第一版用 `copy.title` 當測試資料，它不在白名單裡 ⇒ 被丟掉 ⇒ 斷言失敗。
   改用真實的鍵（`cta_label`）才有鑑別力。
2. `published_json` 存的是**正規化後的 draft 檢視**（`adminSupportConfig().draft`），
   **不是** DB 裡那個原始的 `draft_json`（原始的可能缺欄位）。
   第一版我拿兩者直接比，當然不同。這兩個若沒被測試擋下，就是我對資料形狀的理解錯誤。

#### 9.4 變異測試

`support-async` 的變異集擴到 **17 條，全部 KILLED**（新增 6 條涵蓋 config 與事件：
`wall_enabled` 讀不出來、draft／published 讀反、publish 發佈錯的欄位、
事件 kind 白名單拿掉、meta 不做白名單過濾）。
跑完用 **sha1** 確認 `supportAsync.js` 沒有停在變異狀態（第 8.3 節的教訓）。

### 第十批（2026-09-27）：CTA 狀態機 ＋ 結帳

#### 10.1 內容

`supportAsync.js` 新增 5 個函式：`evaluateSupportCtaAsync`、`markSupportCtaShownAsync`、
`handleSupportCtaRequestAsync`、`dismissSupportCtaAsync`、`createSupportCheckoutAsync`。

這群是「同步函式互相呼叫」的典型：`handleSupportCtaRequest` → `evaluateSupportCta`
→（`readFlags`／`memberUsageFromFlags`／`readPromptState`／`listCtaRules`）→ `markSupportCtaShown`
→（`readPromptState`／`writePromptState`）→ `recordSupportEvent`。PG 分支照同樣順序逐一 await，
純判斷（`mergeCtaState`／`pickEligibleCtaRule`／`sanitizeUsage`／`dismissUntilFromDays`）留在原模組。

#### 10.2 ⚠️ 這批**沒有讓任何路由變成 PG**——原因就是 session 解析

三條路由（`POST /api/support/cta`、`/api/support/cta/dismiss`、`/api/support/checkout`）
的 support.js 卡點都清掉了，但新尺顯示它們**只剩 `findUserByEmail`**：

```
POST /api/support/cta          MIXED  sqlite=[findUserByEmail]
POST /api/support/cta/dismiss  MIXED  sqlite=[findUserByEmail]
POST /api/support/checkout     MIXED  sqlite=[findUserByEmail]
```

**這是「session 解析仍是前置條件」最具體的一次示範**：工作確實做完了，
但只要 session 還讀節點本機檔案，指標上就永遠是 MIXED。
缺口合計維持 206（SQLite 165→164，MIXED 41→42）。

> 這不改變「移植寫入仍有價值」的結論——這三條的 CTA 狀態與結帳流程不再寫節點本機檔案。
> 只是**指標已經飽和**，再怎麼做單條路由都不會動。

#### 10.3 兩個「測試資料沒踩到差異」（又是同一類，第 N 次）

1. **規則型別要用白名單內的**：我第一版把 CTA 規則的 `rule_type` 設成 `view_count`，
   但 `CTA_RULE_TYPES` 只有 `watch`／`view_listing`／`search`／`commute`，
   而 `usageValue()` 把 `watch` 對到 `usage.watches`。設錯 ⇒ 規則永遠不合格 ⇒ `show:false`
   ⇒ **整條流程根本沒被測到**。
2. **`days` 要用 `DISMISS_DAY_OPTIONS` 裡的值**：`dismissUntilFromDays()` 對不在
   `[7,14,30]` 裡的值會**夾成 7**，所以我用 `days: 3` 時，「寫死 7 天」的變異產生完全相同的結果
   ⇒ 等價變異活了下來。改用 14 之後才殺得掉。

另外修掉夾具的一個結構問題：`user_listing_flags` 有 FK 指向 `users`，夾具少了 `users` 的 DDL 會
`no such table`；但把 `users` 列入**清空**又會因為 `user_settings`／`user_events` 還指向它而
`FOREIGN KEY constraint failed`。正解是**只鏡射 DDL、不清資料**（`MIRROR` 與 `TABLES` 分開）。

#### 10.4 變異測試

`support-async` 的變異集擴到 **22 條，全部 KILLED**。跑完用 sha1 確認模組沒停在變異狀態。

### 第十一批（2026-09-27）：公開支持頁（`publicPagePayload` 那條鏈）

#### 11.1 內容

`supportAsync.js` 新增 `publicSupportConfigAsync`、`previewSupportConfigAsync`，
以及它們背後的整條鏈：`publicSponsorWays`／`monthlyOperatingTotal`／`publicMonthlyCosts`／
`activeCheckoutProvider`／`publicActiveSponsors`／`publicSupportThanks`。
同時把四個列表函式重構成「exec 版 ＋ 對外入口」兩層（`listSupportCostsPg` 等），
讓公開頁那條鏈與對外入口**共用同一份**，不是各寫一次。

**3 條路由轉 PG**：`GET /api/support/public`、`GET /api/support/tiers`、`GET /api/admin/support/preview`。
另外 `publicSupportFallback()`（`/api/support/public` 的 catch 分支）也改用 driver-aware 的 flags
——**catch 分支最容易被漏掉**，漏了就會在錯誤路徑上退回讀節點本機檔案。

**量尺**：SQLite 164→**161**、PG 56→**59**、缺口 206→**203**。

#### 11.2 這批**又**是「測試資料沒踩到差異」×3（全部由單獨斷言抓到）

值得注意的是：**整包 `deepEqual(a, s)` 三次都過**，因為兩邊都拿到同樣的「空」結果。
抓到的都是我自己額外加的單獨斷言：

1. **贊助商檔期**：這個測試檔的 `NOW` 是 **2027-06-01**（第七批為了驗 `resolved_status` 改的），
   而我沿用了 2026 的檔期 ⇒ 到 NOW 時已過期 ⇒ `sponsors` 是空的。
   （`seedAll` 那一份**必須保留 2026**，因為另一條測試靠它驗「已過期」——所以只能改
   `seedPublicPage` 那一份，兩行字面完全相同。）
2. **`copy` 的鍵要在 `DEFAULT_PAGE_COPY` 白名單內**：我用 `intro` ⇒ 被 `normalizePageCopy` 丟掉
   ⇒ 兩邊都是 `undefined`。改用 `cta_label`。**這與第九批是同一個坑，隔兩批又犯一次。**
3. **`providers: {}` 會讓 `publicSponsorLinks()` 回空陣列** ⇒「未開啟時不提供 sponsor_links」
   的變異產生相同結果（等價變異）。必須真的啟用一組（id 是 opay／ezpay／oen／kofi／paypal／bmc／github）。

> **教訓（第三次記錄）**：`deepEqual` 兩個空集合也會過。
> **凡是「整包比對」的測試，都必須為關鍵欄位另外加單獨斷言，而且那些欄位要有非空的值。**

#### 11.3 變異測試

`support-async` 的變異集擴到 **28 條，全部 KILLED**。跑完用 sha1 確認模組沒停在變異狀態。

#### 11.4 ⚠️ 守衛測試會**過期**：移植完成之後，它斷言的就是舊事實

量尺的守衛測試裡有一條用 `/api/support/public` 當 ground truth（驗「吃 handle 參數的 helper
要被看見」）。本批把那個路由移植成 PG 之後，**守衛立刻失敗**——因為它還在斷言「這條是 SQLite」。

這不是壞事（紅燈代表它確實在守東西），但要注意：
**凡是拿「目前還沒移植」當 ground truth 的守衛，都會在移植完成的那一刻失效。**
已改挑一條**仍然只被 `(db, …)` helper 卡住**的路由（`/api/admin/support/dashboard` ←
`supportDashboard(db)`），並在測試裡註明「移植它之後要再換一條」。
**不要為了讓它變綠就把斷言刪掉**——那等於失去這個性質的守衛。

#### 11.5 support.js 的進度

`support.js` 原本可完成 21 條路由，本批之後**只剩 `supportDashboard`（1 條）**尚未移植
——也就是上面的守衛測試正在用的那一條。

### 第十二批（2026-09-27）：support.js 收尾（`supportDashboard`）

`supportAsync.js` 新增 `supportDashboardAsync`（只多了 `eventCounts` 一個查詢，
其餘都是已移植好的積木）。`GET /api/admin/support/dashboard` → **PG**。

**量尺**：SQLite 161→**160**、PG 59→**60**、缺口 203→**202**。
**`support.js` 的 21 條路由全部完成。**

#### 12.1 ⚠️ 守衛測試**連續兩批**失效——這件事本身值得記下來

量尺的守衛測試（驗「吃 handle 參數的 helper 要被看見」）這一輪**換了兩次標的**：

| 標的 | 為什麼失效 |
|---|---|
| `GET /api/support/public`（`publicSupportConfig(db)`） | 第十一批把它移植成 PG |
| `GET /api/admin/support/dashboard`（`supportDashboard(db)`） | 第十二批（同一批工作的下一步）又移植掉 |

**凡是拿「目前還沒移植」當 ground truth 的守衛，都會在移植完成那一刻失效。**
這次刻意挑一個**排在後面的模組**（`memberMedia.js` 的 `listMemberMedia(db)`），
並在測試裡寫明「移植它時要再換標的，**不要刪掉斷言**」。
——刪掉斷言等於失去這個性質的守衛，那比紅燈更糟。

#### 12.2 又是「測試資料沒踩到差異」（同一類第 N 次）

`supportDashboard` 的測試裡我種的交易日期是 **2026-09-10**，但 dashboard 用
`periodBounds("month", NOW)`、而這個檔案的 `NOW` 是 **2027-06-01** ⇒ 交易被排除在區間外
⇒ `totals.count` 是 0。**整包 `deepEqual` 照樣過**（兩邊都 0），只有單獨斷言抓到。

另外我原本把成本硬編成 `1600`，改成「大於 0 ＋ 與同步版相同 ＋ 公開成本小於總成本」
——**從夾具資料推導，不要硬編**（這一條交接文件本來就有列）。

#### 12.3 變異測試

`support-async` 的變異集擴到 **32 條，全部 KILLED**。

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

### 建議的下一個標的（2026-09-27 用**新尺**重排，證據在第 7.4 節）

**頭號目標是 session 解析，不是 `getListing`。**

| 優先 | 標的 | 卡住的路由 | 為什麼 |
|---|---|---:|---|
| **1** | **`readSession()` → `findUserByEmail()`** | **237／288（82%）** | 每一條已登入路由都在讀節點本機 SQLite 解析 session。**這是活的正确性問題**（role／plan／deleted_at 兩台可能不同）。**這是步驟 3 的前置條件，不是另一個待辦**——不修它，繼續移植單條路由的效益趨近於零 |
| 2 | `getListing` → `getListingAsync`（已存在） | 8 | 便宜，但順位在 session 之後 |
| 3 | `getSettings` → `getSettingsAsync`（已存在） | 8 | 同上 |
| 4 | `getCommsConfig` → `getCommsConfigAsync`（已存在） | 10 | **注意：這不是 2 個函式就能解決的**——背後的 `comms.js` 是 812 行、約 20 個吃 handle 的函式（第 7.2 節的實例） |

> 舊尺把 comms 家族顯示成「10 條路由只被 2 個函式卡住」，看起來是最划算的一批。
> **那是缺陷 (2) 造成的低估**：`listCampaignsAdmin(db)`／`createCampaign(db, …)`／
> `publicCommsBundle(db, …)` 全部隱形。動手前務必用新尺再看一次。

### 舊尺時代的建議（保留供對照）

先做**盤點**而不是直接動手：把仍判 SQLite／MIXED 的路由逐條列出「卡住的同步函式」，
再對照 `v3/src/*Async.js` 既有的 export，找出**已經有 PG 版本、只是呼叫端沒接**的那些。
第二批的 `stats` 就是這樣撿到的（3 個字的替換解鎖 3 條路由）。
**但這個盤點在舊尺下會低估**——見第 7.2 節。

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
3. **【新，需 Owner 決定、且是步驟 3 的前置條件】session 解析要不要改成不讀節點 SQLite。**
   實測 **237／288 條（82%）** 的路由每一次請求都會經由 `readSession() → findUserByEmail()`
   讀**節點本機 SQLite** 來解析 session（第 7.4 節）。
   **但要講精確，不要過度宣稱**（我第一版寫成「繼續移植單條路由的貢獻趨近於零」，那是錯的）：
   - ❌ **不成立的說法**：移植單條路由沒用。**移植「寫入」仍然很有用**——它止住新的分歧，
     而分歧正是 `PG-ISLAND-ACTIVE-WRITES` 記的那個主要問題。
   - ✅ **成立的說法**：只要 session 仍讀節點本機檔案，這些路由在**指標上永遠停在 MIXED**，
     所以「進度看起來不動」；而且 **讀取一致性**（role／plan／deleted_at 兩台可能不同）
     是 session 這一項獨有的洞，移植再多的路由都不會修好它。
   ⇒ 所以它是**步驟 3 的完成條件與指標解鎖條件**，不是「其他工作都別做」。
   三條路，取捨不同：

   | 選項 | 做法 | 好處 | 代價 |
   |---|---|---|---|
   | **A. async `readSession`** | 加 `readSessionAsync()`，把呼叫端改 async + await | 語意完全不變、最正確 | **呼叫端極多**（幾乎每個 handler），diff 巨大、回歸風險高 |
   | **B. session 帶著身分** | cookie 內已載 `userId`／`role`／`plan`，加上 `deleted_at` 的判斷方式，`readSession` 就不必讀 DB | 一次解鎖 137 條、且**同步函式不必改** | **語意改變**：role／plan 變更與停權要等 token 更新才生效——這是**安全相關**的取捨 |
   | **C. 把 `users` 同步進節點 SQLite** | 由 PG 週期性同步 `users` 到本機檔案，維持同步讀取 | 不必動呼叫端 | 新增一條同步機制與快取失效問題；兩台仍可能短暫不一致 |

   **我的建議是 B＋縮短 session 有效期**，但這涉及安全語意，必須 Owner 決定。
   在決定之前，`readSession` 保持原狀（現行行為不變）。


## 七、量測工具：兩個缺陷已修，而且一修好就找到真正的頭號卡點

`route-data-map.mjs` 是這個專案的進度尺。它原本有**兩個方向相反**的缺陷，
2026-09-27 兩個一起修好（**不能只修一個**），修完之後第一個跑出來的結果就改變了優先順序。

### 7.1 缺陷 (1) 過度回報：頂層函式的本文會吞掉整段路由 → 已修

本文原本切成「到下一個 `function` 宣告」，那假設頂層函式相鄰。**server.js 不是。**
`yieldEventLoop()`（約行 431）後面接著 **51 個路由註冊**，下一個 `function` 宣告在很後面，
所以它的「本文」把整段吞進去，**任何呼叫它的路由都繼承那一整段裡所有路由的函式引用**。

實測證據：在 `/api/health` 加了一個 `*Async.js` 的函式引用之後，`GET /api/demo`
從「無直接DB」變成 **PG**——只因為同段的 `/api/health` 引用了它，而 `/api/demo` 根本沒碰。

修法：`sliceFunctionBody()` —— **先跳過參數列（從 `(` 做括號配對），再取之後的第一個 `{`**，
然後括號配對到收合（跳過字串與正規表達式字面量）。

> ⚠️ **這裡踩過一次，務必記住**：第一版用「簽名後第一個 `{`」當起點，結果**災難性低估**——
> `function f(userId, { docType = "" } = {})` 的第一個 `{` 在**參數列**裡，配對到參數的 `}`
> 就結束，本文被截斷。288 條裡 **55 條**判定改變，連文件明寫「真的還沒轉換」的
> `/api/admin/legal-copy` 都變成「無直接DB」。**函式本文的起點必須跳過參數列。**

### 7.2 缺陷 (2) 低估：吃 handle 參數的 helper 完全看不到 → 已修

`touches`（「只走 SQLite」的函式集合）原本**只從 `db.js` 計算**。但有一整類 helper 把
SQLite handle 當**參數**傳，住在自己的模組、**沒有 import db.js**：

```js
app.get("/api/support/public", (_req, res) => res.json(publicSupportConfig(db)));
app.get("/api/admin/campaigns", requireAdminApi, (_req, res) =>
  res.json({ items: listCampaignsAdmin(db), config: getCommsConfig(), meta: commsMeta() }));
```

`publicSupportConfig`／`listCampaignsAdmin` 這類函式永遠不進 `touches`，於是那些路由被
判成「無直接DB」。修法：`sqliteNodes` 改成**跨模組、以 `(檔, 函式)` 為鍵**，
任何模組裡「本文直接碰 handle 且不是 driver-aware」的函式都算 SQLite 節點，再沿同模組呼叫傳遞。

> ⚠️ **接收者必須列白名單，不能寫成 `\w+\.(prepare|exec|…)`。**
> 全站 receiver 分佈實測：`db` 1027、`conn` 92（`conn.prepare(` 83）、`sqliteDb` 7；
> 其餘 `re.exec()`／`dest.exec()`／`target.exec()` 全是**正規表達式**的 exec。
> 圖省事寫成萬用字元會製造大量誤判。目前白名單是 `db|conn|sqliteDb` ＋ `sqliteHandle`。

### 7.3 修好之後的驗收（逐條人工核對，不是只看數字）

| 路由 | 舊尺 | 新尺 | 人工核對 |
|---|---|---|---|
| `GET /api/health` | PG | **無直接DB** | 只讀行程內計數器，確實不碰 DB ✓ |
| `GET /api/demo` | 無直接DB | **SQLite** | 經 `buildDemoState` 呼叫 `findUserByEmail`，確實讀 SQLite ✓ |
| `GET /api/support/public` | 無直接DB | **SQLite** | 呼叫 `publicSupportConfig(db)` ✓ |
| `GET /api/admin/campaigns` | SQLite（只 2 個卡點） | **SQLite**（含 `listCampaignsAdmin`） | `comms.js` 是 812 行、約 20 個吃 handle 的函式 ✓ |
| `GET/PUT /api/admin/legal-copy` | SQLite | **SQLite** | 與文件原本的說法一致 ✓ |
| `POST /api/listings/:id/reject-match` | PG | **MIXED** | 見 7.4——這條最有意義 |

### 7.4 🚨 新尺揭示的頭號卡點：**每一條已登入路由都在讀節點本機 SQLite**

`auth.js:71`：

```js
export function readSession(req) {
  ...
  const user = findUserByEmail(data.e);   // ← SQLite 讀取
  ...
}
```

`readSession()` 被**幾乎每一個** handler 呼叫，而它會用 `findUserByEmail()` 讀**節點本機
SQLite** 來解析 session。所以：

- **137 條**（缺口 236 條中的 **58%**）的 sqlite 集合含 `findUserByEmail`。
- 連我這一輪剛移植完、離線與真 PG 都測過的 `/api/listings/:id/reject-match`，
  新尺也正確地標成 **MIXED**——寫入走 PG，但**解析 session 仍在讀節點本機檔案**。

**這是舊尺完全看不到的一整類問題**，而且是**活的正确性問題**：`users` 在兩台節點的
SQLite 各有一份，`role`／`plan`／`deleted_at` 都從本機檔案讀。公開站經 HAProxy 在兩台之間
輪流 ⇒ 同一個人在兩台可能拿到不同的 role／plan，**停權或刪帳號也可能只在一台生效**。

**修法有三條路，各有取捨，需要 Owner 決定**（見第五節第 3 點）。

#### 7.4.1 實際影響是 **237／288 條（82%）**，分析器只數到 137

分析器數到 137 條，但那是**低估**——它還有一個殘留盲點：
`requireAdminApi`／`requireMember`／`requireAuth` 常以**中介層參考**傳入，
不帶括號，所以 `callsIn()`（要求 `NAME\s*\(`）抓不到：

```js
app.get("/api/admin/crm", requireAdminApi, (req, res) => { ... });   // ← requireAdminApi 沒有括號
```

而 `requireAdminApi` → `actorIsAdmin` → `readSession` → `findUserByEmail` → **節點本機 SQLite**。

**直接掃 server.js 獨立量測**（不經分析器）：

| 項目 | 條數 |
|---|---:|
| 路由總數 | 288 |
| 以 middleware 參考傳入 `require*` | **122** |
| handler 內直接呼叫 `readSession`／`requireMember` | **121** |
| **至少讀一次節點 SQLite 解析 session 的** | **237（82%）** |

**這件事改變了整個遷移的策略結論**：

> **在 session 解析修好之前，缺口數字不會下降**：一個已登入路由就算把每一段 SQL 都搬到 PG，
> 它**每一次請求**仍然會讀節點本機檔案來認人，所以在指標上永遠停在 MIXED。
> 兩台節點的 `role`／`plan`／`deleted_at` 不同時，行為也會不同。
>
> ⚠️ **但這不等於「移植路由沒用」**——移植**寫入**仍然止住新的分歧（那才是主要問題）。
> session 這一項解鎖的是**指標**與**讀取一致性**，兩者要分開講。

所以第五節第 3 點那三條路**不是「另一個待辦」，而是整個步驟 3 的前置條件**。

> ⚠️ **殘留限制（尚未修）**：分析器不會追「以參考傳遞的中介層」。
> 我**沒有**再動分析器——本輪已經換過一次基準，而修這一項不會改變上面的策略結論
> （決定權在 Owner）。要修的話是在路由迴圈裡多掃 handler 之前的中介層識別字並解析它。
> **在那之前，請以「237 條」為準，不要用分析器的 137。**

> 次要但同樣是「一整類」的：`getUserById`（27 條）、`tableColumns`（23）、
> `sqlExcludeFixtureRows`（23）、`isFixtureMaturityAuthorized`（21）、`ensureUser`（20）。
> 這些全是吃 handle 參數的 helper，以前完全不在雷達上。

## 八、步驟 4～7（後續步驟）

- **步驟 4（三邊對帳）**：轉換完成後再執行。工具已備：md5 比對三邊、主鍵集合比對。
- **步驟 5（功能等價驗證）**：對照測試。
- **步驟 6（cluster／雙備援運轉）**：**最後**才做。
- **步驟 7（移除 SQLite）**：`db.js` 的 SQLite 分支、`sqliteFallback`、本機檔案一併移除，
  屆時「雙路徑」「節點分歧」這整類問題會一起消失。
