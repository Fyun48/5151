# 功能說明 Q&A

覆寫範圍：`v3/public/index.html` 的 `#qaView`。僅已登入會員。

## Purpose

把功能限制與開通規則放在獨立分頁，不要再用蓋住找房列表的 overlay。帳號旁 Q&A 與設定頁入口位置固定，符合「說明入口相對位置一致」。

## Layout

- 沿用 `card panel`，寬度與「設定／刊登」相同（`min(760px, 100%)`）。
- 標題 + 一句 hint +「回找房」。
- 條目用 `<details>` 手風琴；第一則預設展開。
- 空白狀態寫「目前沒有說明項目」，不要大插圖。

## Entry

- 頁首帳號旁 `#helpQaBtn`（訪客隱藏）
- 設定頁 `#meHelpQaBtn`
- 後台獨立分類 `data-admin-nav="qa"`

## Tokens

只用 MASTER 既有色與字級。條目底 `--paper`、線 `--line`、標題 14px 粗體。
