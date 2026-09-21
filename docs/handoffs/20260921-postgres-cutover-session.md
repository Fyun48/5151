# Session 交接：PostgreSQL 雙驅動收尾（2026-09-21）

> **這份同時是 2026-09-21 那次 AI session 的對話紀錄（§1）與交接文件。**
> 用途：隔天在另一台電腦接手時，不必重讀整段對話就能延續 —— §1 是按時間順序的事件與決策，
> §2 是關鍵檔案，§3 是可直接照抄的起手指令，§4 是還沒做完的 ③④ 與具體切法。

> 這份是 2026-09-21 那次 agent session 的交接文件，給**隔天用另一台電腦接手**的人（或 agent）看。
> 內容包含：當天的對話歷程（**憑證已遮蔽**）、目前狀態、以及還沒做完的 ③④ 與具體起手式。
>
> **憑證政策**：本文件與 repo 內任何檔案都**不含**密碼金鑰。當天對話裡出現過的兩組密碼
> （CasaOS root、shadow PG superuser）已置換為
> `<CASAOS_ROOT_PASSWORD>`／`<PG_SUPER_PASSWORD>`；實際值請向 Owner 索取，或從 NAS 上的
> `~/5151-shadow-ha/shadow-ha/postgres-primary/.env`（`PG_SUPER_PASSWORD`）取得。
> 這個 repo 之前就是因為 commit 含明文憑證才重建歷史（見 `AGENTS.md`），不要重犯。

## 0. 一句話現況

- master = `4752b51`（PR #405）。**已部署的程式版本是 `939ecb0`**（①＋②；之後的 #402／#403 是文件、
  #405 是 ③ 佇列讀寫，尚未部署 —— `DB_DRIVER` 仍 `unset`，所以沒部署也不影響使用者）。
- 移植進度：**①七條 `listingsNeeding*` 掃描 ✅、②迴圈欄位寫入 ✅、③通知佇列的讀＋寫 ✅**
  （三者都有 shadow PG live parity）。
- **③ 的另一半（`enqueueListingEvent()` 決策鏈）⛔、④ `enqueueSimilaritySafe` ⛔** → **還不能切換**。
- 正式站（CasaOS `591-tracker-v3`）跑 `939ecb0` 的映像，`DB_DRIVER=unset`（＝sqlite），行為不變。

## 1. 當天對話歷程（依序）

1. **任務下達**：接手 5151，把 v3 從 SQLite 移植到 PostgreSQL 的最後一段做完 ——
   ① 七條背景掃描、② 迴圈欄位寫入、③ 通知／CRM 佇列、④ similarity 佇列；全部完成後跑部署並回報 cutover 清單。
2. **環境盤點（第一個意外）**：工作目錄其實是 `F:\FYProject\cline\5151`（不是交接文寫的 `/workspace/repos/5151`）；
   Node v24.13.0／npm 11.7.0、`node_modules` 不存在 → 先 `npm install`（103 packages）。
   交接文說 live PG 測試要從本機 SSH 打 NAS 的 `/root/pgtest`；實際發現
   - `%USERPROFILE%\.ssh\bnplloan_nas` **不存在**（只有 `5151_ops_synology`，可登 `tori@114.34.73.76:58722`，root@:54722 被拒）；
   - **shadow PG 可從本機直連**：`192.168.0.220:15432`（Synology `5151-postgres-B`），
     密碼在 NAS 的 `~/5151-shadow-ha/shadow-ha/postgres-primary/.env`。
   → 於是所有 live parity 都在本機直跑，不必繞 SSH。**這是本輪最省時間的發現，隔天請直接沿用。**
3. **① 實作**：7 條掃描全部落地（builder → `crawlerReadsBuildContext()` → `repository/crawlerScans.js` → `crawlerReads.needingXxxAsync()` → `watcher.js` await）。
   `crawler-reads-parity.test.js` 由 6 項長到 **8/8**（新增 7 條掃描的逐列逐序比對＋PG 分支覆蓋）。
