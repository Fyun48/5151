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

### 🚨 2026-09-27 第十三批：**基準再換一次**（session 改由 PG 解析 ＋ 尺規缺陷 (6)）

第十三批不是移植路由，而是換掉整個缺口的地基（session）並修掉尺規的第三個低估缺陷。
**舊的兩套數字都保留在上面與下方**，新數字在第三張表：

| 判定 | 新尺（第 12 批） | **+session 改 PG** | **+缺陷 (6)（現行基準）** |
|---|---:|---:|---:|
| SQLite | 160 | 62 | **17** |
| MIXED | 42 | 117 | **164** |
| 無直接DB | 26 | 26 | **20** |
| PG | 60 | 83 | **87** |
| **缺口合計（SQLite＋MIXED）** | **202** | **179** | **181** |

三個關鍵讀數：
* **SQLite（只走 SQLite、完全沒碰 PG）從 160 掉到 17**——剩下的 17 條是登入／註冊／
  OAuth／法律文件／需求聚合這幾群，每一群都是一個獨立深模組。
* **MIXED 從 42 漲到 164**。這不是退步：MIXED 是**誠實**的那一格，代表「這條路由
  PG 一部分、SQLite 一部分，需要人工看」。漲這麼多是因為 137 條路由的 session 依賴
  由 SQLite 換成 PG，於是它們從「純 SQLite」變成「PG session ＋ SQLite 業務邏輯」。
  真正該追蹤的是「還有哪些 SQLite 卡點、它們是不是同一批」。
* 缺口合計 179→181 的 +2 是修掉低估的結果（6 條被誤標成「無直接DB」的路由揭露了
  PG session 依賴），**不是退化**。

詳細原因、驗收與教訓見第二節「第十三批」。

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

### 第十三批（2026-09-27）：**session 改由 PG 解析**（Owner 方案 A）＋ 尺規缺陷 (6)

這一輪不是移植某一條路由，而是把**整個缺口的地基**換掉，所以數字變動最大。

#### 13.1 為什麼一定要先做這件事（第 7.4 節那個頭號卡點的兌現）

第 7.4 節量到「每一條已登入路由都在讀節點本機 SQLite」：`readSession()` →
`findUserByEmail()` → `v3.db`，`server.js` 有 **113 個呼叫點**，尺規上 **137 條**路由
因此被判成 SQLite／MIXED。實際後果不是「數字不好看」而是**數字不會動**：

```
POST /api/support/cta   MIXED   sqlite=[findUserByEmail]   pg=[handleSupportCtaRequestAsync]
```

support.js 21 條全部移植完了，這條卻永遠停在 MIXED——因為剩下的唯一卡點是 session。
**只要它在，後面每一批移植都會停在 MIXED。**

#### 13.2 做法（Owner 從三個選項中選 A）

新增 `readSessionAsync()`（driver-aware：PG 分支查 `users`，讀取政策下 fail-open 回本機
SQLite），並在 `server.js` **第一條路由之前**掛 `app.use(resolveSession())`：
中介層每請求解析一次、把結果快取在 `req` 的一個 Symbol 上，`readSession()` 改成優先讀快取。

**113 個呼叫點一行都沒改。** 而且因為同一請求內 `readSession()` 常被呼叫好幾次，
每請求的 `users` 查詢次數反而**變少**（見 13.5 的實測）。

* 簽章驗證（`sessionClaim()`）與身分組裝（`sessionFromUser()`）都只有一份，同步／PG／
  fallback 三條路共用，形狀不可能漂移。
* 沒有 cookie、或路徑是純靜態資產（`/media/`、`/vendor/`、`/icons/`、`/brand/` 且帶副檔名）
  ⇒ 直接寫入 null，**完全不碰 DB**。帶 cookie 載入 30 個圖檔不該換來 30 次 `users` 查詢。
* `readSession(req)` 仍然保留同步路徑：任何沒經過中介層的呼叫端行為完全不變。

#### 13.3 尺規缺陷 (6)：**傳參考的函式／中介層完全看不到**

修 session 的同時，尺規冒出一個一直在那裡、只是被掩蓋的低估：

`callsIn()` 要求名字後面接 `(`，所以**把函式當參數傳**的寫法一條邊都建不起來：

```js
res.json(buildDemoState({ listUserIds, getSettings, defaultUserId, listListings, stats }));
app.get("/api/admin/providers", requireAdminApi, handler);
```

那 5 個全是 db.js 的 SQLite 讀取，`requireAdminApi` 則是 PG session 的入口。
這個低估被掩蓋了很久：`/api/demo` 本文有 `readSession(req)`，那條邊會拉到
`findUserByEmail`，於是它「剛好」顯示成 SQLite。**session 改成 PG 之後掩蓋消失**，
`/api/demo` 立刻變成 `PG` 且 `sqlite=[]`——低估是真的，不是新壞的。

修法保守度：
* 只在**路由本文**這一層放寬（函式本文仍用 `callsIn`）。
* `callsIn()` 優先於同名守衛（第一版順序寫反，害 4 條路由的 sqlite 集合反而**變小**）。
* 排除**物件字面量的鍵**（`stats:`）：`res.json({ stats: await listingStatsAsync(…) })`
  曾把 db.js 的 `stats()` 整條鏈（7 個函式）拉進 reject-match。

#### 13.4 順手修掉的尺規不穩定：fixpoint 在循環上不單調

驗證缺陷 (6) 時量到「加一條邊竟然讓 4 條路由的 sqlite 集合**變小**」——那不是判定調整，
是 bug：`resolveNode()` 遇到循環時回一個**全新的空集合**，讓「先被走到的節點」吃掉
循環另一端的函式；外層又固定只跑 5 輪，可能還沒收斂。

修法：循環時回傳**目前累積的部分結果**，外層迭代到**不再變動**為止（上限 20 輪）。
驗收標準是**單調性**：新增邊只能增加、不能減少（實測 0 條違反）。

> ⚠️ 這條修正對**現有輸入**是等價變異（舊版 5 輪也收斂到同一組判定，0 條差異），
> 所以變異集裡**刻意沒有**對應的變異——它是穩健性修正，不假裝被測試守住。

#### 13.5 量測（可重跑）

```
node v3/scripts/route-data-map.mjs
```

| 判定 | 舊尺 | 新尺（第 12 批） | **+session（13.2）** | **+缺陷 (6)（13.3/13.4）** |
|---|---:|---:|---:|---:|
| SQLite | 80 | 160 | 62 | **17** |
| MIXED | 36 | 42 | 117 | **164** |
| 無直接DB | 117 | 26 | 26 | **20** |
| PG | 55 | 60 | 83 | **87** |
| **缺口合計（SQLite＋MIXED）** | **116** | **202** | **179** | **181** |

> ⚠️ **缺口合計從 179 回到 181 不是退步**：缺陷 (6) 修好後，**6 條**原本被低估成
> 「無直接DB」的管理路由（`PUT /api/admin/ads`、`PUT /api/admin/broadcasts`、
> `GET/PUT /api/admin/providers`、`POST /api/admin/providers/test`、
> `GET /api/admin/providers/usage`）揭露了它們其實有 PG session 依賴 ⇒ 判定由
> 「無直接DB」變 **PG**（那 6 條本來就是好的，只是尺規看不到）。
> MIXED 從 117 變 164 也一樣——MIXED 是**誠實**的那一格（「PG 一部分、SQLite 一部分，
> 需要人工看」），它變多代表原本藏在 SQLite 底下的 PG 依賴被看見了。
> **判讀請看 SQLite 那一格與「哪些卡點是同一批」**，不要只看缺口合計。

驗收（全部可重跑）：
* 尺規**單調性**：57 條判定改變，`sqlite`／`pg` 集合**沒有任何一條變小**（0 條違反）。
* 尺規**決定性**：連跑兩次輸出完全相同。
* `route-data-map` 變異集 **7/7 KILLED**（含新增的 4 條：缺陷 (6)、物件鍵誤判、
  掛載點檢查失效）。
* `session-async` 變異集 **10/10 KILLED**（快取／驗簽／到期／刪除／fail-open／靜態跳過／
  欄位形狀，各一條）。

#### 13.6 這一輪的教訓（給下一個 session）

1. **守衛測試的「已核對事實」會過期，而且過期方式有兩種**：一種是標的路由被移植掉
   （第 12 批已記錄），另一種是**上游規則改了**（session 改 PG 之後，7 條守衛的期望值
   同時失效）。第二種更危險，因為它會讓守衛**安靜地失去鑑別力**——`/api/demo` 的
   缺陷 (1) canary 就是這樣變成永遠綠燈的。
2. **缺陷的殺手要挑「被污染到的路由」，不能挑「污染源自己」。** 實測缺陷 (1) 對
   `/api/demo` 已經完全沒有影響（它的本文本來就在被吞的範圍內），但
   `/api/support/public` 會從 `PG / sqlite=[]` 變成 `MIXED / sqlite=132 個`。
3. **改量尺的規則時，一定要先存基準再做實驗。** 這次每一版尺規的 `--json` 輸出都留著
   （`/tmp/rdm2.base.json` 起算），才能證明「57 條判定改變」每一條都有解釋。
4. 真的 SQLite schema **有 FOREIGN KEY**（PG 那三張表沒有）：測試裡 `DELETE FROM users`
   會直接 `FOREIGN KEY constraint failed`，要改成只刪自己造的那一批。

#### 13.7 同一輪的收尾：靜態資產判斷漏掉 public 根目錄

`isStaticAssetPath()` 第一版只認 `/vendor/`、`/icons/`、`/brand/`、`/media/` 四個前綴。
但**最大一批靜態檔是 `express.static(v3/public)` 從 public 根目錄服務的**
（`/app.js`、`/support-page.css`、`/admin-support.js`…），那些全部沒被跳過——
登入者每次載入頁面都會為每個檔案各查一次 `users`，正是這個跳過機制要避免的成本。

改成「**符合靜態副檔名、且不在 `/api/` 底下**」，四個前綴自然被涵蓋。
安全前提是「沒有動態路由長得像靜態檔」；目前唯一符合的是 `GET /sw.js`
（純 `sendFile`，用 `_req` 不讀 session）。這個前提**不再靠假設**：
`route-data-map.test.js` 加了一條守衛盯著它，之後有人加了會讀 session 的副檔名路由，
那一條會紅並指向 `auth.js` 的 `DYNAMIC_ASSET_PATHS`。

> 📌 `session-async` 變異集隨之擴到 **11 條**（多一條「退回四個前綴」）。
> 過程中踩到一次**假 SURVIVED**：我把測試名改了，但變異集的 `expect` 沒跟著改，
> 結果是「有殺手卻指名不到」。**變異工具比對的是測試名稱，改測試名一定要同步改 `expect`。**

### 第十四批（2026-09-27）：`listingTools.js`（說明範本 ＋ 聯絡人，10 條路由）

`v3/src/listingToolsAsync.js`（新）＋ 10 條路由改 async。這是 session 改 PG 之後
**第一批量到數字**的移植：SQLite 17（不變）、MIXED 164→**154**、PG 87→**97**、
缺口 181→**171**。

#### 14.1 為什麼這批划算

`/api/listing-description-templates`（5 條）＋ `/api/listing-contact-profiles`（5 條）
是缺口裡最集中的一群，而且只碰三張表，沒有跟 `listings` 的複雜寫入糾纏。
它們原本的卡點是 `getUserById`（`listingToolsInfo(session.userId)` 為了拿 plan／role
去查一次 `users`）＋ 各自的同步函式。

**`getUserById` 那一段可以直接消掉**：上限只取決於 plan／role，而 session 已經每請求
從 PG 解析出來了（第十三批），所以改用**純函式** `listingToolsMeta(session)` 就好——
少一次 `users` 查詢，也少一個卡點。這不是取巧：session 每請求重讀，plan 一定是新的。

#### 14.2 為了不複製邏輯，順手抽了三個純函式

同步版把同一組規則寫在兩個地方（建立／更新各一份）。PG 分支要能用同一份，所以先抽出並
`export`，**同步版照用同一份、行為不變**（`listing-tools.test.js` 12/12 仍然通過）：

| 抽出的純函式 | 原本重複在哪 |
|---|---|
| `templateFields(input, fallback)` | `createDescriptionTemplate` 與 `updateDescriptionTemplate` 各寫一次名稱／內容的正規化與驗證 |
| `accountFieldsFromUser(user)` | 「從 `users` 一列組出帳號聯絡人欄位」只有 SQLite 版本，PG 需要同一份 |
| `sanitizeContactInput` / `publicTemplate` / `publicContact` / `httpError` / `iso` | 純函式，直接加 `export` |

#### 14.3 兩件**同步版有、PG 沒有**的東西（這批真正的難點）

1. **方言**：同步版用 `IFNULL(is_account,0)`，PG 不接受，而且注入式 `exec` 不經過
   `toPostgresSql` ⇒ PG 分支一律 `COALESCE`。夾具會主動拒絕 `IFNULL`，另有一條測試
   掃過整組 `*_SQL` 常數確認沒有殘留。
2. **部分唯一索引**：同步版靠 `hasAccountContactUniqueIndex()` 讀 **`sqlite_master`** 確認
   「一位使用者最多一筆帳號聯絡人」的 `CREATE UNIQUE INDEX … WHERE is_account = 1` 存在。
   **PG 沒有 `sqlite_master`**，而且實測正式站那三張表**只有 pkey**（匯入時 `indexes:false`）
   ⇒ 索引根本不存在，併發首次建立會生出兩筆帳號聯絡人。
   `ensureListingToolsStoreOnce()` 改成：明確的 PG DDL（`GENERATED BY DEFAULT AS IDENTITY`、
   `ADD COLUMN IF NOT EXISTS`）→ **先清重複**（`HAVING COUNT(*) > 1`，保留 id 最小那筆）→
   再建部分唯一索引；每個 pgDriver 只做一次。

#### 14.4 驗收（全部可重跑）

* `v3/test/listing-tools-async.test.js` **20/20**（新）。每個動作都比對**落地的列**
  （disk vs 夾具），不是只比回傳值。
* `v3/scripts/mutation-check.mjs v3/test/listing-tools-async.test.js` → **13/13 KILLED**。
* **live PG**：`v3/test/listing-tools-live-pg.test.js`（新）在 NAS 的**隔離** repro 容器
  （`prb-repro-pg`，`192.168.0.220:15434/repro`）**2/2 通過**。這支證明的是離線夾具
  **證明不了**的三件事：PG 專屬 DDL 真的合法、部分唯一索引真的擋得住第二筆帳號聯絡人、
  identity 序列真的會前進（`admin_audit` 那個缺陷的同類風險）。
  安全設計照抄 `reject-match-live-pg.test.js`：**不吃 `PG_TEST_URL`**（本機那個就是正式站），
  只認 `PG_LIVE_REPRO_URL` 且資料庫名要在允許清單內；CI 的拋棄式 `tracker_test` 在清單內。
* 同步版 `v3/test/listing-tools.test.js` **12/12**（重構後行為不變）。

#### 14.5 這一批的教訓

1. **`is_account` 是布林不是 0/1。** `publicContact()` 做 `Number(row.is_account) === 1`，
   所以 `is_account: true/false`。我第一版斷言 `=== 1`／`=== 0`，測試紅了才知道——
   **回傳形狀要看實作，不要憑印象**（這是本系列第 N 次同一類錯誤）。
2. **同步版沒有 `now` 參數的函式，只能凍結時間。** `listContactProfiles(db, uid)` 內部用
   `new Date()`（而且每次都會 UPDATE 帳號聯絡人的 `updated_at`），所以 PG／SQLite 兩次呼叫
   必然差幾毫秒。用 `node:test` 的 `t.mock.timers.enable({ apis: ["Date"] })` 凍結後才比得出來。
3. **上限類的守衛一定要真的撞到上限。** 「免費 2 則」如果只建 1 則就斷言，是空測試；
   所以測試建滿、斷言 409 `template_limit`，再用 `plan: "sponsor"` 證明第 3 則其實放行
   ——後面那一半才是「擋下來真的是因為上限」的證據。

### 第十五批（2026-09-27）：`memberMedia.js`（照片素材庫，8 條路由）

`v3/src/memberMediaAsync.js`（新）＋ 8 條 `/api/media*` 路由改 async。
SQLite 17（不變）、MIXED 154→**146**、PG 97→**105**、缺口 171→**163**。

**刻意不含 `POST /api/media`（上傳）**：`saveMemberMedia()` 是「影像處理 → 交易內配額檢查 →
寫檔 → 上傳 R2」，交易橫跨檔案 I/O 與網路。搬到 PG 要重新設計交易邊界（PG 的交易不宜橫跨
網路 I/O：連線與鎖都會被佔住），那是獨立一批。

#### 15.1 方言陷阱：`COLLATE NOCASE`

同步版在標籤列表與照片的標籤 JOIN 都用 `ORDER BY name COLLATE NOCASE`。
**`NOCASE` 是 SQLite 專屬 collation，PG 沒有**（`collation "nocase" for encoding "UTF8"
does not exist`）。PG 分支改用 `ORDER BY lower(name)`。夾具主動拒絕 `COLLATE NOCASE`，
另有一條測試掃過整組 `*_SQL` 常數；排序本身也有一條測試（三個標籤刻意大小寫混雜，
把 `lower()` 拿掉就會排錯）。

#### 15.2 與 budgetGuardAsync 同一類的坑：**表約束不會被 pgSchema 鏡射**

`media_tags` 的 `UNIQUE(user_id, name)` 是**表約束** ⇒ 隱式索引、不在 `sqlite_master` ⇒
`pgSchema` 看不到。實測正式站 `media_tags` **只有 pkey**，`member_media` 也只有 pkey
（`idx_member_media_key` 的 storage_key 唯一索引同樣不存在）。後果不只是「少一個索引」：

* `createMediaTag` 的「同名就重用」變成永遠不會觸發；
* `renameMediaTag` 的 409「已有同名標籤」永遠不會發生；
* 同一個 storage_key 可以寫進兩列。

`ensureMemberMediaStoreOnce()` 明確補建兩個唯一索引。清重複標籤時**不是直接刪掉**，
而是先把 `media_tag_map` 的對應**改指到保留者**（`INSERT … SELECT … ON CONFLICT DO NOTHING`
再刪），否則使用者的分類會無聲消失。

#### 15.3 兩個刻意的行為差異（不是「照抄同步版」）

1. **只有真的是重複才轉 409。** 同步版 `renameMediaTag` 是 `catch { throw 409 tag_exists }`
   ——連「連線斷了」都會被報成「已有同名標籤」。PG 分支只認唯一性違反（`23505` 或夾具的
   `UNIQUE constraint failed`），其餘原樣往上丟。有一條測試專門證明非重複錯誤會往上丟。
2. **刪檔在交易之外。** 同步版是刪完 DB 再清檔；PG 這邊刻意**等交易提交後**才清
   （`pendingCleanup`）——在交易裡刪檔，一旦 rollback 就會「DB 還留著、檔案已經沒了」。

#### 15.4 量尺守衛第三次換標的——這次改成驗「性質」

`route-data-map.test.js` 的「吃 handle 參數的 helper 必須被看見」這條守衛**第三次失效**
（`/api/support/public` → `/api/admin/support/dashboard` → `/api/media`，每一個都被移植掉）。
這次除了換成 `demand.js` 的 `getWishExample(db, userId)`（1698 行、沒有 import db.js，
剩下最大的模組之一），**另外加了一條不綁單一路由的性質測試**：
六個「住在 db.js 以外、吃 handle 參數」的 helper 至少要看到 3 個——移植掉一兩個模組
不會讓它紅，但「sqlite 歸屬只看 db.js」的退化一定會被擋下。

#### 15.5 🚨 live PG 抓到一個**離線測試抓不到**的真 bug（這一批最重要的收穫）

**症狀**：`syntax error at or near "AND"`。

**根因**：`pgDriver.query()` **不翻譯** SQLite 方言——它要求呼叫端自己
`toPostgresSql()`（或走 `driver.runSqliteSql()`）。我在兩個模組的 dedupe 輔助函式裡
直接把帶 `?` 的語句丟給 `pgDriver.query()`。

**為什麼離線測試抓不到**：那段程式只有「真的有重複資料」時才會執行，而兩支離線夾具
種的資料從來沒有重複過 ⇒ 迴圈主體一次都沒跑。listingTools 的 live PG 測試也照樣通過
（正式站的帳號聯絡人沒有重複）——**同一個 bug 在兩個模組裡都活著**。

**怎麼被抓到的**：memberMedia 的 live PG 測試**刻意先種兩筆同名標籤**（因為那正是
bootstrap 要處理的情境），於是迴圈第一次真的執行，就炸了。

修完之後做了兩件事，讓同一個錯誤以後在離線就看得見：
1. 兩支離線測試的**假 pgDriver 主動拒絕含 `?` 的語句**（模擬真 driver 的契約）。
   這與「夾具主動拒絕 IFNULL／COLLATE NOCASE」是同一套紀律，只是搬到 **driver 邊界**。
2. 假 driver 只認翻譯後的 `$n`，連斷言也一起改成比對 `$1`。

> **教訓**：離線 parity 測試證明的是「兩邊算出同樣的結果」，**證明不了「送進 PG 的語句
> 合法」**。凡是「只有特定資料形狀才會走到」的分支（清重複、補索引、回退、競態），
> 離線夾具一定要**刻意造出那個形狀**，否則那段程式等於沒測。

#### 15.5 驗收

* `v3/test/member-media-async.test.js` **21/21**（新）；`listing-tools` 的教訓沿用：
  每個動作都比對**落地的列**。
* 變異測試 **13/13 KILLED**。
* 既有 `media-*.test.js` ＋ `member-media.test.js` **34/34**（重構後行為不變）。
* 過程中**我自己加的守衛抓到一次空比對**：「刪除標籤」原本只種一個標籤，刪完兩邊都是 0 列，
  `assertSameRows` 直接断言「兩邊都是 0 列時這個比對沒有鑑別力」。修成留一個不會被刪的標籤。
  ——這正是那條守衛存在的理由。

### 第十六批（2026-09-27）：`contentDocuments.js`（條款／隱私權，9 條路由）

`v3/src/contentDocumentsAsync.js`（新）＋ 9 條路由改 async。
SQLite 17→**15**、MIXED 146→**139**、PG 105→**114**、缺口 163→**154**。

#### 16.1 這批的核心：**不可變性是用 SQLite TRIGGER 實作的**

同步版不是用程式碼擋「已發布文件被改本文」，而是建了一個 SQLite trigger
（`contentDocuments.js:106`）：

```sql
BEFORE UPDATE ON content_documents
WHEN OLD.status = 'published' AND (NEW.body IS NOT OLD.body OR …)
BEGIN SELECT RAISE(ABORT, 'published_document_immutable'); END;
```

**PG 完全不吃這個語法**：沒有 `IS NOT OLD.x`（PG 要用 `IS DISTINCT FROM`，因為 `IS NOT`
不能比 NULL），也沒有 `RAISE(ABORT)`。等價寫法是 plpgsql 函式 ＋
`CREATE TRIGGER … EXECUTE FUNCTION`，而且 PG 沒有 `CREATE TRIGGER IF NOT EXISTS`，
所以 bootstrap 的順序必須是 **建函式 → DROP TRIGGER → CREATE TRIGGER**。

**這不是加固，是一條真的業務規則**：已發布的條款若能被事後改掉，使用者同意過的版本
就會跟畫面不一致。少了它，PG 上等於沒有這個保護。

離線 parity 用的是記憶體 SQLite（跑的是 SQLite 那一版 trigger），所以它**證明不了**
PG 的 trigger 真的建得起來、真的擋得住。這正是上一批（memberMedia）的教訓，所以這次
直接補了 `content-documents-live-pg.test.js`：在隔離的 repro PG 上發發布一份文件，
然後**直接對 PG 下 UPDATE** 改 body／title／check_label／content_hash／version，
逐欄確認被 `published_document_immutable` 擋下；再反向確認改旗標（enabled／
effective_until）**不會**被誤擋。

#### 16.2 變異測試逼出兩條「看起來有驗、其實沒驗」的測試

第一次跑變異是 **13/15**，兩條 SURVIVED，兩條都是真的覆蓋缺口：

| 變異 | 為什麼原本殺不掉 | 修法 |
|---|---|---|
| 拿掉 `containsUnsafeMarkup` 檢查 | 我把不安全標記放在 **body**，但 `sanitizeDocumentBody()` 會**先剝掉** `<script>…</script>`，所以那個檢查永遠不會被觸發 | 改放 **title**／check_label（走 `sanitizeDocumentText()`，只去 NUL／換行、不剝標記） |
| 拿掉稽核事件 limit 的夾範圍 | 只比對回傳值驗不到：當時只有 3 筆事件，`limit=200` 與 `limit=999` 結果一樣 | 改成**直接驗送進 SQL 的參數**（包一層 spy 記錄 `LIMIT ?` 的實參） |

順帶又抓到一次「憑印象寫期望值」：我原本斷言 `limit: 0` 會被夾成 1，實際上
`Number(limit) \|\| 50` 讓 `0` 先變成 50（`Math.max` 之前就替換掉了，同步版一模一樣）。
**期望值要讀程式碼，不要讀直覺。**

#### 16.3 測試冪等性：live 測試重跑會失敗

