# 租屋通知／營運分析（PR D）

覆寫範圍：`#notifyHub` 租屋通知分頁、`#matchSubBar`、`#wishSurveyOverlay`、`#rental-ops`。MASTER 仍適用。

## Purpose

把許願房生命週期、配對與提案的 domain event 變成可關閉的提醒，並給管理員區間彙總。不是第二套通知中心，也不另開 Bottom Nav。

## Design rationale

- Quiet Luxury Property Intelligence：情報與決策，不是行銷推播
- 預設保守：郵件／推播關閉；新符合需求與 digest 預設關
- 文案不恐嚇、不假造「快錯過」或假配對數
- 訂閱符合需求必須寫清楚「不會提高配對排名」
- Feature flag 關閉時 API 404，UI 不假裝已啟用

## Layout

- 通知設定第四個分頁「租屋通知」，沿用 `.hub-pane` 與既有 checkbox 列
- 屋主配對 overlay 上方放 mode select（off / instant / daily_digest），觸控 ≥44px
- 完成找房後輕量 overlay，可跳過
- 後台營運分析用既有 metric 卡，375px 兩欄、不橫向溢出

## States

- 載入／空白／錯誤：`aria-live="polite"`
- 郵件／推播 checkbox disabled，直到正式 channel flag
- 已填問卷顯示「已記錄過」
