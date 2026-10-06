# 分享／贊助身分連動／物件內頁 設計規劃

日期：2026-10-06　作者：Planner agent（研究與原型由 8 個 worker 分工產出）
狀態：**設計提案，尚未實作**。所有附錄與原型在 `evidence/tmp-planning/`。
範圍：只做 v3（`v3/src`、`v3/public`）。本文件不含任何實作變更。

---

## 0. 結論速覽（直接回答 Owner 的三個問題）

### Q1 導入 Buy Me a Coffee 時，能帶出他在吉比租屋網的暱稱嗎？沒有暱稱就用註冊 email？
**可以，但要分兩軌，不能假設 BMC 會自動帶入。**

- 「暱稱 → 沒有就用 email」這層**站內已有現成邏輯**（`display_name = nickname || email`，見 `v3/src/members.js` 的 `publicUser()` 與 `v3/src/server.js` 的 `/api/me` 投影），不用重做。
- 實測結論（詳附錄 `evidence/tmp-planning/sponsor-provider-matrix.md`）：BMC **沒有官方預填留言的 URL 參數**，且單次贊助回傳的 `payer_email` 是**遮罩值**（`****@gmail.com`）；Ko-fi 捐款 webhook 也不回 email。所以「帶暱稱」只能當**給人看的線索**，真正可靠的對帳鍵是**贊助代碼**。設計採雙軌：
  - **軌 1（平台支援時）**：出站連結帶官方支援的參數，把身分或代碼直接帶進留言/備註欄。
  - **軌 2（通用保底）**：站內產生一組**贊助代碼**（例 `JIBBY-7K3M9`），出發前用確認卡顯示「將帶出的身分」＋代碼＋「複製」按鈕，並用一句話請會員在贊助頁留言欄貼上代碼。代碼是**最可靠的對帳鍵**，不依賴平台能力。
- 出發前的確認卡提供三個選項：**用暱稱（預設）／改用 email／完全匿名（只帶代碼）**。預設**不把 email 送給第三方**，只有會員主動選 email 才送（個資最小化，詳 §3.6）。

### Q2 能回抓有贊助的會員、直接開通成贊助會員嗎？
**可以，但要接受「不是每家都能全自動」。** 設計成三層回抓、一條共用開通管線：

1. **webhook 即時**：BMC（16 種事件、`x-signature-sha256` 簽章）與 Ko-fi（payload 內 `verification_token`）都有 webhook。目前 repo 的 `/api/support/webhook/:provider` 端點已存在但驗證全是 stub（回 501），要補簽章驗證。
2. **API 輪詢**：只有部分家有（BMC `GET /v1/supporters`、PayPal Orders `GET /v2/checkout/orders/{id}`、歐付寶查詢 API、GitHub GraphQL）；**Ko-fi 沒有公開 REST 輪詢**。輪詢掛在既有 5 分鐘 tick 上，逐家拉贊助紀錄寫進既有的 `support_transaction` 表（欄位已夠：`supporter_user_id`、`supporter_email`、`supporter_name`、`message`、`amount`、`status`）。
3. **人工登帳**：無回调的管道（銀行轉帳、街口收款頁）保留既有手動登帳入口，但升級成「會員貼交易編號/金額/時間 → 後台一鍵核對開通」。

匹配優先序：**贊助代碼 > email > 人工審核佇列**。匹配成功 → 走同一條 `applySponsorEntitlement()` 管線：`setUserPlanAsync(userId,'sponsor')` ＋ 寄 `sponsor_thanks` 感謝信 ＋ 寫 `admin_audit` 稽核 ＋ 冪等（同一筆交易不重複開通）；退款（refunded）的處理依決策 D8（規格建議預設不自動撤銷、後台手動）。
開通門檻（單筆金額／累計金額／月度訂閱）與效期（到期降回 free）**全部後台可設定**，新功能 flags 一律預設關。

> ⚠️ **這是行為變更，需要 Owner 拍板**：現行設計與歷史結論都是「付款不會自動改會員方案，站長手動改『已贊助』」（`v3/src/sponsorLinks.js` 的 `DEFAULT_SPONSOR_INTRO`、v2 後台 hint、`support_transaction.status` 有 `manual`）。自動開通是推翻這個決策，見 §7 決策 D1。