`member-media-live-pg` 第一次重跑就紅了：它刻意在**索引不存在**的狀態下種兩筆同名標籤，
但上一次執行已經把唯一索引建起來了 ⇒ 種資料這一步先撞索引。
修法是**先 `DROP INDEX IF EXISTS` 還原成正式站目前的狀態**再種。
**live 測試會在同一台隔離 PG 上反覆執行，凡是「驗 bootstrap 補建」的測試都必須自己
把環境還原成「還沒補建」的樣子。**

#### 16.4 驗收

* `v3/test/content-documents-async.test.js` **15/15**（新）。
* 變異測試 **15/15 KILLED**（含把 trigger 寫回 SQLite 語法、漏掉不可變欄位、
  bootstrap 順序顛倒、拿掉應用層 409 檢查、版本號重複、生效判定漏 enabled／effective_from、
  supersedes_id、重複發布的稽核、旗標三態、不安全標記、limit 夾範圍、預設法務文案）。
* **live PG 1/1**（隔離 repro）；既有 `content-documents.test.js` 7/7 不變；
  尺規守衛 14/14 不變。

### 第十七批（2026-09-27）：`comms.js`（公告 ＋ 贊助活動，14 條路由）

`v3/src/commsAsync.js`（新）＋ 14 條路由改 async。
SQLite 15→**12**、MIXED 139→**128**、PG 114→**128**、缺口 154→**140**。

涵蓋：後台公告 4 條、後台活動 3 條、公開公告 4 條、曝光／點擊 1 條，
外加 `/api/sponsored`、`/api/comms`（`publicCommsBundleAsync` 把已移植的三個積木接起來）。

#### 17.1 這批沒有新方言陷阱，要自己補的是**索引**

`ON CONFLICT … DO UPDATE SET excluded.x` 與 `version=version+1` 兩邊都合法，所以這批
幾乎是機械轉換。真正要處理的是：正式站那五張表**只有 pkey**，
`idx_announcements_active`／`idx_campaigns_active`／`idx_sponsored_events_bucket`
都不存在。它們不是唯一約束（少了不會壞），但 `/api/announcements` 是**每個訪客都會打**
的端點，少了索引就是全表掃描。bootstrap 補建。

#### 17.2 最細的一條語意：公告狀態的 upsert

```sql
-- 已讀
ON CONFLICT(announcement_id, user_id) DO UPDATE SET read_at = excluded.read_at
-- 關閉
ON CONFLICT(announcement_id, user_id) DO UPDATE SET dismissed_at = excluded.dismissed_at,
                                                   read_at = COALESCE(announcement_member_state.read_at, excluded.read_at)
```

關閉時**不得**把原本的已讀時間蓋成關閉時間（那兩句寫錯都不會壞，但時間語意會失真）。
測試雙向驗：先讀再關（read_at 保留原值）、先關再讀（dismissed_at 不被清掉）。

#### 17.3 變異測試逼出的三個問題（兩條空測試 ＋ 一次字串不符）

第一次跑 **14/16**：

| 問題 | 根因 | 修法 |
|---|---|---|
| 「頻道整包取代」殺不死 | `normalizeCampaignInput` 對 `inapp` 的預設是 `channels.inapp !== false`（true），我卻用預設值去測 ⇒ 合併與取代算出來剛好一樣 | 先把 `inapp` 設成 **false** 再只更新 webhook |
| 「不過濾 channel_inapp」殺不死 | 只種了一筆 `inapp:true` 的活動 ⇒ 過濾是 no-op | 再種一筆 `inapp:false`，斷言它進 cards 但**不進** notify |
| 換標的之後仍報 SURVIVED | `expect` 寫「頻道**要**合併」，測試名是「頻道**合併**…」 | 對齊字串 |

> **`expect` 比對的是測試名稱，不是斷言訊息。** 這已經是第二次踩到（上一次是改測試名忘了
> 同步改 `expect`）。兩次都表現成「有殺手卻報成 SURVIVED」的**假訊號**，比紅燈更危險。

#### 17.4 量尺守衛**第四次**換標的——這次是先用實測反推，不是憑感覺挑

`/api/admin/campaigns`（`listCampaignsAdmin`）被這批移植掉 ⇒ 「被低估的那一批」守衛失效。
換標的過程本身有兩個坑：

1. 先挑 `addDemandReply` → **殺不死**：它是 db.js 的包裝（`addDemandReply as addDemandReplyOn`），
   在「只認 db.js」的缺陷下照樣被算進去。
2. 再挑 `countWatched`（`watchLimits.js`，server.js 直接 import）→ **還是殺不死**：
   實測把缺陷套回去跑一次，288 條裡**只有 2 條**判定會變，`countWatched` 不在其中
   （它與 db.js 的集合重疊）。

最後是**把缺陷套回去實跑、反推出那 2 條**，才找到 `changesSince`／`currentRevision`
（`dataRevision.js`，沒有 import db.js）與 `searchAdminListings`。
性質測試的清單也一併換成這三個，門檻從 3 降到 2。

> **教訓**：換守衛標的時，「看起來是那一類」不算數——要**把缺陷套回去實測**，
> 確認那個標的真的會變。這一輪為此白換了兩次。

#### 17.5 驗收

* `v3/test/comms-async.test.js` **16/16**（新）；變異測試 **16/16 KILLED**。
* 尺規變異 **7/7 KILLED**；既有 `comms.test.js` 8/8 不變。

### 第十八批（2026-09-27）：`rentalCatalog.js`（租屋目錄，9 條路由）

`v3/src/rentalCatalogAsync.js`（新）＋ 9 條路由改 async。
SQLite 12（不變）、MIXED 128→**119**、PG 128→**137**、缺口 140→**131**。

#### 18.1 這個模組幾乎沒有 SQL——儲存層是 settings 的 JSON blob

目錄本體存在 `settings` 表的一個鍵裡，所以儲存層直接用已移植的 `settingsKvAsync`，
**邏輯全部重用 `rentalCatalog.js` 的純函式**。真正的工作是**行程內快取的一致性**：

db.js 的同步版除了寫 settings，還會呼叫**六個 setter** 更新行程內快取
（`setRentalCatalogCache`／`setSelfListingCatalog`／`setRentalMatchHydrate`／
`setWishOfferHydrate`／`setRentalNotifyHydrate`／`setRentalMarketplaceFlags`）——
那些是 selfListings／wishOffers／rentalMatch 的**同步路徑**在讀的。
PG 分支若只寫 DB 不更新快取，同一台節點會立刻「後台改完、前台沒變」。
所以 `hydrateCaches()` 在**每次讀取也會跑**，節點的快取會自動收斂到 PG 的版本。

#### 18.2 變異測試第一次 8/14——六個存活，根因都是「同步版把缺陷蓋掉了」

最典型的一個：測試寫成「PG 寫入 → 再呼叫同步版比對 → 讀快取」，
但**同步版本本身也會 hydrate 快取**，所以 PG 分支漏掉 hydrate 完全看不出來。
修法是**在只走過 PG 的那個時間點就讀快取**，再跑同步版比對。

其餘五個同類：讀取路徑要先直接把目錄種進 PG 夾具（不經 async 寫入）才驗得到收斂；
系統範本要連「覆寫」一起驗（只驗改名／刪除殺不死 save 的變異）；
`delete_condition` 要**種一筆引用**（沒有引用時硬刪與停用結果一樣）；
草稿路徑也要單獨驗安全檢查。

> **教訓**：parity 測試若把「同步版」當成對照組，要小心對照組自己會做的副作用
> （快取、快照、hydrate）——它會把受測分支的缺失蓋掉。**斷言要在對照組動手之前做。**

#### 18.3 測試資料的三個坑（都是「憑印象」）

| 坑 | 症狀 | 正解 |
|---|---|---|
| 手寫 `{categories:[{conditions:[…]}]}` | 正規化後 conditions 是**頂層陣列**，標籤還會被對應到既有 domain ⇒ diff 永遠是空的 | 用 `defaultCatalog()` 當底再改 |
| 以為 `normalizeTemplate` 會保留傳入的 id | 後續 rename 找不到範本 | 用**回傳的** `created.id` |
| 以為 `saveRentalCatalog` 只寫一個鍵 | 實際寫兩列（目錄 ＋ 清成 null 的草稿） | 斷言兩個鍵 |

另外 `listings` 的欄位用 PRAGMA 推導（`source_key`、`first_seen_at` 都是 NOT NULL 無 default）。

#### 18.4 驗收

* `v3/test/rental-catalog-async.test.js` **14/14**（新）；變異測試 **14/14 KILLED**。
* 既有 `rental-catalog.test.js`、`rental-match.test.js` 全綠；尺規守衛 14/14 不變。

### 第十九批（2026-09-27）：**嘗試 `getLegalCopy` 後回退**——但留下一個重要的行為發現

這一輪挑了 `getLegalCopy()`（3 條路由的卡點）想做成一個小批次。實作很小
（把已移植的 `legalCopyFromDocumentsAsync` 與 `settingsKvAsync` 接起來），
**但 parity 測試一直做不出來，所以整批回退了**（`git status` 乾淨、尺規不變）。

回退的理由：我對這個函式的**心智模型是錯的**，而錯的地方正好是它最重要的分支。

#### 19.1 錯誤的心智模型 vs 實際行為

我以為 `getLegalCopy()`（db.js:1740）是這樣：

```
有文件 → 用文件內容；文件不齊 → 用 settings；都沒有 → 用預設
```

實際上是：

```js
const fromDocs = legalCopyFromDocuments(db);
if (fromDocs?.disclaimer && fromDocs?.privacy) return publicLegalCopy(fromDocs);
return publicLegalCopy(settingKey("legalCopy") ?? defaultLegalCopy());
```

而 **`legalCopyFromDocuments()` 對於缺少的那一段會自己補上 `defaultLegalCopy()` 的內容**：

```js
version:    terms ? `v${terms.version}` : defaults.version,
disclaimer: terms?.body || defaults.disclaimer,      // ← 沒有文件也有值
privacy:    privacy?.body || defaults.privacy,       // ← 沒有文件也有值
```

所以：

* **「完全沒有文件」不會走 settings**——`fromDocs` 的兩段都是預設值、都非空 ⇒
  條件成立 ⇒ 回傳的是**預設文案**，`settings.legalCopy` 根本沒被讀到。
* **「只發布一份文件」也不會走 settings**——缺的那段被補成預設值，兩段依然非空。
* 真正會走到 settings 的只有兩種情況：**文件 body 是空字串**（`""` 是 falsy），
  或 **`legalCopyFromDocuments()` 整個丟錯**。

也就是說 `settings.legalCopy` 是**很少被用到的備援**，不是主要來源。

#### 19.2 為什麼值得記下來

1. **`getLegalCopy` 的「三段取值」不能照字面理解**：`if (a && b)` 看起來像「兩段都要有」，
   但因為底下已經補了預設值，它實際上只擋得住「空字串」。
   要改這一段之前必須先知道這件事，否則會寫出「以為在驗 fallback、其實在驗預設值」的測試
   ——**我這一輪就是這樣來回卡了好幾次**。
2. **下一個 session 若還要移植它**：先把上面那張表當成規格，測資要涵蓋
   「body 是空字串」與「文件讀取丟錯」兩種，其餘情況兩條路徑的結果**本來就一樣**。
3. 另外一個觀察：沒有文件時，PG 分支與同步版回傳的 `version` 欄位**不一樣**
   （同步版走 `legalCopyFromDocuments` 的 `defaults.version`，PG 分支在我當時的實作下拿到
   另一個值）。這一項沒有查到底就被回退掉了，**下次接手時要優先確認 `version` 的來源**
   ——它是同意條款版本的一部分，不一致會影響「已同意哪一版」的判斷。

> **做法上的教訓**：批次再小，只要**心智模型錯了**就會卡住。這一輪花了太多時間在
> 「讓測試通過」，而不是「先確認規格」。下次遇到這種來回，**先停下來把被呼叫函式的
> 實際回傳值印出來**（我最後才印，一印就發現兩邊都是預設值）。

### 第二十批（2026-09-27）：`webPush.js`（推播訂閱，2 條路由）

`v3/src/webPushAsync.js`（新）＋ 2 條路由改 async。
SQLite 12（不變）、MIXED 119→**117**、PG 137→**139**、缺口 131→**129**。

#### 20.1 又是一條「PG 上根本不存在」的約束

```sql
INSERT INTO push_subscriptions(...) VALUES (...) ON CONFLICT(endpoint) DO UPDATE SET ...
```

`ON CONFLICT(endpoint)` 需要 endpoint 上的唯一約束，而 SQLite 的
`endpoint TEXT NOT NULL UNIQUE` 是**欄位約束** ⇒ 隱式索引 `sqlite_autoindex_…` ⇒
不在 `sqlite_master` 的具名索引裡 ⇒ `pgSchema` 鏡射不到。實測正式站 `push_subscriptions`
**只有 pkey**，所以那句話在 PG 上會直接 `42P10`
（`there is no unique or exclusion constraint matching the ON CONFLICT specification`）。
bootstrap 先清重複（保留 id 最大＝最後寫入的那一列）再補建 `UNIQUE(endpoint)`。

這是**同一個坑的第四次**（listingTools 的帳號聯絡人、memberMedia 的標籤名、comms 的複合主鍵、
現在的推播 endpoint）。判準很簡單：**`CREATE TABLE` 裡的 `UNIQUE(...)` 或欄位 `UNIQUE`
在 PG 都不會存在**，用到 `ON CONFLICT` 或依賴唯一性之前，先確認 PG 有沒有那個約束。

#### 20.2 變異測試暴露的兩個「工具／測試」問題（不是程式問題）

第一次 **6/8**，兩個存活都不是程式的錯：

| 存活 | 真正的原因 | 修法 |
|---|---|---|
| 不補建 `UNIQUE(endpoint)` | 變異寫成**刪掉那個 const 定義** ⇒ 模組載入直接失敗 ⇒ 工具只看到「整個檔案失敗」、抓不到任何測試名 ⇒ **假 SURVIVED** | 改成把語句換成 `SELECT 1`（模組仍可載入，行為真的少了索引） |
| 取消訂閱不比對 endpoint | 測試資料裡 user 1 **只有一筆**訂閱 ⇒「只按 user_id 刪」也會刪掉剛好那一筆 | user 1 改成兩筆（模擬兩台裝置），斷言另一筆必須留著 |

另外抓到一條**空斷言**：`first.includes(asyncMod.PG_CREATE_ENDPOINT_INDEX_SQL)` 在常數變成
`undefined` 時**恆真**（`[undefined].includes(undefined)` 是 true）。改成字面 regex 比對。

> **兩個可重用的教訓**：
> 1. **變異不要用「刪掉宣告」**——那會讓模組載入失敗，工具分不出「測試變紅」與「檔案爆掉」，
>    結果是假 SURVIVED。要改成同一個位置的**等價但無效**的實作（`SELECT 1`、`return null`）。
> 2. **斷言不要 `includes(某常數)`**：常數被移除時它會變成 `undefined`，那種斷言會恆真。

#### 20.3 驗收

* `v3/test/web-push-async.test.js` **9/9**（新）；變異測試 **8/8 KILLED**。

## 二之一、2026-09-28 第三十批：許願房的寫入（demand.js 的第一刀）

原本要搬三條「只差一個同步函式」的路由，**最後只接了檢舉那一條**——另外兩條被自己的
live PG 測試證明「現在接會錯」，退回同步版並寫明前置條件。這一批的重點其實是那個退回的理由。

| 路由 | 舊卡點 | 狀態 |
|---|---|---|
| `POST /api/demand/:id/report` | `reportDemand` | ✅ **已接線**（`demandAsync.reportDemandAsync`） |
| `POST /api/demand/:id/reply` | `addDemandReply` | ⛔ 程式與測試都寫好了，**但刻意不接線**（見 30.9） |
| `POST /api/demand/:id/close` | `closeDemandPost` | ⛔ 同上 |

新模組 `v3/src/demandAsync.js`；測試 `v3/test/demand-async.test.js`（11 項，全綠）＋
`v3/test/demand-live-pg.test.js`（真 PG，CI 的 PG job 會跑，本機沒有隔離環境時 skip）。
**CI 四個 check 全綠**（含 PostgreSQL integration）。

### 30.1 副作用刻意留在 `demand.js`（與 `closeSelfListing` 同一個處置）

`reportDemand` 達門檻後的「隱藏」與 `closeDemandPost` 的收尾都會碰到**跨模組**的東西：
`writeLifecycle()`（demand.js 私有）、`syncDemandMatchDistricts()`、
`notifyWishOfferLifecycle()`（`wishOffers.js` 註冊的 hook，那個模組整支還在 SQLite handle 上）。
所以抽出兩支共用副作用函式 `applyReportHideEffects()`／`applyClosedPostEffects()`，
**兩個 driver 呼叫同一支**（PG 分支傳本機 handle 進去），而不是在 PG 分支重寫一份。
好處有兩個：語意不可能漂移；hook 那條線仍留在 sqlite 集合裡，尺規不會假裝它搬完了。

### 30.2 副作用要**分兩半**看，這是本批最重要的一課

達門檻之後的「隱藏」有兩半，第一版我把它們當成同一件事，於是 CI 的 live PG 直接紅：

1. **跟這張表有關的那半**（`status='hidden'`、`lifecycle='blocked'`／`'closed'`）——
   這是**真的來源**，PG 模式下**一定要寫 PG**；只寫本機 handle 的話 PG 上那一列還是 `open`，
   等於**完全沒有隱藏**。反過來，只寫 PG 也不夠：還沒搬完的讀取（`listDemand`／
   `getDemandPost`／公開頁）讀的是節點 SQLite，所以**本機 handle 也要追上**，兩邊才一致。
2. **跨模組的那半**（`syncDemandMatchDistricts`／`notifyWishOfferLifecycle`／hook）——
   那些函式吃 handle、整支還在 SQLite 上，所以照舊只跑本機 handle。

⇒ 因此現在是「PG 先寫，本機 handle 追上」，而且**兩個 driver 的語意來自同一組語句常數**
（`demand.js` 的 `LIFECYCLE_UPDATE_SQL` ＋ `lifecyclePatchParams`，以及
`applyReportHideEffectsAsync`／`applyClosedPostEffectsAsync`）。

> ⚠️ 這裡有一個**很容易寫出無鑑別力測試**的陷阱：第一版這條測試拿**磁碟**當「PG」，
> 結果兩個 store 其實是同一個檔案 ⇒ 把 PG 那一半的寫入拿掉照樣綠。
> **變異測試當場抓到（SURVIVED）**。改成「PG 走記憶體夾具、本機走磁碟」之後才殺得死。

### 30.3 這批我自己的測試寫錯了兩次（第一次整排紅燈都紅在錯的地方）

1. **回傳封包被拿來當 parity 的對照組，會掩蓋真正的差異。** 第一版測試斷言
   `deepEqual(async結果, 同步結果)`，於是紅在 `public_token`（隨機產生，兩邊不同）與
   `replies`（寫 PG、讀 SQLite）——**兩個都與本批無關**，而真正要釘的「落地狀態」反而沒被驗到。
   改成：落地狀態比對（`status`／`hidden`／`lifecycle`／PG 上的回覆列）＋封包只斷言它自己。
2. **對照組要先確認起點相同。** PG 分支跑之前磁碟已經被清回起點，所以
   「磁碟上的回覆列」不能當 PG 分支的對照組（那時是 0 列）；要比的是**同步版留下的快照**。

### 30.4 🚨 我寫出一個會讓整條路徑壞掉的 bug，而 parity 測試是唯一抓到它的東西

`withFallback(options, …, async (exec) => {…})` 的**參數名 `exec` 遮住了 `options.exec`**。
於是 PG 分支（注入式 runner 的正規路徑）拿到的是 `options.exec` 這個**函式物件**，
`one()` 收到非陣列就回 `null` ⇒ **每一筆檢舉都被判成「找不到要檢舉的內容」**，
而 SQL 其實只送出一句、且跑得好好的。

- 症狀極具誤導性：錯誤訊息正確、SQL 正確、只有「查到的東西不見了」。
- 修法：參數改名 `run`，讀取一律 `(await run(...)).rows`（**`run` 的統一回傳形狀是
  `{ rows, rowCount }`，不是「一列一列的陣列」**——這一點是 `crmOutboxAsync.js` 起的慣例，
  但它的 `one()` 是取 `rows`，本檔第一版沒照抄）。
- 已把這個錯誤類別寫成**夾具守衛**：`demand-async.test.js` 的 PG 替身現在會拒絕
  「不是 SQL 字串」的輸入，同型 bug 下次會直接紅在夾具，而不是紅在一個看起來像業務邏輯的 404。

### 30.5 三個測試（不是人）抓到我的錯，其中兩個來自 CI 的 live PG job

**（a）離線 parity 抓到「參數遮住 `options.exec`」**（見 30.4）。

**（b）CI 抓到 live 測試自己的錯（1）：注入式 runner 不翻譯 `?`。**
注入式 `exec` 直接呼叫 `pgDriver.query(sql, …)`，但 `withFallback()` 在 `options.exec`
有值時**不會**再包 `toPostgresSql`，而 `pgDriver.query()` **不翻譯 `?`** ⇒ PG 收到
`SELECT id FROM demand_posts WHERE id = ?`，回 `syntax error at end of input`。
正式站走的是 `pgDriver.query(toPostgresSql(sql), …)`，所以 live 測試現在自己套
`toPostgresSql`。**離線夾具看不到這個**，因為 `node:sqlite` 同時接受 `?` 與 `$1`
——這正是「live PG 測試不可省」的那條紀律又一次兌現。

**（c）CI 抓到 live 測試自己的錯（2）：我用了很大的顯式 id，把 identity 序列留在後面。**
第一版用 `900000000x` 當測試 id，於是序列的 `max` 變成 9 億而 `next` 還是 1；
**下一個跑到的 live 測試**（`reject-match-live-pg`）就紅在它的守衛上：

```
identity 序列落後：demand_posts.id (next=1 max=900000000401)、
                  demand_replies.id (next=1 max=900000000501)、users.id (next=2 max=900000000303)
```

那道守衛是對的——序列落後會讓所有「不指定 id 的 INSERT」撞主鍵。
⇒ **live 測試不要自己發明 id**：讓 identity 產生、用 `RETURNING` 取回（正式站的 INSERT 就是這樣），
並在進入測試時 `setval` 把序列修到 `max`（上一次中途失敗也不會污染）。
收尾刻意**不**再 `setval`：這輪的列是 identity 產生的，序列本來就前進過，刪掉列之後
序列仍然 > max，那才是守衛要的健康狀態。

**（d）另外那個 `$1` 用兩次**：`DELETE FROM demand_replies WHERE id <> $1 AND post_id = $1`
卻傳兩個參數 ⇒ PG 回 `bind message supplies 2 parameters, but prepared statement requires 1`。
**`?` → `$n` 是逐個出現編號，不是依值去重**——同一個值要寫兩次就要兩個編號。

### 30.6 變異測試：8 條全殺，但前 3 條是**假 SURVIVED**

第一輪跑出 3 條 SURVIVED，實際上都**有**對應測試失敗——是我 `expect` 寫的
**測試名字串**與真實測試名不符（紀律 6 第 N 次）。實際失敗項與預期殺手不一致時，
工具會誠實地把它列成「沒有失敗」而不是「殺掉了」，這一點救了這批的可信度。
改掉三個 `expect` 字串之後 **KILLED 7／SURVIVED 0**；再加上 30.2 那條分庫一致性守衛，這一組共 **8 條變異、全殺**。

### 30.7 順手查到的既成事實（唯讀查 `5151_shadow`，可重跑）

```
PG demand_posts 欄位 41 個（與節點 SQLite 相同）✓
PG demand_posts／demand_replies／demand_reports 只有 pkey，SQLite 定義的索引**一個都沒有** ✗
```

也就是 `idx_demand_one_open`（同一人只能有一則 open 的部分唯一索引）在 PG 上**不存在**。
這與「PG 沒有 `CREATE TABLE` 的 UNIQUE」是同一類（第 N 次），但這裡更嚴重一點：
它不是「鏡射不到」，而是**從來沒有人對這三張表呼叫過 `ensurePgSchema`**。
本批的 `ensureDemandStoreOnce()` 會在第一次用到時補建（含部分唯一索引）。
**補建前已先查過資料**：PG 上 `>1 open`＝0 人、重複 `public_token`＝0、`>1 draft`＝0，
所以索引建得起來（現況 35 列：draft 2／closed 33）。live 測試會斷言這個索引真的存在。

### 30.8 這批的尺規變化

```
PG 153 → 154　MIXED 103 → 102　缺口 115 → 114
```

（只多了一條，因為 reply／close 退回同步版——這是**刻意的**，見 30.9。
下一批的 `getDemandPost()` 會一次解鎖三條讀取路由，並讓這兩條可以接回去。）

### 30.9 ⛔ 為什麼 reply 與 close **刻意不接線**（本批最重要的決定）

`addDemandReplyAsync`／`closeDemandPostAsync` 都寫好了、parity 測試也在驗、
mutation 也殺得死，**但路由仍走同步版**。理由：

> 這兩支會**改動「會被讀取」的狀態**（回覆清單、許願房狀態），而站上的讀取
> （`listDemand`／`getDemandPost`／公開頁）**還是讀節點 SQLite**。
> 接線的話就會變成「寫 PG、讀 SQLite」：回覆確實在 PG，但頁面上看不到——
> 那是**雙寫分歧**，正是 `PG-ISLAND-ACTIVE-WRITES` 記的那個問題，只是換了個方向。

