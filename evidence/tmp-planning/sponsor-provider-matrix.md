# 贊助管道能力矩陣（外部整合研究）

> 目的：把「站內會員身分（nickname || email）帶到外部贊助頁」＋「回抓贊助紀錄自動開通 sponsor」
> 在 7 家管道＋純外部網址上的可行性整理成矩陣。
>
> 產生日期：2026-10-06。所有「官方文件 URL + 1~2 行原文摘錄」為證據；查無官方文件的項目一律標「查無官方文件，需實測」，不臆測。
> 本文不含任何金鑰／token 值，只寫「欄位名／env 鍵名」。

## 0. 既有資產摘要（已盤點，僅列與本文件相關者）

- 站內：`users.nickname`、`users.email`、`users.plan ∈ {free, sponsor}`；顯示名 = `nickname || email`。
- 後台 `settings.sponsorLinks`：預設 7 家 `{url, enabled, label}`，前端 `<a target="_blank">` 直開外部網址。
- 既有金流抽象：`supportProviders.js` adapter（`getCheckoutUrl()`、`verifyWebhook()`）；`supportSchema.js`
  的 `support_transaction`（`provider`、`provider_transaction_id`、`supporter_user_id`、`supporter_name`、
  `supporter_email`、`amount`、`status`、`message`、`channel`、`received_at`、`anonymous`、`raw_reference`）；
  webhook 端點 `/api/support/webhook/:provider` 已存在但驗證皆 stub（回 501）。
- 同意機制慣例：`v3/src/memberConsents.js` 的 `member_consents` 表（`user_id, document_type, document_id,
  version, content_hash, source, agreed_at`），**append-only**（BEFORE UPDATE/DELETE 觸發器擋修改），
  `recordConsent(db, userId, {document_type, document_id, version, content_hash, source})`、`hasExactConsent()`
  以 `document_id + content_hash` 判定。

---

## ① 總表

| 管道 | 出站能否帶身分 | 回抓能力 | 可靠匹配鍵 | 建議機制 | 自動化程度 | 需要的金鑰（env 鍵名建議） |
|---|---|---|---|---|---|---|
| Buy Me a Coffee | 無 URL 參數預填留言（查無官方文件）；替代＝留言欄貼代碼 或 Extras「問題欄」 | **有**：REST API（`/v1/supporters`、`/v1/subscriptions`）＋ webhook（16 種事件，`x-signature-sha256` 簽章） | 單次捐款 email 被遮罩；用「贊助代碼」放留言（`support_note`） | (c) webhook 即時 + (d) API 輪詢 + (b) 代碼貼留言 | **中** | `BMC_ACCESS_TOKEN`、`BMC_WEBHOOK_SECRET` |
| Ko-fi | 無 URL 參數預填留言（查無公開官方文件）；替代＝留言欄貼代碼 | **有 webhook**（即時通知）；無公開 REST 輪詢 API（需登入後台開 OAuth App） | 一般捐款**不回傳 email**，只有 `from_name`+`message`；用代碼 | (c) webhook 即時 + (b) 代碼貼留言 | **中低** | `KO_FI_VERIFICATION_TOKEN`（API v2 另加 `KO_FI_CLIENT_ID`/`KO_FI_CLIENT_SECRET`） |
| PayPal（PayPal.Me） | 無（靜態連結，無 query 參數／無 webhook） | 無 | 無（只能人工看帳） | (e) 人工 | **低** | 無 |
| PayPal（Buttons/Orders API v2） | **有**：建立訂單時 `purchase_units[].custom_id`（對付款人不可見）／`invoice_id`／`reference_id` | **有**：webhook `PAYMENT.CAPTURE.COMPLETED` 等＋輪詢 `GET /v2/checkout/orders/{id}` | `payer.email_address` 精確匹配 或 `custom_id` 直接綁定 | (a) API 建單帶 custom_id + (c) webhook + (d) 輪詢 | **高** | `PAYPAL_CLIENT_ID`、`PAYPAL_CLIENT_SECRET`、`PAYPAL_WEBHOOK_ID` |
| 歐付寶 allPay/opay | **有**：AioCheckOut 訂單 `MerchantTradeNo`（唯一，≤64 字）當綁定鍵；`TradeDesc`/`ItemName` 可放文字 | **有**：`ReturnURL` Server POST 通知＋訂單查詢 API＋退款 API（無 webhook 訂閱，只有單向回傳） | `MerchantTradeNo`（產生訂單時已綁 user）；**無付款人 email 回傳** | (a) 產生訂單綁 MerchantTradeNo + (c/d) ReturnURL＋查詢 | **高**（需已登入） | `OPAY_MERCHANT_ID`、`OPAY_HASH_KEY`、`OPAY_HASH_IV` |
| ezPay 簡單付 | 「收款連結」為靜態網址，查無公開 query／API 文件（官網 403） | 查無公開 webhook/API 文件 | 未知（需實測） | (e) 人工（或實測後若有備註欄→代碼） | **低** | 若開放 API 再定（`EZPAY_HASH_KEY`/`EZPAY_HASH_IV` 等，需實測） |
| OEN 幫收 Link | 「幫收 Link」為收款網址，查無公開 query／文件（docs.oen.tw 為 SPA，僅內部 API） | 未見公開 webhook 文件（內部 API 有 `refunded` 狀態但非公開串接文件） | 未知（需實測） | (e) 人工（或實測後代碼） | **低** | 若開放 API 再定（`OEN_*`） |
| GitHub Sponsors | 無留言欄／無 URL 參數（只選 tier） | **有**：webhook `sponsorship`（6 種 action）＋ GraphQL `SponsorsActivity`/`Sponsorship` | GitHub username（login）；**email 不暴露** | (c) webhook + (d) GraphQL 輪詢 + OAuth 綁 GitHub 帳號 | **中**（需綁 GitHub） | `GITHUB_APP_ID`、`GITHUB_APP_PRIVATE_KEY`、`GITHUB_WEBHOOK_SECRET` |
| 純外部網址（銀行轉帳／街口收款頁） | 銀行轉帳備註欄可手動寫代碼；街口視該頁有無備註欄 | 無 API/webhook | 代碼放轉帳備註 | (e) 人工登帳 + 代碼 | **低** | 無 |

