# Property platform — MASTER

產品：**吉比租房物件追蹤**（v3）。這是找房租屋的**情報台**，用途接近 591，但視覺不得做成傳統分類廣告站或行銷官網。

這份檔案是 user-facing UI 的 source of truth。頁面覆寫見 `pages/`。實作檔是 `v3/public/tokens.css`。

## Design rationale

`ui-ux-pro-max`（density 9、motion 2、variance 3）採用的部分：

- **Minimalism & Swiss Style**：網格、高對比、低動效
- **Data-Dense Dashboard**：8–12px 間距、12–14px 輔助字、租金用 tabular 數字
- 主色偏信任綠（技能 `#0F766E` → 本站 `#0f6f6a`）
- PWA／iPhone 觸控目標 44px

明確拒絕（技能會建議，但與產品衝突）：

- Hero-Centric、滿版大圖、行銷 landing
- Glassmorphism、糖果薄荷邊 `#99F6E4`
- Cinzel／Josefin 等展示型英文字體（繁中與租金數字不適合）
- Exaggerated Minimalism 的巨型標題與 8rem 留白
- GSAP scroll reveal

禁止把技能 `--persist` 直接覆蓋本檔。

## Identity

方向：**Quiet Luxury Property Intelligence**

- 安靜、精緻、偏 editorial，不是糖果色分類廣告
- 高資訊密度，不要用空白撐場面
- 搜尋效率與數字可掃性優先於品牌意象
- 繁體中文與租金、坪數、樓層、通勤數字必須一眼可讀
- 必查寬度：375px、768px、1440px

禁止：滿版 Hero、過大標題與巨型留白、過度玻璃擬態／漸層／動畫、每一區塊都做成圓角大卡片、為了好看而藏租金或錯誤狀態、沒有理由改 token。

## Stack

CasaOS 只同步 `v3/src` 與 `v3/public`。前端是 Express 靜態頁，**不是 Next.js**。不要為了設計系統另開一套前端。

`v3/src/auth.js` 的 `publicPath` 必須放行 `/tokens.css`，否則訪客會被導去登入頁。

## Tokens

顏色與字體以 `v3/public/tokens.css` 為準。頁面 **不要再複製一份 `:root`**。

| Token | Value | 用途 |
| --- | --- | --- |
| `--bg` | `#f3efe8` | 頁面底 |
| `--paper` | `#faf8f4` | 卡片／紙面／底欄 |
| `--ink` | `#1c1917` | 正文 |
| `--muted` | `#6f6a64` | 次要文字 |
| `--line` | `#e4dfd6` | 分隔線 |
| `--accent` | `#0f6f6a` | 主色、焦點、主按鈕 |
| `--accent-deep` | `#0b5551` | 主色強調 |
| `--accent-soft` | `#e7f1ef` | 淺底 |
| `--accent-mist` | `#f3f6f5` | 更淺底／選中底欄 |
| `--rose` / `--watch` | `#b08989` / `#9a6b6b` | 關注、警示 |
| `--new` | `#0b5551` | 新物件 |
| `--same` | `#6b6394` | 同屋源 |
| `--same-soft` | `#eceaf4` | 同屋源／外站標籤底 |
| `--tag-on-bg` / `--tag-on-fg` | accent-soft / accent-deep | 上架、可保留 |
| `--tag-off-bg` / `--tag-off-fg` | line / muted | 下架 |
| `--tag-strong-bg` / `--tag-strong-fg` | ink / paper | 確定隱藏 |
| `--hermes` | `#E65326` | 贊助／例外，少用 |
| `--shezi-red` | `#DC2626` | 例外標記 |
| `--radius` / `--radius-lg` | `8px` / `10px` | 控制項／卡片 |
| `--shadow` | `none` | 不要再加玻璃陰影 |
| `--text-xs` … `--text-price` | 12 / 13 / 14 / 16 / 20px | 輔助／正文／租金 |
| `--space-1` … `--space-4` | 4 / 8 / 12 / 16px | 密度間距 |
| `--touch` | `44px` | 主要觸控目標 |
| 字體 | `--font-sans` | 正文；列表不要用展示型英文襯線 |
| 標題可襯線 | `--font-serif` | 站名／後台大標 |

shadcn 別名（`--foreground`、`--primary`、`--border`、`--ring`）指向同一組值，供日後移植，不是第二套色。

## 資訊架構

```
找房     需求     通知     我的
 │
 ├─ 指揮列：狀態 + 搜尋 + 篩選／更多條件
 ├─ 列表（決策面：租金、格局、通勤／捷運）
 └─ 條件抽屜（行政區、租金、通勤；不得擋住列表掃讀）
```

其它頁：`login.html`、`reset.html`、`disclaimer.html`、`admin.html`。

## 元件

- **CommandBar**：搜尋永遠在。375 晶片可橫滑；768 起晶片改換行，不要裁切看不到的條件。觸控 ≥ `--touch`。
- **ListingRow**：租金 `--text-price` tabular-nums 最大；標題最多兩行。
- **AuthCard**：驗證碼圖在上、輸入列在下；無 Hero。圓角用 `--radius-lg`。
- **BottomNav**：四格。`--paper` 底、選中用 `--accent-mist`。固定底欄時按鈕高度 ≥ `--touch`。
- **AlertDock**：桌面右下；手機在「通知」分頁。
- **Empty**：說明下一步（放寬篩選、清搜尋），不要大插圖。

## 響應式

| 寬度 | 行為 |
| --- | --- |
| 375 | 單欄、固定底欄、篩選預設收合、晶片橫滑、無橫向溢出 |
| 768 | 仍單欄＋底欄，但晶片換行可點完；搜尋全寬 |
| 1440 | 可留左側條件欄；不要改成行銷雙欄 Hero |

實作切點：共用窄版 `max-width: 880px`；晶片橫滑只在 `max-width: 767px`；`768–880px` 晶片換行。

## 無障礙與狀態

- `:focus-visible` 用 `--ring`／`--accent`
- 保留空白、錯誤、載入、disabled、hover、selected
- 正文對 `--bg`、主按鈕文字對 `--accent` 需可讀

## 權限

- 訪客可看示範，不可寫入已瀏覽／關注／設定
- `/go/:id` 僅已登入才標記已瀏覽
- 後台、SMTP、密鑰不進前端

## 何時更新本檔

要改：新頁、大改版、改色／字級／間距、新元件族。

不要整份重生：文案、小 bug、API、已用既有 token 的微調。
