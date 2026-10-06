# 後端技術規格草案 — 物件一鍵分享 ＋ 贊助自動開通 ＋ 通用物件公開內頁

> 狀態：**草案（非實作）**。本文件只寫 DDL 草稿、API 契約、函式簽名提案、flag 名稱、遷移版本、測試清單、分期 rollout。
> 不改任何 `v3/src`／`v3/public` 程式碼。
> 所有「既有函式／欄位」引用都以 grep 驗證過，標示 `檔案:行號`；憑證只寫鍵名不寫值。
> 用語：台灣繁體中文。

---

## 0. 現況基線（已 grep 驗證）

| 項目 | 事實 | 位置 |
|---|---|---|
| 會員 | `users.role ∈ {member, admin}`、`users.plan ∈ {free, sponsor}`、`users.nickname`（`ALTER ... ADD COLUMN nickname`） | `v3/src/personalSchema.js:8-9,120` |
| 顯示名 | `display_name = nickname \|\| email` 由 `publicUser()` 統一投影 | `v3/src/members.js:83-94` |
| session | HMAC cookie `591_session`；`readSession(req)`／`readSessionAsync(req, options)`／`requireAuth()`／`requireAdminApi()` | `v3/src/auth.js:110,118,377`（requireAdminApi 同檔） |
| 既有分享歸因 | 只服務許願房 `demand_posts`；`SHARE_EVENT_TYPES`／`PUBLIC_SHARE_EVENT_TYPES`／`CONVERSION_SHARE_EVENT_TYPES`；`recordShareEvent()`／`recordShareEventAsync()`；`resolveValidShareToken()` 查 `demand_posts.public_token`；`sharePageExtras()`；bot 偵測 `looksLikeBot()`；view 限流 `SHARE_VIEW_BURST=20`＋`SHARE_VIEW_HIT_TTL_MS=60_000`＋`SHARE_VIEW_HIT_MAX=2048` | `v3/src/rentalShareGrowth.js:7-10,27-32,51-69,76,142,183` |
| 分享事件表 | `rental_share_events(public_token, share_token, event_type, user_id, visitor_hash, is_bot, created_at)`＋唯一去重索引 `(share_token, event_type, user_id, created_at) WHERE user_id IS NOT NULL` | `v3/src/rentalNotify.js:318-332` |
| 歸因 cookie | `jr_share`（`setShareCookie()`，30 天，SameSite=Lax）；`attributeShare()`／`attributeShareAsync()` | `v3/src/server.js:1451-1455,1457-1483` |
| 公開事件端點 | `POST /api/public/wish-room/:id/share-events`（只收 view/cta） | `v3/src/server.js:1286-1311` |
| 統計 | `rental_analytics_daily(day, metric, value)` PK(day,metric)；`bumpAnalytics(db, metric, now, n)` | `v3/src/rentalNotify.js:346-353,571-574` |
| 後台總覽 | `GET /api/admin/overview` → `getAdminOverview()`／`getAdminOverviewAsync()` | `v3/src/server.js:2874`；`v3/src/adminOverview.js:257,262` |
| 稽核 | `admin_audit`＋`appendAdminAudit({actorId,actorEmail,action,target,before,after,now})`／`appendAdminAuditAsync(params, options)`；路由側 `auditReq()` | `v3/src/adminAudit.js:87`；`v3/src/adminAuditAsync.js:48`；`v3/src/server.js:1674` |
| 物件識別 | `post_id`（`listings` 主鍵） | `v3/src/db.js:514-532` |
| 公開路徑 | `/l/:id` → `v3/public/listing.html`（只服務站內 self）；`/go/:id` → 302；`listingRedirectTarget()`／`publicSharePath()`／`trackedListingPath()` | `v3/src/server.js:3750-3752,942-961`；`v3/src/openLink.js:4-38` |
| 讀取層 | `getListingAsync(postId, userId, options)` | `v3/src/listingDetailAsync.js:26` |
| 公開投影 | `publicListingView(listing, id)`（白名單） | `v3/src/selfListings.js:869-896` |
| 贊助目錄 | `SPONSOR_PROVIDERS` 7 家（opay/ezpay/oen/kofi/paypal/bmc/github）；`CURRENT_SPONSOR_BENEFITS`；`normalizeSponsorConfig()`／`publicSponsorLinks()`／`publicSponsorOffer()`；`sanitizeHttpUrl()` | `v3/src/sponsorLinks.js:13-20,22-88,94,121,164,189` |
| 贊助設定 | `settings` KV key=`sponsorLinks`；`getSponsorConfig()`／`saveAdminSponsorSettings()`；PG 版 `getSponsorConfigAsync()`／`saveAdminSponsorSettingsAsync()` | `v3/src/db.js:1345-1367`；`v3/src/adminSettingsAsync.js:253,266` |
| settings KV | `settingKey(key)`／`writeSettingKey(key, value)`；async `getSiteSettingAsync()`／`setSiteSettingAsync()` | `v3/src/db.js:912,922`；`v3/src/settingsKvAsync.js:58,65` |
| Support schema | `support_provider`（含 `secret_ref`）、`support_transaction`（含 `supporter_user_id`／`supporter_email`／`anonymous`／`status`，唯一 `(provider, provider_transaction_id)`）、`support_tier`、`support_page_config`（`flags_json`）、`support_event`… | `v3/src/supportSchema.js:5-17,32-59,60-80,121-141` |
| Support adapter | `BuyMeACoffeeProvider`／`ExternalUrlProvider`／`FuturePaymentProvider`；`verifyWebhook()` 全 stub 回 `{ok:false, implemented:false, reason:"webhook_not_implemented"}`；`getSupportPaymentProvider(kind)`；`resolveSupportCheckout(providerRow,{amount})` | `v3/src/supportProviders.js:20,42,64,37-39,59-61,77-79,82,94` |
| Support 常數 | `SUPPORT_PROVIDER_KINDS`、`FUTURE_PAYMENT_PROVIDERS`、`TRANSACTION_STATUSES`（pending/completed/failed/refunded/cancelled/manual）、`DEFAULT_SUPPORT_FLAGS`（enabled/cta_enabled/sponsor_enabled/public_cost_enabled） | `v3/src/supportDomain.js:5,13,31-37,63-67` |
| Support 邏輯 | `verifySupportWebhook()`、`createManualTransaction()`（已支援 `supporter_user_id`）、`createSupportCheckout()`（**不帶 user**）、`updateSupportTransaction()`；async 版同構 | `v3/src/support.js:1045,544-583,1019-1043,583`；`v3/src/supportAsync.js:839,876,934` |
| Support 端點 | webhook `POST /api/support/webhook/:provider`；checkout `POST /api/support/checkout`；手動 `POST /api/admin/support/transactions/manual`；改交易 `PUT /api/admin/support/transactions/:id` | `v3/src/server.js:2114-2121,2047-2063,2236,2244` |
| 開通贊助 | 僅管理員 `PATCH /api/admin/members/:id` → `setUserPlanAsync()`／`setUserPlan()`；轉 sponsor 才 `queueSystemMailAsync("sponsor_thanks", email)` | `v3/src/server.js:1776-1788`；`v3/src/usersAsync.js:368`；`v3/src/members.js:41-47`；`v3/src/siteMail.js:69,264` |
| 贊助權益 gate | 抓取間隔 `MEMBER_INTERVAL_MINUTES=8`／`SPONSOR_INTERVAL_MINUTES=5`；媒體配額 `MEDIA_QUOTA {free:30, sponsor:100}`；關注上限 `MEMBER_MAX_WATCHED=6`／`SPONSOR_MAX_WATCHED=15`；匯入 `assertSponsorMember(plan, role)`；範本 `DESCRIPTION_TEMPLATE_LIMIT_FREE=2`／`_SPONSOR=5` | `v3/src/settingsState.js:11-12,149`；`v3/src/memberMedia.js:16,20`；`v3/src/watchLimits.js:3-4`；`v3/src/listingImport.js:68-71`；`v3/src/listingTools.js:19-20` |
| 排程 | 主 `schedule()`＝`setInterval 60s → tick("schedule")`；3 支 5 分鐘 tick；多節點互斥 `scheduler_locks`（SQLite lease 版＋PG advisory lock） | `v3/src/server.js:4317-4335,4216-4315,5093-5102`；`v3/src/jobQueue.js:92,96-137` |
| 遷移慣例 | 不是 `v3/migrations/*.sql`；是 `ensureXxxSchema(db)` 冪等＋掛 `SCHEMA_MIGRATIONS`（每筆 `{version, name, up(db)}`）；**目前最大 version＝8**；新欄位一定要開新 version（PG 只跑沒跑過的版本，改 ensure 對舊庫＝no-op→42703） | `v3/src/schemaMigrations.js:32`（grep `version:` 共 8 筆） |
| 同意機制 | `member_consents(user_id, document_type, document_id, version, content_hash, source, agreed_at)` append-only；`recordConsent()`／`listMemberConsents()` | `v3/src/memberConsents.js:22-54,60,81` |
| ranking 隔離 | `listingScore.js` 只 import `floors/geo/listingCost`；`match.js` 只 import `listingCost`；`sortListingsRows()` 在 `db.js`；db.js 對 support 只 import `ensureSupportSchema`（純 schema）。檔案頭聲明：「不得被 listingScore / match / sortListingsRows 引用」 | `v3/src/listingScore.js:1-8`；`v3/src/match.js:1`；`v3/src/db.js:6804,133`；`v3/src/support.js:1`；`v3/src/supportDomain.js:1` |
| 圖片上限 | `FETCH_LIMITS.maxPhotos=12` | `v3/src/safeFetch.js:8-14` |
| 內頁快取現況 | `GET /api/public/self-listing/:id` → `Cache-Control: public, max-age=15` | `v3/src/server.js:3737-3750` |
| 既有測試 | `npm test`＝`node --test test/*.test.js v3/test/*.test.js ops/test/*.test.js`；`public-share-page.test.js` 讀 `listing.html`＋`server.js` 做靜態斷言（`/api/me`、`sessionState`、`renderCta()`、`safeListingHtml()`） | `v3/test/public-share-page.test.js:1-40` |

