# PG_NO_SQLITE_OPEN 開閘：HTTP/API 表面爆點與靜默缺失採齊

- 產出時間：2026-10-09（晚間）
- 對象：`v3/src/server.js` 的 HTTP/API 表面（正式站使用者按得到的東西），**不是**抓取輪次。
- 方法：casa-nas 既有容器 `5151-crawl-sandbox` 內 `docker exec` 起臨時 web 行程
  （`APP_ROLE=web`、`PORT=5199`、`HOST=127.0.0.1`、`DB_DRIVER=postgres` 指向隔離庫 `crawl_sandbox`、
  `PG_SQLITE_FALLBACK=strict`、`DATA_DIR` 指向空 SQLite），A 遍（閘關）／B 遍（閘開 `PG_NO_SQLITE_OPEN=1`）
  各打同一批 GET 端點，逐端點 diff。
- **採齊時的 code 版本**：容器 `/app` 與 master `31731fc` 逐 byte 相同（sha256 一致）。採齊進行中
  master 前進到 `45f10dc`（#674 budget 可用 handle 判準，已 merge）。#674 動的是
  `createNoOpenSqliteProxy` 的 marker、`budgetGuardAsync`、`executeWithProvider`，**與本表所有爆點無關**；
  下列行號以 master `45f10dc` 為準。

## 0. 開閘後的第一個事實：web 行程根本起不來（兩個啟動爆點）

開閘後 `node src/server.js` 不會成功監聽，會先死在**模組載入**，修掉後又死在**listen 回呼**。
所以「正式站開閘」目前不是「上線看哪裡 500」，而是「上線即 crash loop」。這兩個要先修。

---

## ① 爆點表（去重後 4 個同步 SQLite 存取點 + 已知 1 個待辦）

錯誤原文統一格式（去 `/app/src`／`/data/src2` 前綴）：
`business SQLite is closed (PG_NO_SQLITE_OPEN=1, DB_DRIVER=postgres): synchronous SQLite handle access "…" reached at …`

| # | 檔:行（master 45f10dc） | 函式 | 存取 | 觸發端點／階段 | 錯誤原文（節錄） |
|---|---|---|---|---|---|
| 1 | `v3/src/supportSchema.js:4` | `ensureSupportSchema` | `db.exec` | **啟動**（`server.js:705` → `initSupportDomain` → `support.js:168`） | `…handle access "exec" reached at ensureSupportSchema (…/supportSchema.js:4:6)` |
| 2 | `v3/src/db.js:973` | `settingKey` | `db.prepare` | **啟動**（`server.js:5450` listen 回呼 → `getStoredSmtp` → `db.js:1235`） | `…handle access "prepare" reached at settingKey (…/db.js:973:18)` |
| 3 | `v3/src/pgSchema.js:48` | `tableInfo` | `db.prepare(PRAGMA table_info(...))` | `/api/demand`、`/api/wish-rooms`、`/api/demand/:id`、`/api/wish-rooms/:id`、`/api/public/wish-room/:id`（5 支，全 → 400） | `…handle access "prepare" reached at tableInfo (…/pgSchema.js:48:13)` |
| 4 | `v3/src/db.js:3781` | `getListing` | `db.prepare(SELECT * FROM listings WHERE post_id = ?)` | `/api/public/listings/:id/detail`（400）、`/api/public/listings/:id/similar`（空陣列）、`/p/:id`（404）、已瀏覽標記（stderr 吞掉） | `…handle access "prepare" reached at getListing (…/db.js:3781:18)` |
| 5 | `v3/src/db.js:4413` | `storedSearchKeys` | `db.prepare` | **抓取路徑已知**（`listingCountForSearch` `db.js:8725` ← `watcher.js:1108`），非 HTTP 表面，列為待辦 | `…handle access "prepare" reached at storedSearchKeys (…/db.js:4413:6)` |

### 呼叫鏈（寫進報告，讓 PR 直接照抄）

1. **啟動 ①**：`server.js:705 initSupportDomain(db)` → `support.js:168` → `ensureSupportSchema(db)`（`supportSchema.js:4` `db.exec` DDL）。`support_*` 表在 PG 都已存在（`support_page_config`／`support_operating_cost`／`support_tier`／`support_provider`／`support_transaction`／`support_sponsor`／`support_cta_rule`／`support_prompt_state`／`support_event`），同步 DDL 是冗餘的啟動副作用。
   - 同函式內還有 `seedIfEmpty`（`support.js:114`）與 `remapStoredLegacyProductNames`（`support.js:173` `db.prepare UPDATE`）兩個同步讀寫，一併要解耦。