---

## ② 各家細節與證據

### Buy Me a Coffee（bmc）

1. **帶身分**：官方文件**沒有**任何「預填留言／自訂欄位」的 URL query 參數（查無官方文件，需實測）。
   替代方案有二：
   - 贊助留言欄：單次贊助的留言會以 `support_note` 回傳，可讓會員把「贊助代碼」貼上去。
   - **Extras（數位商品）**：可設「問題欄」要求買家填答——API 回傳 `purchase_question`（問題文字）、
     且 Extras 有 `reward_question` 欄位（見下方證據）。等於一個可程式化「自訂欄位」，比純留言更可靠，但
     要先生成一個數位商品並把答案回傳欄位接起來（答案欄位名需實測）。
   - 證據（API Reference `/v1/extras` 範例）：`"purchase_question": "share your email?"`、
     `"reward_question": "What is your zoom id?"`
     來源：<https://developers.buymeacoffee.com/apireference.md>

2. **回抓**：
   - REST API（Personal Access Token，於 developers.buymeacoffee.com 建立）：
     - `GET /v1/supporters`（單次贊助）、`GET /v1/subscriptions`（訂閱／會員）、`GET /v1/extras`（數位商品）。
     - 認證 header：`Authorization: Bearer <ACCESS_TOKEN>`。
     - 證據：`curl https://developers.buymeacoffee.com/api/v1/supporters -H "Authorization: Bearer ACCESS_TOKEN"`
     - 速率限制：官方文件未載明（需實測）。無付費方案門檻（創作者免費，read-only）。
   - Webhook（16 種事件）：`donation.created`、`donation.refunded`、`extra_purchase.created`、
     `membership.started`、`membership.updated`、`membership.cancelled`、`recurring_donation.started`… 等。
     - 簽章 header：`x-signature-sha256`＝HMAC-SHA256(raw body, signing secret)。
     - 失敗重試：指數延遲最多再加 4 次；連續 10 次失敗會自動停用 webhook。
     - 證據（官方 webhook 文件）：事件表＋「Every webhook request includes the following header:
       `x-signature-sha256`」；來源：<https://studio.buymeacoffee.com/webhooks/docs>