---

# 需求① 物件一鍵分享（LINE／Threads／FB）＋分享統計＋僅登入會員可發起

## 1.1 分享落點決策

**建議：分享連結＝站內公開內頁 `/p/:id` ＋ `?ref=<shareToken>`。**（`/p/:id` 是需求③新建的通用公開內頁）

理由與既有路由的關係：

- `/go/:id`（`v3/src/openLink.js:35-38`、`server.js:942-961`）**不適合當分享落點**：它是「302 導回原站（591／租租通）」的追蹤跳板，把分享連結指向它，打開的人會被踢去第三方站，社群預覽爬蟲也抓不到 OG meta，無法形成分享統計的落地點。
- `/l/:id`（`server.js:3750-3752`）只服務站內刊登 `self`（`publicSharePath()`，`openLink.js:4-8`），且它的「無 ref 公開網址」已有既存語意與 A5 測試（`public-share-page.test.js`）綁定，不適合塞進外站物件。
- 因此**新增 `/p/:id`**，對齊需求③，站內刊登與外部物件共用同一種分享 URL 形狀：`{PUBLIC_BASE_URL}/p/{post_id}?ref={shareToken}`。
- `/go/:id` 維持不變（列表卡片「看原站」追蹤）；`/l/:id` 維持不變（既有站內分享頁，或日後 301 收斂到 `/p/:id`——留給 Owner 拍板，見 §8 決策點 D2）。

## 1.2 DB 設計：方案比較與決策

**兩個方案：**

- 方案 A：重用 `rental_share_events` 加欄位（`subject_type`／`subject_id`／`channel`／`actor_id`）。
- 方案 B：新增 `listing_share_events`（＋`listing_share_tokens`）。

**選 B（新增表）。理由：**

1. 既有 `resolveValidShareToken()` 只認 `demand_posts.public_token`（`rentalShareGrowth.js:60-69`）；既有去重唯一索引 `(share_token, event_type, user_id, created_at) WHERE user_id IS NOT NULL`（`rentalNotify.js:329-331`）以「許願房 share_token」為粒度，混入 listing 需要額外 `subject_type` 才能去重，且會讓 retention 清理（`rentalNotify.js:1257` 的 `attrCut`）與 `share_*` 統計 join 一起變髒。
2. 加欄位一樣要開新 migration version（見 §0 遷移慣例），成本沒省到。
3. listing 分享需要「token 產生／撤銷／每會員每日上限」的獨立生命週期，用專屬 token 表最乾淨。

