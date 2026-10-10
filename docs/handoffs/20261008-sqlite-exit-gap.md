# SQLite 退場缺口盤點（2026-10-08）

> 這份是「文件任務 D 包」的產物：把文件對齊 2026-10-08 晚間（23:45 前後）的唯讀實測。
> 本文**不執行**任何 Production 變更；文中每一項 Production 動作都標明需要 Owner 核准。
> 行號以 `origin/master`（`b32f64f`）為準；時間戳除非另註，都是 UTC（ISO 字尾 `Z`）。

## 一、今晚實測的事實

### 1. 五個服務的 DB_DRIVER

| 服務 | DB_DRIVER | 說明 |
|---|---|---|
| `5151-web-A` | `postgres` | 正式 web 節點（casa） |
| `5151-web-B` | `postgres` | 正式 web 節點（syn） |
| `591-tracker-v3` | `postgres` | 正式爬蟲 |
| `5151-crawl-sandbox` | `postgres` | 沙盒爬蟲（寫隔離庫 `crawl_sandbox`） |
| `5151-ops` | **未設** | `v3/src/dbDriver.js:12` 未設時預設 `sqlite`，但 OPS 走自己的 `ops/src/opsDb.js:11`（明寫「與產品 v3 的 v3.db 完全分離」，資料庫 `data-ops/ops.db`），**不直讀 v3 業務庫**。 |

### 2. 本機 SQLite 仍在、仍被開、仍被寫（但要講精確）

- `v3/src/db.js:504` 在 **import 時無條件** `new DatabaseSync(DATA_DIR/v3.db)`，沒有走 driver gate；
  全站約 75 個模組 import `db.js`。三台節點的 `/data/v3.db` 都存在（480–515MB）。
- **爬蟲主寫入確實已全在 PG**，不要再寫「爬蟲還在寫本機庫」：本機 `listings` 的
  `max(last_seen_at)=2026-09-22T05:48:53.933Z`，今天 0 筆。本機 SQLite **沒有**再收到新的 `listings` 列。
- 本機 `schema_migrations` 最後套用 `2026-10-06T14:20:13.381Z` ⇒ 啟動仍會在本機庫跑遷移
  （因為 `db.js` import 時無條件開庫並建表）。
- `-wal` 約 38MB 未 checkpoint；`-shm`／`-wal` 的 mtime 是 2026-10-08 23:47，主檔 mtime 仍停在
  09-30 ⇒ **唯讀檢查一定要連 `-wal`／`-shm` 一起看**，只看主檔 mtime 會誤判成「沒在寫」。
- 目前**唯一還在產生新業務列**的是 `user_listing_flags`（見下一節）。

### 3. 唯一還在產生新業務列的孤島：user_listing_flags

- `v3/src/watcher.js:1084` 呼叫同步 `copyUserFlags()`（`v3/src/db.js:897` → 寫本機 `db` handle）；
  PG 模式下沒有對應的 async 版本可用，所以這條路徑寫的是**節點本機 SQLite**。
- 本機今天（2026-10-08）有 5 筆 `viewed_at`／`hidden_at`，最新 `2026-10-08T15:47:35Z`。
  其中 `post_id` 22143884／22142960／22141278 在 PG 的 `user_listing_flags` **不存在**；
  PG 今天 `hidden_at` 0 筆 ⇒ 本機有、PG 沒有，是活的孤島寫入。

### 4. 三邊行數差（節點本機庫 vs 正式 PG `5151_shadow`）

| 表 | 節點本機 SQLite | 正式 PG | 說明 |
|---|---|---|---|
| `listings` | 115,618 | 178,968 | 爬蟲新列只進 PG（見 §2） |
| `user_listing_flags` | 805 | 796 | 本機多 9 筆，其中今天 5 筆（孤島） |
| `listing_groups` | 14,510 | 26,660 | 機器推導聚合，PG 已重算 |
| `settings` | 26 | 30 | 4 個 key 只在 PG（`settings` 只有 `key`/`value` 兩欄，**沒有 `updated_at`**） |
| `crawl_covers` | 2 | 38 | 排程狀態以 PG 為準 |
| `demand_posts` | 35 | 35 | 一致 |

### 5. 讀取仍 fail-open