`reportDemand` 沒有這個問題：它只**新增一列 `demand_reports`**，而且目前沒有任何讀取路徑
在讀那張表（檢舉數是寫入時自己數的），所以接到 PG 不會造成「同一份資料兩個地方」。

**⇒ 前置條件：`getDemandPost()`（含 `listDemand()`）先搬上 PG，這兩條就可以接回去。**
那一步會一次解鎖 `GET /api/demand/:id`、`GET /api/wish-rooms/:id`、
`GET /api/public/wish-room/:id` 三條路由。

## 二之零、2026-09-28 第三十一批：許願房的**讀取**搬上 PG，reply／close 跟著接回去

第三十批刻意把 reply／close 留在同步版，理由寫在 30.9：那兩支會改「會被讀回來」的狀態，
而讀取還在節點 SQLite。**這一批就是把那個前置條件做完。**

| 路由 | 之前 | 現在 |
|---|---|---|
| `GET /api/demand/:id` | MIXED | **PG** |
| `GET /api/wish-rooms/:id` | MIXED | **PG** |
| `GET /api/public/wish-room/:id` | SQLite | MIXED（只剩 `sharePageExtrasFor`） |
| `GET /api/demand`、`GET /api/wish-rooms` | MIXED | MIXED（本體已是 PG，剩 `getWishConditions`／`pendingInboxCount`／`wishRoomOwnerSummary`） |
| `GET /api/wish-rooms/mine` | MIXED | 同上 |
| `POST /api/demand/:id/share-events` 等 | — | 讀取改走 PG 入口 |
| `POST /api/demand/:id/reply`、`/close` | ⛔ 刻意不接 | ✅ **已接線** |

尺規：**PG 154→158、MIXED 102→99、SQLite 12→11、缺口 114→110**。

### 31.1 `decoratePost()` 的四個條件式讀取 → loader 介面

`decoratePost()` 會在四個**有條件**的地方自己伸手進 handle：

| 時機 | 原本 | 介面 |
|---|---|---|
| 每一列 | `demand_replies` 查詢 | `replies(row)` |
| 每一列 | `userAuthorName()` | `authorName(uid)` |
| 只有屋主 | `collectWishActivitySignals()` | `activitySignals(row)` |
| 只有 token 為空 | `ensurePublicToken()`（會寫入） | `ensureToken(row)` |
| 判斷欄位存在 | `hasWishColumn()` | `hasColumn(name)` |

同步版用 `syncDecorateLoader(db)` 供這五個操作（**SQL 逐字不變**），PG 版用注入式 runner 供
同一組，兩邊共用 `decoratePostWith()` 這一段純邏輯 ⇒ 輸出形狀不可能漂移。
PG 版把同步版「每一列各查一次」的部分**批次化**（回覆、作者、活動訊號各一批）。

### 31.2 讀取時的過期掃描：又一個「兩個 store 都要寫」

`expireOpenPosts()` 是**讀取時順便寫入**（收掉過期、清 match districts、跑 offer hook）。
三句 UPDATE 與參數順序抽成共用常數，PG 版照樣**PG 先寫、本機 handle 追上**——
理由與檢舉的隱藏完全相同（PG 是真的來源；本機 handle 追上，回退路徑才看到一致狀態）。

### 31.3 🚨 這一包最重要的教訓：**parity 沒開 `strict` ⇒ PG 分支整條沒被測到**

第一版讀取 parity 全部是綠的，但那些綠燈**什麼都沒證明**：PG 分支其實在丟錯
（夾具少了兩張表），而**讀取的 fail-open 回退**默默改成回 SQLite 的答案，
於是 `deepEqual` 永遠成立。這就是紀律 12（fallback 會掩蓋錯誤）的完整實例。

- 加上 `strict: true` 之後，真正的錯誤立刻現形：`no such table: demand_match_districts`、
  接著 `user_listing_flags`——**夾具缺少 PG 真的有的表**（同步版那兩支查詢有 try/catch，
  所以 SQLite 缺表不會有事，夾具就漏了）。
- ⇒ **寫讀取 parity 時，`strict` 不是選項而是必需品**；沒開的話「綠燈」等於沒跑。

### 31.4 變異測試：11 條全殺，過程中修掉兩條**沒有鑑別力**的測試

- **公開列表不套篩選條件**：拿掉 `matchesFilters` 之後照樣綠——因為我的測試**沒帶篩選條件**，
  而 `matchesFilters` 在沒有條件時永遠回 true。補上 `city`／`district`／`housing_type`／
  `rent_min` 四組之後才殺得死。
- **公開視圖的洩漏守衛**：`expect` 原本寫的測試名不對（綠燈其實來自 parity 那兩條），
  改成會真正失敗的那一條。
- **刻意不放**「拿掉 `wishVisibleOnSurface()`」那一條：它只對 stage1 fixture 列有鑑別力，
  非 fixture 列一律回 true；fixture 隔離由 `rental-match-isolation`／`stage1-fixture-*` 守著。
  放了只會得到假 SURVIVED，所以在那組變異集上寫明理由。

### 31.5 測試夾具的兩個坑（都會再遇到）

1. **夾具是整份檔案共用的**：前一個測試留下的 open 貼文還在，而
   `idx_demand_one_mutable` 是「同一人只能有一則 open／draft」的**部分唯一索引** ⇒
   同一個 `userId` 再種一則就撞。每個測試要用**自己專屬的 userId**。
2. **`users` 的 id 1 是 `db.js` 開檔時建的 bootstrap 管理員**，不屬於測試自己種的帳號，
   清理時不會被刪——但前面的測試會改它的 nickname。不還原就會**跨測試汙染**
   （「作者暱稱」那一條就是這樣紅的）。

## 二之負一、2026-09-28 第三十二批：許願房**列表**的三個尾巴（屋主摘要／目錄／待處理報價數）

第三十一批把列表本體搬上 PG，但 `GET /api/demand`／`/api/wish-rooms`／`/mine` 還是 MIXED，
因為同一個 handler 裡還有三個同步呼叫。這一包把他們清掉，三條**都變成 PG**。

| 函式 | 原本 | 現在 |
|---|---|---|
| `getWishConditions()`（性質目錄） | 同步入口 | 改用**既有的** `getWishConditionsAsync()`（`rentalCatalogAsync.js`，本來就寫好了） |
| `wishRoomOwnerSummaryFor()`（屋主摘要） | 同步 | 新增 `wishRoomOwnerSummaryAsync()` |
| `pendingInboxCount()`（待處理報價數） | 同步（`wishOfferQueries.js`，只吃 handle） | 新增 `pendingOfferCountAsync()` |

尺規：**PG 158→161、MIXED 99→96、缺口 110→107**。三條列表路由全部 `sqlite: -`。

### 32.1 `getWishConditions` 這件事本身是一個提醒

它**早就有** driver-aware 入口（`getWishConditionsAsync()`），只是 handler 還在呼叫同步版。
這與第二批的 `stats`、以及計畫文件裡「有現成的卻沒接」是同一類——
**每次動手前先查既有的 `*Async.js` 有沒有這支**，比重新寫一支便宜得多。

### 32.2 屋主摘要：把「同步版自己的前後不一致」也照抄

同步版 `wishRoomOwnerSummary()` 有兩個分支，回傳的鍵**不一樣**：

```js
if (!uid) return { active, draft, closed: [], has_example };          // 有 closed、沒有 can_create
return { active, draft, has_example, can_create: !active };           // 反過來
```

我第一版把兩邊「整理乾淨」（都給 `can_create`），parity 立刻紅。
⇒ 原則是：**要改這個不一致，應該改同步版並另開一批，不是在 PG 版偷偷對齊**；
parity 的價值就在這裡——它會逼你承認既有的形狀，而不是順手發明一個更好的。

### 32.3 變異測試又抓到兩條沒有鑑別力的測試（同一類，第 N 次）

1. **待處理報價數**：只種一筆 pending 時，「不篩 `status = 'pending'`」的變異照樣回 1。
   補一筆 accepted 之後才殺得死。
2. 同一條的 `expect` 又寫成**斷言訊息**而不是**測試名稱**（紀律 6 第 N 次）。
   工具把它列成「沒有失敗」而不是「殺掉了」，這一點再次救了可信度。

這一組現在 **14 條變異全殺**。

### 32.4 夾具的第三個坑：表約束（隱式索引）會擋住第二筆種子資料

`wish_offers` 有 `UNIQUE(owner_user_id, listing_id, wish_id)` 這類**表約束**，
所以想種「第二筆報價」不能只換 `id`／`status`，要換到約束裡的欄位。
⇒ 這是「PG 沒有 `CREATE TABLE` 的 UNIQUE」那條紀律的**鏡像**：SQLite 這邊有，
夾具（用 SQLite 當 PG 替身）也會照樣擋——**種子資料要照真實約束設計**。

## 二之負二、2026-09-28 第三十三批：許願房**提案**的讀取（wishOffers 第一刀）

| 路由 | 之前 | 現在 |
|---|---|---|
| `GET /api/wish-offers/:offerRef` | MIXED | **PG** |
| `GET /api/wish-offers/inbox` | MIXED | **PG** |
| `GET /api/wish-offers/owner` | MIXED | **PG** |

尺規（以 master `7a150e4` 為基準，同一支尺規逐條比對）：**PG 158→161、MIXED 99→96、缺口 110→107**，
而且**只有這三條**改變（不是「大概差不多」）。

### 32.1 做法：兩個投影函式抽 loader，列表主體改成共用 async

- `publicOfferView()`（投影＋安全檢查）只從 handle 讀**兩列**（許願房、站內刊登）＋一次封鎖查詢。
  抽成 loader 之後 `publicOfferViewWith()` 是純轉換，同步版與 PG 版共用——
  `assertOfferSafeView()`（洩漏守衛）因此只有一份實作。
- `listWishOffers()` 的分頁／游標／統計／投影順序抽成 `listWishOffersWith()` 並**改成 async**：
  查詢與投影都 `await queries.*`，同步版把同步結果包成 resolved promise。兩邊跑同一段程式。
- `tenantBlocksOwner()`／`loadVisibleOffer()`／`loadFreshOffer()` 各一句 SELECT，集中在新模組
  `wishOffersAsync.js`。

### 32.2 🚨 順手抓到一個**既有的真缺陷**：`getSelfRowAsync()` 永遠回 undefined

```js
const rows = await exec(SELF_ROW_SQL, [id]);
return rows[0] || undefined;          // ← exec 回的是 { rows, rowCount }
```

統一的 exec 形狀是 `{ rows, rowCount }`（`crmOutboxAsync.js` 起的慣例），所以 `rows[0]` 恆為
`undefined`。它先前**沒有實際呼叫端**（`getSelfListingAsync()` 用它，但那條路由當時也沒接線），
所以缺陷一直躺著；這一包接 wish-offers 讀取時 parity 第一次跑就抓到（症狀：投影只剩 `listing_ref`）。

⇒ 教訓：**「這一支有 PG 版」不等於「這一支是對的」**。沒有呼叫端的程式碼就是沒有被執行過的程式碼；
接線前先確認它真的被測過。

### 32.3 三個測試自己的坑（都由變異測試或 parity 逼出來）

1. **`next_cursor` 是加密字串**（每次 IV 不同）⇒ 不能比字串。改成「去掉游標比內容」
   ＋「各自用自己的游標走到第二頁，再比第二頁的專案」。
2. **回退測試原本沒有鑑別力**：磁碟與夾具資料一模一樣，「不回退、直接讀夾具」照樣過關。
   加上「PG runner 呼叫次數必須為 0」才殺得死。
3. **角色種錯**：`wish_offers` 的 owner 由「刊登的 `listed_by_user_id`」決定、tenant 由
   「許願房的 `user_id`」決定，而 `createWishOffer(db, ownerUserId, …)` 的第二個參數是**屋主**。
   第一版把刊登與許願房掛在同一個人身上，整排紅在「找不到這則站內刊登」。

### 32.4 這一包**只做讀取**

`accept`／`decline`／`withdraw`／`block`／`report` 是狀態機＋事件；
`GET /api/wish-offers/:offerRef/contact` 的 `projectOfferContact()` 會**先寫
`wish_offer_events` 稽核事件**才回聯絡方式——有副作用，所以兩者都歸下一批。在那之前仍走同步版。

### 32.5 暫時的重複（合併後要收斂）

`PENDING_OFFER_COUNT_SQL` 在 `wishOffersAsync.js` 與 `demandAsync.js`（PR #531 的屋主摘要）
各有一份：這一包刻意**不依賴未合併的 PR**。**兩支都合併之後要收斂成一支。**

## 二之負三、2026-09-28 第三十四批：提案檢舉上 PG（wishOffers 寫入的第一支）

| 路由 | 之前 | 現在 |
|---|---|---|
| `POST /api/wish-offers/:offerRef/report` | MIXED | **PG** |

尺規（master `7a150e4` 為基準）：**PG 158→162、MIXED 99→95、缺口 110→106**。

### 33.1 做法：規則重用，只換跑語句的人

檢舉是**寫入 ＋ 稽核事件**，所以上一包（只做讀取）刻意沒動它。這一包把
`createOfferReport()` 拆成：

- 常數與淨化規則**全部重用** `wishOffers.js`（`OFFER_REPORT_REASONS`、
  `OFFER_REPORT_DAILY_CAP`、`OFFER_REPORT_DETAIL_MAX`）與 `safeContent.js`
  （`containsUnsafeMarkup`、`sanitizeDocumentText`）——不在 PG 版重寫第二份。
- 節流 `assertOfferBurst()` 是**行程內記憶體**，與 driver 無關，直接共用。
- 新增 `writeOfferEventAsync()`（`wish_offer_events` 的寫入，同一組敏感欄位過濾清單）。
- 產業務入口 `reportVisibleOfferAsync()`：可見性 → 角色（只有房客能檢舉）→ 寫入，
  與同步版 `reportWishOffer()` 逐條相同。

### 33.2 同步版靠例外、PG 版靠 rowCount

同步版用 `try { INSERT } catch (UNIQUE) { 回 already }`；PG 版改用 **`rowCount === 0`**
判斷（競態時另一方已寫入）⇒ 兩邊回傳形狀相同，但**不依賴例外訊息字串**。
這比同步版更穩，且行為一致。

### 33.3 這一包的兩個「測試自己」的教訓

1. **`pgExec()` 的 `exec.raw` 被我在前一批改掉了**：症狀是
   `Cannot read properties of undefined (reading 'prepare')`。夾具的輔助函式也是程式碼，
   改動時要一起看呼叫端。
2. **清理清單漏表 ⇒ 跨測試汙染**：`resetWorld()` 沒有刪 `wish_offer_reports`，
   前一個測試的檢舉列留到後一個，撞 `UNIQUE(offer_id, reporter_user_id)`。
   ⇒ 清單要涵蓋**所有會被測試寫入的表**。

### 33.4 ⚠️ 未完成：每日上限的 parity 測試

`OFFER_REPORT_DAILY_CAP` 的 PG 版 parity **還沒寫完**。我反覆卡在種子資料與
`UNIQUE(offer_id, reporter_user_id)` 的衝突上，超過合理時間後**移除該測試**，
而不是留一條紅的或假綠的。上限邏輯本身仍由同步版的既有測試守護，
PG 版用的是同一組常數與同一句 `COUNT`。要補的時候注意：種子必須在 `copyRows()`
**之前**灌進磁碟，且兩條路徑用不同的 `offer_id`。

## 二之負四、2026-09-28 第三十五批：封鎖名單（wishOffers 第二支）

| 路由 | 之前 | 現在 |
|---|---|---|
| `GET /api/wish-offers/blocks` | MIXED | **PG** |
| `POST /api/wish-offers/blocks/:blockRef/remove` | MIXED | **PG** |

尺規（master `7a150e4` 為基準）：**PG 158→164、MIXED 99→93、缺口 110→104**。

### 34.1 為什麼與檢舉同一批

`user_blocks` 的**寫入端 `insertUserBlock()` 同時被 block 與 report 兩條路由使用**，
所以這張表不能只搬一半——上一輪的偵察已經確認過。這一包把它的讀取
（`listBlocksForUser`／`loadOwnedBlock`）與刪除（`DELETE`）一起搬完，
`blockOwnerFromOffer()`（建立封鎖）留給狀態機那批。

### 34.2 投影與守衛全部重用

`publicBlockView()` 是純函式，直接重用；兩個業務規則也照抄同步版：

- `loadOwnedBlock()` 要求 **blocker 必須是本人**（別人的封鎖 ⇒ 404）。
- `context === 'moderation'` 的封鎖**不能自行解除**（⇒ 403 `block_locked`）。

### 34.3 變異測試抓到我缺兩條測試

第一輪 4 條新變異裡有 2 條 SURVIVED，而且**都不是假陽性**：

1. **moderation 守衛根本沒有測試**（同步版有、我的檔案沒有）。補上之後殺死。
   ⇒ 「這一條同步版有測」不等於「PG 版有測」。
2. 「接受數字型 ref」那條**是可觀察行為等價**的（token 永遠不是純數字），
   所以**移除該變異並寫明理由**，而不是硬寫一條人工測試。

這一組現在 **12 條變異全殺**。

## 二之負五、2026-09-28 第三十六批：後台檢舉清單（wishOffers 第三支）

| 路由 | 之前 | 現在 |
|---|---|---|
| `GET /api/admin/wish-offer-reports` | MIXED | **PG** |

尺規（master `7a150e4` 為基準）：**PG 158→165、MIXED 99→92、缺口 110→103**。

### 35.1 這一條是**正確性**，不只是進度

檢舉列已經由第三十三批的 `reportOfferAsync()` 寫進 PG。如果後台清單還讀節點 SQLite，
管理員看到的會是**舊的／空的**清單——正是「寫 PG、讀 SQLite」的分歧。
所以這一條雖然只是讀取，卻必須跟著搬。

### 35.2 做法

- `listAdminOfferReports()` 的列→視圖映射抽成純函式 `publicAdminReportView()`，
  兩個 driver 共用（**只給這五個欄位，不含檢舉人**）。
- 查詢語句抽成 `ADMIN_REPORTS_SQL` 常數，PG 版逐字使用。
- `limit` 的夾限（預設 50、上限 100、下限 1）留在 PG 版同一行邏輯裡，
  parity 測試對 `1／2／0／-5／999／undefined` 六種輸入逐項比對。

### 35.3 變異測試

2 條新變異（拿掉 limit 夾限、多回傳原始列）**都被殺死**；這一組目前 **14 條全殺**。

## 二之負六、2026-09-28 第三十七批（**只做偵察，尚未實作**）：wishOffers 最後 5 條的真實障礙

剩下的 5 條是 `accept`／`decline`／`withdraw`／`block`／`contact`。動手前先追完依賴，
**結論是：擋住它們的不是狀態機本身**。

### 36.1 追出來的呼叫鏈（已查證）

```
acceptWishOfferFor()（db.js）
  ├─ acceptWishOfferOn(db, …)            ← wishOfferTransitions.js 的狀態機
  │    ├─ transitionOffer()              ← 樂觀鎖 UPDATE（wishOffers.js）
  │    ├─ expirePendingIfDue()／terminalizeOffers()
  │    ├─ recheckAcceptable() → liveMatchEligible()（純）＋ getSelfRow()
  │    └─ writeOfferEvent()              ← wish_offer_events（PG 版已於第 33 批完成）
  └─ emitRentalNotifyEventOn(db, …) ×2   ← **rentalNotify.js，1199 行、59 處 db.prepare**
```

⇒ **狀態機本身不是最難的部分**（248 行、10+ helper，但都可照既有 loader 模式搬）。
真正的工作量在它後面那兩行：`accept`／`block` 成功後會呼叫 `emitRentalNotifyEvent()`，
而那一支**整支還在 SQLite 上**（寫 `rental_notify_events`、`queueDeliveries()`、
`insertDelivery()`、`bumpAnalytics()`）。

### 36.2 為什麼不能只接狀態機

若只把狀態機搬上 PG，就會出現：
- `wish_offers`／`wish_offer_events` → **PG**
- `rental_notify_events`／`rental_notify_deliveries`／`rental_analytics_daily` → **SQLite**

也就是**同一次「接受提案」被拆到兩個 store**，通知與分析數字會留在節點本機
——正是 `PG-ISLAND-ACTIVE-WRITES` 記的那個問題。所以正確順序是
**先搬通知與分析那條線，再回來接狀態機**。

### 36.3 建議的切法（下次照這個做）

| 順序 | 標的 | 影響 |
|---|---|---|
| **1** | `bumpAnalytics()` → PG（`rental_analytics_daily` 一句 upsert） | 解鎖 **9 條**非 wishOffers 路由（見下） |
| **2** | `emitRentalNotifyEvent()` ＋ `queueDeliveries()`／`insertDelivery()` → PG | `accept`／`block` 的前置條件 |
| **3** | 狀態機（`transitionOffer`／`expirePendingIfDue`／`terminalizeOffers`／`recheckAcceptable`）＋ 4 條路由 | 收尾 |
| **4** | `projectOfferContact()`（`/contact`，會先寫稽核事件） | 收尾 |

**第 1 步就值得單獨做**：`bumpAnalytics` 目前是 **9 條缺口路由**的卡點，而且只是一句
`INSERT … ON CONFLICT(day, metric) DO UPDATE`：

```
POST /api/public/wish-room/:id/share-events   POST /api/wish-rooms
GET  /verify-email                            POST /api/self-listings
GET  /auth/:provider/callback                 POST /api/wish-rooms/:id/survey
POST /api/demand                              POST /api/self-listings/:id/matches/:wishRef/offers
                                              POST /api/wish-offers/:offerRef/accept
```

（最後一條要等第 2、3 步；其餘 8 條第 1 步就能動。）

### 36.4 `rentalNotify.js` 的規模（先量再切，不要憑感覺）

- **1199 行**、**59 處 `db.prepare`**、`RENTAL_NOTIFY_EVENT_TYPES`／`CHANNELS`／
  `preferenceAllows()`／`taipeiDay()` 等純邏輯可以重用。
- 它自己也有 driver-aware 掛勾（`isRentalNotificationsEnabled(flagsCache)`），
  但寫入端整支吃 handle。

⇒ 這是一包**獨立的中大型工作**，不適合塞進 wishOffers 那包一起做。

### 36.5 第 1 步已實作：`bumpAnalyticsAsync()`（`v3/src/rentalAnalyticsAsync.js`）

照 36.3 的順序，第 1 步先做完了：

- 語句與 `rentalNotify.js:491` **逐字相同**（`ON CONFLICT(day, metric) DO UPDATE SET value = value + excluded.value`）。
- 日界線重用**同一支** `taipeiDay()`（時區規則不能有第二份實作）。
- `rental_analytics_daily` 的主鍵是 `PRIMARY KEY (day, metric)`（複合）；已**實測**
  `pgSchema.createTableStatement()` 會逐字鏡射這一句，所以 PG 上 `ON CONFLICT(day, metric)`
  有索引可用（不是靠欄位層級 UNIQUE）。
- 測試 `v3/test/rental-analytics-async.test.js`（6 項全綠）＋變異 **5 條全殺**。

⚠️ **尚未接線任何路由**。原因是：`bumpAnalytics` 雖然是 9 條路由的卡點，但那 9 條**各自還有
別的同步呼叫**（`createDemand`／`recordShareEvent`／`submitCompletionSurvey` /
`getRentalNotifyPrefs`…），所以只搬這一支**不會讓任何路由的判定改變**（尺規不動是正確的）。
這一支是**前置零件**，等它的同伴也搬完才會一起反映在數字上。

### 36.6 第 2 步的第一塊零件：`getRentalNotifyPrefsAsync()`（`v3/src/rentalNotifyReadsAsync.js`）

通知寫入端（`emitRentalNotifyEvent`／`queueDeliveries`／`insertDelivery`）的第一個依賴是
`getRentalNotifyPrefs()`——`queueDeliveries()` 一開頭就讀它。所以先搬這一支：

- 列→prefs 轉換抽成純函式 `prefsFromRow()`，兩個 driver 共用；沒有列時回
  `defaultRentalNotifyPrefs()`（與同步版同義）。
- `timezone` 空字串落回 `RENTAL_SITE_TZ`（站台時區）。
- 測試 `v3/test/rental-notify-reads-async.test.js`（7 項全綠）＋變異 **5 條全殺**。
- 順手把 `safePayload()`（PII 過濾）與 `currentRentalNotifyFlags()` 從 `rentalNotify.js`
  匯出，讓後續 PG 版**逐字重用同一支**淨化規則與同一份旗標快取，不必重寫第二份。

⚠️ **同樣尚未接線**（尺規不動是正確的）：這一支是零件，`queueDeliveries()`／
`insertDelivery()` 還沒搬，所以沒有任何路由的判定會改變。

**變異測試又抓到我一個假設錯誤**：memory SQLite 對 INTEGER 欄位回的是**數字**，
所以 `Boolean(row.x)` 與 `Number(row.x) === 1` 在夾具上結果相同 ⇒ 殺不死該變異。
但真 PG 驅動在某些路徑可能回**字串**，而 `Boolean("0")` 是 `true`——那會讓「關閉的通知」
變成開啟。補了一條直接餵**字串列**給 `prefsFromRow()` 的測試之後才殺得死。

