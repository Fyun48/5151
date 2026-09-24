# 正式站「SQLite 退場」現況報告（給外部審查用）

> 撰寫：2026-09-24（UTC 12:2x）／作者：Cline（自動化代理）
> 用途：供 Owner 交付第三方（ChatGPT）審查「PostgreSQL ＋ HA 上線後，正式站仍在使用 SQLite」的現況、風險與建議做法。
> 所有數字均為**實查輸出**，指令與原始輸出見 §10。不確定的地方在 §7 明確標示「未確認」。

## 0. 一句話結論

**主資料（房源、入庫分析、變更紀錄、通知事件、會員設定）已全部走 PostgreSQL；但正式站此刻仍有寫入落在節點本機的 SQLite**，
實測 93 秒內 `listing_match_evaluations` 就增加了 13 筆（§4.1），且 `crawl_covers` 每一輪都被重寫（§4.2）。
這與原計畫明訂的「PG 模式：**寫入 fail-closed、不得落回 SQLite**」（§3）相違，
在 HA（公開流量可在 web-A／web-B 之間輪替、PG 為 primary＋standby）的前提下就是**節點間資料分歧的來源**，必須收斂。

## 1. 環境事實（實查）

| 項目 | 實查值 | 來源 |
|---|---|---|
| 正式站容器 | `591-tracker-v3`，`revision=9c6b7b04f9801717cb6696e8e095fde4c309473f`，`restarts=0` | `docker inspect` |
| `DB_DRIVER` | **`postgres`** | `docker exec printenv` |
| `PG_URL` | `postgres://postgres:***@192.168.0.140:25433/5151_shadow` | `printenv`（密碼不重現） |
| 正式站埠 | **只有** `127.0.0.1:5153->5153/tcp` | `docker port` |
| `/data` 掛載 | bind `/mnt/Storage1/docker_data/591-tracker-v3` → `/data`，**`rw`** | `docker inspect .Mounts` |
| `/app/src`、`/app/public` | bind 主機目錄，**`ro`** | 同上 |
| web-A 容器 | `5151-web-A`，`DB_DRIVER=postgres`，**也有自己的 `v3.db`（464 MB；mtime 19:08、`v3.db-wal` 19:10 本地時間）** | `docker exec` |
| web-B | 在 Synology（`root` 需密碼，本次未登入）→ **未確認** | — |
| PG | primary = Synology `5151-postgres-B`、hot standby = CasaOS `5151-postgres-A`、HAProxy `pg-rw`/`pg-ro` | `docs/handoffs/20260921-postgres-cutover-session.md` |
| 公開入口 | Cloudflare tunnel ×2 ＋ HAProxy ×2 → `127.0.0.1:25153` | `docs/handoffs/20260924-three-node-align-and-entry-ha.md` |

> 註：`5151_shadow` 是歷史遺留名稱（PG 叢集原為 shadow 驗證環境，後來成為正式）。名稱易誤導，建議日後改名或在維運文件標註。

## 2. 現況分層：哪些已經在 PG、哪些還在 SQLite

### 2.1 已走 PostgreSQL（實測持續在動）

| 資料 | PG 現值 | 容器 SQLite（凍結） | 說明 |
|---|---|---|---|
| `listings` | **118,762** | 115,618（最後寫入 2026-09-22T05:48Z） | 爬蟲入庫主表 |
| `data_revision`（變更紀錄） | **734,217** | 685,489 | 每次入庫一筆 |
| `user_events`（通知佇列） | **7,331** | 7,280 | 會員事件 |
| `listing_prep`（入庫前分析） | **330** | 153 | — |
| `listing_enrich_jobs` | 9,145 | 9,145 | 補齊佇列（匯入後相等） |
| `user_listing_flags` | 705 | 706 | 個人標記（等值） |
| `settings` | 28 | 26 | 全域設定（部分走 PG） |
| `route_jobs` | 72,951 | 73,660 | 通勤任務 |
| `provider_usage_logs` | （未比對） | 65,104（凍結） | 預算／用量 |

### 2.2 已確認「此刻仍寫進 SQLite」（實測）

1. **`listing_match_evaluations`（同屋源配對評估）**：93 秒內 **859,383 → 859,396（+13）**。
   寫入來源唯一：`v3/src/listingGroups.js:165` 的同步 `INSERT`，**沒有任何 PG 版本或 repository**（§4.1）。