`v3/src/sqliteFallback.js` 預設 `closed`＝**寫入不回退、讀取仍回退本機 SQLite**。三台節點
**都沒有**設 `PG_SQLITE_FALLBACK=strict`（`strict` 才會讓殘留的 SQLite 讀依賴變成看得見的失敗）。

### 6. 刻意的鏡射寫入點（PG 成功後再寫本機）

註解說明是「還沒搬完的同步讀者看的是節點本機那一份」。位置：

- `v3/src/selfListingsAsync.js:229/253/308/327`
- `v3/src/listingImportAsync.js:148/321/363/408`
- `v3/src/siteContentAsync.js:235/252`
- `v3/src/rentalNotifyPrefsAsync.js:160/164/233`
- `v3/src/demandAsync.js:702`
- `v3/src/memberConsentsAsync.js:126/137`
- `v3/src/geoCacheAsync.js:96`

### 7. Owner 當初的裁決

- `docs/handoffs/5151_SQLite_Exit_PG_HA_DeepSeek_20260924.md:57`：正式業務讀寫均禁止回退節點 SQLite。
- 同檔 `:60`：正式 PG 模式最終連業務 SQLite 都不開啟、不保留 `PG_SQLITE_FALLBACK=open` 逃生門。
- 同檔 `:61`：優先讓 runtime 完全不掛載業務 SQLite。
- 同檔 `:65`：正式部署規格必須明確指定 postgres，錯 driver 或開 SQLite fallback 應在啟動檢查被拒絕。
- `docs/handoffs/PG-ISLAND-MIGRATION-PLAN-20260927.md:6676-6682`：步驟 4 對帳 → 5 功能等價 →
  6 cluster／雙備援 → 7 移除 SQLite（`db.js` 的 SQLite 分支、`sqliteFallback`、本機檔案）。
- 同檔 `:6534`：順序不可顛倒（先轉換 → 再對帳 → 最後刪除）。

### 8. 已承認、尚未寫入正式 PG 的補遷

- `docs/handoffs/CUTOVER-DATA-DIFF-20260926.md:60、:152-155`：補遷 133 列＋95 衝突處置
  「尚未寫入正式 PG」。
- `docs/handoffs/PG-FALLBACK-AUDIT-20260926.md:65-71`：讀取仍 fail-open、本機空表仍會被建、
  `geo_cache` 等純快取未清。

## 二、現況 vs Owner 裁決對照表

| # | Owner 裁決 | 現況（2026-10-08） | 落差 |
|---|---|---|---|
| 1 | 正式業務讀寫均禁止回退節點 SQLite（:57） | 讀取仍 fail-open（`closed`＝讀取回退，三台未設 strict）；另有孤島＋鏡射寫入 | 未達成 |
| 2 | 正式 PG 模式最終連業務 SQLite 都不開啟、不留 open 逃生門（:60） | `db.js:504` import 時無條件開本機庫 | 未達成 |
| 3 | 優先讓 runtime 完全不掛載業務 SQLite（:61） | `/data` 仍掛；但 `/data` 必須保留（`auth.env`、`vapid.json`、媒體目錄，見 §三 C(2)），做法改為「不開啟＋歸檔移除 DB 檔案」 | 做法需調整 |
| 4 | 部署規格必須明確指定 postgres，錯 driver／開 fallback 應啟動檢查拒絕（:65） | 五個產品服務 driver 已 postgres，但「錯 driver／`PG_SQLITE_FALLBACK=open` 於啟動時拒絕」的強制檢查尚未落地 | 未達成 |
| 5 | 步驟 4 對帳 → … → 7 移除 SQLite，順序先轉換→再對帳→最後刪除（:6676-6682、:6534） | 步驟 4 對帳尚未完成；補遷 133 列＋95 衝突未入 PG；步驟 7 未開始 | 進行中（順序不可跳） |

## 三、退場順序（A → D → B → C(1) → C(2) → C(3)）

> 每步的「Production 動作（需 Owner 核准）」統一列在 §四。

### A 止血：停掉唯一還在長新業務列的孤島

- 目標：`watcher.js:1084` 的 `copyUserFlags()` 改走 PG async 版（或改由 PG 的 reconcile 路徑承接），
  讓 `user_listing_flags` 不再有新列只進本機。
