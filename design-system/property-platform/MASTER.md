# Property platform — MASTER

產品：**吉比租房物件追蹤**（v3）。這是找房租屋的**情報台**，用途接近 591，但視覺不得做成傳統分類廣告站或行銷官網。

這份檔案是 user-facing UI 的 source of truth。頁面覆寫見 `pages/`。Cursor 規則見 `.cursor/rules/ui-ux-workflow.mdc` 與 `.cursor/rules/frontend-design-compliance.mdc`。

## Identity

方向：**Quiet Luxury Property Intelligence**

- 安靜、精緻、偏 editorial，不是糖果色分類廣告
- 高資訊密度，不要用空白撐場面
- 搜尋效率與數字可掃性優先於品牌意象
- 繁體中文與租金、坪數、樓層、通勤數字必須一眼可讀
- 必查寬度：375px、768px、1440px

禁止：

- 滿版 Hero 大圖或行銷 landing 版型
- 過大標題與巨型留白
- 過度玻璃擬態、漸層、動畫
- 每一區塊都做成圓角大卡片
- 為了「看起來比較高級」而藏租金、捷運、錯誤或空白狀態
- 沒有理由就改掉既有 token

## Stack（實作約束）

線上 CasaOS 部署只同步 `v3/src` 與 `v3/public`。目前前端是 Express 靜態頁：HTML + 頁內 CSS + 頁內 JS，**不是 Next.js / React / Tailwind 專案**。

- 新畫面優先改 `v3/public/*.html` 與既有元件，不要為了設計系統另開一套前端。
- `ui-ux-pro-max` 是研究工具。它的 `--design-system` 常會建議 Hero、Glassmorphism、展示型字體；**與本檔衝突時以本檔為準**，禁止把技能預設直接 `--persist` 覆蓋這份 MASTER。
- Token 目前寫在各頁 `:root`（`v3/public/index.html`、`login.html`、`admin.html`、`reset.html`）。抽成共用 `tokens.css` 可以，但必須先改本檔再改程式，且 `v3/src/auth.js` 的 `publicPath` 要放行該靜態檔，否則訪客會被導去登入頁。

## Shipped tokens

下列為 **master 已上線** 的變數。視覺大改必須先更新本節，再改 CSS。

| Token | Value | 用途 |
| --- | --- | --- |
| `--bg` | `#f3f7f9` | 頁面底 |
| `--paper` | `#ffffff` | 卡片／紙面 |
| `--ink` | `#1a2b33` | 正文 |
| `--muted` | `#64748b` | 次要文字 |
| `--line` | `#e2e8ef` | 分隔線 |
| `--accent` | `#0da5a0` | 主色、焦點、主按鈕 |
| `--accent-deep` | `#0a8280` | 主色強調 |
| `--accent-soft` | `#e8f7f6` | 淺底 |
| `--accent-mist` | `#f0fbfa` | 更淺底 |
| `--rose` / `--watch` | `#d4a5a5` / `#b87a7a` | 關注、警示柔色 |
| `--new` | `#0a8280` | 新物件標記 |
| `--same` | `#8b7fd4` | 同屋源 |
| `--hermes` | `#E65326` | 贊助／強調例外（少用） |
| `--shezi-red` | `#DC2626` | 社子等例外標記 |
| 字體 | `"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif` | 正文 |
| 標題可襯線 | `"Noto Serif TC", "Source Han Serif TC", serif` | 後台／少數大標，列表不要用展示型英文襯線 |

尚未成為 token、但既有畫面在用的值：卡片圓角約 `20px`（登入卡）、一般控制項約 `8–10px`。新增元件時先複用這些數字，不要再發明第三種 radius。

## 資訊架構

主要產品在 `v3/public/index.html`，以 `data-app-view` 切換：

```
找房     需求     通知     我的
 │
 ├─ 指揮列：狀態 + 搜尋 + 篩選／更多條件
 ├─ 列表（決策面：租金、格局、通勤／捷運）
 └─ 條件抽屜（行政區、租金、通勤；不得擋住列表掃讀）
```

其它頁：`login.html`、`reset.html`、`disclaimer.html`、`admin.html`。

## 元件（現況）

- **CommandBar**：搜尋必須可點；手機篩選晶片可橫滑；「更多條件」才展開完整列。觸控目標至少 44px。
- **ListingRow**：縮圖小、租金是決策數字、標題最多兩行、通勤／捷運當不同iator。不可把租金藏進次要文字。
- **AuthCard**：驗證碼圖與輸入列在窄螢幕要可橫向填寫，不可被擠成直向細條。沒有 Hero。
- **BottomNav**：找房／需求／通知／我的。FAB 不得擋住列表主操作。
- **AlertDock**：站內通知。桌面右下；手機在「通知」分頁。
- **Empty / error / loading**：沿用現有文案與狀態，設計不得刪掉。

## 響應式

審查寬度固定為 **375 / 768 / 1440**。現行程式多用 `max-width: 880px` 當窄螢幕切點，沒有獨立 tablet breakpoint。新增版面時：

- 375：單欄、底欄、篩選預設收合但搜尋仍在、無橫向溢出
- 768：仍要能搜尋與掃列表；不要做成半成品桌面
- 1440：可保留左側條件欄給會員查詢，不要改成行銷雙欄 Hero

## 無障礙與狀態

- `:focus-visible` 必須看得見，建議用 `--accent`
- 鍵盤可操作搜尋、篩選、列表動作
- 保留 hover、selected、disabled、空白、錯誤、載入
- 對比：正文對 `--bg`、主按鈕文字對 `--accent`

## 權限（Security Reviewer）

- 訪客可看示範列表，不可寫入已瀏覽、關注、設定
- 會員寫入必須帶 session；`/go/:id` 僅已登入才標記已瀏覽
- 後台、SMTP、個資、刪除帳號只在 `admin.html`／對應 API
- 不要把 token、SMTP、VAPID 私鑰畫在前端

## 何時更新本檔

要改：新頁、大改版、改色／字級／間距／層級、新元件族、跨頁不一致。

不要整份重生：文案、小 bug、事件處理、API、已用既有 token 的微調、無視覺意圖的重構。
