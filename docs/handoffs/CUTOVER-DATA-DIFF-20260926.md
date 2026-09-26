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

## 四、補遷腳本與隔離排練（第三節第 4 點）

腳本：`v3/scripts/cutover-backfill.mjs`（只讀 SQLite 快照，輸出 SQL；由 psql 套用，
所以不需要把 PG 連線字串交給腳本，dry-run 與套用走同一份文字）。
回歸：`v3/test/cutover-backfill.test.js` 4 案（dry-run 不產生 SQL、只 INSERT 缺少的鍵、
不得出現 UPDATE／DELETE／DDL、多份快照以 freshness 挑較新、群組先於成員的 FK 順序）。

**dry-run（對正式資料、唯讀）**：三份快照合併後，PG 缺少 133 列，與第二節的獨立比對完全一致。
其中 53 個鍵出現在多份快照，以 freshness 欄位（`updated_at`／`joined_at`／`*_at`）挑較新的一份；
只有 1 個鍵（`settings` 的站台設定）沒有 freshness 欄位可比，而三份內容相同。

產出的 `backfill.sql`：133 筆 `INSERT … ON CONFLICT DO NOTHING`（members 69、groups 25、
flags 38、settings 1），**零** UPDATE／DELETE／DDL。SHA256 `7579f128b4bebec7…`。

**隔離排練**（新建 `prb-cutover-rehearsal` 容器 ＋ 獨立 volume，唯一 label，未掛任何正式 volume；
以 PG dump 還原後套用）：

| 表 | 套用前 | 套用後 | 增減 |
|---|---:|---:|---:|
| `settings` | 28 | 29 | +1 |
| `user_listing_flags` | 705 | 743 | +38 |
| `listing_groups` | 14,486 | 14,511 | +25 |
| `listing_group_members` | 45,181 | 45,250 | +69 |
| 合計 | | | **+133** |

- 與 dry-run 預測一致；`psql -v ON_ERROR_STOP=1` **無任何錯誤**（外鍵與約束通過，靠先寫群組再寫成員）。
- **重跑一次新增 0 筆**（冪等；`ON CONFLICT DO NOTHING` 生效，不會覆蓋 PG 既有列）。
- 排練資源已清除：依 `prb-nas-verify=1` 查容器／volume 皆 0 筆，正式容器未受影響。
- 紀錄留在 NAS `cutover-20260926/rehearsal-record.md`。

## 五、95 列內容衝突的處置（第三節第 5 點）

對每一列衝突都取出兩邊的實際值再分類（不是只看筆數）。結果：**79 筆可用既定規則處理、
16 筆需要 Owner 決定**。

### 可用規則處理（79 筆，尚未套用）

| 規則 | 筆數 | 說明 |
|---|---:|---|
| `listing_groups`：PG 非 admin 且 SQLite 的 `updated_at` 較新 → 取 SQLite | 73 | PG 的值多為 09-11～09-22、SQLite 為 09-24～09-26（watcher 到修好之前都寫 SQLite）。**若 PG 已是 `admin_confirmed` 則一律保留 PG**，不因時間較舊而降級人工確認。 |
| 時間戳較新者勝（旗標以外的鍵） | 6 | `lastCoveringAt`／`lastSystemCoveringAt` → PG 較新（09-26 vs 09-22）；`memberFetchDueAt`×2 → PG 較新（09-26 vs 09-22）；`siteCatalogStats` → **SQLite 較新**（09-24 vs 09-19，PG 並非永遠較新）；`user_listing_flags` 1 筆有時間差。 |

### 需要 Owner 決定（16 筆）

| 表 | 筆數 | 為什麼不能自動決定 |
|---|---:|---|
| `user_listing_flags` | 8 | **兩邊時間戳完全相同、但狀態不同**（例：`watched_at` 一樣，一邊 `watched=1`、另一邊 `watched=0`）。`stampFlags` 在「關閉關注」時不會清掉 `watched_at`，所以時間戳無法判斷哪一邊是最後動作。這是會員的收藏／隱藏狀態，不能亂選。 |
| `settings` | 3 | `housingData`／`sponsorLinks`／`rentalCatalogDraft` 是站台內容與設定（沒有可靠的更新時間），兩邊文字不同。 |
| `user_settings` | 3 | `notifyMatrix`（通知矩陣）／`memberSmtp`／`settingProfiles`（搜尋設定檔），同樣沒有可靠時間戳。 |
| `listing_group_members` | 2 | 同兩筆房源在 PG 屬於群組 `lg_b9cf4f…`、在三份 SQLite 都屬於 `lg_2b2746…`（兩個群組在 PG 都各只有這 2 名成員）。 |

**建議給 Owner 的選項**（每一類都是二選一，不需要逐筆決定）：

1. `user_listing_flags` 8 筆 → (a) 保留 PG（現行站上讀到的狀態）；(b) 取 SQLite（節點上最後的使用者動作）；
   (c) 逐筆列出兩邊狀態再決定。**建議 (a)**：PG 是站上實際顯示的來源，改動會員狀態的風險高於保留現狀。
2. `settings` 3 筆與 `user_settings` 3 筆 → (a) 全部保留 PG；(b) 全部取 SQLite；(c) 逐筆比對文字差異後決定。
   **建議 (c)**：這 6 筆是站台內容與會員通知設定，內容差異可能是有意的編輯，逐筆看文字再決定成本很低。
3. `listing_group_members` 2 筆 → (a) 保留 PG 的 `lg_b9cf4f…`；(b) 取 SQLite 的 `lg_2b2746…`。
   **建議先看兩個群組在 SQLite 的完整成員**再決定（SQLite 多 66 名成員，可能代表後續的合併結果）。

### 尚未對正式 PG 寫入任何衝突處置

補遷的 133 列（第四節）與這 95 列的處置都還沒套用到正式 PG；正式切換時才依序執行
「停寫舊庫 → 取最後差異 → 補遷 → 衝突處置 → 部署 → 恢復」。

## 六、下一步（第三節第 6 點、第四、五節）

1. 95 列內容衝突：依第三節的分類規則處理，其中 `user_settings` 5 筆與
   `listing_group_members` 2 筆需要 Owner 決定（會與其他待決事項一次提出）。
2. 第四節最低驗證：兩節點 A/B 讀寫、爬蟲來源抽查、PG 備份的隔離還原抽查。
3. 第五節：把 PG 備份（pg_dump）接進既有 predeploy 流程。
4. 正式切換：停寫舊庫 → 取最後差異 → 補遷 → 部署 → 恢復。

