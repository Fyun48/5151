# PG 讀寫全開演練（2026-09-21，shadow）

`DB_DRIVER=postgres` 時，用**真實流程**走一遍：寫入 → 列表 → 裝飾 → 會員標記 → 再列表，
並列出仍依賴 SQLite 的部分。腳本：`pg-rw-drill.mjs`（在 app image 的臨時容器內跑，唯讀掛載正式站快照當 schema 來源）。

## 怎麼跑

```sh
# CasaOS；容器內：schema 來源 = 正式站 SQLite 快照、目標 = 專用 schema drill_rw（跑完自動 DROP）
sh ~/shadow-ha-tools/5151-pg-rw-drill.sh
```

## 結果（`drill_rw`，98 張表由**正式站快照**鏡射）

| 步驟 | 結果 |
|---|---|
| schema mirror（production schema → PG，98 表） | ✅ |
| `persistListing()`（PG 寫入）→ `listings` ＋ `listing_search_projection` | ✅ `changeEvent=listing_added`、`district=士林區`、`rent=25000` |
| `searchListingsAsync()`（PG 讀取）→ 卡片 | ✅ **`decoration: "full"`**、`matched=1`，含 `district`／`commute_state`／`source_label` |
| 會員標記寫入（PG）→ 再列一次 | ✅ `viewed=1`、備註「演練」都從 PG 讀到 |
| `stats()`（列表頁統計） | ⚠️ 會執行，但**讀的是 SQLite 商店**（該庫是空的 → `matched=0`，與列表的 1 筆不一致） |

## 落差（PG 模式下仍走 SQLite）

1. **`stats()` 列表頁統計** —— 這是最明顯的一個：PG 模式下列表有資料、統計卻是 0。
   正式切換前必須把統計查詢也接到 PG（或至少確認統計與列表同源），否則使用者會看到矛盾的數字。
2. `getSettings()`／`user_listing_flags`／`route_cache` 等**列表路徑以外**的讀取仍走 SQLite
   （`getSettings()` 是設定來源，屬過渡期可接受；但旗標／路線的讀取在 PG 模式應與寫入同源）。
3. `enqueueSimilaritySafe()`（pHash／相似度佇列）在 PG 模式**不會執行**。
4. `listing_prep` 與通知／CRM 的佇列寫入仍為 SQLite-only。

## 附帶確認（cutover 檢查項）

- **PG schema 必須先建立**：app 本身只會 ensure SQLite 的 schema；PG 模式要求 PG 端先有 schema，
  而且**必須從「完整初始化過的」store 鏡射**（我第一次用空的暫存 DB 鏡射時少了 `data_revision`，
  因為那張表是第一次使用才建立）。正式切換請以正式站 DB 為 schema 來源。