3. **可靠匹配鍵**：**email 不可靠**。單次支持者 REST 回傳裡 `payer_email`／`supporter_email` 是遮罩值
   （`"payer_email": "****@gmail.com"`、`"support_email": "****@gmail.com"`）；訂閱 `/v1/subscriptions` 範例
   顯示完整 email 但需實測。webhook `DonationData` 有 `supporter_email` 欄位（是否遮罩需實測）。
   → 因此建議「站內產生贊助代碼（如 `JIBBY-7K3M9`）請對方貼在留言」。成功率取決於對方願不願意貼：
   預期**中**。風險：留言非必填、會漏貼／打錯。

4. **建議機制**：(c) webhook 即時為主 + (d) API 輪詢 `/v1/supporters` 當 fallback + (b) 代碼貼留言。
   自動匹配率：**中**。

5. **金鑰與存放**：
   - `BMC_ACCESS_TOKEN`（API token，放 `Authorization: Bearer` header）。
   - `BMC_WEBHOOK_SECRET`（webhook signing secret，驗 `x-signature-sha256`）。
   - 兩者都存進 `support_provider.secret_ref`（**只存名稱**，值放伺服器 env／secret 檔）。

### Ko-fi（kofi）

1. **帶身分**：Ko-fi 頁面 URL（`https://ko-fi.com/{username}`）**無公開官方 query 參數**可預填留言
   （查無官方公開文件，需實測）。替代：留言欄貼代碼；或改用 Ko-fi **Shop／Commission**（該兩類有
   email＋留言欄位，可讓對方填代碼）。

2. **回抓**：
   - **Webhook 是主要管道**：付款當下即時 POST 到你在 `ko-fi.com/manage/webhooks` 設的 URL，內容含
     「誰贊助、多少錢」。
     - 證據（官方 help 文章）："Webhooks are automated messages sent when something happens on a platform…
       This message contains all the important details about the event, like who donated and how much."
       來源：<https://help.ko-fi.com/hc/en-us/articles/360004162298>（Wayback 2024-04-12 快照）
     - 驗證：payload 內 `verification_token` 欄位（與你在後台設定的 token 比對）。
     - 事件類型：Donation／Shop Order／Commission／Subscription。
   - **輪詢 API**：公開 REST 面極少。第三方掃描結論「no public REST surface found on ko-fi.com」
     （來源：<https://integrations.sh/ko-fi.com/>，第三方，僅佐證）。Ko-fi 另有 OAuth API v2（需登入後台
     建立 API App），但公開文件不完整（查無官方公開文件，需實測）。

3. **可靠匹配鍵**：一般捐款 webhook **不回傳 email**（隱私設定），只有 `from_name`＋`message`；
   Shop Order／Commission 才有 `email`。→ 用「贊助代碼」放 `message` 留言。成功率取決於貼留言意願：
   預期**中低**（留言非必填）。

4. **建議機制**：(c) webhook 即時 + (b) 代碼貼留言。無可靠輪詢 API 可 fallback。自動匹配率：**中低**。

5. **金鑰與存放**：
   - `KO_FI_VERIFICATION_TOKEN`（webhook 驗證 token，比對 payload `verification_token`）。
   - 若採用 API v2：`KO_FI_CLIENT_ID`、`KO_FI_CLIENT_SECRET`（OAuth2，需實測端點）。
   - 存進 `support_provider.secret_ref`（只存名稱）。

### PayPal（paypal）：分兩支討論

#### PayPal.Me（現行 sponsorLinks 的 paypal 管道）

1. **帶身分**：`paypal.me/{username}/{金額}` 是靜態連結，**無官方 query 參數**可預填備註／自訂欄位。
   官方頁面只說「要求付款」時可以「添加個人化附註」（人為操作，不是 URL 參數）。
   證據（PayPal.Me 官方頁）："輸入你想要求的金額…您甚至可以添加個人化附註。"
   來源：<https://www.paypal.com/paypalme/>
2. **回抓**：無 API／無 webhook（PayPal.Me 是消費者產品，不是 Orders API）。
3. **匹配鍵**：無程式化匹配；只能靠付款人在 PayPal 備註手動寫代碼，或站長人工看 PayPal 交易紀錄。
4. **建議機制**：(e) 人工。自動匹配率：**低**。
5. **金鑰**：無。

