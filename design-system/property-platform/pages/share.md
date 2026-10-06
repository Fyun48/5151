# Share / 物件一鍵分享

覆寫範圍：`v3/public/listing.html`（公開分享頁 `/l/:id`）、`v3/public/index.html` 會員「我的分享」卡、`v3/public/admin.html` 後台「物件分享統計」卡。MASTER 仍適用；本檔只補這些面。實作證據：`evidence/phase1/`；設計源流：`docs/handoffs/20261006-share-sponsor-listing-detail-plan.md`。

## Purpose

會員一鍵把物件分享去 LINE／Threads／Facebook 或複製站內連結；站方用第一方事件統計連結點閱與管道成效。**不接任何第三方追蹤**；被分享頁對訪客仍可完整查看（分享是增長手段，不是付費牆）。

## 發起與權限

- 只有登入會員能建立分享連結（`POST /api/listings/:id/share-link`，未登入 401）。未登入按分享：**不跳轉**，開對話框說明「登入會員才能分享」＋登入／註冊入口＋「訪客仍可查看被分享的頁面」。
- 每日每人上限（`listingShareFlags.dailyLimit`，預設 20）：達到時面板顯示「今日分享次數已達上限」，不報錯。
- 功能開關 `listingShareFlags.enabled`（預設 true）關閉時：分享鈕隱藏、公開事件端點 204 no-op。

## 分享面板（listing.html）

- 行動（窄屏／coarse pointer）點分享優先 `navigator.share()`；不支援或取消（`AbortError` 靜默）才開自訂面板。桌面 ≥768 用 popover 卡、行動用 bottom sheet；同一份 DOM 以 media query 切換外觀。
- 選項固定四項：LINE／Threads／Facebook／複製連結，每項 ≥44px、平台名＋一行說明。第三方品牌色**只允許 16px 圓點**（LINE #06C755、FB #1877F2、Threads #000），鈕本體用中性外框。
- 面板上方顯示物件摘要（首圖或佔位、標題、租金 tabular 數字）。
- 對話框：`role=dialog`＋`aria-modal`＋`aria-labelledby`、focus trap、Esc 關閉、關閉後焦點還原觸發鈕。
- 點通道：記一筆 `cta` 事件（帶 channel）→ 新分頁開意圖 URL（`noopener`）或寫剪貼簿 → toast「已開啟 LINE」／「連結已複製」＋一行「統計只記連結點擊與來源，不追蹤第三方行為」。
- 意圖 URL：LINE `social-plugins.line.me/lineit/share?url=`、FB `facebook.com/sharer/sharer.php?u=&display=popup`、Threads `threads.net/intent/post?text=`（標題＋url）。分享 URL 一律絕對網址（無 `PUBLIC_BASE_URL` 時回退請求 origin）。

## 公開分享頁 `/l/:id`

- 單欄、照片優先、租金與 CTA 在首屏；規格 key/value 表；屋主聯絡區**訪客遮蔽電話/LINE**（決策 D6 收斂方向，實作以該決策拍板為準）。
- head 注入 OG meta（`og:title/description/url/image`＋canonical）供 LINE/FB/Threads 預覽；注入失敗 fail-soft 回原始頁。
- URL 帶 `?ref=` 時載入打一次 `view` 事件（同 session `sessionStorage` 去重）；`/go/:id?ref=` 由 server 端先記 view 再 302。

## 統計面

- 會員「我的分享」（index.html 我的物件區）：總點閱、總 CTA、今日已用/上限、最近 3 筆連結（點閱/CTA/建立日/開啟連結鈕）。401 不渲染；API 失敗顯示「統計暫時無法載入」，不壞整頁。
- 後台「物件分享統計」（admin.html 營運分析）：7 日總點閱/CTA/新連結＋每日表＋top 物件；`/api/admin/overview` 另帶 `listingShare` 三數字供其他面取用。
- 統計只來自 `listing_share_events`/`listing_share_tokens`，**不得**與許願房 `rental_share_events` 混算，也不得進物件排序。

## States

- 空白：無分享連結時給 empty 文案（不放插圖）。
- 載入：卡片內 skeleton 或「載入中…」。
- 錯誤：fail-soft 文案；429 顯示上限說明；409 隱藏入口。

## Do not

- 不接第三方分析/像素/SDK；不把會員 email 預設送進第三方平台。
- 不用 `--notify-*` 色、不用分類廣告視覺、不做 scroll reveal。
- 不在面板或統計面放「Donate/捐款」字樣。