### Q3 這套邏輯能套用在「每一種已啟用的贊助連結」嗎？
**可以，用「provider capability 宣告」做統一抽象**，而不是為每家寫一條 if：

- 每家管道宣告自己的能力：`{ supportsPrefill, supportsWebhook, supportsApiPoll, matchKeys: ['code','email'] }`。
- 出站一律走 `buildSponsorOutbound(providerId, configuredUrl, { code, displayName, email })`（擴充 `v3/src/sponsorLinks.js`），前端**不寫死任何第三方網址**（既有鐵則）。
- 回抓一律先寫 `support_transaction`，再走同一條對帳→開通管線。
- 無回调的管道自動**降級**為「代碼＋人工登帳」，功能不中斷、只是自動化程度較低。
- 後台「贊助連結」預設 7 家（歐付寶、ezPay、OEN、Ko-fi、PayPal、Buy Me a Coffee、GitHub Sponsors）＋最多 8 筆自訂連結，全部適用同一套；目前正式站只啟用了站長的 BMC。

### Q4 有房刊登的物件內頁，能做得像 591／租租通那樣簡潔好瀏覽嗎？
**可以，而且現況比想像中更空：外部物件（591/租租通…）目前根本沒有站內內頁**——找房列表點卡片是 `/go/:id` 直接 302 跳回原站；站內只有「站內刊登」的公開分享頁 `v3/public/listing.html`（240 行、無 media query、桌面也是 760px 窄欄、缺坪數/屋齡/押金/租金內含/捷運/地圖/相似物件）。

所以需求④的正確做法是**新建一個通用公開內頁**（站內刊登與外部物件共用），資訊架構對齊 591/租租通、視覺沿用本站 Quiet Luxury token（設計系統明文禁止做成傳統分類廣告站）。目標 IA 與原型見 §4 與 `evidence/tmp-planning/listing-detail-proto.html`。

---

## 1. 現況盤點（證據）

| 主題 | 現況 | 證據 |
|---|---|---|
| 會員模型 | `users`：`role ∈ {member, admin}`、`plan ∈ {free, sponsor}`、`nickname` | `v3/src/personalSchema.js`、`v3/src/members.js:41-47` |
| 登入 | HMAC 簽章 session cookie `591_session`（非 JWT）；`readSession(req)`／`requireAuth()` | `v3/src/auth.js` |
| 分享 | **沒有** LINE/Threads/FB 一鍵分享（grep 零命中）；只有「許願房」的第一方分享歸因 | `v3/src/rentalShareGrowth.js`、`v3/src/rentalNotify.js:318-332` |
| 分享統計 | `rental_share_events` 表＋`rental_analytics_daily`＋`bumpAnalytics()`；含 bot 偵測、去重、view 限流 20/分/訪客 | 同上 |
| 公開分享頁 | `/l/:id` → `listing.html`，**只服務站內刊登**；無 OG/canonical meta | `v3/src/server.js:3750`、`v3/src/openLink.js` |
| 外部物件內頁 | **不存在**；`/go/:id` 302 導回 591/原站 | `v3/src/openLink.js:9-18` |
| 贊助連結 | 後台 `settings` key=`sponsorLinks`，7 家＋自訂；前端 `<a target=_blank>` 裸外連，**不帶任何身分** | `v3/src/sponsorLinks.js`、`v3/public/index.html` |
| 贊助對帳 | `support_transaction` 表已建、webhook 端點已建但驗證全 stub；**開通只能管理員手動** | `v3/src/supportSchema.js`、`supportProviders.js`、`v3/src/server.js:1776-1788` |
| 贊助權益 gate | 間隔 5/8 分、照片 100/30、關注 15/6、591 匯入、範本 5/2 —— 現成可沿用 | `settingsState.js`、`memberMedia.js`、`watchLimits.js`、`listingImport.js`、`listingTools.js` |
| 排程 | 60s `tick("schedule")`＋3 支 5 分鐘 tick；多節點互斥 `scheduler_locks` | `v3/src/server.js:4317-4335,5093-5102`、`v3/src/jobQueue.js:96-137` |
| 遷移慣例 | `ensureXxxSchema()`＋`schemaMigrations.js` 加 version（目前最大 **version 8**）；**加欄位一定要開新 version** | `v3/src/schemaMigrations.js:70-124` |