#### PayPal Buttons / Orders API v2（可程式化，建議用這支取代 PayPal.Me）

1. **帶身分**：**有，且是最佳實作**。伺服器先 `POST /v2/checkout/orders` 建立訂單，在
   `purchase_units[].custom_id` 放站內 user id／贊助代碼，再把付款人導到 approve 連結。
   證據（官方 schema）：`custom_id`＝"The API caller-provided external ID. Used to reconcile client
   transactions with PayPal transactions. … **not visible to the payer**."（對付款人不可見＝不會外洩身分）。
   來源：<https://developer.paypal.com/api/orders/v2/schema.json>
   （另有 `invoice_id` ≤127 ASCII、`reference_id` 可作備用鍵。）

2. **回抓**：
   - Webhook：`PAYMENT.CAPTURE.COMPLETED`（付款完成→開通）、`PAYMENT.CAPTURE.REFUNDED`（退款→撤銷）、
     `PAYMENT.CAPTURE.DENIED`、`CHECKOUT.ORDER.APPROVED` 等。
     證據："`PAYMENT.CAPTURE.COMPLETED` - Listen for this webhook and then fulfill the order."
     來源：<https://developer.paypal.com/payment-methods/webhooks>
     - 驗證：header `PayPal-Transmission-Id`／`PayPal-Transmission-Time`／`PayPal-Transmission-Sig`／
       `PayPal-Cert-Url`／`PayPal-Auth-Algo`，或把 webhook_id＋headers 回 POST
       `/v1/notifications/verify-webhook-signature`。
     來源：<https://developer.paypal.com/api/rest/webhooks>
   - 輪詢：`GET /v2/checkout/orders/{id}` 回傳 `payer.email_address`、`payer.payer_id`、
     `purchase_units[].payments.captures[].custom_id`。
   - 認證：OAuth2 client-credentials（client_id + secret → access token）。速率限制：有（官方依 endpoint
     設每分鐘上限，本次未記錄具體數字，詳 API 參考）。

3. **可靠匹配鍵**：**email 可精確匹配**。官方 schema：`payer.email_address`＝"The email address of the
   payer."、`payer.payer_id`＝"The PayPal-assigned ID for the payer."；且 `custom_id` 是我們自己放的鍵，
   回傳即完成綁定。來源：<https://developer.paypal.com/api/orders/v2/schema.json>

4. **建議機制**：(a) 伺服器建單帶 `custom_id` + (c) webhook 即時 + (d) 輪詢 fallback。
   自動匹配率：**高**。

5. **金鑰與存放**：
   - `PAYPAL_CLIENT_ID`、`PAYPAL_CLIENT_SECRET`（OAuth2）。
   - `PAYPAL_WEBHOOK_ID`（驗證 webhook 簽章用）。
   - 存進 `support_provider.secret_ref`（只存名稱）。

### 歐付寶 allPay/opay（opay）

1. **帶身分**：**有**。伺服器產生 AioCheckOut 訂單時，`MerchantTradeNo`（會員交易編號，**唯一、不可
   重複、英數字 ≤64**）就是綁定鍵——每次會員點擊時產生唯一編號並記住對應 `user_id`。
   `TradeDesc`（交易描述 ≤200）／`ItemName`（商品名稱）可放顯示文字。
   證據（官方技術文件 O_Pay_011.pdf）："MerchantTradeNo 會員交易編號…會員交易編號均為唯一值，不可重複
   使用…英數字大小寫混合"。
   來源：<https://www.opay.tw/Content/files/O_Pay_011.pdf>
   （注意：歐付寶**沒有** ECPay 那種 `CustomField1~4`，也**不回傳付款人 email**。）

2. **回抓**：
   - `ReturnURL`：付款完成後歐付寶以 Server POST 把結果（`RtnCode`、`TradeNo`、`TradeAmt`、
     `PaymentType`、`PaymentDate`、`CheckMacValue`…）回傳到你的網址，須回應 `1|OK`。若沒回應正確，
     5~15 分鐘重發 3 次、再延至隔天。
   - 訂單查詢 API（`QueryTradeInfo`）、退款 API（信用卡關帳/退刷/取消、會員通知退款、會員申請撥款/退款）、
     定期定額查詢。
   - 簽章：`CheckMacValue`＝SHA256(HashKey + 參數 + HashIV)。介接路徑：
     `https://payment.opay.tw/Cashier/AioCheckOut/V5`（正式）、`payment-stage.opay.tw`（測試）。
   - 證據：同 O_Pay_011.pdf（ReturnURL／檢查碼機制／查詢與退款 API 章節）。

