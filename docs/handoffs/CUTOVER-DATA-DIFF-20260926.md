# 切換前資料比對（2026-09-26）

範圍：上線收尾指令第三節「資料必須真的帶過去」。比對對象是三個 store：
PG primary（Synology `5151-postgres-B` / `5151_shadow`）、CasaOS `591-tracker-v3` 的本機 SQLite、
CasaOS `5151-web-A` 的本機 SQLite、Synology `5151-web-B` 的本機 SQLite。

**本文件只放去識別摘要（表名、筆數、鍵名規則）。個別會員／房源鍵值留在 NAS
`cutover-20260926/data-diff-detail.txt`（600），不進 repo、不進對話。**

## 一、保全（第三節第 2 點）

一致性快照用 SQLite `VACUUM INTO`（含 WAL 內容，不是複製正在寫的檔案），三份都通過
`PRAGMA integrity_check = ok`、各 99 張表。

| 檔案 | 大小 | SHA256（前 16 碼） |
|---|---:|---|
| `591-tracker-v3-v3-snapshot.db`（CasaOS 公開站） | 469,262,336 | `db02297e020acc3e` |
| `5151-web-A-v3-snapshot.db`（CasaOS 站） | 466,018,304 | `5721ac793896e9a5` |
| `5151-web-B-v3-snapshot.db`（Synology 站） | 467,505,152 | `d3b554b691c47775` |
| `pg-5151_shadow-20260926T163821Z.dump`（pg_dump -Fc，DB 635 MB） | 61,165,190 | `6c71258f780562bf` |

- 位置：CasaOS `/mnt/Storage1/cutover-20260926/`、Synology
  `/volume1/homes/tori/5151-shadow/cutover-20260926/`（皆 700）。
- **異機副本已做且逐一核對 SHA256**：CasaOS 兩份 → Synology、Synology 的 web-B 快照與 PG dump →
  CasaOS，四筆雜湊與原檔完全相同。
- PG dump 以 `pg_restore -l` 讀過，可列出 105 個 TABLE DATA。
- 舊 SQLite 原檔未刪、未 DROP、未對正式庫載入任何 fixture。

## 二、三方比對結果（第三節第 3 點，不是只比總筆數）

以主鍵集合比對（`users.id`、`settings.key`、`user_settings(user_id,key)`、
`user_listing_flags(user_id,post_id)`、`listing_groups.group_id`、`listing_group_members.post_id`）：

| 表 | PG | 內容相同 | **同 key 內容不同** | **PG 缺少（只在 SQLite）** | PG 獨有 |
|---|---:|---:|---:|---:|---:|
| `users` | 28 | 27 | 0 | 0 | 1（PG 多一個測試帳號） |
| `settings` | 28 | 20 | 6 | 1 | 0 |
| `user_settings` | 233 | 181 | 5 | 0 | 0 |
| `user_listing_flags` | 705 | 696 | 9 | **38** | 0 |
| `listing_groups` | 14,486 | 14,412 | **73** | **25** | 0 |
| `listing_group_members` | 45,181 | 45,179 | 2 | **69** | 0 |

**關鍵結論：PG 沒有任何一列是三個 SQLite 都沒有的**（PG 獨有 = 0，除了 `users` 的測試帳號），
所以補遷方向是單向的「SQLite → PG」，不需要反向覆蓋，也不會覆蓋掉 PG 較新的資料。
需要處理的總量很小：**缺 133 列 ＋ 內容衝突 95 列**。

（另註：`user_settings` 的 PG 筆數 233 比三個 SQLite 的 186 多，是 PG 領先的部分，不動它。）

## 三、衝突分類與建議處置（第三節第 5 點）

| 類別 | 筆數 | 建議規則 | 需要 Owner 決定？ |
|---|---:|---|---|
| 只在 SQLite 的列 | 133 | 直接 INSERT 進 PG（無衝突） | 否 |
| `settings` 的爬蟲時間戳（`lastCoveringAt`／`lastSystemCoveringAt` 等） | 6 之內 | PG 是現行寫入者且值較新 → 保留 PG | 否 |
| `listing_groups.confirmation_level`／`primary_post_id` | 73 之內 | 採既有優先序（admin > auto > suspected），同級以 PG 為準 | 否 |
| `user_listing_flags` 的 `watched`／`hidden`／`viewed` | 9 | 有 `*_at` 時間戳可比：**取時間較新的一方**；無法判定才列決策 | 少數可能 |
| `user_settings` 的會員設定（無時間戳） | 5 | 無法可靠判斷哪份正確 → **列出鍵名給 Owner 決定** | **是** |
| `listing_group_members.group_id` 不同 | 2 | 同一房源被分到不同群組，需選 canonical | **是** |

**目前尚未對正式 PG 寫入任何一列。** 補遷腳本要先 dry-run、再在隔離副本排練（第三節第 4 點）。

## 四、下一步（第三節第 4、6 點）

1. 產出 `dry-run` 補遷腳本：預設只印「將新增幾列、將更新哪幾類欄位」，不寫入；
   冪等（重跑不重複新增）、以主鍵 upsert、不動 PG 較新的列。
2. 在**隔離 PG instance**（新建容器、獨立 volume、唯一 label、不掛正式 volume）以 PG dump 還原，
   對它跑一次補遷，驗證列數與關聯正確、重跑不變。
3. 正式切換時：暫停會寫舊庫的 writer（目前 crawler 未執行，watcher 在 web 容器內）→
   取最後差異 → 補遷 → 部署 PG 版本 → 恢復。
4. 需要 Owner 的兩類決策（`user_settings` 5 筆、`listing_group_members` 2 筆）在所有其他工作完成後
   一次提出，附具體鍵名與兩邊的值。