分享意圖端點實測（2026-10-06，curl 帶瀏覽器 UA）：
- `https://social-plugins.line.me/lineit/share?url=…` → 302 進 LINE OAuth 同意頁，**url 有保留**。
- `https://www.threads.net/intent/post?text=…` → 301→threads.com 登入頁，**text 有保留**。
- `https://www.facebook.com/sharer/sharer.php?u=…&display=popup` → curl 回 400 是 bot 偵測；**瀏覽器實測（2026-10-06，Playwright）正常載入**，未登入時先顯示 FB 登入表單（預期行為：分享者本來就要登入 FB），登入後即為分享對話框。故 FB 通道可行，無需自研。

---

## 2. 需求①：物件一鍵分享＋分享統計＋僅會員可發起

### 2.1 流程
1. 會員在物件內頁（新頁，見 §4）或找房列表點「分享」。
2. 前端先打 `POST /api/listings/:id/share-link`（需登入）→ 後端發一組 `shareToken`、回傳站內公開內頁 URL（`?ref=<shareToken>`）與各管道意圖 URL。
3. 行動版優先用 `navigator.share()`（Web Share API，帶出原生選單：LINE/Threads/FB/IG/訊息…）；不支援或桌面才開自訂面板（LINE／Threads／Facebook／複製連結＋QR）。
4. 未登入點分享：**不跳轉**，顯示「登入會員才能分享」＋登入/註冊 CTA。被分享的頁面**訪客仍可看**（公開內頁），只是不能發起分享。
5. 被點開的公開內頁打公開事件端點記 `view`（沿用 bot 偵測、去重、限流）；會員在頁內的 CTA（註冊/收藏/聯絡）記轉換事件。
6. 統計：會員自己看「我的分享：總點擊/本週/轉換」；後台 `/api/admin/overview` 加分享漏斗卡片。

### 2.2 資料與 API（細節見附錄 `backend-spec.md`）
- 新表：**`listing_share_tokens`＋`listing_share_events`（migration version 9，現況最大 8）**。不重用 `rental_share_events`——既有 `resolveValidShareToken()` 只認 `demand_posts.public_token`（`v3/src/rentalShareGrowth.js:60-69`），混入 subject_type 會髒掉 retention 與統計 join。
- token＝`randomBytes(12).base64url`（96bit）；每會員每日分享連結上限建議 20（決策 D4）。
- 端點：`POST /api/listings/:id/share-link`（requireAuth，401/404/429）、`POST /api/public/listings/:id/share-events`（訪客落地只收 view/cta，轉換一律 server 端記）、`GET /api/me/listings/share-stats`、`GET /api/admin/listings/share-stats`（overview 加 `listingShare` 區塊）。
- 公開內頁 server-render OG meta（`og:title/og:description/og:image/og:url`＋canonical），LINE/FB 展開才有卡片；無圖給品牌佔位圖。
- 統計 metric 沿用 `rental_analytics_daily`（新名 `listing_share_view` 等），**不另立統計表**。

### 2.3 硬約束
- 不接任何第三方追蹤（既有 `rentalShareGrowth.js` 明示「不接第三方追蹤」）。
- 訪客可看、會員才能發起；公開端點只收 view/cta。
- 分享 UI 不得遮住租金/狀態、375 無橫向溢出、觸控 ≥44px。

---

## 3. 需求②：贊助連結帶會員身分＋回抓自動開通

### 3.1 出站（帶身分）
- 擴充 `sponsorLinks.js`：`buildSponsorOutbound(providerId, url, { code, displayName, email })`，依每家 capability 決定帶什麼。
- 前端一律打 `POST /api/support/outbound/:providerId`（需登入）拿「確認卡資料」→ 會員選身分模式（暱稱/email/匿名）＋勾個資告知 → 再拿最終 URL 出站。**前端不組第三方 URL**。
- 確認卡同時顯示贊助代碼＋複製按鈕（軌 2 保底）。