4. **② 實作**：`repository/listingFields.js` ＋ `crawlerWrites` async 分派；值決策抽成 db.js 純 planner
   （`listingDetailPlan()`／`hpFieldsPlan()`／`mrtCacheUpsert()`／`communityCacheUpsert()`／`listingLocationUpdate()`）。
   新測試 `listing-fields-parity.test.js` **6/6**。
5. **踩坑與修正（4 個，細節見 evidence）**：
   1. `CASE WHEN ?`：PG 要 boolean、`node:sqlite` 不能綁 boolean → 統一 `CASE WHEN ? = 1`。
   2. `? IS NOT NULL`：PG 無法推參數型別 → `CAST(? AS DOUBLE PRECISION) IS NOT NULL`。
   3. `listingLocationUpdate()` 在 SQLite 端取 `current.post_id`（窄 SELECT 沒有 post_id）→ `WHERE post_id = 0` 靜默不更新。
   4. **既有 bug**：`repository/decorationData.js` 的 `PEER_COLUMNS_QUALIFIED` 用 `split(",\n")` 只替每行首欄加 `l.`
      → PG 在 `listing_group_members JOIN listings` 回 `column reference "source" is ambiguous`（SQLite 容忍）。
6. **全量測試**：本機 `npm test` 2417 項、111 筆失敗，**與改動前同一組**（全在 `ops/test`，Windows 的 git worktree 問題）；CI（Linux）綠。
7. **合併與部署**：PR #401 合併（`939ecb0`）→ 三條 manual workflow（build `35699964209` → predeploy `35600236264` → deploy `35600462363`）→
   `IMAGE_DIGEST=sha256:937719ef9c128fa36a4428ee45f390800cc2262c35f4b9c29d110514fbc220f1`。
8. **NAS 端驗證**（Owner 事後給了 root 密碼，用一次性 `ssh2` 腳本讀取、腳本已刪、憑證未落地）：
   `REVISION=939ecb0…`、`REPODIGESTS=[ghcr.io/fyun48/5151@sha256:937719ef…]`、`STATUS=running`、
   本機 `HEALTH=200`／`LANDING=200`／`STATE_ANON=401`、**`DB_DRIVER=unset`（仍 sqlite）**、
   只有 `591-tracker-v3` 被重建、公開站 `/` 200 與 `/api/health` 200。
9. **文件**：#402（切換清單狀態）、#403（上版證據）均已合併；切換 runbook 的步驟 0 已把 ③④ 標成 ⛔。
10. **收尾**：Owner 要求把這個 session 的內容上 GitHub 以便隔天換機續做 → `docs/handoffs/20260921-postgres-cutover-session.md`（PR #404）。
11. **續做 ③ 的第 1 段**（Owner 說「請繼續」之後）：通知佇列的讀＋寫 driver-aware 化
    （`notifyBuildContext()`＋`repository/notifyQueue.js`＋`notifyQueueAsync.js`，watcher 13 處改 await），
    live parity `notify-queue-parity.test.js` **5/5**，PR #405（`4752b51`）合併。
    過程中發現：`pendingNotifyEvents()` 要回一般物件（null-prototype 會讓 async twins 的形狀不同）；
    fixture 混用 event id 與 post_id 被測試直接抓出來。
12. **尚未完成**：③ 的第 2 段（`enqueueListingEvent()` 決策鏈）與 ④（見 §4）。

## 2. 已完成項目的關鍵檔案

