# Admin / 後台

覆寫範圍：`v3/public/admin.html`。僅管理員。

## Purpose

會員、SMTP、抓取與站務設定。資訊密度高於前台，但仍用同一套 token，不要另做深色炫光後台。

## Layout

- 表格與表單為主，不是 dashboard 行銷模組。
- 破壞性操作（刪除會員等）必須有確認與權限檢查。
- 不要在後台放 Hero、玻璃擬態或裝飾插圖。

## Security

- 未授權必須被擋在 API 與頁面。
- 不在畫面或前端原始碼暴露 SMTP 密碼、VAPID 私鑰或其他密鑰。
