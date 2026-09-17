# 房源提案（Wish Offer）

覆寫範圍：`#wishOfferInbox`、`#wishOfferOverlay`、`#wishOfferBlockPanel`，以及屋主配對卡的提供房源 CTA。MASTER 仍適用。

## Purpose

讓屋主對符合的匿名許願房提出自己的房源；租客在許願房分頁回覆。只有雙方確認後才開啟聯絡方式。不是聊天室，也不增加第六個 Bottom Nav。

## Design rationale

- Quiet Luxury Property Intelligence：情報與決策，不是交友滑卡
- Pending 不暴露租客 PII；Accepted 才顯示最小聯絡欄位
- Feature flag `wish.offer_enabled` 關閉時不出現可執行 CTA
- 破壞性操作（封鎖／檢舉）與主 CTA 分開，375px 全寬、觸控 ≥44px

## Layout

- 租客 inbox 放在許願房 `#wishOwnerBar` 下方
- Overlay 沿用 `.hub-panel`，寬度 `min(760px, 100%)`
- 提案卡：標題、租金 tabular、區域／格局、狀態、查看提案
- 設定頁只放已封鎖清單（解除），不列對方身分

## States

- 載入／空白／錯誤：`aria-live="polite"`
- 待回覆 count 寫在 inbox 標題
- 聯絡方式缺資料時說明下一步，不假造電話
