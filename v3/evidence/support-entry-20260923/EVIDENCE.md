# Evidence：行動版按鈕文字雙排 + 「支持本站」看不到贊助方式 — 2026-09-23

專案：`5151`（v3，前台產品名「吉比租房物件追蹤」）。本檔只記實測輸出與變更，不重述設計理念。

## 0. 使用者回報（原句）

> 這是 5151 專案，行動版的畫面，圖片上的按鈕裡的文字可以對齊雙排也沒關係，但按鈕樣式大小不要改變。
> 我後台是有贊助連結使用了 buy me a coffee，但在電腦版的中的支持本站進入後顯示還未開放，
> 而在行動版的版面卻又看不到如何贊助本

## 1. 生產環境實測（只讀，未變更）

```text
GET https://jibbyrenth.reversalplay.me/api/support/public
  → {"enabled":false,"flags":{"enabled":false,...},"entry":{"show":false,...},"cta":{"enabled":false}}

GET https://jibbyrenth.reversalplay.me/api/comms
  → support.enabled=true, support.show_entry=true, support.show_card=true
    （copy 已被站長改成「支持是自願的。沒贊助也能繼續使用。」）
```

也就是說：**通訊設定的「支持本站」入口是開的，但 Support domain 旗標是關的**。

## 2. 根因（都在程式碼裡，不是猜測）

| # | 症狀 | 根因 |
| --- | --- | --- |
| A | 電腦版「支持本站」→ 只看到「目前尚未開放線上支持入口」 | 入口`#supportHeaderLink`／`#supportFooterLink`／`#supportMeLinkWrap` 的顯示與連結由 `support-cta.js` 依 **Support domain**（`/api/support/public`，預設關閉）決定；`/support.html` 在 domain 關閉時由 `support-page.js` 寫死「目前尚未開放線上支持入口」。後台填的「贊助連結」（`sponsorLinks`）完全沒有參與。 |
| B | 行動版看不到如何贊助 | 帳號區的「支持本站」卡片有 `id="supportAccountLinks"` 容器，但 `paintSupportAccount()` 只做 `links.dataset.bound = "1"`，**從來沒有把贊助連結畫進去**（死碼）。行動版 header 的入口又是 `header-desk-only`，所以只剩頁尾連結 → 捲到一張沒有出口的卡片。 |
| C | 訪客／管理員連卡片內容都看不到 | `#sponsorBar` 依設計只給未贊助的登入會員（`body.role-guest #sponsorBar { display:none }` + `publicSponsorOffer()` 排除 admin/sponsor）。訪客在 `/api/me` 拿到的是 `{show:false,links:[]}`，所以就算看到卡片也沒有連結。 |

## 3. 變更（只改 v3）

| 檔案 | 變更 |
| --- | --- |
| `v3/src/comms.js` | `supportPresentation()` 新增 `sponsor_links`（後台「贊助連結」的公開收款方式）；`publicCommsBundle()` 轉傳 `sponsorLinks`。 |
| `v3/src/server.js` | `GET /api/comms` 以 `publicSponsorSettings({}).links` 提供公開的支持方式（訪客也拿得到）；**沒有**改 `#sponsorBar` 的會員限定推銷邏輯。 |
| `v3/public/index.html` | `paintSupportAccount()` 把支持方式畫成 `a.sponsor-chip` 連結，並在「有連結」或「Support domain 真的開放」時才顯示卡片；新增 `paintSupportEntry()` 統一決定 header／頁尾／帳號區入口的顯示。入口**一律是連到 `/support.html` 的普通連結**（見第 7 節：一版曾用 JS 切到設定頁＋捲動，站長回報「點了完全沒反應」）。 |
| `v3/public/support-cta.js` | 不再寫入口的 `href`／`hidden`（避免兩支程式互蓋），只發布 `body.dataset.supportDomain` 並觸發 `support-domain` 事件；CTA 卡片邏輯不變。 |
| `v3/src/support.js` | 新增 `publicSponsorWays(db)`；Support domain 關閉時，`/api/support/public` 仍回傳 `sponsor_links`。 |
| `v3/public/support.html`、`v3/public/support-page.js` | 新增「支持方式／其他支持方式」區塊（`#directWays`），domain 關閉時列出來（文案改成免費聲明，hero CTA 指向該區塊），方案卡維持隱藏。前端仍**不寫死**第三方網址（測試有斷言）。 |
| 測試 | `v3/test/comms.test.js`、`v3/test/comms-ui.test.js`、`v3/test/support-ui.test.js`、`v3/test/support-api.test.js` 各補上對應斷言。 |

