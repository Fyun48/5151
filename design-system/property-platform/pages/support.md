# Support / 支持本站

覆寫範圍：`v3/public/support.html`、`v3/public/support-page.js`、`v3/public/support-cta.js`、找房頁入口與 CTA。後台見 `admin.md` 的「收益與曝光 → 支持本站」。

## Purpose

讓已經得到價值的使用者**自願**支持網站維持免費。不是付費牆、不是廣告站、也不是乞討頁。

## Design rationale

`ui-ux-pro-max` 對「support page」會建議 Hero-centric landing 與藍／橘轉換色。本站拒絕：

- 滿版 Hero、行銷 CTA、Donate 語氣
- 技能建議的 `#2563EB`／`#EA580C`（沿用 Quiet Luxury token）
- 進站阻擋 modal、倒數、假稀缺

採用：理念頁同一套 editorial 直欄、`--accent` 進度條、方案卡網格。

## Copy

產品名是「吉比租房物件追蹤」，短稱「吉比租房追蹤」。前台不要寫「5151」。

優先「支持本站／支持開發／請開發者喝杯咖啡」。禁止「Donate、捐款給我們、急需資金、救救本站」。

必須出現免費聲明：沒有支持也不會減少任何功能。

## Layout

- `/support`：Hero → 免費聲明 → 本月維運進度 → 公開成本 → 方案卡 → 企業贊助（標「贊助」）→ 感謝牆
- 進度條視覺寬度最多 100%；超過仍寫「已達成本 124%」
- Desktop header、帳號區與頁尾放「支持本站」；不要常駐 floating 鈕擋住畫面
- 智慧 CTA 是小型 dialog／卡片，桌面底部、手機在底欄之上（`z-index: 90`，底欄是 120），不得蓋住篩選、地圖、收藏或物件操作

## Feature flags

預設全關：`support.enabled`、`support.cta_enabled`、`support.sponsor_enabled`、`support.public_cost_enabled`。

## Integrity

Support／企業 Sponsor 資料禁止進入 listing ranking。未來若做房仲付費曝光，必須另開 Advertisement domain，並標示「贊助曝光」。
