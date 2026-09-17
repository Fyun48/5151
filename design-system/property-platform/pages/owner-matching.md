# 屋主配對（owner matching）

覆寫範圍：`v3/public/index.html` 有房刊登的 match count、`#ownerMatchOverlay`、`#aggregateDemandPanel`，以及找房頁 `#demandExposure`。MASTER 仍適用。

## Purpose

讓屋主從自己的刊登看到「目前可能符合幾個活躍需求」，並打開匿名需求卡。沒刊房也能看行政區／預算／格局的加總。不是聯絡租客，也不是自動媒合成交。

## Design rationale

- Quiet Luxury Property Intelligence：情報密度，不是行銷 Hero
- 配對說明用 ✓ / ? 列條件，不要只丟一個分數
- Feature flag `wish.owner_matching_enabled` 關閉時整塊隱藏
- 不增加第六個 Bottom Nav

## Layout

- 有房刊登卡片內：match count +「查看符合需求」（44px）
- Overlay 沿用 `.hub-panel`，寬度 `min(760px, 100%)`
- 需求卡：預算 tabular、行政區、活動桶、explanation chips（flex-wrap）
- `wish.offer_enabled` 關閉時，提供房源 CTA 必須 disabled，文案「即將推出」
- flag 開啟後 CTA 改為「提供我的房源」；已送出顯示「已提供，等待對方回覆」，可撤回
- 375px：晶片換行、無橫向溢出
- 找房頁 demand exposure 是列表上方的小型 aside，不是滿版 Hero

## States

- 載入：列表「載入符合需求…」
- 空白：目前沒有符合的活躍需求
- 低樣本：需求樣本不足
- 錯誤：`aria-live="polite"`
