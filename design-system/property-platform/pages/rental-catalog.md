# 租屋與配對（後台）

覆寫範圍：Admin `rental/catalog`、`rental/listing`、`rental/wish`、`rental/rules`、`rental/templates`。MASTER 仍適用。

## Purpose

讓管理者維護一套共用條件目錄。有房刊登說「房子有什麼」，許願房說「租客要什麼」。本頁不實作配對引擎。

## Layout

- Desktop：左分類、右條件列；點條件開 compact drawer，System ID 收在進階
- 375px：分類改直向堆疊，不做超寬 table
- 觸控目標 44px；drawer 可用 ESC／關閉離開

## States

- 套用範本 → 草稿 + Diff（新增／修改／停用）→ 確認發布
- 被引用條件只能停用，不能硬刪
- 「配對規則」維持 disabled placeholder