| 主題 | 檔案 |
|---|---|
| 掃描 builder／pick | `v3/src/db.js`（`aliveCheckScanQuery`／`offlineRecheckScanQuery`／`feeDetail*`／`sourceKit*`／`geo591ScanQuery`／`communityCacheIdsQuery`／`addressGeoScanQuery`／`addressEnrichScanQuery`／`mrtScanQuery`／`mrtCacheKeysQuery`／`routeScanPlan`／`route*Query`／`routeRowNeed`） |
| 掃描 repository | `v3/src/repository/crawlerScans.js`（`select*Candidates`；`selectRouteCandidates` 回 `{ rows, cursor }`） |
| 讀取 façade | `v3/src/crawlerReads.js`（`needingXxxAsync`，含 `needingRouteAsync.lastCursor`） |
| 欄位寫入 repository | `v3/src/repository/listingFields.js` |
| 欄位寫入 façade | `v3/src/crawlerWrites.js`（`setListingDetailAsync`／`persistHpListingFieldsAsync`／`setCachedMrtAsync`／`setCommunityCacheAsync`／`upsertListingPrepAsync`＋`loadListingForWrite`） |
| prep 語句 | `v3/src/listingEnrichQueue.js`（`LISTING_PREP_UPSERT_SQL`／`listingPrepPlan()`／`upsertListingPrepAsync()`／`prepWrite()`／`runHelper`） |
| 呼叫點 | `v3/src/watcher.js`（7 個 backfill ＋ `applyFetchedDetail`／`applyCommunityPin`／`detailOptions().saveCommunity`／MRT 迴圈／`listingEnrichHelpers()`） |
| 測試 | `v3/test/crawler-reads-parity.test.js`、`v3/test/listing-fields-parity.test.js` |
| 證據 | `v3/evidence/pg-loop-parity-20260921/README.md` |

## 3. 隔天起手式（照抄就能跑）

```powershell
# 1) 拉最新
cd F:\FYProject\cline\5151   # 或你新機器的路徑
npm install
git pull

# 2) 不需要 PG 的
npm test

# 3) live shadow PG（本機直連，密碼見 §0 憑證政策）
$env:PG_TEST_URL = 'postgres://postgres:<PG_SUPER_PASSWORD>@192.168.0.220:15432/5151_shadow'
node --test v3/test/crawler-reads-parity.test.js v3/test/listing-fields-parity.test.js `
  v3/test/listing-state-writes.test.js v3/test/listing-detail-parity.test.js v3/test/write-path-parity.test.js
# → 2026-09-21 實測 24/24