2. **啟動 ②**：`server.js:5450 if (!mailConfigured(getStoredSmtp()))` → `getStoredSmtp`（`db.js:1235`）→ `settingKey`（`db.js:973` `db.prepare`）。`register` 路徑已用 `getStoredSmtpAsync()`（`server.js:1498`），這裡是殘留的同步版。
3. **demand/wish-rooms 家族**：`/api/demand`、`/api/wish-rooms` 都進 `wishListPayload(req)` → `demandAsync.js:151 ensurePgSchema(pgDriver, sqliteHandle(), { tables: DEMAND_TABLES })` → `tableInfo`（`pgSchema.js:48`）讀 SQLite schema 來鏡射 PG。PG 的 `demand_posts` 等表早已存在，`ensurePgSchema` 對已存在表仍會先讀 SQLite schema（不是真的 no-op）。
4. **detail/similar/p/已瀏覽**：`listingDetailAsync.js:66-69` 的 fail-open catch 在 PG 讀取或裝飾失敗時 `return getListing(postId, …)`（同步版 `db.js:3780`），開閘時該同步 `db.prepare` 直接拋。detail 把錯誤帶成 400、similar 吞成空、`/p/:id` 吞成 404、已瀏覽標記吞進 stderr。

---

## ② 靜默缺失表（A 遍 → B 遍，不噴 500 卻少東西）

| 端點 | A 遍 | B 遍 | 少了什麼 | 原因 |
|---|---|---|---|---|
| `/api/public/listings/:id/similar` | `items: 4 筆` | `items: []`（HTTP 200 不變） | 相似物件整段消失，前端顯示「無相似」 | `similarPublicListingsAsync` 內同步 `getListing` 拋錯被 catch（`server.js:4062-4065` 回空） |
| `/p/:id`（公開分享頁，LINE/FB 爬蟲抓 OG） | 200 | **404** | 分享頁 OG 變成「找不到物件」，預覽失效 | `getListingAsync` 拋錯被 `server.js:4094` catch，`status` 停在 404 |
| 已瀏覽標記（detail 頁副作用） | 寫入 | stderr `標記已瀏覽失敗：… getListing` | `viewed` 標記不再落地 | 同步 `getListing` 拋錯被吞 |

> 其餘 130 支 GET 端點 A/B 兩遍 HTTP code 與回應形狀一致（含 `/api/listings`、`/api/public/listings`、
> `/api/self-listings`、`/api/rental-notify/prefs`、`/api/wish-offers/*`、`/api/admin/*` 等）。
> 注意：`crawl_sandbox` 的 `demand_posts`／`wish_room_example`／`wish_offers`／`user_match_votes`／`user_match_signals`
> 都是 **0 列**，所以這些表「靜默變空」的訊號在沙盒抓不到（沙盒本就用空 SQLite，節點 SQLite 也是孤島空檔）；
> 正式站那 3 個節點的 SQLite 有真資料，開閘後可能浮現更多「少資料」的端點，本表是下限。

---

## ③ 大批修正分組（同一個 PR 能改完的群組）

### 組 A（與本次採齊無關、已確定要做，**第一優先**）

- **A① 搜尋鍵 projection**：`storedSearchKeys`（`db.js:4413`）／`listingCountForSearch`（`db.js:8725`，呼叫端 `watcher.js:1108`）→ 改 PG 原生。呼叫鏈與「結果被 `searchReports[].baseline` 消費」上一包已查證，**不是死碼**。驗收：`crawl_sandbox` 開閘跑 `SANDBOX_ROUNDS=3`，不再出現 `storedSearchKeys` 爆點，且 `searchReports[].baseline` 有值。
- **A② `schema_migrations` 差 6 列**：PG 5 列 vs SQLite 11 列。**逐條查**（不是只比行數）：PG 有的是 version 1–5（`personal_search_schema`、`demand_feedback_crm_schema`、`marketplace_schema`、`media_consent_tools_schema`、`admin_audit_schema`）；SQLite 多的是 **version 6–11**：`feedback_attachment_schema`、`self_listing_fee_mrt_schema`、`self_listing_mrt_state_schema`、`listing_share_schema`、`listing_share_dedup_channel`、`sponsor_entitlement_schema`（見 `v3/src/schemaMigrations.js`）。原因是 `runMigrations(db, SCHEMA_MIGRATIONS)`（`db.js:874`）跑在**同步 SQLite handle** 上；PG 側靠 `ensurePgSchema` 鏡射建表、**不寫 `schema_migrations`**。待決：這 6 支在 PG 模式「補進 migration 記錄」或「本就不該有記錄」——判斷依據是對應表（`feedback_attachment`、`self_listing` 增欄、`listing_share_events`、`sponsor_entitlement` 三表）在 PG 是否已由鏡射建好。
- **A③ `user_match_votes`／`user_match_signals` 各差 2 列**：**寫入分歧**（不是讀取）。同步寫入點在 `db.js:4041`（votes INSERT）與 `db.js:4049`（signals INSERT），PG 寫入點在 `sameHouseAsync.js:175/181`。觸發端點是 `POST /api/listings/:id/reject-match`（`server.js:5164`）與 `POST /api/listings/:id/confirm-match`（`server.js:5188`）。**本採齊只打 GET，沒打這兩個寫入 POST**（避免污染隔離庫），故 2 列分歧在沙盒無法重現（沙盒兩表皆 0 列）——修這支要先開一個有資料的登入帳號打 reject/confirm，或直接核對「哪條 code path 還在叫 `db.js:4041/4049` 的同步版」。