2. **`crawl_covers`（每輪覆蓋條件）**：兩次快照分別看到 **6 筆**與 **2 筆**（同一張表、內容一直變），
   來源是 `watcher.js:665` `replaceCrawlCovers(db, jobs)`（同步 SQLite handle）。
   而 PG 端的 `crawl_covers` 停在匯入時的 **38 筆**舊資料（§4.2）。
3. **SQLite 檔本身持續被寫**：`/data/v3.db-wal` 的 mtime 在兩次快照間由 `12:16:57` → `12:18:58`（UTC）。
4. **web-A 也有自己的 SQLite 且在寫**：`5151-web-A` 的 `v3.db` mtime `19:08`、`v3.db-wal` `19:10`（本地時間＝UTC+8）。
   → **兩個節點各有一份 SQLite 且都在寫**，這就是 HA 下的分歧來源。

### 2.3 由程式碼稽核得知（尚未逐一實測，但路徑明確）

- `v3/src/db.js` 內仍有 **150 處** `db.prepare(`（同步 SQLite）；其他仍大量使用同步 SQLite 的模組：
  `demand.js` 65、`support.js` 59、`rentalNotify.js` 59、`crm.js` 37、`listingTools.js` 36、
  `selfListings.js` 35、`wishOffers.js` 33、`memberMedia.js` 25、`listingGroups.js` 24、
  `budgetGuard.js` 22（`v3/src/*.js` 逐檔統計）。
- 抓取流程主檔 `watcher.js` **已無** `db.prepare(`（已移植），但它呼叫的 `db.js` 同步函式仍落 SQLite：
  `replaceCrawlCovers(db, jobs)`、`listingCount()`／`listingCountForSearch()`、
  `getRakuyaPageCursors()`／`saveRakuyaPageCursors()`、`markSourceKitRetry()`、
  `getSystemCrawl()`／`saveSystemCrawl()`、`refreshSiteCatalogStats()`／`writeSettingKey()`／`settingKey()`、
  `getSpirit()`／`saveSpirit()`、`writeHousingData()`（皆為同步 SQLite 形狀）。

## 3. 原計畫怎麼說（`v3/POSTGRES_SWITCH_PLAN.md` 原文）

- 目標（§2 第 51–53 行）：
  > 目前只有 listings 搜尋有 PG 路徑；爬蟲入庫、會員標記（`user_listing_flags`）、通知、許願房等寫入仍全部打 SQLite。
  > **一旦讀取改走 PG，寫入還在 SQLite，兩邊就會分叉**，所以這是 cutover 前必須先處理的一項。
- 政策（§2 第 118–128 行，2026-09-23 定）：
  > **PG 模式的 SQLite fallback 政策（收掉寫入的 fail-open）**：每個 `*Async` 模組原本在 PG 失敗時一律 fail-open 回本機 SQLite。
  > 讀取那樣是合理的，但寫入會寫進「站不會讀的 store」＝無聲的資料分歧（HA 演練時真的出現過寫入失敗的窗口）。
  > 現在由 `v3/src/sqliteFallback.js` 統一決定：**寫入 fail-closed**（往上丟…）、**讀取維持 fail-open**；
  > 緊急時可用 `PG_SQLITE_FALLBACK=open` 回退成舊行為。
- SQLite 保留的三個角色（§1 第 4 行、§4 第 277–278 行）：
  > （`DB_DRIVER` 預設仍是 `sqlite`，公開站不受影響）
  > **回復**：把 `DB_DRIVER` 改回 `sqlite` 並以 `deploy-v3.yml` 回前一版 image digest；**SQLite 檔在切換後仍保留** → 資料不丟。

⇒ 因此「不再使用 SQLite」的正確範圍是：**正式站的資料寫入與真相來源只用 PostgreSQL**；
SQLite 仍是（a）本機／測試預設 driver、（b）讀取 fail-open 回退、（c）rollback 路徑。

## 4. 實測證據

### 4.1 93 秒內 SQLite 有哪些表在長（全表快照 diff）

```
t1 = 2026-09-24T12:17:30Z   t2 = 2026-09-24T12:19:03Z
唯一變化：listing_match_evaluations  859,383 → 859,396   (+13)
檔案：v3.db-wal mtime 12:16:57Z → 12:18:58Z；v3.db-shm 12:16:31Z → 12:18:42Z
（其餘 80+ 張表筆數完全相同，含 listings / data_revision / user_events）
```

### 4.2 同一天較早的 `crawl_covers` 快照（同一張表、內容在變）

```
SQLite crawl_covers：6 筆（12:06） → 2 筆（12:17 快照）   ← 每輪 DELETE + INSERT，快照時點不同
PG      crawl_covers：38 筆，last_run_at 全部 NULL       ← 匯入後的舊值
```

