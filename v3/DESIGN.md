# Quiet Luxury Property Intelligence

產品：吉比租房物件追蹤（v3）。這是找房**情報台**，不是分類廣告站、也不是品牌官網。

## 1. Design research（對標與反對標）

| 對標 | 拿走什麼 | 不拿什麼 |
| --- | --- | --- |
| 金融／Ledger SaaS（Firik、Skyfall Ledger、data-dense dashboard） | 表格數字對齊、1px 線、低飽和、高密度 | 交易 K 線、深色炫光 |
| Linear / 現代 SaaS 指令列 | 搜尋永遠在、條件可收合、鍵盤友善 | 滿版空白、行銷 hero |
| Redfin／Zillow 地圖搜尋 | 卡片是決策面：租金、格局、通勤／捷運一眼可掃 | 地圖當唯一主角、巨型房產攝影 |
| 瑞士網格／Aura 類 editorial | 字級層級清楚、禁止玻璃擬態 | 品牌故事頁、過量動畫 |

**禁止：** 滿版 Hero 大圖、過量動畫、巨型空白、只適合官網的置中大標、糖果漸層背景、玻璃擬態、把照片當主視覺而把租金藏起來。

## 2. 資訊架構

```
找房     需求     通知     我的
 │
 ├─ 指揮列：狀態 + 搜尋 + 篩選／更多條件
 ├─ 列表（決策面卡片）
 └─ 條件抽屜（行政區、租金、通勤；不擋列表）
```

主要流程：開列表 → 收合條件下先搜標題／地址 → 需要時展開晶片或條件抽屜 → 掃租金／樓層／捷運 → 點進物件或關注。訪客可看示範列表；寫入需登入。底欄四格在電腦與手機都固定可見。

## 3. Design tokens

實作於 `public/tokens.css`（與 `design-system/property-platform/MASTER.md` 同步）。變數同時提供本站名（`--ink`）與 shadcn 別名（`--foreground`），之後若另開 Next.js 可直接吃同一套，不必先拆 CasaOS Express。頁面不要再複製一份 `:root`。

**為什麼這次不改寫 Next.js：** 線上部署只同步 `v3/src` + `v3/public`，PWA／session cookie／五千行列表邏輯都在 Express。完整改 Next.js 會先犧牲查詢效率，違反「功能永遠優先於形象」。本規格把 tokens 做成可移植層。

## 4. 核心元件

- **CommandBar**：搜尋 44px、篩選、更多條件；晶片橫滑。
- **ListingRow**：縮圖小、租金 tabular-nums 最大、標題兩行、通勤／捷運當不同iator。
- **AuthCard**：驗證碼圖在上、輸入列在下；無 hero。
- **BottomNav**：找房／需求／通知／我的。

## 5. UX 審查清單

- 375／768／1440 皆可完成搜尋與掃列表
- 空白、錯誤、載入狀態仍是現有文案，不得被設計吃掉
- 對比：正文對背景、主按鈕對文字
- 觸控目標 ≥ 44px（篩選、登入、列表動作）
- 焦點可見；驗證碼可橫向輸入
