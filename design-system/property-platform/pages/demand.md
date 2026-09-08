# 許願房（內部 view：demand）

覆寫範圍：`v3/public/index.html` 底欄「許願房」分頁（`data-nav="demand"`）與公開頁 `/w/:id`。MASTER 仍適用。

## Purpose

讓屋主／出租方快速掃到「目前有人在找什麼房」。訪客可看公開許願房；刊登、編輯、下架需登入。不是仲介、沒有私訊、不做自動媒合。

內部仍用 `demand` 識別以避免遷移風險；使用者看到的名稱一律是「許願房」。

## Design rationale

- Quiet Luxury Property Intelligence：情報台密度，不是分類廣告牆
- 卡片先給區域、預算、類型、入住時間、前幾個必須有
- 必須有／希望有／不接受用可換行晶片，不要 30+ 核取方塊長表
- 表單只在建立／編輯時展開；有公開許願房時不出現「再建立一則」
- 長篇法律聲明不進表單；只留 CMS `wish_room_rules` 的低調連結

## Layout

與「有房刊登」同一套頁面骨架：

- 單一 `.card.panel`，寬度 `min(760px, 100%)`，置中
- 順序：h2 → 訪客提示 → 規則短連結 → 會員操作列 → 篩選列 → 公開列表 → 表單（可隱藏）
- 訪客隱藏 `#demandForm` 與會員操作
- 公開卡片用 `.wish-card`（沿用 `.self-mine-card` 節奏），租金用 `.rent-price`
- 詳情可用頁內 overlay 或 `/w/:id`

行政區仍可多選。條件晶片必須 `flex-wrap`，375px 不得橫向裁切。

## States

- 空白：說明目前沒有公開許願房，登入後可建立
- 錯誤：`#demandMsg` `aria-live="polite"`
- 一則上限：有公開許願房時只顯示查看／編輯／下架／範例，不顯示第二則建立
- 載入：列表顯示「載入許願房…」