### 3.2 回抓（對帳）——各家實測能力（2026-10-06，證據與原文摘錄見附錄矩陣）

| 管道 | 帶身分（出站） | 回抓 | 可靠匹配鍵 | 自動化 |
|---|---|---|---|---|
| Buy Me a Coffee | 無官方預填參數；留言/Extras 問題欄貼代碼 | webhook（`x-signature-sha256`）＋REST `GET /v1/supporters` | **代碼**（單次 `payer_email` 被遮罩） | 中 |
| Ko-fi | 無預填；留言貼代碼 | 僅 webhook（`verification_token`），**無公開 REST 輪詢** | **代碼**（捐款不回 email） | 中低 |
| PayPal.Me | 無（靜態連結） | 無 | 人工 | 低（死路） |
| PayPal Orders API v2 | 建單時 `custom_id` 綁代碼（官方明訂付款人不可見） | webhook `PAYMENT.CAPTURE.COMPLETED/REFUNDED`＋輪詢 | `custom_id`／`payer.email_address` | 高 |
| 歐付寶 AioCheckOut | `MerchantTradeNo` 綁代碼 | ReturnURL 通知＋查詢/退款 API | 訂單編號 | 高 |
| 歐付寶快速收款連結／ezPay／OEN | 查無公開官方文件 | 查無 | 代碼＋人工 | 低 |
| GitHub Sponsors | 無留言/參數（只選 tier） | webhook `sponsorship`＋GraphQL | OAuth 綁定／代碼 | 中 |
| 自訂（銀行轉帳/街口） | 轉帳備註手動寫代碼 | 無 | 代碼＋人工 | 低（降級） |

要點：
- **email 預設不送第三方、只送代碼**不只是個資選擇，也是技術事實：BMC 單次 email 遮罩、Ko-fi 捐款不回 email、GitHub 不暴露 email。代碼是唯一跨平台可靠的對帳鍵。
- 現行後台可設的歐付寶「快速收款連結」與 PayPal.Me **無法自動化**；要高自動化需改接歐付寶 AioCheckOut／PayPal Orders API（決策 D11）。
- webhook：補 `verifyWebhook()` 簽章驗證；`support_provider.secret_ref` 只存「env 鍵名」，執行期才解析（值不進 DB、不進前端）。
- 輪詢：新 5 分鐘 tick、`scheduler_locks` 互斥、cursor 表記每家最後拉到的時間；**逐筆 try/catch、被擋 401/403/429/503 就暫停該 provider 並記錄，不得整批歸零**（本專案外部來源 fail-soft 硬規則）。
- 人工：會員「找不到贊助紀錄？回報」表單（交易編號/金額/時間/管道）→ 後台審核佇列一鍵開通。

### 3.3 開通管線
`applySponsorEntitlement(userId, { transactionId, reason })`：冪等用新表 `sponsor_entitlement_grant`（`support_transaction_id UNIQUE`）→ `setUserPlanAsync` → `sponsor_thanks` 信 → `appendAdminAuditAsync` → 回寫 `support_transaction.supporter_user_id`。
門檻與效期存 `settings` KV `sponsorEntitlement`、後台可設；**建議預設：單筆 ≥ NT$100 或 30 天累計 ≥ NT$200 → 開通 30 天、到期降回 free；退款事件（`donation.refunded`／`PAYMENT.CAPTURE.REFUNDED`／GitHub REFUND）撤銷該筆效期**（決策 D5/D8；後端規格草案曾寫 300 元，兩者皆可後台調整）。
新 flags 全預設關：`sponsor_code_attribution`／`auto_entitlement`／`api_poll`／`webhook`，且以既有 `flags.sponsor_enabled` 為前提；新表走 **migration version 10**。