#### 第 2 步剩下的（下一次）

| 標的 | 說明 |
|---|---|
| `emitRentalNotifyEventAsync()` | 寫 `rental_notify_events`（`event_key` UNIQUE ⇒ 去重語意要一致）＋呼叫 queue |
| `queueDeliveriesAsync()` | `preferenceAllows()`／`channelAllowed()`／`isRentalDigestEnabled()` 都是**純函式可直接重用**；寫 `rental_notify_deliveries` |
| `insertDeliveryAsync()` | **`UNIQUE(event_id, channel)` 是表約束（隱式索引）⇒ 這是第 N 次「PG 沒有 CREATE TABLE 的 UNIQUE」**：`ensurePgSchema` 鏡射不到它，要先自己 `CREATE UNIQUE INDEX IF NOT EXISTS`（並確認既有資料沒有重複，否則會失敗） |

### 36.7 第 2 步主體完成：通知寫入端（`v3/src/rentalNotifyWriteAsync.js`）

`emitRentalNotifyEventAsync()` ＋ `queueDeliveriesAsync()` ＋ `insertDeliveryAsync()` 完成。

**重用**（不重寫）：`preferenceAllows()`／`channelAllowed()`（本輪從 `rentalNotify.js` 匯出，
這兩個是**政策**不是 SQL）、`safePayload()`（PII 過濾）、`currentRentalNotifyFlags()`、
`isRentalDigestEnabled()`／`isRentalNotificationsEnabled()`、`getRentalNotifyPrefsAsync()`（上一輪）、
`bumpAnalyticsAsync()`（上上輪）。

#### 🚨 兩個「PG 不能用同步版做法」的實例

1. **去重不能靠例外**：同步版是 `try { INSERT } catch (UNIQUE) { 回 deduped }`。
   在 PG 上撞唯一鍵會讓**整筆交易進入 aborted 狀態**，後續語句全部失敗 ⇒
   改用 `ON CONFLICT(event_key) DO NOTHING` ＋ `rowCount === 0` 判斷。
   遞送的 `(event_id, channel)` 同理。
2. **表約束的唯一鍵鏡射不到（本系列第 N 次）**：`UNIQUE(event_id, channel)` 與 `event_key UNIQUE`
   在 SQLite 是表約束／隱式索引，`pgSchema` 只鏡射有 `sql` 的索引 ⇒
   新增 `RENTAL_NOTIFY_UNIQUE_INDEXES` 兩句 `CREATE UNIQUE INDEX IF NOT EXISTS`。
   **建之前先查過正式影子庫**：兩張表在 PG 上都只有 pkey，
   且 `(event_id, channel)` **0 筆重複** ⇒ 建得起來（與 `demand_posts` 那次的處置相同）。

#### 測試

- `v3/test/rental-notify-write-async.test.js`（**11 項全綠**）：事件／遞送／分析三張表逐列比對、
  去重、prefs 關閉 ⇒ suppressed、通道組合、旗標關閉早退、未知型別／無 user 早退、
  同 `(event_id, channel)` 不重複寫、fail-closed、sqlite 回退、唯一索引語句本身。
- 變異 **7 條全殺**。
- **刻意移除一條殺不死的變異**（「PG 上不補唯一索引」）：那個迴圈只在**沒有注入 exec** 時才會跑，
  離線夾具碰不到 ⇒ 放著只會得到假 SURVIVED。改由 **live PG 測試**驗：
  `v3/test/rental-notify-live-pg.test.js` 在 `ensureRentalNotifyWriteOnce()` 之後
  斷言那兩條索引真的存在（CI 的 PG job 會跑）。
- 又一次踩到「**跨 store 不要比 id**」：遞送列的 `event_id` 是各自 AUTOINCREMENT／IDENTITY
  序號，本來就會不同 ⇒ 比對改成 `(user_id, channel, status)`。

#### 第 3 步（狀態機）現在可以開始了

`accept`／`block` 需要的通知寫入端已經就位。剩下的狀態機本體
（`transitionOffer`／`expirePendingIfDue`／`terminalizeOffers`／`recheckAcceptable`）
可以照既有的 loader 模式搬，接線時 `emitRentalNotifyEventAsync()` 直接可用。

### 36.8 🚨 真 PG 抓到的兩個錯（都是離線測不到的）

CI 的 PG job 連兩次紅，兩次都是我自己的錯，而且**都只有真 PG 會現形**：

1. **`ON CONFLICT(event_key)` 回 `42P10`**：live 測試一開始沒有先跑
   `ensureRentalNotifyWriteOnce()`，所以 PG 上**沒有那個唯一索引** ⇒ `ON CONFLICT` 找不到目標。
   **這正好證明那兩句 `CREATE UNIQUE INDEX` 是必要的**（不是裝飾）。修法是測試先跑 bootstrap，
   並在跑完之後斷言兩條索引真的存在——這樣「拿掉建索引那段」就會被 live 測試殺掉。
2. **`value` 在 `DO UPDATE SET` 裡含糊**（`column reference "value" is ambiguous`）：
   同步版寫 `SET value = value + excluded.value`，**SQLite 接受、PG 不接受**。
   PG 那句改成 `SET rental_analytics_daily.value = rental_analytics_daily.value + EXCLUDED.value`。

   但接著遇到第二層：**SQLite 不接受限定表名的 `SET table.col = …`**（`near ".": syntax error`），
   而離線夾具是**用 SQLite 當 PG 替身**。所以現在有兩句：

   | 路徑 | 語句 |
   |---|---|
   | 真 PG（`pgDriver`） | `BUMP_ANALYTICS_PG_SQL`（限定寫法） |
   | 注入式 `exec`（SQLite 替身） | `BUMP_ANALYTICS_SQL`（兩邊都合法的寫法） |

   ⇒ 這是「注入式 exec 不經過 `toPostgresSql` ⇒ 語句要挑兩邊都合法者」那條紀律的**新變體**：
   當 PG 需要 SQLite 不接受的語法時，**必須分岔並由 live PG 負責驗真 PG 那句**。
   測試 `rental-analytics-async.test.js` 有一條**只驗語句文字**的守衛，
   真正的執行驗證在 `rental-notify-live-pg.test.js`（它會跑真的 bump）。

### 36.9 第 4 步完成：`/contact`（`projectOfferContactAsync()`）

| 路由 | 之前 | 現在 |
|---|---|---|
| `GET /api/wish-offers/:offerRef/contact` | MIXED | **PG** |

尺規（master `7a150e4`）：**PG 158→166、MIXED 99→91、缺口 110→102**。

- 守衛與組裝抽成純函式（`assertContactReadable()`／`contactFieldsFor()`／`contactProjection()`），
  兩個 driver 共用 ⇒ 三種 `next_step` 文案與錯誤碼不可能漂移。
- 三個讀取都已有 PG 版（可見性、許願房列、刊登列、封鎖），稽核事件用上一輪的
  `writeOfferEventAsync()`。
- 測試 3 條（投影 parity、稽核事件、錯誤形狀）＋封鎖後的契約 1 條 ⇒ 這一檔共 **19 項**，
  變異 **16 條全殺**。

#### 這一批的兩個「測試自己」的教訓

1. **節流器是行程內記憶體、跨測試共用**：前一條測試把 `contact:1` 的額度用完，後面那條就拿到
   `RATE_LIMITED` 而不是它要測的 `contact_unavailable`。⇒ `resetWorld()` 要一併
   `offers.resetWishOfferRateLimits()`。
2. **一條可觀察行為等價的變異要移除而不是硬殺**：「拿掉封鎖查詢」之所以殺不死，是因為
   `blockOwnerFromOffer()` 會**同時**把提案終結成 `blocked`，而 `assertContactReadable()`
   先檢查 `status !== 'accepted'` ⇒ 錯誤碼與 status 完全一樣。已在變異集寫明理由，
   但「封鎖之後拿不到」的**契約**仍留一條測試守著。

#### 剩下的（第 3 步）：狀態機

`accept`／`decline`／`withdraw`／`block` 四條。它們的**前置條件都已就位**：
通知寫入端（第 2 步）、`wish_offer_events`、`loadVisibleOfferAsync`／`loadFreshOfferAsync`／
`getSelfRowAsync`／`terminalizeOffers` 需要的 `wish_offers` 讀寫。剩下要搬的是
`transitionOffer()`（樂觀鎖 UPDATE，靠 `rowCount` 判斷）、`expirePendingIfDue()`、
`terminalizeOffers()`、`recheckAcceptable()` 與四支路由的 `*For` 包裝。

#### 36.10 環境敏感測試的量化證據（CI 紅燈的判讀依據）

第 40 批之後 PR 的 **PostgreSQL integration job 全綠**，但一般的 **Tests job 兩次紅**，
兩次都是**既存**的環境敏感測試，不是這一分支的改動：

| 測試 | 症狀 | 證據 |
|---|---|---|
| `listing-search-parity` 的 `cooperative member processing…` | 在本機**每次**紅（2/2 次）、CI 間歇紅 | 在 **base commit `7a150e4` 的 worktree** 上跑同一條 ⇒ 同樣紅（`fail 1`） |
| `listing-search-parity` 的 `cursor walks past the old 2000-row candidate cap` | 本機與 CI 間歇紅 | 同一條在 base 上也紅（先前已驗證過一次） |

⇒ 這幾條是**資料量／時序**敏感（2000 列候選、1.5 秒預算之類），與 wishOffers 的改動無關：
本分支的 18 個改動檔案裡**沒有任何一個**是 `commute`／`listing-search` 相關。
判讀規則：**先看 PG job**（它才是島嶼改動的守門員），再用 base worktree 比對一般 Tests job 的紅燈。

### 36.11 第 3 步完成：提案狀態機（**wishOffers 群清空**）

| 路由 | 之前 | 現在 |
|---|---|---|
| `POST /api/wish-offers/:offerRef/accept` | MIXED | **PG** |
| `POST /api/wish-offers/:offerRef/decline` | MIXED | **PG** |
| `POST /api/wish-offers/:offerRef/withdraw` | MIXED | **PG** |
| `POST /api/wish-offers/:offerRef/block` | MIXED | **PG** |

尺規（master `7a150e4`）：**PG 158→170、MIXED 99→87、缺口 110→98**。
**wishOffers 群已經沒有任何缺口路由**（`route-data-map` 過濾 `wish-offer` ⇒ 0 條）。

#### 做法

- 葉節點 helper 全部搬過來：`transitionOfferAsync()`（樂觀鎖）、`expirePendingIfDueAsync()`、
  `terminalizeOffersAsync()`、`insertUserBlockAsync()`、`recheckAcceptableAsync()`。
- 四條路由共用一個主體 `transitionRoute()`：可見性 → 角色 → 過期／衝突 → 樂觀鎖 → 事件，
  順序與同步版逐條相同；`denied` 的處置（`recordOfferFail()` ＋ 409）也相同。
- 契約（`accept` 之後發通知）留在 `db.js` 的 `acceptWishOfferFor()`，所以**路由層沒有動它**；
  通知寫入端在前一輪已具備 PG 版。

#### 🚨 這一包最關鍵的一行：`rowCount` 不是 `changes`

```js
// 同步版
return Number(result.changes) || 0;
// PG 版
return Number(res?.rowCount) || 0;
```

樂觀鎖靠「改到 0 列」判斷衝突。PG 的 `pg` 回的是 `rowCount`，用 `changes` 會得到 `undefined`
⇒ `|| 0` 一樣是 0…**但 `transitionOfferAsync()` 的呼叫端若拿 `undefined` 去做真值判斷，
就會把衝突誤判成成功**。變異集裡放了一條「改用 changes」的變異，由
「樂觀鎖：version 不對必須是衝突」那條測試殺掉。

#### 測試

- `wish-offers-async.test.js` **24 項全綠**（新增 5 項：接受、樂觀鎖、拒絕／撤回、封鎖、過期）。
- 變異 **21 條全殺**。過程中修掉三條沒有鑑別力的地方：
  1. 「封鎖屋主」原本只比 `status`，所以**把終結時的事件拿掉也照樣過關** ⇒ 補上
     `offer_blocked` 事件的斷言。
  2. `block_ref` 是**隨機 token**（每個 store 各自產生）⇒ 不能比字串，只能比「兩邊都有值」。
  3. 過期那條測試**忘了先 `copyRows()`**，夾具還是空的 ⇒ PG 分支回 `offer_not_found` 而不是
     `offer_expired`。這一條是「測試要先確認兩邊起點相同」的又一次實例。

### 36.12 這條線的收尾狀態（下一個 session 的起點）

第三十六批那份順序的四個步驟**都已完成**，但落成**三個 PR**（都未部署）：

| PR | 內容 | 狀態 |
|---|---|---|
| **#531** | 許願房列表三條路由（`getWishConditions`／`wishRoomOwnerSummary`／`pendingInboxCount`） | CI 全綠 |
| **#532** | 提案讀取三條路由（＋抓到 `getSelfRowAsync` 的既有缺陷） | CI 全綠 |
| **#533** | 檢舉／封鎖／後台清單／分析／通知寫入端／聯絡方式／狀態機（wishOffers 全群） | CI 全綠 |

⚠️ **#532／#533 是堆疊在彼此之上**（#533 的 base 目前是 master，但它的 diff 含 #532 的內容）。
**合併順序建議：#531 → #532 → #533**；#532 合併後 #533 的 diff 會自動收斂。

以 master `7a150e4` 為基準的尺規變化（三支合併後應為）：

| 判定 | 起點 | 現在 |
|---|---:|---:|
| SQLite | 95 | **11** |
| MIXED | — | **87** |
| 無直接DB | — | **20** |
| PG | 22 | **170** |
| **缺口** | — | **98** |

`route-data-map` 過濾 `wish-offer` ⇒ **0 條**（wishOffers 群清空）。

#### 下一步（不在本輪範圍）

下一個最大的單一群是**通知／分析的其餘部分**與 **`getUserById`（25 條）／`ensureUser`（22 條）**；
`bumpAnalyticsAsync()` 與通知寫入端已就位，所以 `POST /api/demand`、`POST /api/wish-rooms`、
`POST /api/self-listings`、`/verify-email`、`/auth/:provider/callback` 等 8 條已經少了一個卡點。

## 二之負七、2026-09-28 第三十八批：`getUserById`／`ensureUser` 的範圍界定（第三十八批本身是文件）

合併 #531～#533 之後，缺口的前兩大卡點換人了：

| 卡點 | 缺口路由數 |
|---|---:|
| `getUserById` | **25** |
| `ensureUser` | **22** |

### 38.1 為什麼 `getUserById` 不是「一句 SELECT 的便宜目標」

它看起來只是 `SELECT * FROM users WHERE id = ?`，但在 `db.js` 裡有 **8 處私有呼叫**，
而且那些呼叫端**全部是同步函式**：

```
db.js:932／942／954   adminPatchMember()
db.js:2282            listingToolsInfo()
db.js:2299            createDescriptionTemplateFor()
db.js:2720            getSettings()
db.js:2727            saveSettings()
db.js:2769            saveAsProfile()
db.js:4111            armMemberExternalFetch()
```

⇒ 要讓 `getUserById` driver-aware，就得把上面這 7 支**一起**改成 async（或改成注入 loader）。
這是一個**成組的批次**，不是單點修改；而且其中幾支本身就是高價值標的：

- `getSettings` 是 **8 條**缺口路由的卡點（而且 `getSettingsAsync` **早就存在**，只是呼叫端沒接
  ——與 `getWishConditions`／`stats` 同一類）。
- `saveSettings`／`saveAsProfile` 對應 `POST /api/settings`、`POST /api/profiles`。
- `adminPatchMember` 對應 `PATCH /api/admin/members/:id`。

### 38.2 建議切法

| 順序 | 標的 | 理由 |
|---|---|---|
| **1** | `getSettings` → 接上**既有的** `getSettingsAsync` | 8 條路由、零新程式（先查既有 `*Async.js` 那條紀律） |
| **2** | `getUserById` 的 PG 版 ＋ 把上面 7 支改成接受 loader | 一次解鎖 25 條的卡點 |
| **3** | `ensureUser`（22 條） | 它會**寫入**（PG 模式建立使用者？）——要先決定政策：PG 模式找不到人就明確失敗（`personalFlagsAsync.js` 已表明這個立場），不要偷偷在本機建帳號 |

### 38.3 現況（合併後，可重跑）

```
node v3/scripts/route-data-map.mjs
PG 173、MIXED 84、SQLite 11、無直接DB 20、缺口 95
wishOffers 群：0 條
```

**已部署**：master `af21275`、image `sha256:8b587364…`（deploy evidence `passed: true`）。

### 38.4 第 2 步的第一塊：`getUserByIdAsync()`（`v3/src/usersAsync.js`）

缺口的**頭號卡點**（25 條路由）現在有 PG 版了：

- 語句 `SELECT * FROM users WHERE id = ?`，與 `members.getUserById()` 逐字相同。
- **查不到回 `null` 而不是 `undefined`**——呼叫端（`adminPatchMember`、`getSettings`、
  `saveSettings`…）靠 `if (!user)` 判斷，形狀不能變。
- `uid` 為 0／非數字時**直接早退、不送查詢**（同步版同義）。
- 測試 `v3/test/users-async.test.js`（5 項全綠）＋變異 **4 條全殺**。

**變異測試又抓到我兩個問題，都不是程式的錯：**

1. **斷言用了 `assert.equal` 而不是 `assert.strictEqual`**：`assert.equal(undefined, null)` 是**通過的**
   （`node:assert` 的非嚴格版本用 `==`）。所以「回 undefined 而不是 null」的變異原本殺不死。
   已全部改成 `strictEqual`。
2. **一句多餘的 `|| null`**：`one()` 本身就保證查不到回 `null`，所以在它後面再接 `|| null`
   是**等價**的——拿掉測試照樣過。已把那一句從原始碼移除，並在變異集寫明「刻意不放這條變異」，
   免得留下「看起來有守衛、其實沒作用」的程式碼。

#### ⚠️ 第 2 步的**另一半還沒做**（下一次）

`getUserById` 的 7 個私有呼叫端（見 38.1）還沒轉成 async／loader。它們**不是同一種難度**：

| 呼叫端 | 難度 | 說明 |
|---|---|---|
| `listingToolsInfo()` | 低 | 只讀 `plan`／`role` 交給 `listingToolsMeta()`；但它所在的 `/api/self-listings` 還有 `getRentalCatalog`／`listMineSelfListings` 等同步依賴 |
| `createDescriptionTemplateFor()` | 低 | 只傳 `plan`／`role` 給 `createDescriptionTemplateOn()` |
| `armMemberExternalFetch()` | 低 | 只讀 `plan` 算間隔 |
| `getSettings()` | 中 | **`getSettingsAsync` 早就存在**（第三十八批 38.2 的第 1 步），應先接它 |
| `saveSettings()`／`saveAsProfile()` | 中 | 依賴 `getSettings()`／`getUserById()` 兩者 |
| `adminPatchMember()` | 高 | 完整的會員修改流程，牽涉多張表與稽核 |

⇒ 建議**先接 `getSettingsAsync`**（零新程式、單獨卡 8 條），再處理低難度那三支。

### 38.5 第 1 步（38.2 的順序）：`getSettings` 接上既有的 `getSettingsAsync()`

**零新程式**——`getSettingsAsync()` 早就寫好了，只是呼叫端沒接（與 `getWishConditions`／
`stats` 同一類）。這一輪把 `server.js` 裡剩下的同步呼叫全部改掉：

| 位置 | 原本 | 現在 |
|---|---|---|
| `queueGeoBackfill()` 的同步預設值 | `settings = getSettings()` | `settings = null` ⇒ `await getSettingsAsync(0)` |
| `GET /api/state` | `getSettings(uid)`（在 try 裡） | `await getSettingsAsync(uid)`（**保留原本的 500 處理**） |
| `POST /api/commute/focus` | handler 同步 ＋ `queueGeoBackfill(getSettings(uid))` | handler 改 async ＋ `await queueGeoBackfill(await getSettingsAsync(uid))` |
| `GET /api/commute/snapshot` | handler 同步 | handler 改 async |
| 已在 async 內的一處（`resolveWorkPointForSave` 之前） | `getSettings(uid)` | `await getSettingsAsync(uid)` |

結果：**`getSettings` 從這三條路由的卡點清單消失**（`/api/state`、`/api/commute/focus`、
`/api/commute/snapshot`）。

#### ⚠️ 但**尺規沒動**（缺口仍 95）——這是對的

那三條路由各自還有別的卡點（`ensureUser`、`getUserById`、`countWatched`、
`collectCommuteSettings`… 都在清單上），所以只換掉一個函式不會改變判定。
`GET /api/settings` 本來就已經是 PG（它用的是 `getSettingsAsync`）。

`GET /api/demo` 仍把 `getSettings` **以參考傳遞**給 `buildDemoState()`：

```js
res.json(buildDemoState({ listUserIds, getSettings, defaultUserId, listListings, stats }));
```

那是「以參考傳遞的函式」那一類（尺規現在看得到它，見第三十一批的缺陷 (2) 修正），
要改成注入值而不是注入函式才算真的搬完——留給 `/api/demo` 那一包。

#### 測試

57 項相關測試全綠（commute／demo／settings／profile／route-data-map／module-imports／boot）。
`queueGeoBackfill()` 改成 async 之後，三個仍以同步方式呼叫它的地方（`reason !== "startup"`、
`settings.enabled` 分支、啟動流程）不會爆——它體內的 DB 讀取已移到最前面並由呼叫端提供，
throws 只可能發生在「呼叫端已 await」或「參數已備好」的情況下。

#### 38.6 ⚠️ 動手前的量測：為什麼「先轉低難度那三支」其實不會解鎖路由

第 38.4 節建議「先處理低難度那三支（`listingToolsInfo`／`createDescriptionTemplateFor`／
`armMemberExternalFetch`）」。**實測之後要修正這個建議**：

| 函式 | 目前單獨卡幾條路由 |
|---|---:|
| `getUserById` | **24** |
| `ensureUser` | **22** |
| `sqlExcludeFixtureRows` | 13 |
| `countWatched` | 12 |
| `listingToolsInfo` | **0** |
| `armMemberExternalFetch` | **0** |

而且**沒有任何一條路由是「只差 `getUserById`」**（`(r.sqlite||[]).length === 1` 且該項為
`getUserById` ⇒ **0 條**）。

⇒ 兩個結論：

1. **`getUserById` 是一整群的共同卡點，不是終點。** 它出現的 24 條路由每一條都還有別的卡點
   （`ensureUser`、`countWatched`、`sqlExcludeFixtureRows`、`collectCommuteSettings`…）。
   所以要看到數字下降，得**成組清掉這些共同卡點**，而不是一次轉一個。
2. **`listingToolsInfo` 與 `armMemberExternalFetch` 不是「低難度捷徑」。** 它們目前單獨卡 0 條
   ⇒ 轉了它們**不會改變任何路由的判定**，而且 `/api/self-listings` 還有
   `getRentalCatalog`／`listMineSelfListings`／`getRentalMarketplaceFlags` 等同步依賴
   （其中 `getRentalCatalog` 就是第 31.2 節提到的「PG 版快取沒補」那條線）。

**下一次的順序建議改為**：先量「哪一組共同卡點一起清掉之後，缺口會真的下降」，
再從那一組開始；`getUserByIdAsync()` 已經是那組的現成零件。

## 二之負八、2026-09-28 第三十九批：個人旗標讀取（`loadFlags`／`loadFlagMap`）

### 39.1 先做了「模組 × 卡點 × 影響路由」的量測，才挑這一包

38.6 的結論是「要找一組共同卡點」，所以我把 95 條缺口路由的 207 個卡點
**依定義模組分組**，再看哪個模組的「卡點數 ÷ 影響路由數」最好：

| 模組 | 卡點數 | 影響路由數 |
|---|---:|---:|
| `db.js`（都是包裝層） | 97 | 78 |
| `selfListings.js` | 8 | 16 |
| `demand.js` | 12 | 16 |
| **`personalFlags.js`** | **2** | **13** |
| `rentalNotify.js` | 7 | 13 |
| `contentDocuments.js` | 7 | 12 |

⇒ **`personalFlags.js` 只有 2 個卡點（`loadFlags` 9 條 ＋ `loadFlagMap` 8 條，重疊後 13 條）**，
是投報率最高的一組。

### 39.2 做法

兩支都只是**一個 SELECT**，而且 `personalFlagsAsync.js` 裡**已經有**
`FLAGS_BY_USER_POST_SQL`（`setFlags` 在用），所以只補了 `FLAGS_BY_USER_SQL`：

- `loadFlagsAsync()`：查不到（或 `uid`／`pid` 為 0）回 **`emptyFlags()`**——不是 null／undefined。
  呼叫端 `overlayPersonal()` 會直接讀欄位，形狀不對就會出現 `undefined` 而不是 0。
- `loadFlagMapAsync()`：回 **`Map`**，鍵是**數字** `post_id`
  （`overlayRowsPersonal()` 用 `flagMap?.get(Number(row.post_id))` 查，鍵型別錯了永遠查不到）。
- `uid`／`pid` 為 0 時**直接早退、不送查詢**（同步版同義）。