# 4) CasaOS 端實查（root 密碼向 Owner 要；Windows OpenSSH 不能非互動帶密碼，
#    當天是 npm i ssh2 到 %TEMP% 寫 20 行 runner，讀 env 傳入，事後刪除）
#    docker inspect 591-tracker-v3 --format '{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
#    curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5153/api/health
#    docker exec 591-tracker-v3 sh -c 'echo DB_DRIVER=${DB_DRIVER:-unset}'
```

## 4. 還沒做完的 ③④（隔天從這裡開始）

### ③ 通知／CRM 佇列的讀寫（切換阻塞項）

**症狀**：PG 模式下通知寫進 SQLite、Web 讀 PG → **會員收不到通知**；CRM outbox 同理。

**現況清單（`v3/src/db.js` 內）**

| 函式 | 形狀 | 備註 |
|---|---|---|
| `pendingNotifyEvents(limit, now)` | 讀（`user_events` LEFT JOIN `listings`，含排序 CASE） | flush 迴圈的入口 |
| `updateEventNotify(id, patch)` | 先讀整列再寫 12 欄 | 失敗時 fallback `markEventNotified` |
| `markEventNotified(id)` | 單欄 UPDATE | |
| `channelJobDone(state)` | 純函式 | 不需移植 |
| `reopenNotifyAfterGeo(postId, coord)` | 單一 UPDATE | **已完成**：語句已抽成 `notifyReopenQuery()`，欄位寫入路徑（`setListingDetailAsync` 的座標更新）已在 PG 上跑它 |
| `markLegacyNotifiedUnknown()` | 批次 UPDATE | 遷移用 |
| `addUserEvent(event)` | INSERT（`user_events`） | **瓶頸**：`enqueueListingEvent()` 用它在 PG/SQLite 之間選錯邊 |
| `enqueueListingEvent(listing, event)` | 決策＋寫入 | 依賴 `listUserIds()`／`getSettings()`／`notifyJobSnapshotFor()`（search profile）／`loadFlags()`／`groupIdForPost()`／`watchedInGroup()`／`alreadyNotifiedGroup()`／`getMemberMailBundle()` |
| `v3/src/crmOutbox.js`（`enqueueCrmOutbox`／`claimCrmOutboxBatch`／`markCrmOutboxSent`／`markCrmOutboxFailure`／`crmOutboxStats`） | `fn(db, …)` 形式、同步 | 語句單純，但 `res.changes` 是 SQLite 專屬（PG 要用 rowCount） |

**建議切法（兩段）**

> **狀態（2026-09-21 晚間補記）**：**第 1 段已完成並合併** —— PR #405（`4752b51`）：
> `notifyBuildContext()` ＋ `repository/notifyQueue.js` ＋ `v3/src/notifyQueueAsync.js`，
> `watcher.js` 13 處改 await，live parity `v3/test/notify-queue-parity.test.js` **5/5**
> （證據 `v3/evidence/pg-notify-queue-20260921/README.md`）。
> **隔天請直接從下面的第 2 段（`enqueueListingEvent` 決策鏈）開始**，不要重做第 1 段。

1. ~~**佇列的讀＋寫**~~ ✅ 完成（見上）。
2. **`enqueueListingEvent()` 的決策鏈**（真正的瓶頸，需要先補三個尚未移植的讀取）：
   - `users`（`repository/users.js` 已有 `list()` ✅）、`user_listing_flags`（`repository/flags.js` ✅）、
     `settings`（`repository/settings.js` 已存在，但 `getSettings(uid)` 是 db.js 的大型組裝函式，**尚未接**）、
     search profile（`getActiveSearchProfile`）與 listing group（`groupIdForPost`／`watchedInGroup`／`alreadyNotifiedGroup`）**尚未移植**。
   - 也就是說 ③ 要完整關閉，會拉到「settings／search profile／listing group 的 PG 讀取」這幾個 §2 的獨立項目。
     建議做法：`enqueueListingEventAsync()` 接受注入的 lookups（`users`／`settings`／`flags`／`groupIds`／`alreadyNotified`），
     SQLite 傳原本的同步版本、PG 傳 repository 版本，決策主體保持純函式（本輪 ①② 已用這個模式三次）。

### ④ `enqueueSimilaritySafe`（pHash 佇列）

**症狀**：`persistListing()` 的 PG 分支目前刻意**不呼叫**它（`db.js` 有註解），所以 PG 模式下新爬進來的物件
不會進 `listing_image_phash`／`listing_similarity_suggestion`／`listing_crawl_insight`。功能缺口，不會寫壞資料。

**難點**：`v3/src/listingSimilarity.js` 的 `enqueueListingSimilarity(db, listing, opts)` 整條鏈都是同步 SQLite 形狀
（13 處 `db.prepare`，加上 `shouldEnqueueSimilarity`／`isPhashEnabled`／`loadEnabledProvider` 讀 `settings` 與
`system_provider_configs`，`suggestFromNewHash` 要讀同版本 peer 的 phash，`compareSameHouseWithLlm` 讀 provider 設定）。
建議：把「指紋列＋候選列」的 upsert 抽成 db.js builder（`listingSimilarityBuildContext()`），
模組改成 async＋注入 store（跟 ③ 第 2 段同一套模式），先移植 `recordListingPhash`＋`upsertSuggestion`，
LLM insight（`recordCrawlInsight`）維持 SQLite 並在計畫書標明。

### 切換清單（切換當天照做）

見 `docs/runbooks/postgres-cutover-bootstrap.md`：**步驟 0 的 ③（⛔）沒關掉就不要開始**。
固定流程：凍結寫入 → 快照＋匯入（`importStore`，含 identity sequence re-sync）→ **建索引** →
先切 web-A 驗證（`DB_DRIVER=postgres`＋`PG_URL=…pg-rw:25433`）→ 切正式站 → 觀察
（`/api/health`、`Server-Timing`、`pg_stat_activity`、`pg_stat_replication`）→ 回復（改回 `sqlite`＋回前一版 digest；
SQLite 檔不動故資料不丟，但切換期間寫進 PG 的資料要人工評估）。

## 5. 隔天開工的第一件事

```bash
git log --oneline -5                                     # 確認 master 至少有 daf7bad
cat docs/handoffs/20260921-postgres-cutover-session.md    # 就是本文件
# 照 §3 起手式跑一次 24/24 確認環境沒變，再從 §4 ③ 第 1 段開始。
```