- 這是**程式碼變更**，經 PR 合併＋部署後才生效；在本步完成前，孤島會繼續長（本機今天已有 5 筆）。

### D 文件：把文件對齊現實（本份）

- 修正 `v3/ARCHITECTURE.md`、`docs/runbooks/shared-infra-access.md` §4／§5.1、
  `deploy/shadow-ha/README.md` 與 `deploy/shadow-ha/web/README.md` 裡「已全面 PG／不再寫入／完全隔離」
  的過時說法，並補上可重跑的唯讀驗證指令（§五）。
- 純文件，不觸及 Production。

### B 步驟 4 dry-run：三邊對帳（先不寫正式 PG）

- 工具已備（md5 比對三邊、主鍵集合比對，見 `PG-ISLAND-MIGRATION-PLAN-20260927.md` §八）。
- **先 dry-run、隔離副本排練**，補遷 133 列＋95 衝突處置在 Owner 核准前**不寫正式 PG**
  （`CUTOVER-DATA-DIFF-20260926.md:60` 明寫「尚未對正式 PG 寫入任何一列」）。

### C(1) strict：把殘留的 SQLite 讀依賴變成看得見的失敗

- 在測試／預備環境開 `PG_SQLITE_FALLBACK=strict`，跑整合測試＋業務閉環＋內容比對，
  逐條消除仍回退本機 SQLite 的讀取路徑。
- 這不是正式站直接開 strict（正式站直接開會把 PG 短暫錯誤變成使用者可見的失敗）；先收乾淨再考慮。

### C(2) 不開啟＋啟動檢查＋歸檔移除（`/data` 掛載必須保留）

> Owner 原裁決「完全不掛載業務 SQLite」（:61）在實作上要轉成「**不開啟**＋**歸檔移除 DB 檔案**」，
> 因為 `/data` 不能整個不掛。

- 實測 `591-tracker-v3:/data` 裡有：`auth.env`（600）、`vapid.json`（600）、`member-media/`、
  `self-photos/`、`feedback-media/`；`v3/src/env.js:32-37` 就是從 `DATA_DIR` 讀 `auth.env` 與
  `session.secret`。所以 `/data` 掛載要留，不能因「移除 SQLite」而整個卸下。
- 做法（依序）：
  1. `v3/src/db.js:504` 加 driver gate：PG 模式下**不開啟**本機庫；同時在啟動檢查拒絕
     「錯 driver」或 `PG_SQLITE_FALLBACK=open`（Owner 原裁決 :60/:65）。
  2. 步驟 4 補遷收尾後，把 `v3.db`／`v3.db-wal`／`v3.db-shm` **歸檔移除**
     （保留 `auth.env`／`vapid.json`／媒體掛載）。
  3. 歸檔後驗證「PG 模式下不再有任何本機庫 open／write」。

### C(3) 移除分支：移除 `sqliteFallback` 與 `db.js` 的 SQLite 分支

- 對應 `PG-ISLAND-MIGRATION-PLAN-20260927.md:6681-6682` 的步驟 7：移除 `db.js` 的 SQLite 分支、
  `sqliteFallback`、本機檔案，屆時「雙路徑」「節點分歧」這整類問題一起消失。
- **必須在 B、C(1)、C(2) 完成後**才做；順序不可顛倒（:6534）。

## 四、需要 Owner 核准的 Production 動作（一次列清）

| 步驟 | Production 動作 | 為何非 Owner 不可 |
|---|---|---|
| A | 合併 `copyUserFlags` 的 PR 並部署 v3 | 依規則代理人不得自行 merge／觸發 workflow（F-0013） |
| B | 核准補遷 133 列＋95 衝突處置寫入正式 PG（先 dry-run＋隔離排練後） | 這是正式資料變更，只能 Owner 下令 |
| C(1) | 正式站開 `PG_SQLITE_FALLBACK=strict`（或決定維持 `closed` 的可用性取捨） | 直接影響正式可用性，屬 Owner 取捨 |
| C(2) | 部署「driver gate＋啟動檢查」版本；之後核准歸檔移除三台 `/data/v3.db*` | 動正式啟動路徑與正式節點檔案 |
| C(3) | 合併＋部署「移除 SQLite 分支」的最終版本 | 移除後無法再用本機庫當任何回退 |