### 組 B（啟動副作用：讓 web 行程能開閘）

- `initSupportDomain`（`supportSchema.js:4` + `support.js:114/173`）與 `getStoredSmtp`（`server.js:5450` → `db.js:973`）解耦：PG 模式改走 async 或直接略過（`support_*` 表與 SMTP 設定都在 PG）。驗收：`PG_NO_SQLITE_OPEN=1 node src/server.js` 能完整監聽，`/api/health` 200，且 stderr 無這兩個爆點。

### 組 C（demand／wish-rooms 家族）

- `ensurePgSchema`（`pgSchema.js:48 tableInfo`）在 PG 模式對「已存在的表」不得再讀 SQLite schema；改「先查 PG `information_schema`，存在就 skip 鏡射」或「靜態 schema 快取」。驗收：開閘後 `/api/demand`、`/api/wish-rooms`、`/api/demand/:id`、`/api/wish-rooms/:id`、`/api/public/wish-room/:id` 不再 400。

### 組 D（listing detail／similar／分享頁）

- `listingDetailAsync.js:66-69` 的 fail-open fallback 改「開閘時不回退同步 `getListing`」；並把裝飾層（`decorateRowsWithProvider`／`loadFlags`／`getSettings` 的同步讀）退場。驗收：開閘後 `/api/public/listings/:id/detail` 200、`/api/public/listings/:id/similar` 有 `items`、`/p/:id` 200。

---

## ④ 正式站開閘作業單

1. **設哪個變數**：三個 web 容器（`591-tracker-v3`、`5151-web-A`、`5151-web-B`）在各自 compose/env 加 `PG_NO_SQLITE_OPEN=1`（其餘 `DB_DRIVER=postgres`、`PG_SQLITE_FALLBACK=strict` 已就緒）。**開閘前必須先落地組 A②／A③ 的決策與組 B（啟動副作用）**，否則 web 行程 crash loop。
2. **回退**：刪掉 `PG_NO_SQLITE_OPEN` 這個變數 → 重建容器即可（gate 預設關，行為回到現況）。單一變數、無 schema 變更，回退就是一個變數的事。
3. **開閘後 24 小時要盯的 4 個訊號**：
   1. web 行程存活：三容器不進 crash loop（`docker ps` 穩定 Up、`/api/health` 200）。
   2. **`v3.db-wal` mtime 凍結**：三個節點的 `/data/v3.db-wal`（或 `v3.db`）mtime 不再前進＝孤島不再被寫（開閘後唯一允許動它的只剩 migration bookkeeping，見組 A② 決策）。
   3. 錯誤率：三容器 stderr 不再新增 `business SQLite is closed`；若出現，依 `reached at` 逐條補表 ①。
   4. 使用者可見面：`/api/demand`、`/api/wish-rooms`、`/api/public/listings/:id/detail`、`/api/public/listings/:id/similar`、`/p/:id` 回 200 且有資料（不是 400/404/空）。

---

## 附：採齊範圍與跳過清單

- 端點總數：`server.js` 註冊 **309 條**路由（GET 145、POST/PUT/PATCH/DELETE 164）。**本遍只打 GET 145 支、實際打 137 支**。
- 跳過（8 支）：`/auth/:provider`、`/auth/:provider/callback`（OAuth 打外部）、`/api/events/stream`（SSE 長連線）、`/logout`（清 cookie）、`/media/self/:file`、`/media/lib/:file`、`/api/wish-offers/:offerRef/contact`、`/api/wish-offers/:offerRef`（`:file`/`:offerRef` 無可用樣本值，且沙盒 `wish_offers` 0 列）。
- **未打的寫入/通知/抓取端點**（依指示排除，避免污染隔離庫與打外部站台）：全部 164 條 POST/PUT/PATCH/DELETE，含 `/api/crawl*`、手動抓取、下架探測（`/api/listings/:id/recheck`、`/report-gone`）、`/api/support/webhook/:provider`、`/api/admin/mail/test`、`reject-match`/`confirm-match`（A③ 寫入點）。
- 需要登入的端點：用隔離庫 `crawl_sandbox` 既有的 1 個 admin 帳號（`role=admin`，未讀其密碼，直接以「SESSION_SECRET 未設 → HMAC("missing")」自簽 session cookie 走 `readSessionAsync` 的 PG 查 user 路徑），未在隔離庫新建帳號。