## 4. 驗證

### 4.1 測試

```text
$ node --test v3/test/comms.test.js v3/test/comms-ui.test.js v3/test/support-ui.test.js \
    v3/test/support-api.test.js v3/test/sponsor-links.test.js v3/test/index-script.test.js
# tests 78 / # pass 78 / # fail 0
```

（上面的 78 項是**所有改動完成後**才跑的，涵蓋本次動到的 4 個測試檔與相關檔案。）

全套 `npm test` 的結果是 **pass 2412 / fail 2**（cancelled 0、skipped 11）；兩個失敗都與本次改動無關：

```text
# pass 2412 / # fail 2 / # skipped 11

not ok 795 - executable deploy failure-path tests (rollback on fail, fail-closed backup)
  ln: failed to create symbolic link '/usr/local/bin/docker': Permission denied  ← 容器權限，非程式問題

not ok 905 - PR A src manifest matches git tree and fails closed when mounted db.js is tampered
  v3/src manifest mismatch: {"changed":["comms.js","server.js","support.js"], ...}
  ← 這個測試拿 working tree 的 v3/src 對比 git HEAD；未提交的 src 變更一定失敗，提交後即通過
```

### 4.2 瀏覽器（headless Chromium，375 / 768 / 1280）

> 環境註記：容器內 Chromium 原本一開就 crash（`FATAL:third_party/skia/src/ports/SkFontMgr_FontConfigInterface.cpp:163] Not implemented`），
> 原因是 `FONTCONFIG_PATH` 指向的 `fonts.conf` 只列了不存在的 `/usr/share/fonts`。裝上 Noto Sans/Serif TC
> 並給一份只列實際字型目錄的 fontconfig 後即正常；截圖裡的中文可讀。

| 情境 | 結果（`dom-probe.json`） |
| --- | --- |
| 會員 375/768/1280 | `#supportHeaderLink` 桌機可見、`href="#me"`；頁尾 `#me`；`#supportAccountLinks` 內含 `Buy Me a Coffee → …`；`horizontalOverflow=false` |
| 訪客 375/1280 | 同上（入口可見、卡片有連結） |
| 點入口後 | 開 `/support.html` 並列出支持方式（第 7 節改版後的行為） |

截圖：`shots/375-account-support-ways.png`、`shots/1280-account-support-ways.png`、`shots/1280-guest-account-support-ways.png`、
`shots/375-support-page-ways.png`、`shots/1280-support-page-ways.png`（Support domain 關閉時 `/support.html` 會列出支持方式，不再只有「尚未開放」）。

### 4.3 行動版按鈕尺寸（`filter-button-measurement.json`）

`#openFilterSheetBtn`／`#filterRestoreBtn` 注入超長摘要文字後量測：

| 寬度 | 按鈕高度 | 文字行數 | 版面橫向溢出 |
| --- | --- | --- | --- |
| 375 | 44（`max-height: var(--touch)`） | 5（超過可視 2 排，被裁掉後 JS 會退回短標籤） | false |
| 320 | 44 | 7 | false |
| 768 | 44 | 2（完整顯示，未被裁切） | false |

→ 符合「文字可以雙排，但按鈕樣式大小不要改變」。

## 5. 已知／未處理

- `getScrollTop is not defined` 這個 console page error 是**既有問題**（`git show HEAD:v3/public/index.html` 同一行就存在，
  而且 `v3/test/client-state-wiring.test.js` 的斷言還把這個錯字一起鎖住）。同一個 PR 已修：改用既有的
  `pageScrollY()`，並把斷言改成正確版本（另加 `assert.doesNotMatch(html, /getScrollTop/)` 擋回去）。