**DDL 草稿（`ensureListingShareSchema(db)`，migration version 9，SQLite 與 PG async 島嶼同步落地）：**

```sql
-- 分享連結 token（由會員產生，可撤銷、可過期）
CREATE TABLE IF NOT EXISTS listing_share_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  share_token TEXT NOT NULL UNIQUE,      -- 24B base64url（不可猜）
  post_id INTEGER NOT NULL,
  actor_id INTEGER NOT NULL,             -- 產生連結的會員
  channel TEXT NOT NULL DEFAULT '',      -- line | threads | facebook | url_copy
  expires_at TEXT,                       -- 可空＝不自動過期
  revoked_at TEXT,                       -- 撤銷時間
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_listing_share_token_post
  ON listing_share_tokens(post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_listing_share_token_actor
  ON listing_share_tokens(actor_id, created_at);

-- 分享事件（公開落地）
CREATE TABLE IF NOT EXISTS listing_share_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_token TEXT NOT NULL UNIQUE,     -- 事件層對外 token
  share_token TEXT NOT NULL,
  post_id INTEGER,
  channel TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL,              -- view | cta（沿用 PUBLIC_SHARE_EVENT_TYPES 語意）
  actor_id INTEGER,                      -- 歸因到「誰產生這條連結」
  user_id INTEGER,                       -- 觀看者（登入才非空）
  visitor_hash TEXT,                     -- sha256(ip|ua)
  is_bot INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_listing_share_lookup
  ON listing_share_events(share_token, event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_listing_share_actor
  ON listing_share_events(actor_id, created_at);
-- 去重：登入使用者／匿名訪客各自一天一次（同許願房既有語意）
CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_share_dedup_user
  ON listing_share_events(share_token, event_type, user_id, created_at)
  WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_share_dedup_visitor
  ON listing_share_events(share_token, event_type, visitor_hash, created_at)
  WHERE event_type = 'view' AND user_id IS NULL;
```

**欄位與既有事件的對應**：`public_token`（隨機）、`visitor_hash`、`is_bot`、`created_at` 對齊 `rental_share_events`（`rentalNotify.js:318-332`）；新增 `post_id`／`channel`／`actor_id` 做 listing 歸因。

**token 格式與防猜**：`share_token`＝`randomBytes(12).toString("base64url")`（24 字元，約 96 bits 熵），沿用 `recordShareEvent()` 既有的 `randomBytes(12).toString("base64url")` 慣例（`rentalShareGrowth.js:116-118`）。`resolveValidShareToken` 與 `recordShareEvent` 都有「純數字或短於 8 字元的 token 直接拒絕」的守衛（`rentalShareGrowth.js:62`），listing 版沿用。

## 1.3 API 契約

### 1.3.1 產生分享連結（僅會員）

- **method／path**：`POST /api/listings/:id/share-link`
- **auth**：`requireAuth`（`v3/src/auth.js:377`）；訪客擋在 middleware → 401。
- **request body**：`{}`（可選 `{"channel":"line"}` 提示；伺服器一律回傳全套 channels）。
- **response 200**：
  ```json
  {
    "shareToken": "<token>",
    "url": "https://<PUBLIC_BASE_URL>/p/123?ref=<token>",
    "channels": [
      {"id":"line","label":"LINE","url":"https://line.me/R/msg/text/?<encoded title+url>"},
      {"id":"threads","label":"Threads","url":"https://www.threads.net/intent/post?text=<encoded>"},
      {"id":"facebook","label":"Facebook","url":"https://www.facebook.com/sharer/sharer.php?u=<encoded url>"},
      {"id":"url_copy","label":"複製連結","url":"<url>"}
    ],
    "expiresAt": null
  }
  ```
- **錯誤形狀**（統一 `{error, code}`）：
  - `401` `{"error":"請先登入","code":"AUTH_REQUIRED"}`（由 requireAuth 產生）
  - `404` `{"error":"找不到物件","code":"listing_not_found"}`（`getListingAsync` 回 undefined 或非公開可見）
  - `429` `{"error":"今日分享連結已達上限","code":"SHARE_LINK_LIMIT"}`（每會員每日上限，見 §1.6）
- **第三方 URL 不寫死在前端**：channels 的 `url` 由伺服器組好，前端只複製／開新窗（對齊 `supportProviders.js:1`「前端不得寫死第三方 URL」的原則）。

### 1.3.2 公開事件端點（訪客可打，落地 view/cta）

- **method／path**：`POST /api/public/listings/:id/share-events`
- **auth**：無（公開）；若帶 session 則記 `user_id`。
- **request body**：`{"event_type":"view"}` 或 `{"event_type":"cta"}`（只收 `PUBLIC_SHARE_EVENT_TYPES = ["view","cta"]`，`rentalShareGrowth.js:8`）。
- **response 200**：`{"recorded":true,"is_bot":false}` 或 `{"recorded":false,"reason":"deduped","is_bot":false}`
- **錯誤**：
  - `403` `{"error":"無法記錄轉換","code":"share_conversion_forbidden"}`（非 view/cta）
  - `404` `{"error":"找不到分享","code":"share_not_found"}`（token 無效）
  - `429` `{"error":"請稍後再試","code":"RATE_LIMITED"}`（view 突發限流）
- 契約直接對齊 `POST /api/public/wish-room/:id/share-events`（`server.js:1286-1311`）。

### 1.3.3 會員自己的分享統計

- **method／path**：`GET /api/me/listings/share-stats`
- **auth**：`requireAuth`。
- **response 200**：
  ```json
  {
    "myShares": {
      "total": 3,
      "views": 120,
      "ctas": 7,
      "byChannel": {"line":40,"facebook":60,"threads":0,"url_copy":20}
    },
    "perListing": [
      {"postId":123,"title":"…","views":80,"ctas":5,"createdAt":"…"}
    ]
  }
  ```

### 1.3.4 後台統計