### 3.4 套用到每一種已啟用連結
capability 宣告（寫進 `SPONSOR_PROVIDER_CAPABILITIES`）：`{ supportsPrefill, supportsServerOrder, supportsWebhook, supportsApiPoll, matchKeys, secretEnv }`。出站一律 `buildSponsorOutbound()`：可程式化管道（PayPal Orders、歐付寶 AioCheckOut）回「伺服器建單＋`custom_id`/`MerchantTradeNo` 綁代碼」的 approve URL；純外部連結管道回「原網址＋代碼文案」。無回调的管道自動降級為「代碼＋人工登帳」，功能不中斷。
所需金鑰（**只寫鍵名**，值放伺服器 env／`support_provider.secret_ref`）：`BMC_ACCESS_TOKEN`、`BMC_WEBHOOK_SECRET`、`KO_FI_VERIFICATION_TOKEN`、`PAYPAL_CLIENT_ID`／`PAYPAL_CLIENT_SECRET`／`PAYPAL_WEBHOOK_ID`、`OPAY_MERCHANT_ID`／`OPAY_HASH_KEY`／`OPAY_HASH_IV`、`GITHUB_APP_ID`／`GITHUB_APP_PRIVATE_KEY`／`GITHUB_WEBHOOK_SECRET`。`/home/cline/.secrets/INDEX.md` 未收錄者一次問完（決策 D10）。

### 3.5 不得違反的鐵則
- **Support/贊助資料不得進入 listing ranking**（`listingScore.js`、`match.js`、`sortListingsRows` 不得 import support 模組）；要寫對應測試擋住。
- 文案禁止「Donate/捐款/急需資金」；必須保留「沒有支持也不會減少任何功能」。
- flags 預設關；金額用整數最小單位；所有自動開通寫稽核。

### 3.6 個資
- 預設**不送 email**，只送代碼；選 email 才送，且確認卡明示「email 只傳給該平台用於對帳、不會公開顯示」。
- 同意紀錄走既有 `memberConsents.js` 機制加一筆同意項（提案見附錄）。

---

## 4. 需求③：通用物件公開內頁（對齊 591／租租通的資訊架構）

### 4.1 定位
- 新建通用公開內頁：**路由 `/p/:id`＋新頁 `v3/public/detail.html`**，站內刊登與外部物件共用。
- **不動**既有 `/l/:id`＋`listing.html`（`public-share-page.test.js` 有靜態斷言綁它）；分享連結的正式落地頁改指 `/p/:id?ref=<shareToken>`。`/go/:id` 維持「已登入標記已瀏覽＋302 原站」的原語意。
- 對齊的是**資訊架構與決策欄位**，不是 591 的視覺：沿用 Quiet Luxury token、租金 tabular 最大、無 Hero、無玻璃擬態。

### 4.2 目標 IA（桌面 ≥1024 雙欄／行動單欄）
桌面：左照片牆（主圖＋縮圖條＋張數徽章＋lightbox）｜右 sticky 摘要卡（租金/月、押金、標題、核心標籤、地址、收藏/分享/聯絡 CTA）→ 基本資料 key/value 表 → 設備 icon 格 → 交通（捷運步行 N 分鐘/公尺）＋地圖 → 說明 → 屋主/聯絡 → 相似物件 → sticky 錨點導覽。
行動：全寬滑動照片牆 → 租金＋標題＋標籤 → 地址 → 基本資料（兩欄可摺疊）→ 交通一句話 → 設備 → 說明（4 行展開）→ 聯絡 → **底部固定 CTA bar：聯絡／收藏／分享**。

### 4.3 資料補齊（後端已取得但公開 API 沒給/前端沒畫）
`fee_includes`/`fee_include_labels`、`deposit`、`role_name`、`created_at`、捷運步行（`mrt_station`/`mrt_walk_m`/`mrt_walk_km`）、`listing_values`（坪數/樓層/屋齡/型態）、`pledged`、座標、圖片陣列、來源標籤。
訪客視角遮蔽規則沿用：屋主電話只給登入會員；來源晶片只有 admin 與 sponsor 可見。

### 4.4 現況 vs 目標差異（摘要）
| 面向 | 現況 | 目標 |
|---|---|---|
| 首屏 | 單張封面、張數不明 | 照片牆＋縮圖＋張數 |
| 規格 | 一行「型態・格局・行政區・樓層」 | key/value 表格（補坪數/屋齡/押金/租金內含/刊登時間） |
| 交通 | 無 | 捷運步行分鐘＋地圖 |
| 桌面 RWD | 760px 窄欄、無 media query | 雙欄＋sticky 導覽 |
| 底部 CTA | 只有「免費註冊」 | 聯絡/收藏/分享 |
| token | inline 寫死橘色 fallback | 一律 tokens.css 綠系 |
| a11y | lightbox 無 focus trap | 補 focus trap/Esc/焦點返回 |