- 本次刻意**沒有**改 `.chip`／`a.sponsor-chip` 的尺寸（`.chip` 在這個專案本來就不是 44px，維持既有慣例）。
- 站內那條主動出現的贊助橫條（`#sponsorBar`）維持「只給未贊助的登入會員」，與 `sponsorLinks.js` 的既有註解一致。
- 驗證用資料已清掉：`data-v3/v3.db` 內的測試會員（`free@example.com`）與測試用 `sponsorLinks`
  （`https://buymeacoffee.com/jibbyexample`，佔位網址）都刪除，只留原本的 `admin@local`。

## 6. 部署與上線後實測（2026-09-23，`manual_owner` 路徑）

```text
PR                 #441（squash 併入 master）
master / sha       0008fcb28feabae80c8bb330a0033f205795977f
build              run 35814831289  → success
image digest       sha256:c697e6aff1741428740bd94fc4ae639de1d2d0a77b1e5ebd32b58d05da653ccb
predeploy-check    run 35814977523  → success
deploy-v3          run 35815081496  → success
```

上線後對正式站（`https://jibbyrenth.reversalplay.me`，**訪客**身分）實測：

| 檢查 | 結果 |
| --- | --- |
| `GET /api/comms` → `support.sponsor_links` | 1 筆：`吉比需要你的支持~來份飼料~! → https://buymeacoffee.com/acefengyund` |
| `GET /api/support/public`（Support domain 仍關閉） | `enabled:false`，但 `sponsor_links` 有 1 筆 |
| 桌機 1280 訪客首頁 header「支持本站」 | 可見（`display:flex`）；點擊後切到設定頁並可見上述連結（第 7 節改版後改為直接開 `/support.html`） |
| 手機 375「設定」分頁 | 卡片可見並帶上述連結 |
| `/support.html`（桌機 1280／手機 375） | hero＝支持本站＋免費聲明、「支持方式」列出上述連結、方案卡隱藏、無 console error、無橫向溢出 |

截圖：`shots/prod-375-account-support-ways.png`、`shots/prod-1280-account-support-ways.png`、
`shots/prod-375-support-page-ways.png`；DOM 實測輸出：`prod-verify.json`。

> 註：`prod-verify.json` 內有一行 `TIMEOUT waiting for sponsor chip`。那是驗證腳本用
> `waitForSelector`（預設等「可見」）去等一個位在**已隱藏**的「設定」檢視裡的元素造成的誤判，
> 同一次輸出裡 `ways` 已列出該連結、點擊後 `cardVisible=true`，不是頁面問題。

## 7. 追加修正：入口改成一般連結（站長回報「支持本站」點了完全沒反應）

**回報**（部署 `0008fcb` 之後）：點「支持本站」完全沒反應。

**正式站重現**（訪客身分，四種情境）：

| 情境 | appView | scrollY | 判定 |
| --- | --- | --- | --- |
| 桌機 1280 header | listings → me | 0 | 有切換，但左側面板以外幾乎沒差 |
| 桌機 1280 頁尾（**已在「設定」**） | me → me | 0 | **完全沒反應** ← 與回報一致 |
| 手機 375 頁尾 | listings → me | 208 | 有反應 |
| 手機 375 帳號區的「支持本站」連結 | 直接開 `/support.html` | — | 有反應 |

**根因**：`paintSupportEntry()` 在 Support domain 關閉時把入口寫成 `href="#me"`，再用 JS
`preventDefault()`＋`setAppView("me")`＋`scrollIntoView()` 假裝站內跳轉；**已經在「設定」檢視時這三步等於什麼都沒做**。

**修法**：入口一律維持 `<a href="/support.html">`（頁尾靜態 HTML 也由 `#me` 改成 `/support.html`），
`paintSupportEntry()` 只決定顯示與否、不再攔截點擊。`#441` 已讓 `/support.html` 在 Support domain
關閉時列出後台「贊助連結」的支持方式，所以點了一定看得到東西，而且**不依賴 JS**。

**驗證**（本機 dev server 重啟後、訪客身分；四種情境全部變成 `/support.html`）：

| 情境 | 點擊後 |
| --- | --- |
| 桌機 1280 header | `/support.html`（hero＝支持本站） |
| 桌機 1280 頁尾（已在「設定」） | `/support.html` |
| 手機 375 頁尾 | `/support.html` |
| 手機 375 帳號區連結 | `/support.html` |

四種情境皆無 console error；`node --test`（6 個相關檔）**76/76 通過**。