### 4.3 SQLite vs PostgreSQL 逐表對照（12:06:58Z）

| 表 | SQLite | PostgreSQL |
|---|---|---|
| `listings` | 115,618 | 118,762 |
| `listing_search_projection` | 115,618 | **32,198（落差 86,564，原因未確認，見 §7.3）** |
| `data_revision` | 685,489 | 734,217 |
| `user_events` | 7,280 | 7,331 |
| `crawl_covers` | 6→2 | 38（舊） |
| `settings` | 26 | 28 |
| `listing_prep` | 153 | 330 |
| `route_jobs` | 73,660 | 72,951 |
| SQLite 檔最後寫入 | 2026-09-22T05:48:53Z（主檔；但 WAL 一直動） | — |

### 4.4 程式碼稽核（`v3/src/*.js` 內 `db.prepare(` 次數）

方法：以 `grep -c 'db.prepare('` 逐檔統計（完整輸出見 §10.1）。抓取主檔 `watcher.js` 為 **0**，
但其呼叫的 `db.js` 同步函式仍是 SQLite 形狀——這是「看起來已移植、實際仍在寫 SQLite」的來源。

## 5. 仍未走 PostgreSQL 的完整清單（含位置）

### P0 — 此刻仍在污染 SQLite，且在 HA 下會導致節點行為不一致

| # | 項目 | 位置 | 為什麼是 P0 |
|---|---|---|---|
| 1 | **`listing_match_evaluations`**（同屋源配對評估） | 唯一寫入：`v3/src/listingGroups.js:165`（同步）；**無 PG 版、無 repository** | 實測 93 秒 +13 筆；兩節點各自一份 → 「疑似同屋源」判定跨節點不一致 |
| 2 | **`crawl_covers` 讀寫** | 寫：`watcher.js:665` `replaceCrawlCovers(db, jobs)`；讀：`db.js` `listCrawlCovers(db)`（`coveringPlan` 用）；`crawlCovers.touchCrawlCoversRun(db)` | 每輪覆蓋條件只寫 SQLite；PG 端仍是匯入時的 38 筆舊值 |
| 3 | **抓取用同步讀** `listingCount()`／`listingCountForSearch()` | `db.js`（watch 路徑用來判斷 baseline） | PG 模式讀到凍結值 → baseline 判斷錯誤 |
| 4 | **樂屋網分頁游標** `getRakuyaPageCursors()`／`saveRakuyaPageCursors()`、**source-kit 重試** `markSourceKitRetry()` | `db.js`（同步） | 抓取進度跨節點不一致 |
| 5 | `listing_groups`／`listing_group_members`／`listing_group_audits` | `listingGroups.js`（24 處同步） | **未逐一確認**是否已有 PG 寫入端（PG 有對應表）→ 見 §7.3 |

### P1 — 設定類（會被「這次輪到哪一台回答」影響）

| # | 項目 | 位置 |
|---|---|---|
| 6 | 後台全站抓取設定 `getSystemCrawl()`／`saveSystemCrawl()` | `db.js`（同步 SQLite）→ 管理員改的間隔只落在一台 |
| 7 | site 鍵：`refreshSiteCatalogStats()`（`siteCatalogStats`）、`writeSettingKey()`／`settingKey()`（covering 時間戳已在 2026-09-24 的 #493／#495 改走 PG，其餘未）、`getSpirit()`／`saveSpirit()`、`writeHousingData()`、`getMailTemplates()` | `db.js` |
| 8 | 預算／用量：`provider_usage_logs`、`budget_limits`、`call_reservations` | `budgetGuard.js`（22 處同步）→ **啟用付費 provider 前必須修**（跨節點預算不準） |

### P2 — 功能 domain（尚未移植，多數已有 repository 示範可照抄）

`demand.js`(65)、`support.js`(59)、`rentalNotify.js`(59)、`crm.js`(37)、`listingTools.js`(36)、
`selfListings.js`(35)、`wishOffers.js`(33)、`memberMedia.js`(25)、`comms.js`(21)、
`listingSimilarity.js`(18)、`contentDocuments.js`(15)、`jobQueue.js`(13)、`feedbackOutbox.js`(13)、
`feedback.js`(12)、`userSameHouse.js`(11)（數字＝該檔 `db.prepare(` 次數）

## 6. 風險：在「PG ＋ HA」下繼續有 SQLite 寫入會怎樣

