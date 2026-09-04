# Demand / 需求

覆寫範圍：`v3/public/index.html` 底欄「需求」分頁。MASTER 仍適用。

## Purpose

公開需求牆：登入會員刊登找房條件，訪客可看、登入後可回覆。不是仲介、沒有私訊。

## Layout

與「有房刊登」同一套頁面骨架，不要做成找房列表的縮小版：

- 單一 `.card.panel`，寬度 `min(760px, 100%)`，置中
- 順序：h2 → 訪客提示 → 法律提示 → 操作規則 → `.self-grid` 表單 → 送出列 → 列表
- 訪客隱藏 `#demandForm`（對齊 `#selfListingForm`）
- 已刊登需求用 `.self-mine-card`，租金用 `.rent-price`

行政區仍可多選（需求常跨區），放在租金／類型欄後面的 `span-all`；不要改成有房刊登的單區下拉。先看到與刊登頁相同的兩欄欄位，再展開縣市。