## 五、可重跑的唯讀驗證指令

> 全部唯讀。PSQL 連線方式：`ssh syn-nas` 後
> `export PATH=/usr/local/bin:/bin:/usr/bin:$PATH; docker exec -i -u postgres 5151-postgres-B psql -tA -F"|" -d 5151_shadow -f -`
> （SQL 用 stdin 送）。時間戳是 TEXT、ISO 字尾 `Z`，比較時用字串字面值（例如 `'2026-10-08T12:0'`
> 可當字首比對今天）。注意 `settings` 表只有 `key`/`value` 兩欄、**沒有 `updated_at`**。

### 1. 比對 `-wal`／`-shm` 與主檔 mtime（三台節點）

```bash
# casa-nas 上的兩台
ssh casa-nas 'for c in 591-tracker-v3 5151-web-A; do echo "== $c =="; docker exec $c sh -c "ls -l --time-style=full-iso /data/v3.db /data/v3.db-wal /data/v3.db-shm 2>/dev/null"; done'
# syn-nas
ssh syn-nas 'export PATH=/usr/local/bin:/bin:/usr/bin:$PATH; docker exec 5151-web-B sh -c "ls -l --time-style=full-iso /data/v3.db /data/v3.db-wal /data/v3.db-shm 2>/dev/null"'
```

判讀：主檔 mtime 可能停在很久以前；**只要 `-wal`／`-shm` 的 mtime 是最近，就代表本機庫仍在被開／被寫**。

### 2. `user_listing_flags` 本機 vs PG：行數與最新時間戳

```bash
# 本機（容器內 node:sqlite，readOnly）
ssh casa-nas 'docker exec 591-tracker-v3 node -e "const {DatabaseSync}=require(\"node:sqlite\");const d=new DatabaseSync(\"/data/v3.db\",{readOnly:true});console.log(JSON.stringify(d.prepare(\"SELECT COUNT(*) n, MAX(viewed_at) viewed, MAX(watched_at) watched, MAX(hidden_at) hidden FROM user_listing_flags\").get()))"'

# PG（primary = syn-nas 5151-postgres-B）
ssh syn-nas 'export PATH=/usr/local/bin:/bin:/usr/bin:$PATH; docker exec -i -u postgres 5151-postgres-B psql -tA -F"|" -d 5151_shadow -f -' <<'SQL'
SELECT COUNT(*), MAX(viewed_at), MAX(watched_at), MAX(hidden_at) FROM user_listing_flags;
SQL
```

判讀：本機今天（2026-10-08）有 5 筆 `viewed_at`／`hidden_at`（最新 `15:47:35Z`），PG 今天 `hidden_at`
0 筆。若本機 MAX 持續前進而 PG 沒有對應列，就是孤島寫入還在發生。

### 3. PG 今天 hidden 筆數（確認孤島沒有被補上）

```bash
ssh syn-nas 'export PATH=/usr/local/bin:/bin:/usr/bin:$PATH; docker exec -i -u postgres 5151-postgres-B psql -tA -F"|" -d 5151_shadow -f -' <<'SQL'
SELECT COUNT(*) FROM user_listing_flags WHERE hidden_at >= '2026-10-08T00:00:00Z';
SQL
```

### 4. 三邊行數快照（§一.4 的對照）

```bash
ssh syn-nas 'export PATH=/usr/local/bin:/bin:/usr/bin:$PATH; docker exec -i -u postgres 5151-postgres-B psql -tA -F"|" -d 5151_shadow -f -' <<'SQL'
SELECT 'listings', COUNT(*) FROM listings
UNION ALL SELECT 'user_listing_flags', COUNT(*) FROM user_listing_flags
UNION ALL SELECT 'listing_groups', COUNT(*) FROM listing_groups
UNION ALL SELECT 'settings', COUNT(*) FROM settings
UNION ALL SELECT 'crawl_covers', COUNT(*) FROM crawl_covers
UNION ALL SELECT 'demand_posts', COUNT(*) FROM demand_posts;
SQL
```

（本機側用同一份 `node -e` 的 SQLite 唯讀查詢，把上面六個表各 COUNT 一次即可。）

---

## 2026-10-10 夜間校正