- **method／path**：`GET /api/admin/listings/share-stats`
- **auth**：`requireAdminApi`。
- **response 200**：`{byChannel, byListing, dailyBars:[{day, metric, value}], botViews, totalViews, totalCtas}`。
- 另在 `GET /api/admin/overview`（`server.js:2874`）新增一個 `listingShare` 區塊（見 §1.5）。

## 1.4 「僅會員可分享」的實作點

- **後端**：`POST /api/listings/:id/share-link` 直接掛 `requireAuth`（`auth.js:377`），訪客在此就被 401 擋下，`code:"AUTH_REQUIRED"`。
- **前端**：分享按鈕在頁面上先查 `/api/me` 得知登入態（沿用 A5 的 `sessionState`，`public-share-page.test.js:1-40`）；訪客按下時**前端直接跳登入流程**（不發 request），並把 401 的 code 當作後端最後防線。
- **訪客仍可「看」分享頁**：`GET /p/:id`（渲染）與 `POST /api/public/listings/:id/share-events`（落地）都不需要登入；只有「發起分享」需要登入。這點與許願房現況一致（公開頁＋公開事件端點，但許願房的分享不需登入，listing 的「發起」提高門檻）。

## 1.5 OG／canonical meta（公開內頁 server-render）

`GET /p/:id` 由伺服器回傳 HTML（或回傳內頁 HTML 骨架＋`<head>` 內 meta），需含：

- `<link rel="canonical" href="{PUBLIC_BASE_URL}/p/{post_id}">`（**不含 ref**，避免重複索引）。
- `og:title`＝物件標題（`listing.title`）。
- `og:description`＝摘要（自 `listing.body`／`listing.traits` 截斷 160 字）。
- `og:image`＝`listing.cover`（有圖）；**無圖 fallback**＝站方預設圖（brand banner）。
- `og:url`＝`{PUBLIC_BASE_URL}/p/{post_id}`（可含 ref 與否由 SEO 拍板；建議 canonical 用無 ref 版、`og:url` 用無 ref 版）。
- 另加 `og:type=website`、`og:site_name=吉比租房物件追蹤`、`twitter:card=summary_large_image`（若有 cover）。

圖片來源：`listing.cover`（`listings` 表，`db.js:514-532`；站內刊登另見 `selfListings.js` 的 `cover`／`self_photos` 投影）。**ref 參數只進統計、不進 meta**，避免分享 token 污染索引。

## 1.6 統計指標

- 沿用 `rental_analytics_daily(day, metric, value)`（`rentalNotify.js:346-353`）＋ `bumpAnalytics()`（`rentalNotify.js:571-574`）。
- **新 metric 名**（沿用既有 `share_<type>` 與 `share_<type>_bot` 命名，`rentalShareGrowth.js:119`）：
  - `listing_share_view`／`listing_share_view_bot`
  - `listing_share_cta`／`listing_share_cta_bot`
  - `listing_share_link_created`
- 後台 `/api/admin/overview` 新增 `listingShare: {totalLinks, totalViews, totalCtas, botViews, byChannel:{...}, byListingTop:[...]}`（實作在 `adminOverview.js` 加一個只讀查詢區塊，不 import 排序模組）。
- 會員可看：`GET /api/me/listings/share-stats`（§1.3.3）。

## 1.7 防濫用

- **沿用既有機制**：`looksLikeBot()`（UA 黑名單，`rentalShareGrowth.js:27`）、`visitorHash()`（`rentalShareGrowth.js:30`）、`allowView()` 突發限流（`SHARE_VIEW_BURST=20`／`SHARE_VIEW_HIT_TTL_MS=60_000`，`rentalShareGrowth.js:10-11,51-59`）、每日 dedup 唯一索引（`rentalNotify.js:329-331` 的語意）。
- **新增「每會員每日分享連結上限」**：建議 `LISTING_SHARE_LINK_DAILY_LIMIT = 20`（每會員每日最多產生 20 條分享連結），計數查 `listing_share_tokens(actor_id, created_at >= 當日)`；超過回 `429 SHARE_LINK_LIMIT`。
- 這些 helper 目前是 `rentalShareGrowth.js` 模組內私有（`looksLikeBot`／`visitorHash`／`allowView` 沒 export），**實作時 export 或抽到共用模組**，避免 listing 版複製一份造成兩邊漂移（可參考既有「同步與 async 共用同一份 SQL／helper」的慣例，`rentalShareGrowth.js:132-142` 註解）。

## 1.8 遷移版本號提案

- 目前 `SCHEMA_MIGRATIONS` 最大 `version: 8`（`schemaMigrations.js:32` 起，grep 確認共 8 筆）。
- 需求① **version 9**：`name:"listing_share_schema"`，`up(db){ ensureListingShareSchema(db); }`，並在 SQLite 與 PG async 島嶼兩邊都掛。

---

# 需求② 贊助連結帶會員身分 ＋ 回抓自動開通贊助會員

## 2.1 統一抽象：`buildSponsorOutbound`

**提案函式簽名（放 `sponsorLinks.js` 或新檔 `sponsorAttribution.js`，建議新檔，避免 sponsorLinks 承載金流）：**

```js
// sponsorAttribution.js（同步版）＋ sponsorAttributionAsync.js（PG 島嶼版，套用既有雙分支慣例）
export function buildSponsorOutbound(providerId, configuredUrl, { code, displayName, email } = {}) {
  // 回傳 { url, prefilled: bool, sendEmail: bool }
  // - 只把 capability 允許的欄位拼進 url 查詢參數
  // - 預設不送 email（見 §2.8 個資）
}
export async function buildSponsorOutboundAsync(providerId, configuredUrl, identity, options = {}) { ... }
```

**capability 宣告（程式結構草稿）**——每家 provider 的能力差異用宣告式描述，`buildSponsorOutbound` 只照表操作，不寫死單一 provider：

```js
export const SPONSOR_PROVIDER_CAPABILITIES = Object.freeze({
  opay:    { supportsPrefill:false, supportsWebhook:false, supportsApiPoll:false, matchKeys:["code"], secretEnv:null },
  ezpay:   { supportsPrefill:false, supportsWebhook:false, supportsApiPoll:false, matchKeys:["code"], secretEnv:null },
  oen:     { supportsPrefill:false, supportsWebhook:false, supportsApiPoll:false, matchKeys:["code"], secretEnv:null },
  kofi:    { supportsPrefill:false, supportsWebhook:false, supportsApiPoll:false, matchKeys:["code"], secretEnv:null },
  paypal:  { supportsPrefill:false, supportsWebhook:false, supportsApiPoll:false, matchKeys:["code"], secretEnv:null },
  bmc:     { supportsPrefill:false, supportsWebhook:true,  supportsApiPoll:false, matchKeys:["email"], secretEnv:"BMC_API_TOKEN" },
  github:  { supportsPrefill:false, supportsWebhook:false, supportsApiPoll:false, matchKeys:["code"], secretEnv:null },
});
```