3. **可靠匹配鍵**：`MerchantTradeNo`（產生訂單當下就綁定 user，**不需要事後 email 匹配**）；
   **無法用 email**（歐付寶不回傳付款人 email）。高。

4. **建議機制**：(a) 產生訂單綁 `MerchantTradeNo` + (c/d) ReturnURL 通知＋訂單查詢 API 對帳。
   自動匹配率：**高**（前提：會員已登入、由我們伺服器代開訂單）。
   （註：目前 repo 用的是歐付寶「快速收款連結」＝靜態連結、無回調 → 只能人工；要自動化必須改用
   AioCheckOut API。）

5. **金鑰與存放**：
   - `OPAY_MERCHANT_ID`、`OPAY_HASH_KEY`、`OPAY_HASH_IV`（簽章用，由歐付寶後台提供）。
   - 存進 `support_provider.secret_ref`（只存名稱）。

### ezPay 簡單付（ezpay）

1. **帶身分**：repo 既有提示是「登入 ezPay 簡單付後台 → 收款連結 → 產生收款連結」複製 https 網址。
   此「收款連結」為**後台產生的靜態網址**；官方網站（ezpay.com.tw）對未登入請求回 403，
   **查無公開 query 參數／API 文件**，需實測。
2. **回抓**：**查無公開 webhook／API 文件**。個人「收款連結」是否提供伺服器回調需實測。
   （ezPay 簡單付屬藍新科技 NewebPay 體系，其「藍新金流 MPG」有完整 API，但「簡單付個人收款連結」
   不在公開文件中。）
3. **匹配鍵**：未知（需實測）；保守做法＝若收款頁有備註欄，用代碼。
4. **建議機制**：(e) 人工登帳（或實測後改代碼）。自動匹配率：**低**。
5. **金鑰**：查無；若後續開放 API 再定（`EZPAY_*`），存 `support_provider.secret_ref`。

### OEN 幫收 Link（oen）

1. **帶身分**：「幫收 Link」為收款網址。docs.oen.tw 是前端 SPA，只暴露內部 API（`api.oen.tw`、
   `openapi.oen.tw`、`subscription-api.oen.tw`），**未見公開 query 參數／串接文件**；查無官方公開文件，
   需實測。
2. **回抓**：**未見公開 webhook 文件**。內部 API 有 `refunded`／`partial_refund` 訂單狀態（見其前端
   bundle 的 `/crm/{id}/orders` 查詢），但那不是給第三方公開串接的文件。
3. **匹配鍵**：未知（需實測）；保守＝代碼放備註（若收款頁有）。
4. **建議機制**：(e) 人工（或實測後改代碼）。自動匹配率：**低**。
5. **金鑰**：查無；若後續開放再定（`OEN_*`），存 `support_provider.secret_ref`。

### GitHub Sponsors（github）

1. **帶身分**：GitHub Sponsors **沒有留言欄、沒有 URL 參數**，贊助者只選 tier（月訂閱或一次性）。
   無法把文字帶進去。替代：請會員先 OAuth 綁定 GitHub 帳號（或手動填 GitHub username），以 username 匹配。

2. **回抓**：
   - Webhook `sponsorship`：action 有 `created`／`cancelled`／`edited`／`pending_cancellation`／
     `pending_tier_change`／`tier_changed`；webhook 只能在 GitHub.com 對你的 sponsored account 建立，
     需 GitHub App `sponsors_listing` 權限，簽章 header `X-Hub-Signature-256`。
     證據："A sponsorship was cancelled and the last billing cycle has ended. This event is only sent when a
     recurring (monthly) sponsorship is cancelled; it is **not sent for one-time sponsorships**."
     來源：<https://docs.github.com/en/webhooks/webhook-events-and-payloads#sponsorship>
   - GraphQL API：`SponsorsActivity`（`action` 含 `NEW_SPONSORSHIP`、`CANCELLED_SPONSORSHIP`、`REFUND`、
     `TIER_CHANGE`…）、`Sponsorship`（`sponsor`、`tier`、`isOneTimePayment`、`privacyLevel`、`createdAt`）。
     來源：<https://docs.github.com/en/graphql/reference/sponsors>