⚠️ 這個模組的 `pgExec()` 回的是 **rows 陣列**，不是 `{ rows, rowCount }`
（與 `demandAsync.js`／`wishOffersAsync.js` 的契約不同）——寫新函式時要看清楚，別套錯樣板。

### 39.3 測試

`v3/test/personal-flags-read-async.test.js`（**7 項全綠**）：逐鍵 parity、查不到的形狀
（含「每個鍵都要在」的斷言）、只讀自己的、Map 的鍵型別、空集合、fail-closed、sqlite 回退
（用**計數的 exec** 證明回退時完全不碰 PG runner）。變異 **6 條全殺**。

順手踩到兩個夾具問題（都已寫進測試註解）：`user_listing_flags` 有 **FK 到 `users`**，
所以測試使用者要先種、夾具也要鏡射 `users` 的表定義，否則會是
`FOREIGN KEY constraint failed`／`no such table: main.users`。

### 38.7 🚨 量測推翻了 `ensureUser` 那一項：它是**尺規的偽陽性**（不必移植）

第 38.1／38.2 節把 `ensureUser`（22 條路由）列為第二個要處理的卡點，並說它需要政策決定
（「PG 模式要不要建帳號」）。**實際追完之後，它根本不需要移植。**

#### 可重跑的證據

`ensureUser` 在全站的呼叫點只有三個，**沒有任何一個在路由路徑上**：

```
personalFlags.js:23        export function ensureUser(conn, email, …)   ← 定義（吃 handle）
db.js:430                  ensureUser as ensureUserOn                  ← 匯入
db.js:836                  ensureUserOn(db, email, opts)               ← db.js 的同步包裝（無人呼叫）
db.js:841                  cachedDefaultUserId = ensureUserOn(db, …)   ← **只在 defaultUserId() 內**
db.js:8530                 bootstrapAdminUserOn(db, …, { ensureUser: ensureUserOn })  ← 當參數傳
members.js:316             ensureUser(conn, key, { role: "admin" })     ← 只在 bootstrap 且由參數傳入時
```

- `db.js:841` 是**模組層 `defaultUserId()`** 裡的一行；`ensureUser(email)`（`:836`）**沒有呼叫端**。
- 那 22 條路由一條都沒有直接呼叫 `ensureUser`；其中 3 條被列成「唯一卡點」
  （`POST /api/admin/crm/contacts`、`…/contacts/:id/notes`、`POST /api/admin/similarity/:id/review`），
  但三條的 handler 都是 **async**、走 `crmAsync`／`*Async` 路徑，
  而 `actorUserId` 是**由 session 帶進來的參數**——它們從來不會碰到 `ensureUser`。

⇒ 尺規把它算成那 3 條的卡點，是因為它掃到 **`db.js` 內有一個 `ensureUser(` 呼叫**，
再沿 db.js 的模組層邊傳遞出去——與第三十批那個
`saveSiteBudget`／`budgetStore()` 的偽陽性是**同一類（經過一層 facade／模組層）**。

#### 結論

1. **不要為 `ensureUser` 做 PG 版**，也不需要 Owner 決定「PG 要不要建帳號」——
   那條路徑在正式站（PG 模式）根本不會被走到。
2. 缺口的 22 條**含 `ensureUser`** 的路由，真正要清的是它們**其他的**卡點
   （`countWatched`／`getUserById`／`sqlExcludeFixtureRows`…）。
3. **第三十八批 38.2 的順序建議據此修正**：第 3 步（`ensureUser`）**刪除**；
   力氣應該放在「一起清掉 `getUserById`＋`countWatched`＋`sqlExcludeFixtureRows` 這組共同卡點」。

## 二之負九、2026-09-28 第四十批：許願房生命週期寫入（更新／刊登／重開）＋範例儲存

### 40.1 量測方式換了：從「模組」改成「**移植單元**」，答案完全相反

39.1 的分組法（依定義模組）有一個盲點：**同一個工作單元常常橫跨兩個模組**
（實作在 `demand.js`、吃 handle 的包裝在 `db.js`）。所以「只清一個模組能放掉幾條路由」
永遠接近 0，看起來像「沒有便宜的目標」，其實是**量錯了**。

改成用「移植單元」（把 `X`／`XFor` 這種成對的包裝收斂成同一個單元）重量之後：

| 移植單元 | 影響路由 | 單獨做完可放掉的路由 |
|---|---:|---:|
| `ensureUser` | 22 | 3（**偽陽性**，見 38.7，實際 0） |
| `getUserById` | 24 | 0 |
| `setCachedGeo` | 7 | 1（`POST /api/profiles`） |
| **`updateWishRoom`／`publishWishRoom`／`reopenWishRoom`** | **3** | **3** |
| **`saveWishExample`** | **1** | **1** |
| `getCompletionSurvey`／`submitCompletionSurvey` | 2 | 0（要搭 `getDemandPost`，已在島上） |

⇒ 許願房生命週期的三支 ＋ 範例儲存是**唯一一組「自己就是自己瓶頸」的單元**：
把這四支搬完，四條路由同時落地。這就是這一包。

### 40.2 做法

`demand.js` 這一批**只抽共用、不改行為**（先抽再搬，兩個 driver 才不可能漂移）：

- `normalizeWishFields(userId, input, fallback, contactThunk)`：`normalizeWishInput()` 的純核心。
  ⚠️ `contactThunk` 在**原本 `snapshotContact()` 的位置**才被呼叫——「同時有多個錯誤時先丟哪一個」
  與同步版相同（`rentPair()`／行政區等較早的驗證仍然優先）。PG 版把查好的聯絡人列包成 thunk。
- `contactFields()`：聯絡人快照的純部分（「只能用自己的聯絡人」「電話太短」「line 正規化」）。
- `WRITE_ROW_SQL` ＋ `writeRowParams()`：`writeRow()` 的語句與參數順序（29 個欄位）。
- `applyPublishInPlace()`／`applyPublishInPlaceAsync()`、`applyReopenInPlace()`／`applyReopenInPlaceAsync()`：
  狀態轉換的資料半，同步版與 PG 版逐字共用同一組語句與同一個 lifecycle patch。
- `countMutable` 的兩條 COUNT、`publishExpiry()`、`publishLifecyclePatch()`、`examplePayload()` 也都匯出重用。

`demandAsync.js` 新增 `updateWishRoomAsync()`／`publishWishRoomAsync()`／`reopenWishRoomAsync()`，
`wishExampleAsync.js` 新增 `saveWishExampleAsync()`，`server.js` 接線四條路由
（`PATCH /api/wish-rooms/:id`、`POST …/publish`、`POST …/reopen`、`PUT /api/wish-rooms/example`）。

### 40.3 這一包的三個坑（少處理一個就會出錯，而且症狀都很難查）

1. **行程內快取要先跟上 PG**：`db.js` 的 `*For` 包裝第一件事是 `getWishConditions()`，
   它把 `marketplaceFlags`／`catalogCacheV2` 灌進 `demand.js` 的模組變數——`normalizeWishFields()`
   讀的正是那兩個。PG 分支若跳過，會拿**空目錄**正規化（條件選項整批消失、生命週期開關判錯），
   而且只有在「真的改了條件選項」時才看得出來。所以每一支都先 `await getWishConditionsAsync(options)`。
2. **`updated_at` 這種「寫入當下」的時間戳會漏進衍生欄位**：`last_active_at`、`activity_score`、
   `activity_bucket` 都是由 `updated_at` 推出來的，所以 parity 比對不能只遮罩 `updated_at`。
   這一包改用**時間縫**（`options.now`，與 `listingSimilarityAsync` 同一個寫法）：
   兩邊餵同一個時間，回傳值就能逐鍵 `deepEqual`，不必遮罩任何欄位。
3. **PG 沒有交易**：`run()` 走連線池，下 `BEGIN` 不保證同一條連線，所以 `withImmediate()` 沒有對應物。
   「同一人只能有一則 open／draft」改靠 `ensurePgSchema` 從 SQLite 鏡射過去的**部分唯一索引**
   （`idx_demand_one_open`／`idx_demand_one_draft`／`idx_demand_one_mutable`）；
   撞到 23505 要轉成與同步版**同一個** `wish_active_limit`。
   ⚠️ 轉換要**指名索引名稱**：`demand_posts` 上還有 `idx_demand_public_token`，
   把所有 23505 都當成 active limit 會把「token 撞號」講成「已有許願房」。

順手補掉一個**潛在缺陷**：`wishExampleAsync` 的 `pgExec()` 回裸陣列，但注入式 `exec` 的既有慣例是
`{ rows, rowCount }`（`crmOutboxAsync` 起）。原本只認裸陣列，餵另一種會**靜默地**回 null
（症狀：「範例明明存進去了，GET 卻說沒有」）。現在 `rowsOf()` 兩種都吃。
⚠️ 同一類的形狀問題在 `settingsKvAsync.getSiteSettingAsync()` 也在（它讀 `rows[0]?.value`）。
   **2026-09-28 第四十三批已修**：注入 `{ rows, rowCount }` 形狀的替身時，它會**靜默地**把所有
   設定當成「沒有值」⇒ 全部退回預設值。實際症狀是 live PG 測試裡的
   「站上明明開了通知，PG 分支卻回 404 `rental_notify_disabled`」——那個錯誤離「讀不到 settings」
   很遠，所以查了一段時間。現在兩種形狀都吃（與 `wishExampleAsync` 同一個 `rowsOf()` 寫法）。

### 40.3.1 🚨 只有真 PG（CI 的 PG job）才抓得到的兩個錯

**這兩個都是「本機 handle 追上」那一半造成的**，離線夾具完全看不到：

1. **本機的 FK 把一個已經成功的 PG 寫入變成 500**。本機 `wish_room_example` 有
   `FOREIGN KEY(user_id) REFERENCES users(id)`，但 PG 模式的帳號可能是在**別的節點**建立的
   （session 走 `readSessionAsync()` 讀 PG，不看本機 `users`）。第一版無條件寫本機 → 
   `FOREIGN KEY constraint failed`（`ERR_SQLITE_ERROR`），而 PG 上其實已經寫好了。
   ⇒ 現在先確認本機有這一列才寫（沒有的那一列本來就沒有本機讀者）。
   教訓：**「兩個 store 都寫」的紀律要加上「本機寫得進去嗎」這一個前提**，
   不是每一種鏡射都像 `UPDATE` 那樣可以無條件套用。
2. **SQLite 的 `INTEGER PRIMARY KEY` 在 PG 上會變成 identity，而這個欄位是使用者帶進來的**。
   `ensurePgSchema()` 依 `PRAGMA table_info` 重建表時，單一 `INTEGER` 主鍵一律翻成
   `BIGINT GENERATED BY DEFAULT AS IDENTITY`（那是為了讓「不指定 id 的 INSERT」能動）。
   但 `wish_room_example.user_id` 是 `users.id`，永遠由呼叫端提供 ⇒ 明確寫入不會推進序列，
   `v3/scripts/pg-identity-sequences.mjs` 的健檢就**永遠紅著**
   （`wish_room_example.user_id (next=1 max=2)`），把真正落後的序列蓋掉——而那個健檢
   正是先前抓出 `admin_audit` 十二天無聲失敗的那一支（見
   `PG-IDENTITY-SEQUENCE-DEFECT-20260927.md`）。
   ⇒ `ensureWishExampleStoreOnce()` 多一句
   `ALTER TABLE wish_room_example ALTER COLUMN user_id DROP IDENTITY IF EXISTS`。
   ⚠️ 這是**通則**：任何「單一 INTEGER 主鍵，但那個主鍵是別人給的 id」的表（目前只有這一張）
   都會踩到，遇到時要一起檢查。
3. 附帶：live 測試在**共用**資料庫上跑，中途失敗留下的殘骸會讓後面依賴「序列健康」的
   live 測試跟著紅（這次 CI 一次紅兩條就是這樣）。新的一條測試改用 `t.after()` 保證清理。

### 40.4 測試

- `v3/test/wish-room-lifecycle-async.test.js`（**12 項全綠**）：更新（正規化欄位／錯誤形狀／
  PG 不得被寫入）、刊登（draft→open 的兩個 store、冪等、非草稿狀態的錯誤、23505 競態與
  「非 23505 不得被吞掉」）、重開（closed→open、hidden／blocked／collapsed／completed 四種拒絕）、
  快取 priming（真的對 `settings` 查過 ＋ 快取被灌好）、範例（INSERT→UPDATE、`created_at` 不變、
  兩個 store、未登入／別人的聯絡人、兩種 exec 形狀、**本機沒有這個帳號時仍要成功**）。
  變異 **16 條全殺**。
- `v3/test/demand-live-pg.test.js` 追加一條 live PG：更新／刊登／重開真的在 PG 上生效、
  **PG 上真的擋得住第二則 mutable**（部分唯一索引）、範例第二次是 UPDATE、
  **`user_id` 不是 identity**（釘住 40.3.1 的第 2 點）；清理由 `t.after()` 保證執行。
- 尺規（可重跑）：`node v3/scripts/route-data-map.mjs` ⇒ 缺口 **95 → 91**，PG **173 → 177**。

### 40.5 下一個候選（用同一個「移植單元」量測法）

`getCompletionSurvey`／`submitCompletionSurvey`（2 條路由，`rentalSurvey.js` 只有 72 行）＋
`surveyAggregate`／`rentalOpsSummary`／`rentalOpsDrilldown`（2 條路由，`rentalOpsAnalytics.js` 206 行）
＝ **4 條路由**，而且 `getDemandPost`／`bumpAnalytics` 都已經在島上。

## 二之負十、2026-09-28 第四十一批：完成問卷（completion survey）

### 41.1 範圍與投報率

40.5 列的下一個候選。`rentalSurvey.js` 只有 72 行，而且兩個前置條件都已經在島上
——`getDemandPostAsync()`（同步版走 `db.js getDemand()`）與 `bumpAnalyticsAsync()`
（第三十六批 36.5）。做完放掉兩條路由：

| 路由 | 進入點 |
|---|---|
| `GET  /api/wish-rooms/:id/survey` | `getCompletionSurveyAsync` |
| `POST /api/wish-rooms/:id/survey` | `submitCompletionSurveyAsync` |

尺規：缺口 **91 → 89**，PG **177 → 179**。

另外把 `surveyAggregateAsync()` 也備好（admin 的 `survey_breakdown` 在用）；它目前唯一的
呼叫端是 `rentalOpsSummary()`，那一支還沒搬，所以這一批不放掉任何路由，但 parity 先釘住
（第四十二批會直接用）。

### 41.2 這一包的三個坑

1. **`rental_completion_surveys` 的兩條唯一鍵在 PG 上不存在**。SQLite 的 DDL 是
   `wish_id INTEGER NOT NULL UNIQUE` 與 `public_token TEXT NOT NULL UNIQUE`——都是**表約束**，
   而 `ensurePgSchema()` 只從 `PRAGMA table_info` 重建欄位／主鍵／預設值（表約束的隱式索引抓不到，
   本系列已中過四次）。少了它們，PG 上的「一則許願房一則問卷」與「token 不重複」會**整個失效
   而且不會有任何錯誤**。所以 `ensureSurveyStoreOnce()` 除了鏡射建表，還要自己補
   `SURVEY_UNIQUE_INDEXES`（與 `rentalNotifyWriteAsync` 同一個做法），live PG 測試再直接
   對 PG 插第二列確認它真的在擋。
2. **`wish_id` 是全域唯一，不是 `(wish_id, user_id)`**。所以「同一則許願房有兩個人的問卷」
   這個狀態不存在——測試第一版就是這樣紅的（夾具的 `UNIQUE` 擋下來）。要驗「不是自己的」
   只能用**別人的許願房**，而且要挑 `status='open'` 的那一種：`getDemandPost()` 對公開中的
   許願房會回公開視圖（不丟錯），所以「這不是你的許願房」必須由**所有權檢查**擋下來。
   少了它，任何人都能替別人的許願房填問卷（變異測試現在會殺掉這一條）。
3. **`COUNT(*)` 在 PG 回來的是字串**（bigint → string），SQLite 是數字，而同步版把列原樣
   往外送（admin 的 `survey_breakdown` 直接用）。所以 PG 版要 `Number(row.n)` 正規化，
   否則前端的 `"3"` 會跟 `3` 不一樣。離線測試用「把 COUNT 轉成字串的夾具」釘住這一條。

**兩個 store 都寫**：問卷列與 `rental_analytics_daily` 的計數都各寫一次
（`bumpAnalyticsAsync()` 的 PG 分支不會碰本機 handle，所以不會重複）。
本機那兩條線的讀者是還沒搬的 `rentalOpsSummary()`／`rentalOpsDrilldown()`（見 40.5）。
`public_token` 兩個 store 用**同一個**（同步版是各自產生）——這樣 admin 的 drill-down
不管從哪個 store 讀，看到的 `survey_ref` 都一樣。

### 41.3 測試

- `v3/test/rental-survey-async.test.js`（**9 項全綠**）：讀取（沒有／有／別人的／不存在的 404）、
  送出（兩個 store 的列與計數「各一次」、跳過記 `survey_skipped`、不合法的值降級、
  already 不得再寫再計數、23505 競態、非唯一鍵錯誤不得被吞、生命週期／所有權／不安全標記、
  非 postgres 走同步路徑）、彙總（逐列相同 ＋ COUNT 型別）。變異 **12 條全殺**。
- `v3/test/rental-survey-live-pg.test.js`（新，CI 的 PG job 會跑）：兩個唯一索引真的在 PG 上、
  送出真的落地、already、直接插第二列會被拒、公開中的別人的許願房不得填、COUNT 是數字。

### 41.4 下一個候選

`rentalOpsSummary()`／`rentalOpsDrilldown()`（`rentalOpsAnalytics.js`，2 條路由）。
⚠️ **先讀再切**：那兩支的 `medianSecondsToAccept()` 用了 **`julianday()`**（SQLite 專屬），
所以不是「換個 runner」就好——要決定用方言分支（PG 的 `EXTRACT(EPOCH FROM …)`）還是把中位數
搬到 JS 算。這也是「尺規看不到方言問題」的又一個實例：量測說 2 條路由、實作有一個真障礙。

## 二之負十一、2026-09-28 第四十二批：Admin 營運分析（rental ops）

### 42.1 範圍與投報率

41.4 列的下一個候選，也是 40.5 那條線的收尾：`rentalOpsSummary()`／`rentalOpsDrilldown()`
（`GET /api/admin/rental-ops`、`GET /api/admin/rental-ops/drill`）。

尺規：缺口 **89 → 87**，PG **179 → 181**。

### 42.2 做法：語句一份、組裝是轉錄

`rentalOpsSummary()` 是**一包 30 幾個查詢**的彙總（許願房存量、報價狀態、通知計數、成長指標、
時間序列、中位數），硬寫成 PG 版會有一堆重複的 SQL。所以：

1. **語句只有一份**：把每一句抽進 `RENTAL_OPS_SQL`／`WISH_COUNT_SQL`／`OFFER_STATUS_COUNT_SQL`
   （抽的時候逐字照抄、不動行為——`rental-notify.test.js` 的 25 項當場驗證沒改壞），
   PG 版跑同一批字串。
2. **組裝是同步版的轉錄**，刻意**不**共用物件字面值：同步版是**參考實作**，
   parity 測試深度比對整包 summary（含每個 `*_definition` 文案與每個鍵），
   共用同一個字面的話「兩邊一起寫錯」會變成看不到的漂移。
3. **錯誤碼沿用同一組**（`analytics_metric_failed`／`analytics_series_failed`／
   `analytics_count_failed`／`analytics_median_failed`／`analytics_drill_failed`）——
   admin 靠它分辨哪一類查詢壞掉。
4. `DAY_START`／`DAY_END` 也抽成常數：區間的兩端各有測試（資料集刻意同時放**早於 from**
   與**晚於 to** 的列，否則「迄日被忽略」那一類錯誤不會有任何測試紅——變異測試就是這樣抓到的）。

### 42.3 🚨 `julianday()` 是 SQLite 專屬（尺規看不到的障礙）

同步版的 `medianSecondsToAccept()` 用 `(julianday(accepted_at) - julianday(created_at)) * 86400`
排序後取中間那 1～2 列；PG 沒有 `julianday()`。處理方式：

- PG 版用 `EXTRACT(EPOCH FROM (accepted_at::timestamptz - created_at::timestamptz))`。
  兩個時間欄位在 PG 上是 **TEXT**（SQLite 的 TEXT 鏡射過來），所以一定要明確轉型
  （值都是應用程式寫入的 ISO 字串，轉型不會失敗）。
- **刻意不把中位數搬到 JS 算**：那一句的 `LIMIT/OFFSET` 是「母體中位數、不是最快 N 筆」的
  保證（`median_definition` 就是這樣寫給 admin 看的），搬到 JS 等於撈全量。
- 離線夾具是記憶體 SQLite，所以它把 PG 那一句**翻回去**（`PG_TO_STANDIN`）才跑得動
  ——也就是說「PG 的 SQL 本身對不對」在離線測試裡看不到，由
  `rental-ops-live-pg.test.js` 在真 PG 上驗：拿真 PG 的列用 JS 算同一個中位數來對帳，
  奇數／偶數兩種母體各一次。

⚠️ 夾具的**順序**也是一個坑：要先驗「PG 分支有沒有寫出 SQLite 專屬語法」**再**翻譯，
顛倒過來會讓翻譯出來的 `julianday(...)` 被自己的守衛擋下（症狀是 `analytics_median_failed`，
看起來像模組壞了）。

### 42.4 測試

- `v3/test/rental-ops-async.test.js`（**7 項全綠**）：整包 summary 深度比對（偶數母體／
  奇數母體／空資料庫）、區間驗證的錯誤形狀、明細兩種 kind ＋ 分頁游標、五種查詢失敗的
  錯誤碼、非 postgres 走同步路徑。變異 **11 條全殺**。
- `v3/test/rental-ops-live-pg.test.js`（新，CI 的 PG job 會跑）：方言 SQL 的中位數與 JS 對帳
  （奇／偶各一次）、整包該有的鍵、明細在 PG 上真的能分頁且兩頁不重複。

## 二之負十二、2026-09-28 第四十三批：租屋通知偏好／配對訂閱／取消訂閱

### 43.1 範圍與投報率

42.1 之後剩下的長尾裡，這一組是「同一個使用者的三張小表、一次做完」最順的一包
（`rentalNotify.js` 裡的 prefs／subscriptions／unsubscribe_tokens）。做完放掉五條路由：

| 路由 | 進入點 |
|---|---|
| `GET  /api/rental-notify/prefs` | `getRentalNotifyPrefsForAsync` |
| `PUT  /api/rental-notify/prefs` | `saveRentalNotifyPrefsForAsync` |
| `GET  /api/self-listings/:id/match-subscription` | `getMatchSubscriptionAsync` |
| `PUT  /api/self-listings/:id/match-subscription` | `saveMatchSubscriptionAsync` |
| `POST /api/public/unsubscribe/:token` | `applyUnsubscribeTokenAsync` |

尺規：缺口 **87 → 82**，PG **181 → 186**（其中 `POST /api/public/unsubscribe/:token` 原本是
唯一的 SQLite 判定，也一起變 PG）。

### 43.2 這一包的四個坑

1. **行程內快取決定「通知是開還是關」**：`db.js` 的 `*For` 包裝第一件事是
   `hydrateRentalMarketplace()`，它灌的是 `flagsCache`（`assertRentalNotificationsEnabled()`
   讀它）與 marketplace flags（`publicRentalNotifyCaps()` 讀它）。PG 分支跳過就會
   「站上明明開了通知，PG 站卻回 404 `rental_notify_disabled`」——**功能全滅**，不是小差異。
   ⇒ 每一支都先 `await getWishConditionsAsync(options)`；測試刻意讓本機與 PG 的 settings
   不一致，驗 PG 版跟的是 PG（`prefs 讀取`／`PG 說通知關閉`這兩條）。
2. **取消訂閱要暫時打開閘門，而且 `finally` 在 async 會提早還原**：同步版直接改
   `flagsCache`，PG 版若照抄那個寫法，`finally` 會在 `saveRentalNotifyPrefsAsync()` 的
   Promise **還沒結算**時就還原旗標 ⇒ 使用者的取消連結被自己的閘門擋下（404）。
   ⇒ 另寫一支 `withNotificationsForcedEnabledAsync()`（`await` 之後才還原）。
3. **兩個 store，而且本機那一列不一定存在**：同步的 `planDeliveries()` 讀本機 prefs、
   worker 的摘要查詢讀本機訂閱，所以 PG 寫完本機要寫**同一組值**；反過來取消連結的
   token 可能是**別的節點**寄的（本機沒有那一列），那時只能動 PG
   ——硬寫本機不會報錯，但會讓狀態看起來像「取消了」而本機其實沒有那筆資料。
4. **`rental_match_subscriptions` 的唯一鍵又是表約束**：`UNIQUE(owner_user_id, listing_id)`
   與 `public_token UNIQUE` 都鏡射不到（本系列**第五次**），少了它們「同一刊登一組訂閱」會失效；
   另外 `rental_notify_prefs.user_id` 是 `INTEGER PRIMARY KEY` ⇒ PG 上是 identity，而它是
   使用者 id ⇒ 健檢會永遠紅著（與第四十批的 `wish_room_example` 同一個坑），ensure 補
   `DROP IDENTITY`。