> **這一節不是修訂上文，而是把上文標成反面教材。** 前面 §一～§五 是 **2026-10-08** 的實測，
> 原文保留不動；其中「本機 SQLite 仍被開、仍被寫」、「三台都沒有設 `PG_SQLITE_FALLBACK=strict`」、
> 「`user_listing_flags` 是唯一還在長的活孤島」、「後台只是少資料」**這四項已全部失效**。
> 以下逐條是 2026-10-10 夜間實測（＋v4-pro 覆核）的結論，行號以 `origin/master = 0b7716c` 為準；
> 時間戳除另註外都是 UTC。
>
> 讀法：要判斷「現在還剩什麼」，只看本節；上文的價值在於記錄「閘還沒開之前的症狀長什麼樣」。

### 1. 閘已全面生效：SQLite 已經不再被開、不再被寫

- 三隻正式容器都設了 `PG_NO_SQLITE_OPEN=1`（`591-tracker-v3`、`5151-web-A`、`5151-web-B`），
  `5151-web-A` 另加 `PG_SQLITE_FALLBACK=strict`；三台跑的是**同一個映像 digest**（`sha256:4b2b4e452ec7…`）。
- 判準（不是靠感覺）：`-wal` 隔 **61 秒雙取樣、逐 byte 不動**，且 `/proc/*/fd` 掃過**沒有任何程序持有**
  `/data/v3.db*` ⇒ **SQLite 已不再被寫入**。
- 最後一次寫入落在 **2026-10-09 09:39**（tracker 節點）。
- ⇒ 上文 §一.2（「仍被開、仍被寫」）、§一.3（活孤島）、§一.5（三台都 fail-open 沒開 strict）
  與 §二 對照表第 1、2 列的現況描述**已作廢**。

### 2. 仍在拋錯的同步讀取只剩 3 條（24 小時 82 行）

| # | 爆點 | 呼叫鏈 | async 替身 |
|---|---|---|---|
| 1 | `watcher.js:1357 collectCommuteSettings()` | → `members.js:49 listUserIds()` | `settingsAsync.js:108`、`usersAsync.js:181`（**早已存在**） |
| 2 | `db.js:6588-6589 routeScanPlan`（同步 `collectCommuteSettings()` ＋ `commuteRushEnabled()`） | 經 `db.js:3869` / `db.js:3903 crawlerReadsBuildContext` → `repository/crawlerScans.js:106` | `settingsAsync.js:108`、`settingsAsync.js:89` |
| 3 | `db.js:8721 getCommunityCache()` | 呼叫者兩條：`watcher.js:375`，以及 `watcher.js:316` → `client591.js:424`（以 `getCommunity` 注入） | PG 端只有 async 寫 `crawlerWrites.js:213`（路徑是 **`v3/src/crawlerWrites.js`**，不是 `repository/`） |

第 2 條原本被第 1 條的錯誤量遮住，是這一輪才分出來的——**它一直是同一條鏈的另一個出口**，
只改第 1 條不會讓錯誤歸 0。

### 3. `listUserIds` 其餘 4 個呼叫點是死路／已 async ⇒ 不得再動

`db.js:4258`、`db.js:4338`、`db.js:5615`、`db.js:5705` 這四處**不要再改**：它們不是活路徑
（或已由 async 版本承接）。改了會造迴歸——這是本輪明確的「不要動的清單」，不是待辦。

### 4. 後台是「靜默 0」不是「少資料」

- `adminOverview.js:29-35 countSql()` 的實作是 `try { … } catch { return 0 }`；
  `adminOverview.js:157-167 sameHouseCounts()` 同一個形狀（`catch { /* schema may be fresh */ }`）。
  ⇒ 閘開了之後，後台呈現的是**假的 0**，不是「資料變少」，兩者在畫面上長得一樣。
- `adminOverview.js:187` 用的是**同步** `readSiteCatalogStats()`。
- 相關端點：`server.js:3162 /api/admin/overview`、`server.js:3174 /api/admin/data-health`、
  `server.js:3122`（GET）／`server.js:3129`（PUT）`/api/admin/system-crawl`；
  最後一組打到 `siteContentAsync.js:240`／`siteContentAsync.js:258` 的**未擋閘鏡射寫**。
  （同一條線上的技術債見第 12 條。）

### 5. 匯入路徑有「半套寫入」