1. **節點間分歧（已發生）**：`listing_match_evaluations`、`crawl_covers`、樂屋游標、source-kit 重試狀態都是「每台一份」。
   使用者在 web-A 得到的判定與 web-B 可能不同；同一個「全站抓取」在三台各自算自己的。
2. **讀取 fail-open 回本機 SQLite ＝ 可能回舊資料**：`sqliteFallback.js` 目前是「讀取 fail-open、寫入 fail-closed」。
   在 HA 下，PG 出問題時回本機 SQLite 會回**該節點的舊快照**。2026-09-23 的「設定檔不見、列表全空」就是這一類（當時是會員設定島嶼）。
   → 建議重新評估：正式站的讀取是否也該 fail-closed（或至少大聲告警）。
3. **HA 切換（web 或 PG primary）時的行為差異**：PG standby 的**主資料完整**（listings／flags／events／settings 已同步），
   但上述 islands 的狀態不跟著走 → 會出現「換一台後，配對評估／覆蓋進度／游標看似倒退」。
4. **rollback 能力會反過來依賴這件事**：計畫 §4 寫明「回復不自動回寫」；
   若 islands 沒有移植完成，`DB_DRIVER=sqlite` 的 rollback 會缺新資料 → **完成移植才是保有 rollback 的前提**。
5. **資源成本**：正式站 `v3.db` 498 MB ＋ web-A 464 MB，各自成長、各自備份（計畫 §1 的 backup 流程只備份正式站資料卷）。
6. **政策有漏洞（結構性）**：`sqliteFallback` 只保護 9 個 `*Async` 模組的 helper；
   `db.js` 內的**同步** `db.prepare` 寫入完全繞過這個政策 → 這就是今天仍在寫 SQLite 的機制。

## 7. 我無法確認 / 不確定該怎麼改的部分（請特別審查）

1. **web-B（Synology）的狀態我查不到**：`root@syn-nas` 需要密碼（無免密碼登入）。
   待確認：`DB_DRIVER`、`/data/v3.db*` 是否存在與 mtime → 這決定「幾個節點各有一份 SQLite」。
2. **`listing_search_projection` 落差原因未確認**（PG 32,198 vs SQLite 115,618）。
   可能是「投影只涵蓋可搜尋子集（正常）」或「漏建（異常）」。
   需用 visitor 搜尋路徑（`repository.searchPage`）實際對照 → **這是唯一可能讓訪客少看到房源的疑點**。
3. **`listing_groups`／`listing_group_members`／`listing_group_audits` 是否已有 PG 寫入端**：未逐一確認（PG 有表，但 `listingGroups.js` 仍 24 處同步）。
4. **結構性：同步函式不受 fail-closed 保護**。我傾向新增一個「PG 模式下 SQLite 寫入守門」（直接拋錯或大聲告警），
   而不是逐一改 150 處同步 SQL；但這會同時影響本機／測試（需環境變數可關）→ **需要決策**。
5. **`/data` 唯讀化的範圍未驗證**：`/data` 還放 `auth.env`、`vapid.json`、`member-media`、`self-photos`（唯讀化會影響媒體寫入）。
   我的意見：只把 `v3.db*` 單獨唯讀掛載，不要整包 `/data`。
6. **無法窮舉「一輪抓取會寫哪些 SQLite 表」**：我只能用「全表快照 diff」，目前只涵蓋 93 秒窗。
   建議做法：在**一輪抓取前後**各跑一次快照（涵蓋 ≥ 20 分鐘），才能把清單收斂到完整。
7. **我不建議一次改完 `db.js` 的 150 處同步 SQL**（回歸風險太高），建議依「實際會寫入」排序（即 §5 的 P0 → P1 → P2）。
8. **`jobQueue.js`／`queueDispatch.js` 在 PG 模式下的角色未確認**（可能是 enrich worker 的 claim；若讀 SQLite 會空跑）。
9. **今天我自己先前的判斷修正（誠實記錄）**：我一度認為「591 在擋」，實測是 HTTP 200／1.0 秒／無驗證碼；
   真正原因是**輪次過長撞 15 分鐘預算**（已用「每輪限額＋逐批記進度」處理，PR #495）。

## 8. 建議做法與驗收標準

### 8.1 順序（每個 PR 一個主題，符合 repo 慣例）

P0（§5 的 1–4，現在就在寫 SQLite）→ P1（設定類 6–7）→ P1（預算 8，**付費 provider 啟用前必須完成**）→ P2（功能 domain）→ 最後「`v3.db*` 唯讀化」。

### 8.2 每項的驗收方式（沿用計畫既有做法）