**訂閱 token 的優先序**（PG 已有的 → 本機已有的 → 新產生）：PG 上還沒有那一列、但本機有時
（島嶼搬遷前建立的訂閱），沿用本機的 token 才不會讓**已經寄出去**的連結失效；
兩個 store 因此一定收斂到同一個 token（`SUBSCRIPTION_SYNC_LOCAL_SQL` 連 `public_token` 一起蓋）。

### 43.3 測試

- `v3/test/rental-notify-prefs-async.test.js`（**10 項全綠**）：常數清單（兩條 unique index ＋
  `DROP IDENTITY`）、prefs 讀取（預設值／caps 跟 PG）、prefs 寫入（兩個 store 同值、
  計數各一次、未知鍵不得落地）、未登入 401 與站上關閉 404（PG 版與本機旗標不一致時以 PG 為準）、
  訂閱（INSERT／UPDATE／同一個 token／不合法 mode 降級／所有權與名稱錯誤）、取消訂閱
  （四種 scope、只能用一次、站上關閉時仍要生效、過期／不存在、本機沒有 token 時仍要成功）、
  非 postgres 走同步路徑。變異 **14 條全殺**。
- `v3/test/rental-notify-prefs-live-pg.test.js`（新，CI 的 PG job 會跑）：唯一索引真的在 PG 上、
  `user_id` 不是 identity、prefs 的 `ON CONFLICT` insert／update 兩條分支、
  訂閱的 INSERT→UPDATE 與「第二列被唯一索引擋下」、取消連結端到端（prefs＋訂閱＋`used_at`）。
- CI 這一條抓到的兩個**測試自己**的錯：`syncSequence()` 寫死 `id`（`listings` 的主鍵是
  `post_id`），以及上面的 `settingsKvAsync` 形狀問題。

## 二之負十三、2026-09-28 量測筆記：迴避回饋／Ops 遞送那一叢（**需要 Owner 決定**）

第四十三批之後，用「移植單元」重量缺口（82 條），下一個看起來最順的是
**回饋 ＋ Ops 遞送**那一叢（5 條路由，模組都很小：`feedback.js` 306 行、
`feedbackOutbox.js` 188 行、`opsDelivery.js` 176 行）：

```
GET   /api/admin/ops-delivery                  deliveryControl, outboxCapacityAlert
PUT   /api/admin/ops-delivery                  ＋ setLocalDeliveryStopped
POST  /api/admin/ops-delivery/compact-outbox   compactSentOutboxPayloads
POST  /api/feedback                            createFeedbackWithOutbox, enqueueFeedbackOutbox
GET   /api/admin/feedback                      deliveryControl, feedbackStats, listFeedback, outboxCapacityAlert
```

**但實際讀完之後，這一叢有很高機率是「刻意節點本機」而不是「還沒搬」**（與
`stage1FixtureIsolation`／`tableColumns` 那些屬於同一類：尺規看得到，但不是待辦）：

- `opsDelivery.js` 檔頭自己寫著「背景遞送 worker（Product 端）……由 server 以 setInterval
  週期驅動」，`claimOutboxBatch()` 是**本機**的 outbox 佇列；`OPS_INGEST_URL`／
  `OPS_INGEST_SECRET`／`OPS_FEEDBACK_DELIVERY` 都是**每台節點各自的環境變數**。
- `isLocalDeliveryStopped()`／`setLocalDeliveryStopped()` 的註解寫得很明白：
  「本機 `settings.ops_feedback_stop=1` 可在不重啟、OPS 不在線時立刻停送」——那是**這一台**
  的緊急切斷開關，搬到 PG 就變成全站一起停。
- `compactSentOutboxPayloads()` 壓縮的是**本機已經送出的** payload；
  `deliveryControl()` 是「env ＋ 本機停止旗標 ＋ 本機 outbox 容量」的組合。
- `createFeedbackWithOutbox()` 用 `BEGIN IMMEDIATE` 維持
  「一筆 feedback ⇔ 一筆初始 outbox 事件」的不變式，而那個 outbox 事件是**本機 worker**
  要認領的；把 feedback 搬到 PG、outbox 留在本機，這個不變式就跨了兩個 store、無法原子。

⇒ **兩個選項，需要 Owner 決定**：

- **A（建議）**：把這一叢登記為「刻意節點本機」，在尺規上加一類例外（像 fixture 隔離那樣），
  文件寫明理由。缺口數字會少 5 條，但**不是**靠搬遷達成的，要誠實標註。
- **B**：把 `feedback` 與 outbox 一起搬上 PG，同時重新設計 worker（共享佇列要
  `FOR UPDATE SKIP LOCKED`；「本機停止」的語意要改成每節點旗標或全站開關），
  並接受「一筆 feedback 與它的 outbox 事件不再同一個交易」或改用 PG 交易。
  這是一個**功能語意**的改變，不是機械搬遷。

在 Owner 決定之前，這一叢**不要**列進「剩下的工作」，以免下一個 session 又量到同一個結論。

## 二之負十四、2026-09-28 第四十四批：系統爬蟲設定／目錄快照／後台刊登搜尋／分享頁 extras

### 44.1 範圍與投報率

第四十三批之後，跳過「需要 Owner 決定」的回饋／Ops 遞送那一叢（見二之負十三），
改挑四條各自只差一個函式、而且互不相干的路由：

| 路由 | 進入點 |
|---|---|
| `GET /api/public/wish-room/:id` | `sharePageExtrasAsync`（新 `rentalShareGrowthAsync.js`） |
| `GET /api/admin/system-crawl` | `getSystemCrawlAsync` ＋ `refreshSiteCatalogStatsAsync` |
| `PUT /api/admin/system-crawl` | `saveSystemCrawlAsync` |
| `GET /api/admin/listings/search` | `searchAdminListingsAsync`（`adminOverviewAsync.js`） |

尺規：缺口 **82 → 78**，PG **186 → 190**。
順帶把 `POST /api/public/wish-room/:id/share-events` 的旗標來源也換成 PG（同一組旗標不該有兩個
來源），那一條的卡點因此從 3 個降到 2 個（`bumpAnalytics`／`recordShareEvent`）。

### 44.2 這一包的四個坑

1. **「只套用有給的欄位」是這一包最容易寫錯的地方**：`PUT /api/admin/system-crawl` 是五個
   **獨立**的 settings 鍵（不是一個 JSON blob），後台只切一個開關時若整包覆蓋，其他設定會被洗掉。
   規則抽成純函式 `normalizeSystemCrawlPatch(partial, current)`，兩個 driver 共用；
   ⚠️ `showMrt: false` 是「有給」而不是「沒給」，要用 `hasOwnProperty` 判斷（不是 truthiness）。
2. **後台改完要對爬蟲生效**：`systemCrawlFromRows()` 還有**同步**讀者（爬蟲角色的
   `crawlIntervalMinutes()`、`getSettings()` 的 system 區塊），所以 PG 寫完**本機也要寫同一組值**，
   而且本機的會員設定記憶體快取要清（`forgetSettings()`；同步版也做這一步）。
3. **目錄快照的兩個 driver 要一致**：`buildSiteCatalogSnapshot()` 抽成純函式共用，但
   「列出」的來源不同（PG vs 本機）；快照本身要寫進 `settings.siteCatalogStats`
   （同步的 `readSiteCatalogStats()` 是 adminOverview 的來源健康度在用）。測試用**同一個**資料集
   驗兩個 driver 逐鍵相同，並確認 PG 與本機都寫了同一份。
   ⚠️ 快照的 `at` 是「跑快照的當下」，兩個 driver 不可能同毫秒 ⇒ parity 比對要遮罩它。
4. **`IFNULL` 是 SQLite 專屬**：後台刊登搜尋的 LIKE 那一段原本是 `IFNULL(address, '')`，
   PG 沒有這個函式 ⇒ 共用常數改成兩邊都有的 `COALESCE`，並順手補上 `, post_id DESC`
   （原本只按 `last_seen_at DESC`，時間相同時兩個 driver 的順序不保證一樣）。

**共用 vs 轉錄的取捨**：這一包把「政策」全部抽成純函式共用（patch 規則、快照組裝、搜尋的
needle／上限、來源標籤），只把「跑語句」留給 driver——與第四十二批（整包轉錄）不同，
因為這裡的每一段都是短函式、共用不會犧牲可讀性。

### 44.3 測試

- `v3/test/system-crawl-async.test.js`（**6 項全綠**）：分享頁 extras 跟 PG 的旗標、
  後台搜尋六種輸入（含 `address` 是 NULL、limit 上限值本身）、系統爬蟲設定讀取與 partial patch
  （含「明確 false 要生效」）、目錄快照（含來源標籤與「不在監看區不算」）、
  非 postgres 走同步路徑。變異 **9 條全殺**。
  ⚠️ 「上限」那一條變異證明了一件事：**共用政策的變異 parity 抓不到**（兩邊一起被改壞），
  所以測試要對「值本身」下斷言，不能只比對兩個 driver 相等。
- `v3/test/system-crawl-live-pg.test.js`（新，CI 的 PG job 會跑）：`settings` 的 upsert 在真 PG 上
  可用、五個鍵逐鍵讀回來的結果等於用同一批列組出來的、快照真的寫進 PG、
  後台搜尋的 `COALESCE` 對 NULL 位址的列真的能跑。
- CI 抓到的兩個**既有守衛**問題（都已修）：
  1. **尺規的缺陷 (2) 守衛又到期了**（這是第 6 次）：它拿「目前還沒移植」當 ground truth，
     這一包把 `GET /api/admin/listings/search` 移植掉之後它必然紅。重新實測（套回缺陷 (2)）
     後全站只剩 `GET /api/events/revision` 會因缺陷變判定 ⇒ 標的換成它，
     **並補上「已移植的那四條現在必須是 PG」的反向斷言**，讓「移植完就整條失效」不再重演。
  2. **注入式 `exec` 的兩種形狀**：`siteContentAsync`／`adminOverviewAsync` 的 runner 原本
     只吃裸陣列，餵 `{ rows, rowCount }` 會在 `for…of` 爆 `rows is not iterable`
     （live PG 測試抓到）。兩個 runner 都統一成裸陣列（與 `settingsKvAsync`／
     `wishExampleAsync` 的修法相同）。

## 二之負十五、2026-09-28 第四十五批：匯入清單（listing imports）

### 45.1 範圍與投報率

第四十四批之後重跑「移植單元」量測，缺口 78 條裡可單獨放掉路由的只剩十來個 1 條的單元
（其餘都牽涉決策或大模組）。這一包挑的是**同一個模組、同一個形狀**的兩條讀取：

| 路由 | 進入點 |
|---|---|
| `GET /api/listing-imports` | `listMineListingImportsAsync` |
| `GET /api/admin/listing-imports` | `listAdminListingImportsAsync` |

尺規：缺口 **78 → 76**，PG **190 → 192**。

### 45.2 做法

兩條都只是**一句 SELECT**（後台那句多一個 `LEFT JOIN users` 取會員 email），所以
「列 → 物件」與「上限」這兩件**政策**先抽成共用零件，PG 版只負責換 runner：

- `rowToImport()` 匯出（`listing_id == null`、`photo_errors`／`media_ids` 的 JSON 還原、
  缺欄位時的空字串都在裡面）。
- `importListLimit(limit, {cap, fallback})`：會員 50／後台 200 的上限與預設值（20／50）。
- `importAdminView(row)`：`member_email` 的 `|| ""`。
- `IMPORT_MINE_SQL`／`IMPORT_ADMIN_SQL` 兩句共用。

⚠️ 路由**行為保持與原樣完全相同**：`GET /api/listing-imports` 原本不吃 `?limit`，
所以就連「順手支援 ?limit」這種看起來無害的加值也不做——這一包的定義是「只換 driver」。

### 45.3 測試

- `v3/test/listing-imports-async.test.js`（**5 項全綠**）：會員清單（只看自己的／新到舊／
  列的形狀逐鍵相同）、後台清單（`LEFT JOIN` 的 email＋查不到使用者時的空字串）、
  上限的**值本身**（parity 抓不到共用政策的變異）、上限真的生效（`limit 3` 只回 3 列、
  超額請求被夾住）、非 postgres 走同步路徑。變異 **7 條全殺**。
- `v3/test/listing-imports-live-pg.test.js`（新，CI 的 PG job 會跑）：`LEFT JOIN` 與
  `LIMIT ?` 在真 PG 上可用、`id` 是數字（PG 的 bigint 是字串，靠 `rowToImport` 轉）、
  孤兒列的 `member_email` 是空字串。

⚠️ 測試夾具的兩個老坑又出現一次（都已寫進註解）：**不要動 user 1**
（它是 bootstrap 管理員，磁碟與 PG 夾具的 email 不同，而且被其他表以 FK 引用——
第一版把它的 email 改掉，`DELETE FROM users` 立刻 `FOREIGN KEY constraint failed`）；
`listing_import` **沒有** FK，所以「帳號已被刪除」的孤兒列可以照種。

## 二之負十六、2026-09-28 第四十六批：檢舉站內刊登／後台隱藏

### 46.1 範圍與投報率

第四十五批之後重跑量測，這一包是剩下的 1 條單元裡**同一組功能**的兩條路由：

| 路由 | 進入點 |
|---|---|
| `POST /api/self-listings/:id/report` | `reportSelfListingAsync` |
| `POST /api/admin/self-listings/:id/hide` | `hideSelfListingAsync` |

尺規：缺口 **76 → 74**，PG **192 → 194**。

### 46.2 這一包的四個坑

1. **達門檻才隱藏**（`SELF_REPORT_HIDE_AFTER = 2`）：門檻是**共用政策**，parity 抓不到
   「兩邊一起被改壞」，所以測試除了比對兩個 driver，還對門檻值本身下斷言
   （變異：門檻改成 1 或 9999 都要被殺掉）。
2. **PG 的 `listing_reports` 沒有唯一鍵**（SQLite 的 DDL 只有一般索引）⇒「同一人不重複檢舉」
   只能靠**先查再寫**；把那段查詢拿掉不會有任何錯誤，只會多一列，所以要單獨驗。
3. **停權寫的是 `users.self_ban_until`，而讀它的是同步路徑**：`assertCanPublish()`（由仍在本機的
   `createSelfListing()` 呼叫）讀**本機** handle ⇒ 兩個 store 都要寫，否則「被停權的人換一台
   節點就又能上傳」。測試直接呼叫同步的建立函式驗「本機真的被停權」，並補一組對照
   （沒被停權的人必須仍可上傳）。
4. 🚨 **`selfBanStamp()` 的時間解析**：模組內的 `nowMs()` 只認 `Date` 與數字，
   餵 ISO **字串**時 `Number("2026-…")` 是 NaN ⇒ 靜默退回 `Date.now()`
   ⇒ PG 版與同步版的停權時間差了好幾個小時（parity 測試當場紅）。
   已改成先 `Date.parse()`、解析不出來才用當下（同步路徑一向傳 `Date`，所以行為不變）。

**順手修掉一個既有的同類缺陷**：`closeSelfListingAsync()` 原本**只寫 PG**
（`listings` 的狀態是本機同步瀏覽路徑 `keepSelfListingForViewer()` 在讀的）⇒ 補上本機鏡射。
⚠️ 那個測試檔原本「先跑 async、再跑同步版」，所以本機的 `closed` 其實是**同步版**寫的
——把 async 版的本機鏡射拿掉也照樣綠。已加一條「只跑 async 版」的測試，變異才殺得死
（這一條是變異測試逼出來的，不是為了覆蓋率）。

**檢舉列本身不需要本機鏡射**：`listing_reports` 在島上沒有任何同步讀者（唯一的讀者是這一支的
門檻計數，而它已經在 PG 上跑）——「兩個 store 都寫」的紀律要按**讀者在哪**決定，不是無條件套用。

### 46.3 測試

- `v3/test/self-listing-report-async.test.js`（**6 項全綠**）：第一筆不隱藏／第二筆達門檻
  （檢舉列、`listings` 狀態、停權時間三者在兩個 store 都相同）、重複檢舉不得寫第二列、
  自己的刊登／找不到／未登入的錯誤形狀、後台隱藏（含 404）、**停權後同步的建立路徑必須擋**
  （含對照組）、非 postgres 走同步路徑。變異 **8 條全殺**。
- `v3/test/close-self-listing-async.test.js` 追加「PG 分支自己就要把本機那一列關掉」，
  該檔變異 **4 條全殺**。
- `v3/test/self-listing-report-live-pg.test.js`（新，CI 的 PG job 會跑）：真 PG 上的門檻、
  重複檢舉、隱藏與 `hidden`／`hidden_at`、停權時間（由注入的 now 算出 2026-10-12）、後台隱藏。

## 二之負十七、2026-09-28 第四十七批：匯入生命週期（讀取／修改／取消）

### 47.1 範圍與投報率

第四十六批之後，這一包是「同一個深度模組、同一組狀態機」的三條路由：

| 路由 | 進入點 |
|---|---|
| `GET   /api/listing-imports/:id` | `getOwnedListingImportViewAsync` |
| `PATCH /api/listing-imports/:id` | `reviewListingImportAsync` |
| `POST  /api/listing-imports/:id/cancel` | `cancelListingImportAsync` |

尺規：缺口 **74 → 71**，PG **194 → 197**。
（`POST /api/listing-imports/:id/confirm` 只差 `confirmListingImport`＋`recordConsent`，
`/publish` 那一條則卡在 fixture 隔離與 `publishImportedDraftListing`——都留給後續批次。）

### 47.2 做法與四個坑

- `publicImport()` 的 **20 個鍵**抽成 `publicImportShape()` 共用；`listing` 那一格在 PG 版是
  `getSelfListingAsync()` 的 try/catch（同步版是 `safeListing()`）——「查不到就 null」的寬容度
  兩邊一致，測試也驗了「`listing_id` 指向不存在的刊登」這一條。
- **狀態機共用**：`reviewListingImport()` 只接受 `ready_for_review`；`cancelListingImport()` 對
  `confirmed` 丟 409、對 `cancelled` 回同一筆（idempotent）。這些狀態碼是**共用政策**，
  parity 抓不到「兩邊一起改壞」，所以測試直接對值下斷言。
- **取消要一起收掉草稿**（`updateImportedDraftListing`／`abandonImportedDraftListing` 都用共用的
  `DRAFT_LISTING_UPDATE_SQL`／`ABANDON_DRAFT_LISTING_SQL`），而且**兩個 store 都寫**
  （本機的同步瀏覽路徑讀 `listings`）。
- **媒體清理是 best-effort**：逐筆 try/catch（同步版也是）——「已被引用或已刪」不該讓取消失敗；
  live PG 測試另外驗「存在的媒體列真的被 soft delete」。

⚠️ 測試踩到的兩個**方法論**坑（都不是程式的錯，但會讓測試失去鑑別力）：

1. **同步對照也可能是 async**：`cancelListingImport()` 在同步版就是 `async`（要 await 媒體清理），
   所以「同步對照」若用同步的錯誤捕捉會拿到 `null`，看起來像「同步版沒有擋」。
2. **等價的變異不要硬殺**：原本想驗「沒有草稿時 `listing` 是 `null` 不是 `undefined`」，
   但 `publicImportShape(row, { listing = null } = {})` 的**預設參數**對「顯式傳 undefined」
   一樣生效 ⇒ 那個變異是**等價**的、殺不死。照紀律改成驗「PG 版根本沒去查草稿」
   （`listing: null` 永遠），這一條有鑑別力。另外 `assert.equal(undefined, null)` 會**放過**
   這類差異——已改用 `assert.strictEqual`。

### 47.3 測試

- `v3/test/listing-import-lifecycle-async.test.js`（**6 項全綠**）：讀取（公開形狀逐鍵相同、
  巢狀 `listing`、沒有草稿時 `listing` 是 `null`、別人的 403／不存在的 404）、修改
  （標題淨化、草稿一起更新、兩個 store 都寫、狀態 409、別人的 403）、取消
  （匯入與草稿都變 `cancelled`、兩個 store、idempotent、已確認 409、別人的 403）、
  非 postgres 走同步路徑。變異 **8 條全殺**。
- `v3/test/listing-import-lifecycle-live-pg.test.js`（新，CI 的 PG job 會跑）：真 PG 上的
  巢狀 listing、孤兒 `listing_id`、修改同步更新草稿、取消的媒體 soft delete、idempotent。
- ⚠️ **`syncSequence()` 的主鍵不要用預設值**：`listings` 的主鍵是 `post_id`，這一輪有三支
  live 測試各踩一次 `column "id" does not exist`。最新的一支改成**自己查主鍵**
  （`pg_index` ＋ `pg_attribute`），新寫的 live 測試請照抄。
- 🚨 **注入式 `exec` 的形狀問題第四次出現**（`memberMediaAsync`）：它的 `pgExec()`／
  `withFallbackTx()` 只吃裸陣列，餵 `{ rows, rowCount }` 時 `firstRow()` 拿到 undefined
  ⇒ `deleteMemberMediaAsync()` 靜默地變成 404、被呼叫端的 try/catch 吞掉
  ⇒ **「取消匯入時的媒體清理」在 PG 上整個沒作用**（沒有錯誤、沒有任何跡象）。
  已統一成裸陣列。四次清單：`wishExampleAsync`、`settingsKvAsync`、`siteContentAsync`＋
  `adminOverviewAsync`、`memberMediaAsync`——**新模組請在 runner 邊界就 `rowsOf()`**。

## 二之負十八、2026-09-28 第四十八批：會員同意紀錄＋匯入確認

### 48.1 範圍與投報率

第四十七批之後，這一包把「同意紀錄」整組搬完，順便把匯入流程在使用者路徑上的最後一塊
（`confirm`）補上：

| 路由 | 進入點 |
|---|---|
| `GET  /api/consents` | `listMyConsentsAsync` ＋ `pendingRequiredDocumentsAsync` |
| `POST /api/consents` | `acceptPendingDocumentsAsync` |
| `GET  /api/consents/:id/document` | `getOwnConsentDocumentAsync` |
| `POST /api/listing-imports/:id/confirm` | `confirmListingImportAsync` |

尺規：缺口 **71 → 67**，PG **197 → 201**。

### 48.2 這一包的四個坑

1. **`member_consents` 是 append-only**（DDL 有 trigger 擋 `DELETE`），而且有 **FK 到 `users`**
   ⇒ 「先刪測試資料再用同一個帳號」的做法行不通（刪不掉同意列、也刪不掉有同意列的帳號）。
   離線測試改成**每個測試配置全新的 user id**（`nextUserId()`），live 測試用全新帳號且只清匯入列。
2. **`content_documents` 有 `UNIQUE(document_type, version)`，而且 bootstrap 已經種了
   `registration_terms`／`privacy_notice`／匯入聲明** ⇒ 測試要用 v2；而且離線夾具（只鏡射 DDL）
   **沒有那些 bootstrap 列**，於是「待同意清單」兩邊會不一樣（同步版 2 份、PG 版 1 份）——
   第四十八批的夾具改成**把磁碟上的文件列原樣複製進夾具**（那才是 PG 站的真實狀態）。
3. **`db.js` 的 `recordMemberConsent` 只是原樣再匯出**（`export { recordConsentOn as recordMemberConsent }`，
   沒有綁 handle）⇒ 照包裝的簽章呼叫會把 `userId` 當成 `db`（症狀是「請先登入」）。
   SQLite 分支要直接呼叫 `memberConsents.recordConsent(sqliteHandle(), …)`。
4. 🚨 **注入式 `exec` 的形狀問題第五次出現**（`contentDocumentsAsync`）：它的呼叫端是
   `rows.map(...)`／`readById(exec, …)`（裸陣列），餵 `{ rows, rowCount }` 時
   `getEffectiveDocumentAsync()`／`getDocumentByIdAsync()` 會回 null／undefined ⇒
   呼叫端（同意紀錄、匯入確認）把它當成「目前沒有有效文件」⇒ **靜默的功能失效**
   （匯入確認會回 503、同意清單會多出根本不存在的待同意文件）。已在 runner 邊界統一成裸陣列。
   五次清單：`wishExampleAsync`、`settingsKvAsync`、`siteContentAsync`＋`adminOverviewAsync`、
   `memberMediaAsync`、`contentDocumentsAsync`。
   另外**本機鏡射的 FK 陷阱第二次出現**（`member_consents` 有 FK 到 `users`）：PG 模式的帳號
   可能在別的節點建立 ⇒ 鏡射前要先確認本機有那一列（`LOCAL_USER_SQL`），
   否則一個已經在 PG 寫成功的請求會變成 `FOREIGN KEY constraint failed` 的 500。

**語意照抄的兩條**：`hasAcceptedRequiredDocument()` 比的是 **id ＋ content_hash**（不是「曾經同意過」），
而且文件若 `requires_reacceptance`，legacy 的 `users.accepted_disclaimer_at` **不算數**；
`recordConsent()` 是 idempotent（先查再寫、回舊的那一筆）。

### 48.3 測試

- `v3/test/member-consents-async.test.js`（**7 項全綠**）：列表／idempotent／缺欄位 400／未登入 401、
  待同意（id＋雜湊、`requires_reacceptance` 時 legacy 不算、舊雜湊不算）、批次同意（缺件 400、齊件寫入）、
  歷史文件（自己的／別人的／不存在／非 published）、匯入確認（三個聲明欄位各自的 stale、寫入同意、
  狀態與所有權錯誤）、非 postgres 走同步路徑。變異 **10 條全殺**。