`listingImportAsync.js:320-322`／`:362-363`／`:407-408`：PG 寫成功之後，**沒有 try/catch**
就再寫一次本機 SQLite（`sqliteHandle().prepare(…).run(…)`）。
⇒ 開閘（SQLite 不可用）時的行為是「**PG 已經寫進去、使用者卻收到錯誤**」——資料是對的、體驗是壞的，
而且重試會再做一次。這是 P3 包（鏡射寫移除）的主目標。

### 6. 裁決：PG 缺的 7 欄與 3 張表「不補」

- 7 欄＝`fee_includes` ＋ 6 個 `self_mrt_*`；3 張表＝`member_support_code`／
  `sponsor_entitlement_grant`／`support_poll_cursor`。**兩邊都是零資料**（見 §四的快照複核），
  補它沒有意義。
- 而且 lazy-add 早就接線：
  - `selfListingsAsync.js:374-383 SELF_LISTING_PG_COLUMNS`（`ALTER TABLE … ADD COLUMN IF NOT EXISTS`）
    ＋ `selfListingsAsync.js:386 ensureSelfListingColumnsOnce()` ＋ `:410` 的呼叫點。
  - `sponsorEntitlementAsync.js:31 ensureSponsorEntitlementStore()` ＋ `:50` 的呼叫點
    （沒有可用 SQLite handle 時走 PG 原生 DDL）。
- ⇒ 這一條是**已裁決**，不要再開「補欄／補表」的工作項。

### 7. `schema_migrations` 的編號不需要對齊

SQLite 走 `migrate.js` 的**編號 runner**（`SCHEMA_MIGRATIONS_DDL_SQLITE`，`applied_at` 是 TEXT）；
PG 走 `pgSchema.ensurePgSchema()` 的**鏡射**，再各自用模組內的 lazy `CREATE/ALTER … IF NOT EXISTS`
補欄補表（`SCHEMA_MIGRATIONS_DDL_PG` 幾乎沒被使用）。兩套體系本來就不相同，
「PG 只有 5 版、SQLite 有 11 版」**不是缺口**，也不需要對齊。

### 8. 啟動檢查已經存在，不要重做

`v3/src/runtimeGuards.js` 的 `assertRuntimeDbGuard()`（commit `7d119c7`）已經在
`PG_NO_SQLITE_OPEN`／`PG_SQLITE_FALLBACK=open` 這幾種「會悄悄退回本機 SQLite」的設定上 fail-closed；
接線在 `server.js:5451` 與 `watcher.js:732`，測試是 `v3/test/runtime-guards.test.js`。
⇒ §二 對照表第 4 列的落差已結案，不要再寫第二份啟動檢查。

- 但它**還缺兩刀**（judgment 層已認定，2026-10-10）：目前只看得到 `DB_DRIVER` 解析結果、
  「有 PG env 卻不是 postgres」、以及 `PG_SQLITE_FALLBACK=open`；**沒有**
  （a）在有 PG 連線 env 時強制要求 `PG_NO_SQLITE_OPEN=1`、**也沒有**
  （b）拒絕 `PG_SQLITE_FALLBACK` 停在預設的 `closed`（`closed` 仍然允許**讀取**回退本機 SQLite）。
- **這兩刀由另一包（P5）做，本文件的讀者不要動 `v3/src/`**——本節只是把「已經有什麼、還缺什麼」寫清楚，
  避免下一包又去重做一個已經存在的檢查。

### 9. 不追的清單（標待查、不推測、不阻塞退場）

下面 6 張表的 PG 列數**少於凍結快照**，原因**尚未查證**：

| 表 | 差異 |
|---|---|
| `provider_usage_logs` | −49,710 |
| `rental_analytics_daily` | −1 |
| `rental_notify_prefs` | −1 |
| `user_match_signals` | −2 |
| `user_match_votes` | −2 |
| `admin_audit` | −1 |

處置：**標記待查**，不推測原因，也**不列為退場阻塞項**（沒有任何一條指向「SQLite 還留著獨有資料」）。

### 10. 待架構層裁決的一條

