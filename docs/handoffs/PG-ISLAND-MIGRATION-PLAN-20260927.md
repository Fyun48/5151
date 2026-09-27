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

| 判定 | 舊尺（有缺陷） | 新尺（換尺當下） | 第三批後 | 第四批後 | **第五批後** |
|---|---:|---:|---:|---:|---:|
| SQLite | 80 | 189 | 179 | 173 | **170** |
| MIXED | 36 | 47 | 49 | 49 | **50** |
| 無直接DB | 117 | 26 | 26 | 26 | **26** |
| PG | 55 | 26 | 34 | 40 | **42** |
| **缺口合計（SQLite＋MIXED）** | **116** | **236** | **228** | **222** | **220** |

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