### 4.5 原型審查紀錄（Planner 複核）
- 原型 `evidence/tmp-planning/listing-detail-proto.html`：桌面雙欄＋sticky 摘要卡＋錨點導覽、行動單欄＋底部固定 CTA bar（收藏/分享/聯絡，44px）均已落實；axe WCAG 2.2 AA 前後 0 critical/0 serious；375/768/1440 皆 `scrollWidth == clientWidth`。
- **實作期必須解決的兩個保留項**：
  1. 原型用 CSS `order` 在行動版把「交通」提到「設備」前，DOM 順序與視覺順序不一致（WCAG 1.3.2 有意義順序的風險）。正式實作要改成「同一 DOM 順序＋斷點內調整版面」或接受兩版 DOM，並用螢幕閱讀器實測。
  2. 相似物件端點目前不存在（`matchCandidatesAsync()` 是爬蟲側候選邏輯），Phase 2 要新開一個公開推薦端點，且**不得 import support/sponsor 模組**（ranking 隔離鐵則）。
- 分享/贊助流程原型（`share-panel-proto.html`、`sponsor-flow-proto.html`） likewise 0 違規、無橫向溢出；文案無禁用字、含自願性說明。原型內的 API 名稱（例 `/api/share/create`）僅供視覺溝通，**正式契約以 `evidence/tmp-planning/backend-spec.md` 為準**。

---

## 5. 共用硬約束（三需求都適用）
1. 新功能只做 v3；Production 部署一律 Owner 手動核准，agent 不得觸發。
2. UI 變更流程：讀 MASTER.md＋pages 覆寫 → ui-ux-pro-max → Figma 規格 → Builder 實作 → Playwright 驗 375/768/1440 → UX Reviewer＋Security Reviewer（不得自審自過）。
3. 遷移：新表/新欄位一律開新 `schemaMigrations` version；SQLite 與 PG async 島嶼兩邊一起改。
4. 外部整合一律 fail-soft：逐筆 try/catch、被擋暫停該家、不得整批歸零；預設關＋fallback＋審計。
5. 憑證只寫檔名與鍵名，值不進 repo/PR/對話。
6. 台灣繁體中文與台灣慣用語。

---

## 6. 分期 rollout（每期可獨立上線與回滾）
- **Phase 1（分享機制）**：migration v9 新表＋4 個分享端點＋分享面板 UI＋OG meta。落地頁暫用既有 `/l/:id`（站內刊登）與 `/go/:id?ref=`（外部物件，302 前先記 view）。驗收：`npm test` 全綠、Playwright 375/768/1440 截圖、a11y AA、未登入按分享回 401 且畫面有引導、`rental_analytics_daily` 查得到 `listing_share_view`。回滾＝關 `listingShareFlags.enabled`（settings KV，預設 true）。
  **狀態（2026-10-06）**：PR #624 已合併（merge `5a89aa0`）並部署正式站（build 37447535689 → predeploy 37447798216 → deploy 37448069650，皆 success）；正式站驗證：share-link 未登入 401、share-events 無效 token 404、admin share-stats 401、`/l/` 200。實機證據見 `evidence/phase1/`；cta 歸因依管道保留（migration v10 重建去重索引）。
- **Phase 2（通用內頁）**：`/p/:id`＋`detail.html`＋`publicListingView()` 擴充＋訪客遮蔽（電話/LINE 登入才可見）＋相似物件＋地圖；分享連結正式改導 `/p/:id?ref=`。驗收：既有 `public-share-page.test.js`／`listing-projection-kind-keys.test.js` 不壞、375 無橫向溢出、無圖 fallback 不 CLS。回滾＝移除路由、還原投影白名單。
  **狀態（2026-10-06）**：已實作並開 PR #625（`/p/:id`＋detail/similar API＋D6 遮蔽＋`detail.html`＋index「站內頁」入口；相似物件改走「同行政區＋租金±20%」公開查詢，不 import support/sponsor）。**分享連結改導 `/p/:id?ref=` 留作後續小改**（Phase 1 已上線用 `/l/`＋`/go/`，兩條落地頁都會記 view）；地圖區塊本期未做（mrt/座標覆蓋率不足，先以捷運步行文字呈現）。