`crawlerReads.js:59 scan()` 只認 `options.strict`（`crawlerReads.js:67` 的 `if (options.strict) throw error;`），
**不認** `fallbackMode` ⇒ 一旦把 `/data/v3.db*` 摘掉，這條 fail-open 會從「靜默回退」變成「直接 throw」。
需要在影子站確認**沒有業務路徑依賴這條回退**之後，才由架構層決定「改成 throw」或「改走 async 替身」。

### 11. 剩餘退場步驟與門禁

1. 改碼三包：**P1** 同步讀（本節第 2 條那 3 條鏈）／**P2** 後台 async 讀（第 4 條）／
   **P3** 鏡射寫移除（第 5 條）。
2. 各自開 PR → **CI 綠**。
3. **（Owner 核准）** 合併 → 發版（依 F-0013，代理人不得自行 merge／觸發 workflow）。
4. `docker logs` 的 `business SQLite is closed` 等錯誤**歸 0**。
5. 跑退場快照：`node v3/scripts/snapshot-sqlite-exit.mjs --sqlite=/data/v3.db --pg-url=PG_URL --out=<file> --sample-seconds=61`
   （唯讀；正式 PG 目標需 `ALLOW_PRODUCTION_PG_TARGET=1` 明確授權）。
6. **（Owner 核准）** 摘除 `/data/v3.db`、`/data/v3.db-wal`、`/data/v3.db-shm`。
   **`/data` 掛載本身必須保留**——`auth.env`／`vapid.json`／media 都在裡面（見 §三 C(2)）。
   - **順序裁決（2026-10-10）：先刪資料檔，source 檔留到最後。**
     〔路〕`/data/v3.db*`：門禁全綠＋Owner 手動 → 現在就可以刪。
     〔碼〕搬出來的同步分支 source 檔（P2 之後會出現的 `*Sqlite.js` 這類）：
     **留到 C(3) 移除同步分支那一刀**才刪。
   - 理由：`adminOverview.js` 是**模組載入期的 eager import**（現行是 `:3-13` 直接 `from "./db.js"`；
     P2 拆檔之後同形的 eager import 會指向被搬出去的那支 `*Sqlite.js`）。
     先刪 source 檔會讓 ESM 連結失敗 ⇒ **所有模式（含純 PG）都起不來**，
     那會比「留著一個沒人呼叫的檔案」嚴重得多。
7. 收尾：同步調整 `.github/workflows/build-production-image.yml:303-313` 的 build smoke
   （`test -f "$SMOKE_DIR/v3.db"` 在 `:303`，那段 `node:sqlite` 完整性檢查整段要拔掉或改成「不存在也要過」）；
   `production-predeploy-remote.sh` 已經支援 v3.db 不存在，不用另外改。

### 12. 已知技術債（本次不改，記檔就好）：`scheduleTransaction` 不接受注入式 exec

- `v3/src/crawlScheduleAsync.js:25 scheduleTransaction()` 的 PG 分支直接走
  `driver.withTransaction(...)`（`:25-29`），**沒有 `options.exec` 注入口**。
- 因此 `readCrawlSourceStreaksAsync()`（`v3/src/crawlScheduleAsync.js:136`）**不吃注入式 exec**
  ⇒ 後台總覽在 PG 模式下**多開一個交易**才能讀 streak，而且測試想塞 stub 得另外繞。
- 對照組（同一個 repo 已經做對的形狀）：`v3/src/adminOverviewAsync.js:31-42 pgExec()`，
  在 `:32` 就有 `if (options.exec)`。
- **沒有 correctness bug**：`v3/src/adminOverviewAsync.js:74-79` 把讀 streak 的失敗吞成 `streaks = {}`
  （與 `lastSeen` 同樣的容忍度，後台總覽不會因此壞掉）。
- 後續：**等 SQLite 模式全退之後**再把它改成吃 `options.exec`（那條路徑是純讀，本來也不需要交易）。
  在那之前不動它——現在動會與 P1／P2／P3 三包撞車。

> 這一節對 §二 對照表的更新：第 1、2 列（讀寫回退、無條件開庫）與第 4 列（啟動檢查）**已結案**；
> 第 3 列（`/data` 保留、改為不開啟＋歸檔移除）**做法不變**；第 5 列（步驟 4 對帳 → 步驟 7 刪除）
> 的順序不變，只是「補遷」被第 6 條的裁決縮小成「零資料、不補」。
