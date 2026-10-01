# Owner 工作單 A1～C3：手機／桌機截圖（第九十九批）

截圖環境：本機 `PORT=5199`、`DATA_DIR` 指向暫存目錄、SQLite driver、
以 `demo@example.com`（admin）登入；瀏覽器由 Playwright 驅動。
桌機 1440×900、手機 375×812。

| 檔案 | 對應項目 | 看什麼 |
|---|---|---|
| `a2-body-desktop.png` / `a2-body-mobile.png` | A2 | 「物件說明」與範本下拉**直接展開**在「刊登物件」按鈕上方，可手寫也可套範本 |
| `a4-mrt-desktop.png` / `a4-mrt-mobile.png` | A4 | 輸入地址後自動顯示「捷運士林站，步行路線約 958 公尺（1 公里內）。」 |
| `a5-share-member-desktop.png` / `a5-share-member-mobile.png` | A5 | 已登入會員開分享頁：頁首是自己的帳號與登出，CTA 是「回找房頁面」 |
| `a5-share-guest-mobile.png` | A5 | 訪客開同一頁：只有「登入 / 註冊」與「免費註冊」，且看不到會員區連結 |
| `b1-b2-wish-desktop.png` / `b1-b2-wish-mobile.png` | B1／B2 | 五個租金包含條件＋捷運距離需求共六項，集中在同一個連續選項區 |
| `c3-feedback-images-desktop.png` / `c3-feedback-images-mobile.png` | C3 | 回饋表單的附圖區：張數提示、選檔鈕、貼上提示、縮圖與刪除 |
| `a3-admin-draft-desktop.png` | A3 | 後台目錄：改名後**還沒發布**時，逐列標「（草稿，未發布）」、按鈕變「尚未發布：確認並發布」 |
| `a3-frontend-synced-desktop.png` | A3 | 按發布後重新載入前台：「我的刊登」卡片顯示新的目錄名稱「華廈/公寓電梯、門衛／管理」 |
| `c3-admin-feedback-desktop.png` | C3／C1 | 後台回饋清單看得到附件縮圖；「聯絡」是會員 email（前台沒有這個欄位） |
| `r2-listing-fee-tristate-desktop.png` / `r2-listing-fee-tristate-mobile.png` | R2 | 房東端的「租金已包含」五列三態（已含／另計／未確認）；手機 375px 沒有橫向溢出、每個選項高 44px |

> ⚠️ 這些截圖是在**本機**跑的，不是正式站。Production 未部署（manual-only）。
