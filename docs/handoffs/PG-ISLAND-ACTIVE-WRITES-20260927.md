# 節點本機 SQLite **仍在被寫入**（2026-09-27 更正）

## 更正我先前說過的話

我在切換驗收時說過「部署後新程式完全停止寫本機 SQLite」。**那句話現在不成立。**

當時的證據是 `listing_match_evaluations` 的筆數與時間戳凍結（09-26 18:28）。但今天查證發現
節點 SQLite **仍持續收到寫入**，而且寫的是**真實使用者的操作**。

## 證據（2026-09-27 05:24Z 前後）

從 CasaOS `591-tracker-v3:/data/v3.db` 讀出的實際資料：

| 表 | 內容 | 時間戳 |
|---|---|---|
| `user_listing_flags` | user 2 把 listing `22075980` 設為隱藏 | `hidden_at` = **2026-09-27T05:17:41.999Z** |
| `user_listing_flags` | user 1 把 listing `22075233` 設為隱藏 | `hidden_at` = 2026-09-27T00:58:45.766Z |
| `listing_groups` | 新群組 `lg_bd21f312958ba02f1cf5` | `created_at` = 2026-09-27T02:04:06.742Z |
| `listing_group_members` | 該群組的 2 位成員 | `joined_at` = 2026-09-27T02:04:06.742Z |
| `listing_group_members` | `21974336`／`22053558` 的評估 | `evaluated_at` = 2026-09-27T02:30:56.089Z |

`05:17` 距離我查看的時間只有約 7 分鐘。**這不是冷凍的殘留資料，是正在發生的寫入。**

對應的路由（來自 `PR-A-ROUTE-DATA-MAP-20260927.md`）：

```
POST /api/listings/hide-many   → **SQLite**  (hideMany)
```

## 這件事的意義

1. **這是活的正确性問題，不只是收尾債。** 會員隱藏了一個物件，寫進「回答他那台節點」的本機檔案；
   公開站經 HAProxy 在兩台之間輪流，所以**同一件事在另一台看不到**（隱藏可能失效、通知可能照發）。
2. **分歧正在擴大，不會停在切換那一刻。** 只要還有路由沒切過去，就會持續產生新的分歧。
3. **因此步驟順序必須是：先切換（步驟 3）→ 再對帳（步驟 4）→ 最後刪除。**
   先對帳會被新的寫入立刻作廢。

## 步驟 4 的範圍（已量測，很小但會變動）

比對 PG／CasaOS／Synology 三邊的主鍵集合，**節點有、PG 沒有的鍵只有 10 筆**：

| 表 | 只在 CasaOS | 只在 Synology |
|---|---|---|
| `listing_group_members` | 5 | 2 |
| `listing_groups` | 1 | 0 |
| `user_listing_flags` | 2 | 0 |

其餘 `users`、`user_settings`、`content_documents`、`demand_posts` 都是 **0**。

其中 `lg_2b2746d9…/21974336`、`/22053558` 這兩筆兩台 SQLite 都有，只是 PG 把這兩個 listing
歸在另一個群組（`lg_b9cf4fc4…`）——**不是資料遺失，是歸組不同**，已在
`CUTOVER-CONFLICT-DECISIONS-20260927.md` 說明過。

## 三邊筆數比對（附帶證據）

- 三邊筆數一致：**69 張表**
- **兩節點 SQLite 彼此不同：16 張表**（例：`listing_match_evaluations` 差 59,279 筆、
  `provider_usage_logs` 差 12,483 筆、`route_cache` 差 10,952 筆）
- PG 與節點不同：17 張（PG 幾乎都比較多：`listings` 127,622 vs 115,618、
  `data_revision` 134 萬 vs 68 萬）

**兩個節點的 SQLite 本身就已經不一致**——這證明以前「每個節點各寫各的檔」本來就會造成
兩台資料不同。這正是共用 PG 要解決的事，也是為什麼「把路由全部切過去」是唯一真正的解法。