- **Phase 3（贊助連動）**：migration **v11** 新表（v10 已被 Phase 1 的 cta 去重索引重建占用）＋`buildSponsorOutbound()`＋`applySponsorEntitlement()`＋webhook 簽章＋API 輪詢 tick＋後台門檻設定＋人工審核佇列。4 個新 flag 全預設關。驗收：影子站/沙盒跑一輪 mock provider 對帳、冪等與退款撤銷測試、稽核可查、flags 全關時行為與現況完全相同。回滾＝4 flag 全關，回復「手動改已贊助」現狀。

---

## 7. 需要 Owner 拍板的決策
- **D1 自動開通**：是否推翻「付款後站長手動改已贊助」的現行決策？（建議：是，但**只對「代碼唯一命中」自動開通**，email 命中與曖昧 case 進後台人工審核佇列，手動開通入口保留。）
- **D2 分享/內頁落點**：新路由 `/p/:id`（建議）vs 沿用 `/go/:id`（302 抓不到 OG、統計無意義）或 `/l/:id`（語意綁站內刊登、測試綁定）。
- **D3 分享統計命名**：獨立 `listing_share_*` metric（建議）vs 併入既有許願房 `share_*`。
- **D4 分享上限**：每會員每日分享連結上限（建議 20）。
- **D5 開通門檻與效期**：建議預設「單筆 ≥ NT$100 或 30 天累計 ≥ NT$200 → 開通 30 天、到期降回 free」（矩陣建議；後端規格草案曾寫單筆 300 元）。兩者都是後台可調，請 Owner 定**預設值**。
- **D6 訪客聯絡資訊**：公開內頁的屋主電話/LINE 要收斂為「登入才可見」嗎？（現況 `publicListingView()` 有露 `mobile/phone/line_url`，建議收斂。）
- **D7 個資**：是否同意「預設只送贊助代碼、會員主動選才送 email」給第三方收款平台？
- **D8 退款**：refunded 是否自動撤銷 sponsor plan？（建議預設不撤銷、後台手動。）
- **D9 BMC 標籤文案**：SQLite「吉比需要你的支持~來份飼料~!」vs PG「用杯最便宜的咖啡錢贊助吉比本站」尚未裁定（`docs/handoffs/CUTOVER-CONFLICT-DECISIONS-20260927.md`）。
- **D10 金鑰來源**：webhook/輪詢所需各家 API token 放哪個 env／`~/.secrets` 檔（只寫鍵名，清單見 §3.4）；INDEX 沒收錄的就一次問完。
- **D11 金流 API 範圍**：Phase 3 先做「BMC webhook＋輪詢＋代碼＋人工佇列」（覆蓋目前唯一啟用的 BMC）＋Ko-fi webhook；PayPal Orders API v2／歐付寶 AioCheckOut 的「伺服器建單」高自動化是否本期做？（建議列 Phase 4 選配，因為要簽約/建應用與金鑰，且現行設定用的是無法自動化的快速收款連結。）

---

## 8. 證據與產出清單
- 既有頁 a11y 基線：`v3/public/listing.html` 經 axe-core 4.13.0（WCAG 2.2 AA，1440×900）＝**0 違規**（手動項如 lightbox 焦點管理仍欠，見 §4.4）。
- 現況截圖：`evidence/tmp-planning/listing-detail-375.png`／`-768.png`／`-1440.png`
- 內頁原型：`evidence/tmp-planning/listing-detail-proto.html`＋`listing-proto-*.png`
- 分享/贊助流程原型：`evidence/tmp-planning/share-panel-proto.html`、`sponsor-flow-proto.html`＋`share-proto-*.png`、`sponsor-proto-*.png`
- 贊助管道能力矩陣：`evidence/tmp-planning/sponsor-provider-matrix.md`
- 後端技術規格：`evidence/tmp-planning/backend-spec.md`

（本檔為設計提案；實作需另開 PR，且 Production 發版仍需 Owner 明確核准。）