3. **可靠匹配鍵**：只有 GitHub **username（login）**；**email 不暴露**。最可靠＝OAuth 綁 GitHub；
   否則靠會員填 username。注意 `privacyLevel`＝private 時 `sponsor` 可能為 null（拿不到身分）。

4. **建議機制**：(c) webhook 即時 + (d) GraphQL 輪詢 + OAuth 綁 GitHub 帳號。自動匹配率：**中**
   （需先綁 GitHub）。

5. **金鑰與存放**：
   - GitHub App：`GITHUB_APP_ID`、`GITHUB_APP_PRIVATE_KEY`（簽 JWT 取 installation token）。
   - `GITHUB_WEBHOOK_SECRET`（驗 `X-Hub-Signature-256`）。
   - 存進 `support_provider.secret_ref`（只存名稱）。

### 純外部網址（銀行轉帳／街口收款頁，無回調）——通用做法

1. **帶身分**：無 API、無回調。銀行轉帳可請付款人於**網銀轉帳備註欄**手動打贊助代碼；街口收款頁
   視該頁有無備註欄（多數收款 QR 無備註欄 → 需實測）。
2. **回抓**：無。只能人工查銀行對帳單／街口後台交易紀錄。
3. **匹配鍵**：贊助代碼放轉帳備註；漏寫／打錯率高 → 匹配成功率**低**。
4. **建議機制**：(e) 人工登帳 + 代碼。自動匹配率：**低**。
5. **金鑰**：無。

---

## ③ 通用規則建議

### 3.1 小額單次贊助是否直接開通 sponsor

- **業界常見做法**：一次性打賞（one-time donation）與「訂閱會員權益」是兩回事；多數平台把
  一次性打賞當「感謝」，把「會員權益」綁在月訂閱或累計門檻上。真正有「訂閱」語意的只有：
  BMC membership、Ko-fi 月訂閱、GitHub Sponsors、PayPal Subscription。其餘（PayPal 單次、歐付寶、
  ezPay、OEN、銀行轉帳）都是單次付款。
- **建議規則（本專案）**：**不要「每筆小額都開通」**，改採「門檻 + 效期」：
  - 開通門檻（二擇一，可後台設定）：
    - 單筆 ≥ `N` 元（建議 NT$100 起），或
    - 30 天內**累計** ≥ `N` 元（建議 NT$200 起）。
  - 效期：開通後 `X` 天（建議 30 天），可被後續贊助續期；到期自動降回 `free`。
  - 真「月訂閱」（BMC membership／Ko-fi 月訂閱／GitHub Sponsors／PayPal Subscription）：
    依訂閱事件（started/updated/cancelled）控制，訂閱存續期間維持 sponsor，取消（cancelled）當週期
    結束後降回 free。
- **引用既有權益**（`sponsorLinks.js` 的 `CURRENT_SPONSOR_BENEFITS`）：照片 100 張（一般 30）、
  591/5168 匯入、自動搜尋間隔 5 分鐘（一般 8）、多來源篩選、特別關注 15 筆（一般 6）。
  開通 sponsor 即解鎖這組權益，到期收回。

### 3.2 防濫用

- **同 email／同筆交易重複入帳**：以 `provider + provider_transaction_id` 唯一索引做冪等（
  `support_transaction` 已建 `idx_support_tx_provider_id`）；同一平台交易只入帳一次。
- **匿名贊助**：`anonymous` 欄位已存在；匿名（無匹配鍵）**不自動開通**，進人工佇列。
- **代碼外流被別人用**：贊助代碼＝一次性、綁 `user_id`、短效期（建議 24h）、用完即失效。若他人輸入
  已綁定代碼 → 拒絕並提示「代碼已被使用／不屬於你」，不把權益給錯人。
- **退款（refunded）撤銷**：收到 `donation.refunded`／`PAYMENT.CAPTURE.REFUNDED`／GitHub `REFUND` 等
  事件 → 把對應 `support_transaction.status` 改 `refunded`，並**撤銷該筆所貢獻的 sponsor 效期**（若
  效期源自該筆）；保留完整帳務紀錄不刪。