> 注意：`SPONSOR_PROVIDERS`（`sponsorLinks.js:22-88`，會員贊助目錄 7 家）與 `support_provider.kind`（`supportDomain.js:5` 的 `SUPPORT_PROVIDER_KINDS`、`supportProviders.js` 的 adapter）是**兩套清單**。規格建議以 `SPONSOR_PROVIDERS.id` 為對外鍵，`SPONSOR_PROVIDER_CAPABILITIES[id]` 宣告能力，webhook/API poll 時再對應到 `support_provider.kind`。目前 7 家中只有 `bmc` 有真實 webhook 能力；其餘是收款連結（external URL），自動開通只能靠「代碼＋人工／API 對帳」。

## 2.2 贊助代碼：`member_support_code`（DDL 草稿）

```sql
CREATE TABLE IF NOT EXISTS member_support_code (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,             -- 大寫、無易混淆字元
  user_id INTEGER NOT NULL,              -- 誰的贊助代碼
  provider TEXT NOT NULL DEFAULT '',     -- 綁定哪家（空＝通用）
  status TEXT NOT NULL DEFAULT 'active', -- active | used | revoked | expired
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  matched_transaction_id INTEGER         -- 命中哪筆 support_transaction
);
CREATE INDEX IF NOT EXISTS idx_member_support_code_user
  ON member_support_code(user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_member_support_code_tx
  ON member_support_code(matched_transaction_id);
```

**代碼格式與防護**：

- 格式：長度 **10 字元**、字元集 **Crockford base32**（`0123456789ABCDEFGHJKMNPQRSTVWXYZ`，去掉 I/L/O/U，避免肉眼誤讀），由伺服器 `crypto.randomBytes` 生成；約 50 bits 熵，比 24B base64url 分享 token 短但足以抗暴力猜（附每會員限額＋過期＋登入後才發）。
- **每會員同時有效代碼數上限**：`1`（同一時間只有一條 active code；產生新的即 revoke 舊的），降低被猜中／被重複使用的風險。
- **過期**：預設 `expires_at = created_at + 14 天`，可後台調整。
- **可否撤換**：可。會員或後台可 revoke 舊碼、發新碼（`status='revoked'`，保留稽核）。

## 2.3 對帳（support_transaction 怎麼被填）

現況：`createSupportCheckout()` 不建立交易列、也不帶 user（`support.js:1019-1043`）；`createManualTransaction()` 已支援 `supporter_user_id`（`support.js:544-583`）。

**提案**：

1. **checkout 時**（`POST /api/support/checkout`，`server.js:2047-2063`）改成：若登入，產生一筆 `support_transaction(status='pending', supporter_user_id=<uid>, anonymous=0)`，並把 `member_support_code` 的 code 帶入出站連結（若 capability `supportsPrefill`）或寫進 `raw_reference`。
2. **對帳匹配優先序**：**代碼（member_support_code.code）＞ email（supporter_email）＞ 人工（createManualTransaction 的 supporter_user_id）**。
3. **匹配結果處理**：
   - **唯一命中代碼** → 自動開通（走 §2.5）。
   - **唯一命中 email**（且該 email 對應唯一會員）→ 自動開通（需 `flags.sponsor_auto_entitlement` 開）。
   - **多筆曖昧**（同名 email 多帳號／代碼撞多筆）→ **進後台人工審核佇列**（狀態停在 `pending`，`support_event` 記 `sponsor_match_ambiguous`，後台 dashboard 顯示）。
   - **完全沒命中** → 保持 `pending`＋`support_event` 記 `sponsor_match_missed`，進人工審核。
4. **退款（`status='refunded'`，`TRANSACTION_STATUSES` 內建）**：是否撤銷 plan → **後台可設定**（`sponsorEntitlement.revokeOnRefund`，預設 `false` 保守）。若撤銷，走 §2.5 的 `revokeSponsorEntitlement` 並 `setUserPlanAsync(userId,"free")`＋稽核，不重複寄信。

## 2.4 自動開通：`applySponsorEntitlement`

**提案函式簽名：**

```js
// sponsorAttribution.js／Async
export async function applySponsorEntitlement(userId, { transactionId, reason = "support_matched" } = {}, options = {}) {
  // 1. 冪等閘：查 sponsor_entitlement_grant(transaction_id) 已存在 → 直接回傳已開通
  // 2. setUserPlanAsync(userId, "sponsor", options)         // usersAsync.js:368
  // 3. queueSystemMailAsync("sponsor_thanks", email)        // siteMail.js:69；server.js:1782 同語意
  // 4. appendAdminAuditAsync({actorId:0, actorEmail:"system", action:"sponsor.auto_entitlement", target:`support_transaction:${transactionId}`, before:{plan:"free"}, after:{plan:"sponsor"}}, options) // adminAuditAsync.js:48
  // 5. 寫 sponsor_entitlement_grant 一筆（transaction_id UNIQUE）
}
```

**冪等表 DDL（併入 version 10）：**

```sql
CREATE TABLE IF NOT EXISTS sponsor_entitlement_grant (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  support_transaction_id INTEGER NOT NULL UNIQUE,  -- 同一筆交易不得重複開通
  user_id INTEGER NOT NULL,
  plan_before TEXT NOT NULL,
  plan_after TEXT NOT NULL,
  validity TEXT NOT NULL DEFAULT 'one_time',       -- one_time | monthly | cumulative
  granted_at TEXT NOT NULL,
  revoked_at TEXT
);
```

**開通門檻與效期（後台可設定）**：存 `settings` KV key=`sponsorEntitlement`（重用 `settingKey/writeSettingKey`＋`getSiteSettingAsync/setSiteSettingAsync`，`db.js:912,922`、`settingsKvAsync.js:58,65`），結構：