- `v3/test/member-consents-live-pg.test.js`（新，CI 的 PG job 會跑）：真 PG 上的待同意清單（bootstrap 文件）、
  逐一同意 ＋ idempotent、匯入聲明的 stale 409、確認成功後匯入列與 `source=import` 的同意列都落地。

## 二之負十九、2026-09-28 第四十九批：變更紀錄（data revision）＋量尺守衛改成合成來源樹

### 49.1 範圍與投報率

| 路由 | 進入點 |
|---|---|
| `GET /api/events/revision` | `currentRevisionAsync`（`MAX(id)`）／`changesSinceAsync`（`id > ? ORDER BY id ASC LIMIT ?`） |

尺規：缺口 **67 → 66**、PG **201 → 202**、MIXED **57 → 56**（SQLite 10、無直接DB 20 不變）。

**這一條的價值不在「多一條路由」，而在修掉一個靜默失效。** 寫入端
（`repository/writePath.js` 的 `bumpRevision`）**早在先前批次就已經是 driver-aware（走 PG）**，
但讀取端一直是 node-local 的 `db.js` ——
在 PG 節點上是「寫在 PG、讀在本機」，於是 `/api/events/revision` **永遠回 0**、
`changesSince` **永遠回空集合**，前端輪詢看不到任何變更，而且**不會有任何錯誤**。
這一包把讀取端搬上 PG，才讓寫讀同源。

> 這是「移植單元」量測法要挑的典型：單純看模組會覺得 `dataRevision.js` 很小、投報率低，
> 但它是**一組寫讀配對的其中一半**，缺另一半就是功能失效。

### 49.2 這一包的五個坑

1. **驗「寫讀同源」要用真的寫入器，不要自己 INSERT。** live 測試用
   `createWritePath({ driver: "postgres", pgDriver })`（正式路徑）寫三筆，再用
   `currentRevisionAsync`／`changesSinceAsync` 讀回來，並斷言讀到的等於**全表 `MAX(id)`**。
   自己 INSERT 只能證明「語句合法」，證明不了「兩端指同一個 store」。
2. **上限值不在 SQL 字串裡。** `CHANGES_SINCE_MAX = 5000` 是 `LIMIT ?` 的**參數**，
   所以「把上限改成 1」這種變異**不會改變 SQL 文字**；要殺它只能**捕獲送出的參數**
   （測試把 `exec` 收到的 params 記下來，斷言最後一個是 5000）。
3. **量尺缺陷 (2) 的守衛第七次過期。** 舊守衛拿「當時還沒移植的某條路由」當真值，
   那條路由一被移植，守衛就從「會紅」變成「量尺壞了也照樣過」。
   改成**合成來源樹**：把尺規複製到暫存目錄 → 跑一次原版、一次套上缺陷 (2) 的版本 →
   斷言 `/api/thing` 由「SQLite ＋ `loadThing`」變成「無直接DB」。
   守衛**自己造輸入**，不再依賴 repo 現況 ⇒ 不會再過期。這是後續所有尺規守衛的標準形。
4. 🚨 **「來源沒有那張表」會被鏡射成零欄表（這一包在 CI 上實際中過）。**
   `data_revision` 是**延遲建立**的表（同步版每個入口都先 `ensureDataRevisionTable(db)`，
   但沒有任何中央 migration 先建它）。第一次跑 PR #547 時，CI 的拋棄式資料庫 ＋ 全新
   `DATA_DIR` 正好是「PG 沒有那張表、本機 SQLite 也還沒有」的狀態，於是
   `ensurePgSchema()` 從空來源產生了一句 **`CREATE TABLE IF NOT EXISTS data_revision ()`**
   —— **PostgreSQL 照收**。症狀因此不是 `42P01`（找不到表），而是之後每一句都
   `42703 column "entity_type" does not exist`，非常難回推。
   - 修法一（模組）：`ensureDataRevisionStoreOnce()` 鏡射前先 `ensureDataRevisionTable(sqlite)`；
     `db.js` 的寫入端本來就是這樣（`ensureChangeLogStoreOnce`），現在兩邊一致。
   - 修法二（共用工具）：`pgSchema.ensurePgSchema()` 現在會**主動擋**來源缺表的情況
     （丟錯點名缺哪張表，且**一句 DDL 都不送**）。這是橫向修正，所有島嶼都受益。
   - 教訓：live 測試要**自己把環境還原成「還沒補建」**再跑（這裡是 `DROP TABLE`），
     否則本機因為「上次跑過已經有表」而永遠是綠的——本機第一次跑就是這樣騙過我的。
5. **`exec` 形狀／identity 這兩個老坑這一包沒有再中**：`data_revision.id` 本來就是
   `BIGINT GENERATED BY DEFAULT AS IDENTITY`（由寫入端決定、讀取端只讀不寫），
   讀取端也全程用 `rowsOf()` 正規化。老坑清單與判準見 §二之二第 6～9 條。

### 49.3 兩項順手量測（都推翻了原本的候選順位）

- **夾具隔離（fixture isolation）擋住的路由：18 條，其中「只被夾具擋住」的：0 條。**
  ⇒ 「先把夾具隔離拆掉再移植」**不是**一條獨立的投報率路徑（拆了也沒有一條路由因此可移植）。
  建議維持 **A：把 node-local 的 registry／maturity 寫入宣告成尺規例外**，
  而不是 **B：把 worker 重做成 PG** —— B 的成本落在爬蟲與佇列，收益卻只有 5 條路由。
- **`setCachedGeo` 這一叢（3 條路由）不是乾淨的移植單元。**
  它的**寫入端在 `watcher.js`／`db.js:6529` 的同步爬蟲路徑**（不是請求路徑）：
  只改請求端會變成「請求寫 PG、爬蟲寫本機」，兩份 `geo_cache` 各自演化。
  要嘛連爬蟲一起搬（成本大），要嘛先不動。**目前不動。**

### 49.4 測試與可重跑指令

- `v3/test/data-revision-async.test.js`（**6 項全綠**）：`MAX(id)` 語意、`id > since` 嚴格大於、
  由小到大、`limit` 上限（捕獲參數 ＝ 5000）、非 postgres 走同步路徑、**全新節點要建出完整欄位**
  （把本機表砍掉再 `ensure`，斷言建表語句含五個欄位）。變異 **7 條全殺**。
- `v3/test/data-revision-live-pg.test.js`（**1 項全綠**，隔離庫實跑）：用正式寫入器寫三筆 →
  PG 版讀回來、`changesSince` 只回那三筆且排序正確、`created_at` 是寫入時給的值。
  建表由 `ensureDataRevisionStoreOnce(pgDriver)` 在測試內補；**驗證時要先把 PG 的表 `DROP` 掉**
  （模擬 CI 的拋棄式資料庫），否則只會驗到「上次跑過的表還在」。前後都清 `${TOKEN}%`，可重跑。
- `v3/test/pg-import-batches.test.js`（**8 項**，其中 live 1 項在 CI 的 PG job 才跑）：
  新增「來源缺表時 `ensurePgSchema` 必須丟錯且不送任何 DDL」。
- `v3/test/route-data-map.test.js`（**12 項全綠**）＋ `MAP_MUTATIONS` **7 條全殺**。

```bash
# 離線
node --test v3/test/data-revision-async.test.js
node --test v3/test/data-revision-wiring.test.js
node --test v3/test/pg-import-batches.test.js
node v3/scripts/mutation-check.mjs v3/test/data-revision-async.test.js
node --test v3/test/route-data-map.test.js

# live PG（隔離庫 prb-repro-pg；憑證檔在共用憑證庫，值不要寫進 repo／對話）
set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
# 先 DROP 掉表，模擬 CI 的拋棄式資料庫（不然只會驗到「上次跑過的表還在」）
node -e 'const{Client}=require("pg");(async()=>{const c=new Client({connectionString:process.env.PG_LIVE_REPRO_URL});await c.connect();await c.query("DROP TABLE IF EXISTS data_revision");await c.end();})()'
node --test v3/test/data-revision-live-pg.test.js

# 量尺
node v3/scripts/route-data-map.mjs --json
```

> 🔑 **live PG 憑證怎麼來的（下一個 session 不用再找一次）**：NAS 上的 `tori` 在 `docker` 群組，
> 直接 `/usr/local/bin/docker inspect prb-repro-pg` 就拿到容器環境變數（**不需要 sudo**；
> 但 PATH 裡沒有 `docker`，要寫**全路徑**）。值已寫進
> `/home/cline/.secrets/postgres/5151-live-repro.env` 的 `PG_LIVE_REPRO_URL`，
> 並登記在 `INDEX.md` 第 10 列。`5151-agent-pg.env` 的 `PG_TEST_URL` 是**正式站**，不要拿來跑測試。

## 二之負二十、2026-09-28 第五十批：法律文案（legal copy）＋ OAuth 設定讀取

### 50.1 範圍與投報率

| 路由 | 進入點 |
|---|---|
| `GET  /api/disclaimer` | `getLegalCopyAsync` |
| `GET  /api/admin/legal-copy` | `getLegalCopyAsync` |
| `PUT  /api/admin/legal-copy` | `saveLegalCopyAsync` |
| `GET  /api/me` | 同一支（顯示「使用者同意的那一份」；這條還有其它卡點，尚未整條變 PG） |
| `GET  /auth/:provider` | `getStoredOauthAsync` ＋ `getRequiredRegistrationDocumentsAsync` |
| `GET  /auth/:provider/callback` | 同一支的 OAuth 設定讀取（其餘卡點仍在） |

尺規：缺口 **66 → 62**、PG **202 → 206**、SQLite **10 → 7**、MIXED **56 → 55**。
**一次四條路由變 PG**（三條法律文案 ＋ OAuth 起始），是近期單包最大的一格。

### 50.2 這一包的五個坑

1. 🚨 **`settings.legalCopy` 不是來源，是「種子」。**
   `legalCopyFromDocuments()`（contentDocuments.js:441）**永遠不會回 null**：文件不在時它回
   `defaultLegalCopy()` 的欄位。而 `getLegalCopy()` 的條件是
   `if (fromDocs?.disclaimer && fromDocs?.privacy)` —— 兩個欄位恆為 truthy ⇒
   **`?? settingKey("legalCopy")` 那一路只有「文件讀取丟例外」時才到得了**。
   我第一版測試照「settings 是回退」寫，**5 條紅**；改成照真實語意寫（文件優先／沒有文件回預設值／
   只有例外時才走 settings）才對。**先讀懂語意再寫期望值，不要照字面猜。**
2. 🚨 **`withFallbackTx()` 沒有把注入式 `exec` 正規化（「exec 形狀」第六次）。**
   `contentDocumentsAsync.withFallbackTx()` 直接 `runPostgres(options.exec)`，但那個模組的 PG runner
   一律吃**裸陣列**；照 `crmOutboxAsync` 慣例傳 `{ rows, rowCount }` 時，
   `nextVersionAsync()` 會把整個物件當成「沒有資料列」⇒ 版本算成 1 ⇒ 撞
   `idx_content_documents_type_version`（**由 live PG 測試抓到**，不是單元測試）。
   已修成 `runPostgres(await pgExec(options))`，並補測試（兩種形狀都要吃得下）＋變異。
   **同一個形狀問題還在其它 7 個模組**（`budgetGuardAsync`、`commsAsync`、`crmAsync`、
   `listingEnrichQueueAsync`、`listingSimilarityAsync`、`listingToolsAsync` 的 `withFallbackTx`／
   `withTransaction` 路徑）——它們的 **live/parity 測試目前都傳裸陣列**，所以還沒爆；
   要修就是同一行（`options.exec` → 該模組的 `pgExec(options)`）。**列為下一批的橫向修正。**
3. **`saveLegalCopy()` 只會為「真的改到的」那份文件建立新版本**（未變動的 `continue`）。
   live 測試第一版斷言「兩份都會被建立」也是錯的（只有 `registration_terms` 會多一版）。
4. **`/api/me` 的四行 `getLegalCopy()`** 只是同一支的順手移植（該路由還有 5 個卡點），
   但它是**必要**的：會員頁顯示的是「他同意的那一份」，讀本機在 PG 站會顯示舊版。
5. **本機鏡射**：`db.js` 的 `updateUserProfile()` → `withLegalProfile()`（`PATCH /api/profile`）
   還是同步讀本機，所以 `saveLegalCopyAsync()` 在 PG 寫完後會**順手把本機那份也寫成同一個值**
   （`saveLegalCopySync(next)`，盡力而為）。其它節點仍要等 `PATCH /api/profile` 移植才會一致。

### 50.3 測試

- `v3/test/legal-copy-async.test.js`（**8 項全綠**）：文件優先（settings 放誘餌值）、
  沒有文件回預設值、**文件讀取丟例外時才走 settings**、儲存時與同步版比對**落地的位元組**
  （settings JSON ＋ 文件 body）、SQLite 模式走同步、fail-open 讀／fail-closed 寫（有 strict 與
  沒 strict 兩種）、OAuth 與同意文件同源、wiring。變異 **6 條全殺**；
  另有一條**刻意移除的等價變異**（`withFallback()` 的 `!isPg` 檢查：這一支的 PG 分支全由
  既有島嶼函式組成，它們自己會依 driver 分派 ⇒ 拿掉之後 8 條測試一條都不紅）。
- `v3/test/legal-copy-live-pg.test.js`（**1 項全綠**，隔離庫實跑兩次）：寫進去 → 讀回來、
  settings 存原文、只有改到的那份文件多一版且 `published`、**不可變性 trigger 仍在**
  （直接 UPDATE 已發布文件必須被擋）。前後都還原（刪新列 ＋ 寫回 settings）。
- `v3/test/content-documents-async.test.js`（**16 項全綠**）：新增「注入式 exec 兩種形狀都要吃得下」；
  `CONTENTDOCS_MUTATIONS` **16 條全殺**。
- `v3/test/route-data-map.test.js`（**12 項全綠**）：原第 17 條「`/api/admin/legal-copy` 必須看得到
  SQLite 讀取」**第八次過期**（這條路由一移植就失效），改成**不動數字的版本**：
  解析交接文件的「現況」表 ＋ 尺規的 `--json` 統計，兩邊自動比對
  ⇒ 之後只會因為「改了程式沒改文件」而紅，不會再因為進度而過期。

```bash
node --test v3/test/legal-copy-async.test.js v3/test/content-documents-async.test.js v3/test/route-data-map.test.js
node v3/scripts/mutation-check.mjs v3/test/legal-copy-async.test.js
node v3/scripts/mutation-check.mjs v3/test/content-documents-async.test.js
set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
node --test v3/test/legal-copy-live-pg.test.js
```

### 50.4 這一包之後，剩下的缺口長什麼樣（62 條）

- **`ensureUser`（22 條）＋ `getUserById`（24 條）＋ `countWatched`（12 條）＋
  `expireOpenSelfListings`（10 條）**：會員／管理後台那一叢，**沒有任何 Async 版本**
  （`deleteUser`、`restoreUser`、`listUsers`、`listAdminMembers`、`adminPatchMember`、`setUserPlan`…），
  是下一塊真正的大石頭（一次可能清掉 5～8 條）。
- **`getMailTemplates`（10）／`getStoredSmtp`（6）**：寄信那一叢（`/api/change-password`、
  `/auth/:provider/callback`…），多數已有 Async 版本，屬「接線型」工作。
- **`tableColumns`（10）＋ 自主刊登配對那一叢**：`self-listings` 的 4 條。
- **Owner 未決**：`PUT /api/admin/mail`、`PUT /api/admin/oauth`（會寫節點本機 `auth.env`）、
  feedback／Ops 遞送那一叢（A：宣告尺規例外／B：worker 重做）。

## 二之負二十一、2026-09-28 第五十一批：「注入式 exec 形狀」的橫向修正

### 51.1 為什麼要單獨一批（不是為了讓測試變綠）

第五十批在 `contentDocumentsAsync` 踩到第六次「exec 形狀」：`withFallbackTx()` 直接把
`options.exec` 轉送給 runner，而那個模組的 runner 吃**裸陣列** ⇒ 呼叫端照 `crmOutboxAsync`
慣例傳 `{ rows, rowCount }` 時，`nextVersionAsync()` 把整個物件當成「沒有資料列」，
版本算成 1 ⇒ 撞 `idx_content_documents_type_version`。**只有 live PG 測試抓到。**

同一個洞在別的模組還在，只是它們的（離線與 live）測試**剛好都傳裸陣列**，所以沒爆。
這一輪把六個模組一次補上，並各留一條「還原這個洞」的變異。

### 51.2 修法（每個模組照自己的 runner 形狀正規化）

| 模組 | runner 形狀 | 修法 |
|---|---|---|
| `budgetGuardAsync` | 裸陣列 | 新增 `rowsOf()` ＋ `injectedExec()`；讀取與寫入兩條路都改 |
| `commsAsync` | 裸陣列 | `pgExec()` 內把注入的 exec 包成陣列；`withFallbackTx` 改走 `pgExec()` |
| `crmAsync` | 裸陣列 | 新增 `injectedExec()`；單一入口改掉 |
| `listingEnrichQueueAsync` | 讀取＝裸陣列、寫入＝`{rows,rowCount}` | 讀取路徑補「轉回裸陣列」（**這裡差點改錯**：第一版寫成 `normalizeResult()`，方向剛好相反） |
| `listingSimilarityAsync` | 裸陣列 | 新增 `injectedExec()` |
| `listingToolsAsync` | 裸陣列 | `pgExec()` 內正規化；`withFallbackTx` 改走 `pgExec()` |

> ⚠️ **每個模組的 runner 形狀不一定一樣**（`listingEnrichQueueAsync` 就是讀寫不同）。
> 修之前先看那個模組自己怎麼建 `exec`，不要照抄別的模組。

### 51.3 測試與變異

- 六個測試檔各加一條「注入式 exec 的形狀不影響結果（裸陣列 vs `{ rows, rowCount }`）」：
  `budget-parity`、`listing-enrich-parity`、`listing-similarity-admin-parity`、
  `comms-async`、`crm-module-async`、`listing-tools-async`（**68 項全綠**）。
  形狀測試要**比落地結果**，不是只比回傳值（`budget-parity` 走完整串 save／reserve／settle／
  release／hold；`crm-module-async` 斷言讀回的值必須是剛寫的 `"0"` 而不是預設 `true`）。
- 變異：新增 `BUDGET_MUTATIONS`(2)、`ENRICHQ_MUTATIONS`(1)、`SIMILARITY_MUTATIONS`(1)
  三套，並在既有 `COMMS_MUTATIONS`／`CRMMOD_MUTATIONS`／`LISTINGTOOLS_MUTATIONS` 各加 1 條，
  **40 條全殺**（`node v3/scripts/mutation-check.mjs <該測試檔>`）。
- live PG：`listing-tools-live-pg`（2 項）、`legal-copy-live-pg`、`member-consents-live-pg`
  都在隔離庫重跑過（改動只影響注入式分支，真 driver 的路徑不受影響，但照樣驗）。

```bash
node --test v3/test/budget-parity.test.js v3/test/listing-enrich-parity.test.js \
  v3/test/listing-similarity-admin-parity.test.js v3/test/comms-async.test.js \
  v3/test/crm-module-async.test.js v3/test/listing-tools-async.test.js
for t in budget-parity listing-enrich-parity listing-similarity-admin-parity \
         comms-async crm-module-async listing-tools-async; do
  node v3/scripts/mutation-check.mjs v3/test/$t.test.js
done
```

## 二之負二十二、2026-09-28 第五十二批：會員帳號讀寫＋登入搬上 PG

### 52.1 範圍與投報率

| 路由 | 進入點 |
|---|---|
| `POST /api/login` | `verifyLoginAsync`（PG 分支）＋ `afterMemberSessionAsync` |
| `POST /api/admin/crm/contacts` | `await actorUserIdAsync(req)` |
| `POST /api/admin/crm/contacts/:id/notes` | 同上 |
| `POST /api/admin/similarity/:id/review` | 同上 |

尺規：缺口 **62 → 58**、PG **206 → 210**、MIXED **55 → 52**、SQLite **10 → 6**。

**這一包修的是「只有剛好在本機建過帳號的人登得進去」。** 同步版 `verifyLogin()` 讀的是
節點本機的 `users`；PG 模式下別的管理節點建立的成員一律回「帳號或密碼不正確」，
而且沒有任何訊息指向真正的原因。

### 52.2 新增的共用單元（後面幾批都會用到）

`v3/src/usersAsync.js` 補上：`findUserByEmailAsync`、`ensureUserAsync`、`defaultUserIdAsync`、
`verifyUserPasswordAsync`、`setUserPasswordAsync`、`touchLastLoginAsync`、`resumeIdleIfNeededAsync`；
`v3/src/auth.js` 補上 `verifyLoginAsync`（**同一串規則**：鎖定 → 雜湊 → 未驗證擋下 → env admin 後備）；
`v3/src/idlePause.js` 補上 `applyIdleResumeAsync`（與同步版逐欄相同的雙實作，用注入回呼比對）。

### 52.3 這一包的三個坑

1. 🚨 **`defaultUserId()` 是「lazy 寫入」而不是純讀取。** 它第一次被呼叫時會在**節點本機**
   `INSERT` 一個 admin 帳號，然後回傳**本機 id**。`server.js` 的 `actorUserId(req)`（沒有 session 時）
   與 `ensureWorkCoords()` 都用它 ⇒ PG 模式下「拿本機 id 去讀 PG 設定」＝**跨店錯位**
   （同一個人在兩個 store 各有一份 id）。修法：`defaultUserIdAsync()` ＋ `actorUserIdAsync(req)`。
   **判斷這類問題的方法**：不要看函式名，要看它**有沒有寫入**——「讀起來像 getter」的名字最危險。
2. 🚨 **`settingsAsync.js` 是第七個「注入式 exec 形狀」的洞**（第五十一批只修了六個）。
   它的 `pgExec()` 直接回傳 `options.exec`，於是 `{ rows, rowCount }` 會在
   `for (const row of rows)` 炸成 `(rows || []) is not iterable`。
   這次不是推論出來的：新測試的夾具照 `crmOutboxAsync` 慣例回 `{rows, rowCount}`，當場炸。
   已修（`asArrayExec`）＋變異。**剩下還沒檢查的同型模組請用同一招驗**：夾具回 `{rows}` 跑一輪。
3. **等價變異要移除並寫理由**：「`ensureUser` 先查再寫拿掉」殺不死——`users.email` 有唯一約束，
   INSERT 撞鍵會走 catch 重讀，回傳值完全一樣。改用「INSERT 少了 `RETURNING id`」這條
   （回 0 ⇒ 呼叫端拿不到 id）。

### 52.4 測試

- `v3/test/users-async.test.js`（**13 項全綠**）：新增 8 條（findUserByEmail 大小寫、驗密碼／已刪除、
  換密碼後新舊密碼、ensureUser 冪等與 role、`defaultUserIdAsync` **必須在 PG 建帳號且本機不得多一列**、
  touchLastLogin 的 `minIntervalMs` 與 best-effort、resumeIdle 走 PG 設定、sqlite 模式不碰 exec）。
  變異 **10 條全殺**。
- `v3/test/auth-member-async.test.js`（**6 項全綠**）：PG 才有的帳號登得進去（同步版會說密碼錯誤）、
  密碼錯誤 401、未驗證 403、env admin 後備、sqlite 模式走同步版、wiring。變異 **3 條全殺**。
- `v3/test/idle-verify.test.js`（**6 項全綠**）：`applyIdleResumeAsync` 與同步版在三種情境下逐欄相同。
  變異 **2 條全殺**。
- `v3/test/member-auth-live-pg.test.js`（**1 項全綠**，隔離庫連跑兩次）：只在 PG 建帳號（本機確認沒有）、
  大小寫讀回、冪等、換密碼後新舊密碼、`touchLastLogin` 的時間與間隔守衛。

> 📌 **下一批（第五十三批）**：`GET /verify-email` 與 `POST /api/forgot-password`（各 11／3 個卡點）。
> 兩者都已具備大半前置（`findUserByEmailAsync`、`setUserPasswordAsync`、`touchLastLoginAsync`、
> `resumeIdleIfNeededAsync`、`activateSearchProfileAsync`、`getMailTemplatesAsync`、`getStoredSmtpAsync`），
> 還缺：`confirmVerifyTokenAsync`（emailVerify）、`requestTempPasswordAsync`（forgotPassword，
> 該函式已經是 async 且可注入，只需換掉 `findUser`／`setPassword`／`restoreHash`／`compose`）、
> `recordShareEventAsync`、`attributeShareAsync`。

## 二之負二十三、2026-09-28 第五十三批：註冊確認／忘記密碼／分享事件搬上 PG

### 53.1 範圍與投報率

| 路由 | 進入點 |
|---|---|
| `GET  /verify-email` | `confirmVerifyTokenAsync` ＋ `afterMemberSessionAsync` ＋ `attributeShareAsync` ＋ `queueSystemMailAsync` |
| `POST /api/forgot-password` | `requestTempPasswordAsync` |

尺規：缺口 **58 → 56**、PG **210 → 212**、SQLite **6 → 4**（MIXED 52 不變）。

