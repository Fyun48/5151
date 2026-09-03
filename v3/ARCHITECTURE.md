# 5151 ver. 3.11

線上：

- v1：已停用。原始碼仍在 `src/` + `public/`，埠 5151／`https://a5151.reversalplay.me` 不再是正式站；資料 `591.db` 可只讀匯入
- v2：`v2/`，埠 5152，`https://b5151.reversalplay.me`，資料 `data-v2/v2.db`（不再改功能）
- 本目錄：埠 5153，`https://c5151.reversalplay.me`，資料 `data-v3/v3.db`

之後功能只做這份。畫面上的產品名仍是「吉比租房物件追蹤」，版本只在頁尾寫 `ver. 3.11`。

## 這版多了什麼

- 行動底欄：找房／需求／通知／我的；MAIL 與 Webhook 收到「我的」
- PWA + Web Push（不必下載 App；iPhone 請加到主畫面）
- 公開租屋需求牆（欄位化、額度、檢舉；不做即時私訊）
- 物件 `source` 與後台來源爬蟲開關，方便之後接其他平台
- 預設通知：站內 + 系統推播；郵件／Webhook 選用

啟動時若掛得到 v2 的 `v2.db`（容器 `/v2-data/v2.db`），會只讀補尚未存在的刊登與快取，不寫回 v2。