```json
{
  "enabled": false,
  "minAmountTWD": 300,
  "validity": "one_time",          // one_time | monthly | cumulative
  "validityDays": 30,              // monthly 用
  "revokeOnRefund": false,
  "autoEntitleByEmail": false      // 只接受代碼（預設）→ 見 §2.8
}
```

**預設值建議**：`minAmountTWD=300`、`validity="one_time"`、`validityDays=30`、`revokeOnRefund=false`、`autoEntitleByEmail=false`。門檻金額留 Owner 拍板（§8 決策點 D5）。

## 2.5 回抓機制（webhook ＋ API 輪詢）

### 2.5.1 webhook 補簽章驗證

現況 `verifyWebhook()` 全 stub 回 `{ok:false, implemented:false,...}`（`supportProviders.js:37-39,59-61,77-79`），端點直接回 501（`server.js:2114-2121`）。補法：

- `secret_ref` 只存鍵名（`supportSchema.js:53`、`supportProviders.js:118` 的 `has_secret`），**解析成 env 鍵**：`const secret = process.env[providerRow.secret_ref]`；鍵名例如 `BMC_API_TOKEN`（值絕不落地）。缺值或空 → 該 provider 回 503 並記 `support_event`，**不整批歸零**。
- `BuyMeACoffeeProvider.verifyWebhook(payload, headers)` 實作 HMAC／簽章比對（用 `node:crypto` 的 `createHmac`，`timingSafeEqual`），驗過才把 `payload` 轉成 `support_transaction`（對帳流程 §2.3）。

### 2.5.2 API 輪詢

- **掛哪支 tick**：新增第 4 支 5 分鐘 tick（沿用 `startXxxLoop`＋`runXxxWorkerTickAsync`／同步版雙分支，`server.js:5093-5102` 的模式），或併入既有 5 分鐘 loop 的其中一支；建議獨立 `startSponsorReconcileLoop`。
- **多節點互斥**：`tryAcquireSchedulerLock(db,{key:"sponsor_reconcile",owner,leaseMs:60_000})`＋`releaseSchedulerLock`（`jobQueue.js:107,135`；PG 走 advisory lock `POSTGRES_TRY_ADVISORY_LOCK_SQL`，`jobQueue.js:92`）。拿不到 lock 就 skip 本輪。
- **cursor 表 DDL（version 10）**：

```sql
CREATE TABLE IF NOT EXISTS support_poll_cursor (
  provider TEXT PRIMARY KEY,
  cursor TEXT NOT NULL DEFAULT '',      -- 各家 last seen id/timestamp
  last_success_at TEXT,
  paused_until TEXT,                    -- 被擋時冷卻到何時
  fail_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
```

- **失敗退避與暫停**：**逐筆 try/catch**；被擋 `401/403/429/503` → 該 provider `paused_until = now + 冷卻`（冷卻預設 30 分鐘，對齊既有「來源被擋冷卻 30 分鐘」的教訓），`fail_count += 1`，**不得整批歸零**；已經抓到的交易照樣落地。
- **第一線 fail-soft 硬規則**（AGENTS.md「外部來源第一線就要 fail-soft」）：規格明訂——每一筆外部回抓／webhook 都各自 try/catch；單筆失敗只損失該筆；被擋就暫停該 provider 並記錄；`catch` 首行保留取消語意；只有「連一筆都抓不到」才維持該輪失敗語意並丟原始 error。**這條要寫進 spec 的驗收測試（§7）。**

## 2.6 個資與同意

- **預設不送 email、只送代碼**（更安全）：出站連結只帶 `code`，`buildSponsorOutbound` 的 `sendEmail` 預設 `false`；只有 capability `supportsPrefill && sendEmail`（後台明確開啟＋會員同意）才把 email 帶進第三方收款頁。
- **同意機制**：用既有 `memberConsents.js` 加一筆同意項。既有形狀：`recordConsent(db, userId, {document_type, document_id, version, content_hash, source})`、`member_consents` append-only（`memberConsents.js:22-54,81`）。提案：`document_type="sponsor_identity_share"`，`document_id` 指到既有 `content_documents` 的同意書；會員在 UI 勾選「同意把身分代碼／email 帶給贊助平台」後寫入。
- **UI 告知對應 API 欄位**：`buildSponsorOutbound` 回傳值加 `{requiresConsent:true, consentType:"sponsor_identity_share"}`；前端未同意時，`POST /api/support/checkout` 回 `403 {"error":"尚未同意第三方身分告知","code":"SPONSOR_CONSENT_REQUIRED"}`。

## 2.7 flags（新功能一律預設關）

- **新 flag 名稱**（放 `support_page_config.flags_json`，沿用 `DEFAULT_SUPPORT_FLAGS` 的 `normalizeSupportFlags`/`readFlags` 機制，`supportDomain.js:63-67`、`support.js:194-196,227`）：
  - `sponsor_code_attribution`（預設 `false`）：是否發 member_support_code＋帶碼出站。
  - `sponsor_auto_entitlement`（預設 `false`）：是否自動開通。
  - `sponsor_api_poll`（預設 `false`）：是否啟動輪詢。
  - `sponsor_webhook`（預設 `false`）：是否接受 webhook 對帳。
- **與既有 flag 的關係**：`flags.enabled`（support 總開關）與 `flags.sponsor_enabled`（贊助牆展示）是**上層**；上述四個新 flag 是**子開關**，`sponsor_enabled=true` 是它們的前提。門檻／效期等「營運參數」放 `settings` KV `sponsorEntitlement`（§2.4），不放 flags。
- 存放位置建議：**page flags 用 `support_page_config.flags_json`**（它已是 support 功能的單一旗標源，且 async 版有 `getSupportFlagsAsync`，`supportAsync.js:682`）；**營運參數用 `settings` KV**（`settingsKvAsync.js` 已是 driver-aware）。

## 2.8 不得違反的既有鐵則（ranking 隔離）