這一包讓**註冊流程整條**（登入 → 點信裡的連結 → 忘記密碼）都不再依賴節點本機的 `users`。
在此之前，別的管理節點建立的新帳號點連結會拿到「找不到這個開通連結」——使用者看到的是
「連結壞了」，真正的原因是讀錯 store。

### 53.2 這一包的三個坑

1. 🚨 **`requestTempPassword()` 是 async，但它對注入的回呼**沒有 `await`**。**
   它寫 `const user = findUser(key);`，而 PG 島嶼傳進去的是 async 版本 ⇒ `user` 是 Promise
   ⇒ `!user?.id` 成立 ⇒ **靜默地當成「查無此人」**（信不寄、密碼不改，卻回成功訊息）。
   `forgotPassword.js` 已補上 `await findUser/setPassword/restoreHash`（同步回呼 await 也安全）。
   **通則**：移植一個「已經是 async、且用注入回呼」的函式時，**逐一確認每個回呼都有 await**，
   不要看到 `async` 就假設它準備好了。
2. **同步核心不能餵 async 假 handle。** 分享事件第一版想「注入一個 async handle 給同步版
   `recordShareEvent()`」，但同步版用 `db.prepare(...).get()`（不 await）⇒ 拿到 Promise ⇒
   `row?.public_token` 是 undefined ⇒ 判成「找不到分享」，又是一種靜默失效。
   正解是把 **async 版寫在同步模組裡**（`rentalShareGrowth.recordShareEventAsync()`），
   私有 helper（bot 判斷、訪客雜湊、速率限制、事件類型政策）與同步版**共用同一份**。
3. **等價變異**：`ensureUser` 的「先查再寫拿掉」殺不死（`users.email` 有唯一約束，INSERT 撞鍵
   會走 catch 重讀）——已移除並改寫理由；換成「INSERT 少了 `RETURNING id`」。

### 53.3 測試

- `v3/test/email-verify-async.test.js`（**3 項全綠**）：成功（旗標落地 ＋ 與同步版逐欄相同）、
  用過 409／已驗證 409／過期 410／找不到 404（三種錯誤的 status／code／message 都與同步版比對）、
  sqlite 模式走同步版。變異 **4 條全殺**。
- `v3/test/forgot-password-async.test.js`（**5 項全綠**）：寄信成功（臨時密碼寫進 PG、本機不得被動到）、
  沒設定 SMTP 503 且不得先改密碼、寄信失敗要把**舊雜湊**寫回去（與同步版比對訊息）、
  冷卻 429、查無此人不洩漏帳號存在。變異 **3 條全殺**。
- `v3/test/share-events-async.test.js`（**4 項全綠**）：view 去重／bot 標記（含落地列逐欄比對）、
  signup 轉換（落地列 ＋ analytics 兩邊相同）、政策守衛（偽造 token／公開來源記轉換／未知事件類型
  的 status／code／message 都要與同步版相同）、sqlite 模式不碰 exec。變異 **4 條全殺**。
- `v3/test/member-auth-live-pg.test.js`（**2 項全綠**）：新增「註冊確認 token 流程（成功 → 第二次 409）
  ＋ 忘記密碼在沒有 SMTP 的隔離庫必須 503 且不得改雜湊」。

## 二之負二十四、2026-09-28 第五十四批：後台會員管理（列表／停權／復原／改方案／自我刪除）

### 54.1 範圍與投報率

| 路由 | 進入點 |
|---|---|
| `GET   /api/admin/members` | `listAdminMembersAsync` |
| `POST  /api/admin/members/:id/delete` | `adminDeleteMemberAsync` ＋ `queueSystemMailAsync` |
| `POST  /api/admin/members/:id/restore` | `adminRestoreMemberAsync` |
| `PATCH /api/admin/members/:id` | `adminPatchMemberAsync` ＋ `queueSystemMailAsync` |
| `POST  /api/account/delete` | `deleteOwnAccountAsync` |

尺規：缺口 **56 → 51**、PG **212 → 217**、MIXED **52 → 47**（SQLite 4 不變）。

**這一包修的是後台的「假 0」**：算出一列會員要三份資料——`users`、該會員的 `settings`
（通知間隔）、`user_listing_flags` ＋ `listings`（關注數／刊登數）。同步版三份都讀節點本機
⇒ PG 模式下後台對別的節點會員顯示「關注 0 筆、刊登 0 筆、間隔是預設值」，而且不會報錯。

### 54.2 新增的共用單元

- `v3/src/adminMemberView.js`：**純**投影（前端契約）。原本藏在 `db.js` 的私有函式裡，
  抽出來之後同步版與 PG 版共用同一份欄位定義（`db.js` 只負責把三個值準備好）。
- `v3/src/watchLimitsAsync.js`：`countWatchedAsync`（**12 條路由**的共用卡點）。
  額度的定義只有一句 SQL（`WATCHED_COUNT_SQL`），PG 路徑靠 `toPostgresSql()` 把
  `IFNULL` 翻成 `COALESCE`——**不要自己再抄一份**（列表頁的 `watchedTotal` 用的就是同一句）。
- `v3/src/usersAsync.js`：`listUsersAsync`／`setUserPlanAsync`／`deleteUserAsync`／`restoreUserAsync`。
- `v3/src/members.js`：把刪除／還原的守衛抽成 `assertMemberDeletable()`／`assertMemberRestorable()`
  （**訊息是使用者看得到的，只能有一份**）。
- `v3/src/adminMembersAsync.js`：`listAdminMembersAsync`／`adminDeleteMemberAsync`／
  `adminRestoreMemberAsync`／`deleteOwnAccountAsync`／`adminPatchMemberAsync`／
  `countOpenSelfListingsAsync`／`adminMemberViewAsync`。

### 54.3 這一包的三個坑

1. 🚨 **「exec 形狀」第三次咬人——這次是模組自己的約定不一致。**
   `watchLimitsAsync` 的 runner 回**裸陣列**，但 callback 一度寫成 `(...).rows`
   ⇒ 永遠回 0 ⇒ **額度算成 0 筆，會員可以無限加入關注**（不報錯）。
   是靠「同一支函式在 admin-members 的列表測試裡被比對」才看出來的。
   **規則**：新模組的 runner 約定要在檔頭寫清楚，callback 立刻用同一種形狀。
2. **等價變異**：「改方案時不重設 `intervalMinutes`」（寫 `undefined`）殺不死——讀取端在
   `intervalAdminSet === false` 時就用方案預設值算，寫不寫那個數字投影都一樣。
   已移除並改寫理由；換成「把 `intervalAdminSet` 設成 `true`」（手動間隔會蓋掉方案預設）。
3. **`listings` 是寬表**：測試夾具要用 `PRAGMA table_info` 自動補齊 NOT NULL 欄位
   （`url`／`first_seen_at`／`last_seen_at`…），不要一個個猜欄位名。

### 54.4 測試

- `v3/test/admin-members-async.test.js`（**6 項全綠**）：列表（PG 才有的會員要算得出
  關注數／刊登數／間隔；已離線的不佔額度；過期的不算刊登）、刪除／復原（管理員不可刪、
  已刪除不能再刪、未刪除不能復原、不存在 404、PG 的列真的被改）、自我刪除（`deleted_by=self`）、
  改方案（方案落地、間隔依方案重設、手動指定要標 `adminSet`）、sqlite 模式走同步版、
  投影形狀。變異 **8 條全殺**。
- `v3/test/watch-limits-async.test.js`（**3 項全綠**）：PG 與同步版相同（已確認離線的不佔額度、
  沒關注的不算、uid 0 早退）、**注入式 exec 兩種形狀都要吃得下**、sqlite 模式不碰 exec。
  變異 **3 條全殺**。
- `v3/test/member-auth-live-pg.test.js`（**3 項全綠**，隔離庫連跑兩次）：新增「後台列表要算得出
  PG 的關注數／刊登數／通知間隔，停權與改方案也落地」。
- 另外修掉兩個**過期的接線守衛**（`admin-members.test.js`／`system-mail.test.js`
  斷言 `queueSystemMail("account_deleted")` 等同步接線，條目改走 `queueSystemMailAsync` 後就會紅）。

## 二之二、2026-09-27 session 收尾：現況、下一步、交接紀律

**這一段是給下一個 session 的第一站。** 前面的第一～二十批是逐批紀錄，這裡是「現在在哪」。

### 現況（可重跑）

```
node v3/scripts/route-data-map.mjs
```

| 判定 | 起點 | **現在（2026-09-28 第五十四批）** |
|---|---:|---:|
| SQLite | 95 | **4** |
| MIXED | — | **47** |
| 無直接DB | — | **20** |
| PG | 22 | **217** |
| **缺口（SQLite＋MIXED）** | — | **51** |

> 📌 這張表現在**由測試守住**（`v3/test/route-data-map.test.js` 的最後一條會解析它與尺規的
> `--json` 統計來比對）⇒ 之後只要跑了尺規，就要同步改這裡，否則 CI 會紅。

> 🐌 **已知的 CI flake（2026-09-28 實測）**：`v3/test/commute-route-live.test.js` 的
> 「cursor walks past the old 2000-row candidate cap」會間歇紅。機制是它的 `runIsolated()`
> 給子程序 **30 秒**上限（2105 列 ＋ 路線計算），超時時 `result.status` 是 `null`
> ⇒ 斷言 `null !== 0`。本機與 CI 都會中，重跑就好（`gh run rerun <id> --failed`）；
> 不是程式缺陷，但**看到它紅時不要往程式面找**。
>
> ⚠️ **這一節的「下一步」與「障礙」清單寫在 2026-09-27，部分已經過期**：
> - 「session 解析是步驟 3 的前置條件」**已經做完**（Owner 方案 A：`readSessionAsync()`
>   ＋ `resolveSession()` 中介層每請求解析一次，`readSession()` 改讀 `req` 上的快取）。
>   113 個呼叫點沒有改，但每請求只查一次 `users`。**這一項不必再重追。**
> - 障礙清單裡的 `deleteWishExample`／`getWishExample`／`saveWishConditions`／
>   `getAdminAdsSettings`／`applyBrandUpload`／`getAdminBroadcastsSettings`／
>   `remoteCsAcceptControl` **都已經完成**（實跑尺規：這些函式已經不在任何缺口路由的卡點裡）。
> - 障礙清單第 1 項（`ensureUser` 3 條）**仍然成立**；新增的 2026-09-28 進度看「二之一」。
> - **量測要改用「移植單元」而不是「模組」**：舊分組法會讓每一包的投報率看起來都是 0，
>   因為同一個工作單元通常橫跨 `X`（實作模組）與 `XFor`（`db.js` 包裝）兩個模組。
>   做法與量測表見 40.1。

PR #529（`fix/route-map-driver-aware`，34 個 commit）**CI 全綠、未部署**；
Production `{"ok":true,"version":"3.57"}`、identity 序列 75/75 健康。**部署要 Owner 明確批准（§8.2）。**

### 下一步的優先順序（依「投報率 ÷ 風險」，不是依模組大小）

1. **`demand.js`（約 10 條）**——剩下最大的單一群。⚠️ **尺規的兩條守衛都指向它**
   （`GET /api/wish-rooms/example` ← `getWishExample`，以及性質清單裡的 `addDemandReply`）。
   移植時要換標的，**換之前把缺陷套回去實測**（見下方紀律 3）。
2. **單一卡點群**（下面這些各自都只差一個函式）：
   `ensureUser`（3 條：`POST /api/admin/crm/contacts`、`…/contacts/:id/notes`、
   `POST /api/admin/similarity/:id/review`）、`getWishExample`（1）、`deleteWishExample`（1）、
   `getWishConditions`／`saveWishConditions`（2）、`getAdminAdsSettings`／`applyBrandUpload`／
   `getAdminBroadcastsSettings`（3）、`getRentalMarketplaceFlags`（1）、`remoteCsAcceptControl`（1）、
   `saveAdminMailSettings`／`saveAdminOauthSettings`（2，**這兩個同時寫節點本機 `auth.env`**，
   要另外決定怎麼處理）。
3. **`getLegalCopy`（3 條）**——**先讀第十九批**，那裡有我弄錯的心智模型與沒查到底的 `version` 疑點。
4. **`POST /api/media`（上傳）**——`saveMemberMedia()` 的交易橫跨影像處理與 R2 上傳，
   需要重新設計交易邊界，是獨立一批。
6. **`/api/demand/aggregate`、`/api/demand/exposure`、`/api/public/wish-room/:id`、
   `POST /api/public/unsubscribe/:token`** 屬於 demand.js 那一群。
7. **剩下的登入／註冊／OAuth 六條**（`/api/login`、`/api/register`、`/verify-email`、
   `/auth/:provider`、`/auth/:provider/callback`、`/api/forgot-password`）——
   這一批**風險最高**（動到登入），而且與 §13 的 session 解析高度耦合，
   建議等前面的都清完、而且 Owner 有時間盯的時候再做。

### 下一步的**實際障礙**（先看這裡，省下摸索時間）

1. **`ensureUser`（3 條）不是「接一個函式」而已。** 尺規看到的 `ensureUser` 是
   `personalFlags.js:23`（吃 `conn`、回 user id），但 `server.js` **沒有直接引用它**——
   三條路由（`POST /api/admin/crm/contacts`、`…/contacts/:id/notes`、
   `POST /api/admin/similarity/:id/review`）是**經過別的模組**呼叫的。
   **動它之前要先追出呼叫端**（`grep -rn "ensureUser" v3/src/*.js` 是起點），
   否則會改了函式卻沒接到路由、尺規不動。

   **已追到的線索（2026-09-27）**：三條路由都只差 `ensureUser` 這一個卡點，而
   `POST /api/admin/crm/contacts` 的 handler 只做
   `await createCrmContact(...)` → `db.js:1967` → `createContactAsync()`（`crmAsync.js`）。
   但 **`crmAsync.js` 裡完全沒有 `ensureUser` 這個字**——所以那是**再下一層**的
   （`createContactAsync` 呼叫的某個共用模組，或 `db.js` 自己的 `ensureUser`）。
   也就是說要往 `createContactAsync` 的呼叫鏈再追一層才會看到實際呼叫點；
   這是為什麼上一輪沒有直接動它。
2. **`saveAdminMailSettings`／`saveAdminOauthSettings` 需要 Owner 決定。** 它們除了寫
   settings，還會寫**節點本機的 `auth.env`**。PG 之後「每個節點都有自己的檔案」與
   「設定應該只有一份」直接衝突——這是政策問題，不是技術問題：
   (a) 只寫 PG、`auth.env` 改成啟動時從 PG 產生？(b) 兩個都寫（節點間仍可能不一致）？
   (c) 這兩個端點維持同步、明確標成「節點本機設定」？
3. **`saveWishExample`（`PUT /api/wish-rooms/example`）不是廉價目標**（2026-09-27 查證）：
   它呼叫 `normalizeWishInput(db, uid, input)`——**吃 handle 且會查許願目錄**，
   所以要先移植那一支。同一條路由的另一個卡點 `saveWishExampleFor` 只是 db.js 的包裝。
   已移植的是同表的 `getWishExample`／`deleteWishExample`（第二十八批）。
4. **`hideSelfListing`（`POST /api/admin/self-listings/:id/hide`）的障礙已查明**（2026-09-27 嘗試後回退）：
   它除了把刊登標成 hidden，還要**停權刊登者**（`banSelfPublisher` → `UPDATE users SET self_ban_until=?`）。
   我原本以為可以抽一個純時間函式共用，**但 `selfListings.js` 已經有 `selfBanUntil(db, userId)`**
   ——**吃 db、簽章不同**，不是純函式。所以要嘛匯出 `SELF_BAN_DAYS` ＋ `nowMs` 自己算，
   要嘛把 `banSelfPublisher` 做成 driver-aware。**不要照「抽純函式」那條路走**（會撞名）。
   同一個模組的 `closeSelfListing` 已在第二十九批完成，可以照它的形狀（含 hook 仍用本機 handle 的處置）。
5. **`getLegalCopy`（3 條）先讀第十九批**：那裡有我弄錯的心智模型（`legalCopyFromDocuments`
   會自己補預設值，所以 settings 那段是很少走到的備援）與一個沒查到底的 `version` 疑點。

   **第二次嘗試（2026-09-27）仍然回退，但縮小了範圍。** 照第十九批的規格重寫後，
   parity 在「兩份文件都到齊」這一條就紅了，而且**差異是 PG 側多了一段**
   （`'文件版免責\n\n超過約兩個月沒有登入，系統會暫停主動向外抓取與通知…'`），
   同步側只有 `'文件版免責'`。那段文字看起來是 `ensureIdleLegalClauses()` 補上的
   ——但**「為什麼只有 PG 這條路補」還沒查清**。
   → 下一次要碰這個函式時，**先把兩邊的 `disclaimer` 值完整印出來比對來源**
   （`legalCopyFromDocuments()` 的 `terms.body`、`defaultLegalCopy().disclaimer`、
   `seedDefaultDocuments()` 的 `ensureIdleLegalClauses()` 三者誰先誰後），
   不要再一次從「照規格重寫」開始。

### 🚨 尺規的**偽陽性**（動手前先看這一條，可以省下一整批白工）

`route-data-map.mjs` 把 `PUT /api/admin/providers/site-budget` 列成「只剩 `saveSiteBudget`
一個卡點」，但**那條路由其實已經是 PG 能力**，程式碼路徑是：

```
server.js  await saveAdminSiteBudget(req.body || {})
  → db.js:1067  saveAdminSiteBudget() = budgetStore({ sqliteDb: db, options }).saveSiteBudget(partial)
  → budgetStore.js:47  const driver = options.driver || resolveDbDriver();
                       if (driver === "postgres") return postgresBudgetStore(...)
  → budgetStore.js:47（PG 分支）  saveSiteBudget: (input) => pg.saveSiteBudgetAsync(...)
```

也就是說它走的是**與 `budgetGuardAsync.js` 同一條島嶼**，只是中間隔了 `budgetStore()`
這一層 facade。

**尺規為什麼還是報它**：`resolveNode()` 的「driver-aware 就不算 SQLite」規則是看**該函式
自己的本文**有沒有 `resolveDbDriver(`。`saveAdminSiteBudget` 的本文只有 `budgetStore(...)`，
`resolveDbDriver()` 在 `budgetStore` 裡面——於是那條邊照樣把同步的 `saveSiteBudget` 算進來。
（尺規的缺陷 (4) 修過一次「`budgetStore()` 委派的函式其實已經是 driver-aware」，
看起來沒有涵蓋 `saveAdminSiteBudget` 這一個。）

**可重跑的證據**（注入式 `exec` 只有 PG 分支會用到）：

```js
const calls = [];
const exec = async (sql, params = []) => { calls.push(sql); return []; };
await saveAdminSiteBudget({ monthly_limit_twd: 1234 }, { driver: "postgres", exec, strict: true }).catch(() => {});
// 實測 calls.length === 2，第一句是 `SELECT value FROM settings WHERE key = ?`
// ⇒ PG 分支確實被走到（沒有回退 SQLite）。
```

**根因（2026-09-27 實驗確認）**：尺規的 `callsIn` 是 `\bname\s*\(`，所以
`budgetStore({...}).saveSiteBudget(partial)` 裡的 **`.saveSiteBudget(` 被當成「呼叫了匯入的
`saveSiteBudget`」**。加上 lookbehind（名字前面不能接 `.`）可以修掉這一條，但**實測會讓 12 條
路由失去 sqlite 條目**（例如 `POST /api/admin/same-house/reconcile` 一次掉 12 個函式，
`collectCommuteSettings`、`getRentalNotifyPrefs`、`getSystemCrawl`… 都被吃掉）——
那是**破壞了正確的歸屬**，不是修正。所以**該實驗已回退**，尺規維持原狀。
要修的話得先分清楚「方法呼叫」與「同名匯入」在每個現場是哪一種，不能只加 lookbehind。

**⚠️ 只有這一條是偽陽性——上一輪實驗顯示的另外兩條是「真卡點」（2026-09-27 逐條查證）**：

| 路由 | 卡點 | 判定 |
|---|---|---|
| `PUT /api/admin/providers/site-budget` | `saveSiteBudget` | **偽陽性**（走 `budgetStore()` → `saveSiteBudgetAsync`，已用注入式 exec 證實） |
| `GET /api/admin/same-house/reconcile` | `sameHouseBackfillStatus` | **真卡點**——`db.js:7851` 用 `settingKey(...)` 讀**本機 SQLite** 的兩個鍵，沒有任何 driver 判斷 |
| `POST /api/admin/ops-delivery/compact-outbox` | `compactOpsSentOutboxPayloads` | **真卡點**——`db.js:2041 compactOpsOutbox()` = `compactLocalOutbox(db, opts)`，吃 handle |

也就是說：**缺口 120 只被高報 1 條**，不是 3 條。上一輪那個 lookbehind 實驗「讓 3 條判定改變」被誤讀成
「可能都是偽陽性」——實際上另外兩條的卡點真的存在，只是被 lookbehind 錯誤地吃掉了
（這也再一次佐證那個實驗是破壞而非修正）。

**下一次要碰這裡時**：先確認是不是同一個偽陽性類型（**凡是經過 `budgetStore()` 的都先查**），
要嘛把 `saveAdminSiteBudget` 這種「只委派給 driver-aware facade」的函式補進尺規規則
（並依既有紀律留下新舊基準與單調性證據），要嘛就承認那條路由不需要移植。

### 交接紀律（這一輪累積下來的，全部都有實例）

1. **動手前先確認 PG 有沒有那個約束。** `CREATE TABLE` 裡的 `UNIQUE(...)`（表約束）與欄位
   `UNIQUE` 都是**隱式索引**，`pgSchema` 鏡射不到。已中四次：`listing_contact_profile` 的
   帳號聯絡人、`media_tags` 的 `(user_id,name)`、comms 的複合主鍵、`push_subscriptions.endpoint`。
   → 動 `ON CONFLICT` 之前先確認，否則就是 `42P10`。
2. **方言陷阱（已中過的）**：`IFNULL`、`COLLATE NOCASE`、`LIMIT -1`、純量 `MIN(a,b)`、
   SQLite 的 `TRIGGER … RAISE(ABORT)`／`IS NOT OLD.x`、**`pgDriver.query()` 不翻譯 `?`**
   （要顯式 `toPostgresSql`）。夾具一律要**主動拒絕**這些，否則寫錯照樣過關。
3. **換守衛標的時，把缺陷套回去實測。** 「看起來是那一類」不算數（我為此白換兩次）。
4. **變異不要用「刪掉宣告」**：模組載入失敗會讓工具抓不到測試名 ⇒ 假 SURVIVED。
   改成同位置的無效實作（`SELECT 1`、`return null`）。
5. **斷言不要 `includes(某常數)`**：常數被移除時會變 `undefined`，那種斷言**恆真**。
6. **`expect` 比對的是測試名稱**，不是斷言訊息。改測試名要同步改 `expect`（已中兩次）。
7. **parity 測試不要把「同步版」當無害的對照組**：它自己也會做副作用（hydrate 快取、
   寫快照），會把受測分支的缺失蓋掉。**斷言要在對照組動手之前做。**
8. **測試資料要刻意造出「只有那條分支才會走到」的形狀**：沒有重複資料就測不到清重複、
   只有一筆就測不到「只刪指定那一筆」、空集合的 `deepEqual` 等於沒驗。
   **落點比對要加「兩邊都是 0 列時沒有鑑別力」的守衛**（這一輪它救我好幾次）。
9. **live PG 測試不可省**：離線夾具證明不了「送進 PG 的語句合法／真的生效」。
   隔離環境是 NAS 的 `prb-repro-pg`（`192.168.0.220:15434/repro`），
   `PG_LIVE_REPRO_URL` 有允許清單，**正式庫 `5151_shadow` 一律拒絕**。
   寫「驗 bootstrap 補建」的 live 測試時，**要自己把環境還原成「還沒補建」的狀態**（否則重跑會紅）。
10. **量尺有缺陷就修，但要留下基準**：每一版尺規的 `--json` 輸出都留著，
    並驗證**單調性**（加邊只能增加、不能減少）。
11. **`settingsKvAsync` 的 JSON 語意不適用於「原生 SQL 讀者」。** `setSiteSettingAsync` 會
    `JSON.stringify`，把 `"1"` 寫成 `"\"1\""`；`remote-cs` 那個鍵的讀者
    （`siteCommandApply.js` 的 `isRemoteCsStopped`）是直接比對**原始文字**，
    所以會變成「開關永遠失效且沒有任何錯誤」。要動某個 settings 鍵之前，
    **先確認有誰用原生 SQL 讀它**。
12. **fallback 會掩蓋錯誤。** 測「失敗路徑」（壞資料、例外）時一定要用 `strict: true`：
    預設的讀取是 fail-open，例外會被接住並**回退到另一份資料**，若那份資料剛好算出同一個
    結果，變異就永遠殺不死。實例：許願房範例的「payload 壞掉直接丟錯」變異，
    因為回退到磁碟上同一筆資料而存活；補上 strict 斷言後才被殺掉。
13. **parity 可以過，而絕對斷言才是鑑別力所在。** `applyBrandUpload` 那批我兩個絕對斷言
    都寫錯（url 要用本地 `/brand/…` 才過白名單、`mark` 不存在 `markUrl` 欄位），
    但 parity 全程是綠的——因為錯的是**我的期望值**，不是程式。
    兩種斷言都要留：parity 抓移植漂移，絕對值抓「兩邊一起錯」。

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