### 3.3 個資與告知義務

- **預設不送 email，只送代碼（最小化）**。對「伺服器建單」型管道（PayPal Orders API、歐付寶
  AioCheckOut），身份在我們後端用 `custom_id`／`MerchantTradeNo` 綁定，**根本不需要把 email 送給第三方**。
- 只有當「必須把 email／暱稱送到第三方頁面」時（例如用 BMC Extras 問題欄自動帶入 email 以精確匹配），
  才需要會員同意，且沿用 `memberConsents.js` 慣例：
  - `recordConsent(db, userId, { document_type: 'sponsor_third_party_share', document_id, version,
    content_hash, source })`，append-only；
  - UI 勾選框明示「將把你的暱稱／email 傳給 {平台} 以完成贊助核對」，版本號＋內容 hash 存檔，
    未來條款變更需重新取得同意（`hasExactConsent` 以 `document_id + content_hash` 判定）。
- 結論：**預設只送代碼、不送 email**；email 傳遞改為 opt-in + 同意紀錄。

---

## ④ 無法自動化、必須人工的清單

| 管道／情境 | 為什麼只能人工 | 可改善方向 |
|---|---|---|
| PayPal.Me（現行） | 靜態連結、無 webhook/API | 改用 PayPal Orders API v2 可全自動 |
| 歐付寶「快速收款連結」（現行） | 靜態連結、無回調 | 改用 AioCheckOut API（MerchantTradeNo）可全自動 |
| ezPay 簡單付「收款連結」 | 查無公開 API/webhook | 需向 ezPay／藍新確認個人收款連結是否有 API；否則維持人工 |
| OEN 幫收 Link | 查無公開 API/webhook | 需向 OEN 確認是否有公開串接；否則維持人工 |
| 銀行轉帳／街口收款頁 | 無回調、備註非結構化 | 無解（本質人工對帳），只能靠代碼降低錯配 |
| 匿名贊助／留言漏貼代碼的款項 | 無匹配鍵 | 進人工比對佇列；UI 強化「請務必貼代碼」提示 |

---

## 附錄：證據來源清單（官方文件 URL）

1. Buy Me a Coffee API Reference：<https://developers.buymeacoffee.com/apireference.md>
   （`/v1/supporters`、`/v1/subscriptions`、`/v1/extras`、`Authorization: Bearer`、email 遮罩範例）
2. Buy Me a Coffee Webhooks：<https://studio.buymeacoffee.com/webhooks/docs>
   （16 事件、`x-signature-sha256`、重試 4 次）；OpenAPI payload 規格：
   <https://cdn.buymeacoffee.com/assets/integrations/bmc-webhooks-openapi.json>
3. Ko-fi help「Does Ko-fi have an API or webhook」：
   <https://help.ko-fi.com/hc/en-us/articles/360004162298>（Wayback 2024-04-12 快照）
4. PayPal Orders API v2：<https://developer.paypal.com/api/orders/v2>（schema：
   <https://developer.paypal.com/api/orders/v2/schema.json>，`custom_id`／`payer.email_address`／`payer_id`）
5. PayPal Webhooks（訂閱 checkout webhooks）：<https://developer.paypal.com/payment-methods/webhooks>
6. PayPal Webhooks API Reference：<https://developer.paypal.com/api/rest/webhooks>（簽章驗證方式）
7. PayPal.Me 官方頁：<https://www.paypal.com/paypalme/>
8. 歐付寶全方位金流介接技術文件：<https://www.opay.tw/Content/files/O_Pay_011.pdf>
   （`MerchantTradeNo`、`ReturnURL`、`CheckMacValue`、查詢/退款 API、介接路徑 `payment.opay.tw/Cashier/AioCheckOut/V5`）
9. GitHub Sponsors Webhook：<https://docs.github.com/en/webhooks/webhook-events-and-payloads#sponsorship>
10. GitHub Sponsors GraphQL Reference：<https://docs.github.com/en/graphql/reference/sponsors>
11. 次要佐證（非官方）：Ko-fi 無公開 REST 面 — <https://integrations.sh/ko-fi.com/>