- **Support／贊助資料不得進入 listing ranking**：`listingScore.js`（`v3/src/listingScore.js:1-8`）、`match.js`（`v3/src/match.js:1`）、`sortListingsRows()`（`v3/src/db.js:6804`）**不得 import** `sponsorAttribution.js`／`support.js`／`supportDomain.js`／`sponsorLinks.js`（除了純 schema 的 `ensureSupportSchema` 已在 `db.js:133`）。
- **規格明訂檢查**：PR review 時 grep 這三檔的 import；CI 加一支測試檔（§7 `support-ranking-isolation.test.js`）用 `readFileSync` 斷言這三檔的 import 字串不含 `support/sponsor` 模組。

---

# 需求③ 通用物件公開內頁（對齊 591／租租通資訊架構）

## 3.1 路由與頁面

**建議：新增 `/p/:id` 路由＋新頁 `v3/public/detail.html`；不擴充既有 `/l/:id`＋`listing.html`。**

理由：

- `/l/:id` 是「站內刊登公開分享頁」，語意與 A5 測試（`public-share-page.test.js:1-40`，靜態斷言 `listing.html` 的 `sessionState`／`renderCta()`／`safeListingHtml()`）綁死；若把外站物件塞進 `listing.html`，既有一堆「只服務 self」的 DOM 會誤用，且會弄壞 `public-share-page.test.js` 的多條斷言。
- 外部物件（591／租租通）沒有站內內頁，需求③要新建；**新頁獨立成 `detail.html`** 最乾淨，`listing.html` 不動 → 既有測試零影響。
- `/p/:id` 對站內刊登與外部物件**共用同一渲染器**；`/l/:id` 保留為既有公開分享頁（或日後 301 收斂，見 §8 決策點 D2）。

## 3.2 資料層：`publicListingView()` 白名單擴充

既有 `publicListingView()` 已含欄位：`id, title, price, price_num, address, area_name, layout, floor_name, kind_name, role_name, cover, photos, body, traits, trait_labels, fee_includes, fee_include_labels, deposit, contact_name, contact_role, mobile, phone, line_url, created_at`（`selfListings.js:869-896`）。

**新增欄位（每個標來源）**：

| 欄位 | 來源 | 訪客遮蔽 |
|---|---|---|
| 捷運步行 | `self_mrt_station/walk_m/state/nearest_m`（`selfListings.js:473-480,832-840`；外部物件若無則空） | 公開（只回站名＋距離，**不回精確座標**，沿用 `docs/handoffs/20261001-owner-workorder-report.md` §3 隱私原則） |
| 坪數／面積 | hydrated listing row 的 `area`／`area_name`（`listings.area_name` 已證實，`db.js:514-532`；確切「坪數」欄位名實作時 grep hydrated row 確認，不憑印象） | 公開 |
| 屋齡 | hydrated listing row（欄位名實作時 grep，勿臆測） | 公開 |
| 型態 | `kind_name`／`role_name`（已含，`selfListings.js:877-878`） | 公開 |
| 押金 | `deposit`（已含，`selfListings.js:884`）＋`depositLabel`（`selfListings.js:10`） | 公開 |
| 租金內含 | `fee_includes`／`fee_include_labels`（已含，`selfListings.js:882-883`） | 公開 |
| 刊登時間 | `created_at`（已含，`selfListings.js:895`） | 公開 |
| 座標 | `listings.lat/lng`（`adminOverview.js` 的 data-health 已用 `lat/lng`，證實欄位存在） | **遮蔽：訪客不回精確座標**（或四捨五入到低精度）；登入會員／sponsor 可見精度 |
| 圖片陣列 | `photos`＋`cover`（已含，`selfListings.js:874,879`） | 公開 |
| 來源標籤 | `source`＋`selfSourceLabel()`（`selfListings.js:255`） | **來源晶片沿用既有規定：admin 與 sponsor 可見**；訪客看得到「站內／591／租租通」粗分類，看不到內部 source_key |
| 歷史價格 | hydrated row（欄位名實作時 grep；若無現成欄位則本需求不新增，標待確認） | 公開（若有） |

**訪客遮蔽規則（沿用既有）**：

- 屋主電話／`mobile`／`phone`／`line_url`：**建議只給登入會員**（現況 `publicListingView` 有露出，屬 Owner 決策點 D6，見 §8）。
- 來源晶片：**只有 admin 與 sponsor 可見**（既有規定）——實作時以 `role/plan` 區分，不把來源內部值塞進訪客投影。

## 3.3 快取與效能

- `GET /p/:id` 渲染 HTML：建議 `Cache-Control: public, max-age=60`（比 `/api/public/self-listing/:id` 的 15 長，因內頁變更頻率低；`server.js:3737-3750` 現況 max-age=15）。
- 內部資料端點（若有 `GET /api/public/listing-detail/:id`）建議 `public, max-age=30`。
- **多節點快取失效**：`eventBus.js` 已有 `createLocalEventBus()`／`createPostgresEventBus()`／`createEventBus()`（`eventBus.js:11,31,59`）。內頁不強制接 eventBus；**可選**在站內刊登發布／修改時 `emit("listing:updated", {postId})` 讓各節點 purge 本機 SSR 快取（Phase 3 再做，見 §6）。

## 3.4 相似物件

- 可用既有 `matchCandidatesAsync(excludePostId, incoming, options)`（`crawlerReads.js:199`）＋同屋源邏輯。
- **不得讓贊助影響排序**：相似物件只照既有 score／距離排序，**不 import** support／sponsor 模組（§2.8 鐵則）。

## 3.5 圖片

- 既有欄位：`cover`、`photos`（`selfListings.js:874,879`）、`self_photos`（`selfListings.js:464`）；數量上限 `FETCH_LIMITS.maxPhotos=12`（`safeFetch.js:8-14`）。
- 無圖 fallback：站方預設圖（brand banner），`<img>` 需帶 `width/height`（或 CSS aspect-ratio）防 CLS。
- CLS 防護：`og:image` 與頁首圖都用固定比例容器；`loading="lazy"`＋`decoding="async"` 給次要圖。

---

# 共通：分期 rollout