「同一份 payload 在兩個 driver 寫入後讀回完全相同」的 parity 測試（範例：`v3/test/write-path-parity.test.js`、
`v3/test/settings-driver-parity.test.js`、`v3/test/listing-state-writes.test.js`）。

### 8.3 「SQLite 真的退場」的可驗證標準

1. 正式站與 web-A（與 web-B）的 `v3.db*` **mtime 在 30 分鐘內不再變動**（涵蓋至少一輪抓取）。
2. 全表快照 diff（跨一輪抓取的時間窗）**沒有任何表筆數增加**。
3. PG 的 `crawl_covers.last_run_at` 開始更新；`listing_match_evaluations` 在 PG 出現且不再只長在 SQLite。
4. 每個移植項目都有 parity 測試進 CI。
5. 最後把 `v3.db*` 改唯讀掛載 → 任何漏掉的寫入會**立刻報錯**（而不是靜默分歧）。

### 8.4 我建議「不要變更」的部分

- SQLite **保留為本機與測試的 driver**（所有 parity 測試都靠它，也是 cutover 前的對照基準）。
- rollback 策略改為「**只支援 PG 內回版**（image digest 回上一版）」，並在計畫文件明確聲明不再保證 `DB_DRIVER=sqlite` 可完整回退。

## 9. 想請 ChatGPT 一起裁決的問題（附我的初步意見）

1. **`listing_match_evaluations` 是否該改寫法**（85 萬列且持續成長）：改成「每個 `post_id` 只保留最新評估（upsert）」或「只在結論變更時寫」？→ 我的意見：應該，順便解掉跨節點分歧與表膨脹。
2. **正式站的「讀取」是否也要 fail-closed**（目前讀取 fail-open 回本機 SQLite，HA 下可能回舊資料）？→ 我的意見：應該（或至少告警）。
3. **rollback 策略**是否改成「只支援 PG 內回版」？→ 我的意見：是，並更新計畫與 runbook。
4. **`crawl_covers` 是否還需要存在**？→ 我的意見：PG 版保留為觀測用，排程判定改用 settings 的進度時間戳（今天已朝此方向）。
5. **是否新增「SQLite 寫入守門」**（PG 模式下同步寫入直接拋錯／告警）？→ 我的意見：值得，但需環境變數可關。
6. **唯讀化範圍**：只 `v3.db*` 還是整個 `/data`？→ 我的意見：只 `v3.db*`。
7. **有沒有比我更可靠的「窮舉遺漏寫入端」方法**？（我目前只有全表快照 diff。）
8. **P2 的 15 個 domain 是否都要在 HA 完成前處理**，或可接受「單節點語意」先放著（許願房／CRM 等）？
   → 我的意見：**跨節點可見的（房源、通知、配對、預算）必須先**，其餘可排後面。

## 10. 附錄：指令與原始輸出

### 10.1 `v3/src/*.js` 內 `db.prepare(` 次數（稽核輸出）

```
150 db.js      65 demand.js    59 support.js   59 rentalNotify.js  37 crm.js
 36 listingTools.js  35 selfListings.js  33 wishOffers.js  25 memberMedia.js
 24 listingGroups.js  22 budgetGuard.js  21 comms.js  18 listingSimilarity.js
 15 contentDocuments.js  13 jobQueue.js  13 feedbackOutbox.js  12 feedback.js  11 userSameHouse.js
（抓取主檔 watcher.js：0）
```

### 10.2 使用過的唯讀腳本（可重跑）

- 全表快照 diff：`/tmp/sqlite-diff.mjs`（`SELECT COUNT(*)` 逐表 ＋ `statSync` 檔 mtime，`readOnly: true`）
- SQLite vs PG 逐表對照：`/tmp/store-compare.mjs`
- 執行方式（不寫入任何資料）：
  ```
  ssh root@casa-nas 'docker exec -i 591-tracker-v3 node --input-type=module' < /tmp/sqlite-diff.mjs
  ```

### 10.3 今天（2026-09-24）已完成的相關修正

| PR | 內容 | 狀態 |
|---|---|---|
| #492 | `data_revision` 序號自我校正 ＋ PG 變更紀錄 best-effort | 已合併、已發版 |
| #493 | 整輪完成紀錄改 driver-aware（不再只寫 SQLite） | 已合併、已發版 |
| #494 | 爬蟲事故紀錄（§10） | 已合併 |
| #495 | 每輪只跑一段覆蓋條件 ＋ 取頁階段就記進度 | 已合併、已發版（`9c6b7b04`） |