- **Phase 1（需求①分享）**：`listing_share_tokens`＋`listing_share_events`（version 9）、`POST /api/listings/:id/share-link`、`POST /api/public/listings/:id/share-events`、`GET /api/me/listings/share-stats`、後台 share-stats＋overview 區塊、分享按鈕（LINE/FB/Threads/複製）。**可獨立上線**：純新增，不碰既有許願房分享。**回滾**：關 flag `listing_share_v2`（預設關，上線時開）＋不呼叫新端點；資料表留著無害。
- **Phase 2（需求③內頁）**：`/p/:id`＋`v3/public/detail.html`、`publicListingView` 擴充、OG meta、訪客遮蔽規則。**可獨立上線**（不依賴分享統計，但分享連結 URL 要等它才有落地頁——順序上 Phase 2 應在 Phase 1 的「分享」正式導流前完成，或 Phase 1 先只回 `/go/:id` 當臨時落點）。**回滾**：移除 `/p/:id` 路由、還原 `publicListingView`。
- **Phase 3（需求②贊助）**：`member_support_code`＋`support_poll_cursor`＋`sponsor_entitlement_grant`＋`support_transaction` 新欄位（version 10）、`buildSponsorOutbound`、`applySponsorEntitlement`、webhook 簽章、API 輪詢、後台設定 UI。**可獨立上線**：全在 `flags.sponsor_code_attribution/auto_entitlement/api_poll/webhook`（預設關）之後。**回滾**：四 flag 全關＝回復「付款後站長手動改已贊助」的現狀（`PATCH /api/admin/members/:id` 路徑不受影響）。

**每期驗收條件（共通）**：`npm test` 全綠；`node --test` 新測試檔全綠；PG async 島嶼有對應 parity／live-pg 測試；不觸發 Production 部署（manual-only，Owner 核准）。

---

# 測試清單

**新增測試檔（檔名＋測什麼）**：

1. `v3/test/listing-share-link.test.js` — `POST /api/listings/:id/share-link` 需登入、401/404/429 契約、token 格式、每會員每日上限。
2. `v3/test/listing-share-events.test.js` — 公開事件端點 view/cta、403/404/429、dedup、`is_bot`、`bumpAnalytics` metric 名。
3. `v3/test/listing-share-events-async.test.js` — PG 島嶼 parity（對照 `share-events-async.test.js` 既有形狀）。
4. `v3/test/sponsor-attribution.test.js` — `buildSponsorOutbound` capability 宣告、不送 email 預設、code 格式。
5. `v3/test/sponsor-entitlement.test.js` — `applySponsorEntitlement` 冪等（同交易不重複開通）、audit、`sponsor_thanks` 寄信、退款撤銷。
6. `v3/test/sponsor-entitlement-async.test.js` — PG 島嶼 parity。
7. `v3/test/sponsor-reconcile-live-pg.test.js` — API 輪詢 fail-soft（401/403/429/503 暫停該 provider、不整批歸零）。
8. `v3/test/support-ranking-isolation.test.js` — 靜態斷言 `listingScore.js`／`match.js`／`db.js` 不 import support/sponsor 模組。
9. `v3/test/listing-public-detail.test.js` — `publicListingView` 白名單新增欄位、訪客遮蔽（屋主電話／來源晶片／座標）。
10. `v3/test/listing-share-og.test.js` — OG/canonical meta、無圖 fallback。

**既有測試會不會被影響**：

- `public-share-page.test.js`：**不影響**（不動 `listing.html`）。
- `share-events-async.test.js`／`rental-notify.test.js`：**不影響**（新表、新端點獨立；不碰 `rental_share_events`）。
- `listing-score.test.js`／`listing-detail-parity.test.js`／`listing-projection-kind-keys.test.js`：需求③若動 `publicListingView` 白名單，`listing-projection-kind-keys.test.js` 這類「白名單 key 斷言」要**同步更新**（新增欄位 key 要加進斷言清單），需在實作時 grep 確認其斷言方式。

---

# Owner 拍板決策點（編號清單）

1. **D1**：是否推翻「付款後站長手動改已贊助」的現狀、引入自動開通（`applySponsorEntitlement`）？（預設建議：只對「代碼唯一命中」自動開通，email 命中走人工。）
2. **D2**：物件分享／內頁落點用**新 `/p/:id`** 還是沿用／擴充 `/go/:id` 或 `/l/:id`？（本草案建議新 `/p/:id`。）
3. **D3**：分享統計是否併入既有 `rental_analytics_daily` 的 `share_*` metric，還是獨立 `listing_share_*`？（建議後者，避免許願房統計被污染。）
4. **D4**：每會員每日分享連結上限取多少？（建議 20。）
5. **D5**：自動開通門檻金額與效期預設值？（建議 `minAmountTWD=300`、`one_time`、30 天；金額請 Owner 定。）
6. **D6**：物件公開內頁要不要把屋主電話／LINE 給**訪客**，還是只給登入會員？（現況 `publicListingView` 有露 `mobile/phone/line_url`，建議收斂為「登入會員才看得到」。）
7. **D7**：是否允許把 email 帶給第三方收款平台（`sendEmail`）？（建議預設不送、只送代碼。）
8. **D8**：退款（`refunded`）是否自動撤銷 sponsor plan？（建議預設不撤銷、後台手動。）

---

# 風險與踩坑（引用既有教訓）

1. **新增欄位一定要開新 migration version**：`docs/handoffs/20261001-owner-workorder-report.md` §4（migration version 7/8 實例；「只改 ensureXxxSchema 不會生效，本機實測回 no such column」）。本草案 version 9／10 各開新版本。
2. **PG async 島嶼與同步分支要一起改**：`rental_share_events` ／`support_transaction` 等都要有同步版與 async 版（`support.js`／`supportAsync.js` 雙分支，`share-events-async.test.js` 形狀）。
3. **`[hidden]` 輸給 `display:flex`**：A5 教訓——自動化斷言（`hidden` 屬性）全綠、畫面卻錯。內頁訪客遮蔽（屋主電話／來源晶片）驗收要用**截圖**，不能只靠 DOM 斷言。
4. **自動化斷言全綠 ≠ 畫面對**：分享按鈕、內頁、OG meta 都要上實機截圖（375/768/1440）驗收，見 `docs/handoffs/20261001-owner-workorder-report.md` §5。
5. **外部來源第一線 fail-soft**：webhook／API 輪詢逐筆 try/catch；401/403/429/503 暫停該 provider、不整批歸零（§2.5.2）。
6. **第三方 URL／憑證不落地**：channels URL 與出站 URL 由伺服器組；`secret_ref` 只存鍵名、值從 env 解析（`supportProviders.js:118`）。

---

（完）
