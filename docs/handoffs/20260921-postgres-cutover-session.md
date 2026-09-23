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

- **正式站已切到 PostgreSQL（2026-09-22）**：部署 `a5f6ba0`（digest
  `sha256:9a50251fb06cb1318f427a70356304bced4a075b8cbd42213ad604325a6d083c`、deploy run `35692135894`）
  ＋容器 env `DB_DRIVER=postgres`、`PG_URL=…@192.168.0.140:25433/5151_shadow`。
  流程與數據：凍結（05:49:57Z）→ 匯入 **2,017,228 列／285s** → 7 條 hot-path 索引 → 切站 → 驗證
  （`listings=115,618`；`v3.db` 停在凍結時刻未被寫入）；步驟見
  `docs/runbooks/postgres-cutover-day-checklist.md`。
  **回復**＝NAS `/mnt/Storage1/apps/5151/.env` 把 `DB_DRIVER` 改回 `sqlite` ＋重建容器
  （回復點：image `sha256:0f758bd6…`／備份 `predeploy-20260922-054731`）。
- 移植進度：**①七條 `listingsNeeding*` 掃描 ✅、②迴圈欄位寫入 ✅、③通知佇列的讀＋寫 ✅**
  （三者都有 shadow PG live parity）。
- **③ ✅（通知，含 shadow live 5/5；全 live 套件 61/61）。③ 的 CRM outbox 與 ④ `enqueueSimilaritySafe`
  都判定為「單容器可接受的 SQLite 孤島」（同一個 store 進出；④ 還是 opt-in 且正式站未啟用）
  → 單容器切換已無功能阻塞項**；兩者都要在 HA（或啟用該功能）前移植，掛點在 runbook 步驟 7。
- 正式站（CasaOS `591-tracker-v3`）跑 `64828a8` 的映像，`DB_DRIVER=unset`（＝sqlite），行為不變。

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
13. **同日稍晚的追加部署（Owner 決定）**：先把 #405 推上正式站，理由是「先在 sqlite 模式讓 await 化
    跑過真實流量，並讓正式站 revision 對齊 master」。三條 manual workflow 全 success：
    build `35605862498` → predeploy `35606208183` → deploy `35606393475`，
    source `64828a8`（程式等同 `4752b51`，`64828a8` 只多了 #406 的文件）。
    predeploy 前的正式站是 `sha256:937719ef…`（`939ecb0`）、備份
    `predeploy-20260921-133223`（`sha256:6cf1f045…`）＝ 回復點；部署後 `container_image` 確認為
    digest-pinned 候選（`0f758bd6…`）、只有 `591-tracker-v3` 被重建、NAS 端 `SHARP_OK`、
    健康（container/health/landing/login）四項 true。`DB_DRIVER` 全程 `unset`（compose 沒有這個變數）。
14. **收尾**：關掉過期的 PR #404（它新增的交接文件已隨 #405 的 squash 落地，master 上的版本還比它新
    20 行；硬 merge 會是 both-added 衝突）。

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

> **狀態（2026-09-22 補記）**：**通知的兩段都已完成，並補上 shadow live 實證**。
> - 第 1 段：PR #405（`4752b51`）—— `notifyBuildContext()` ＋ `repository/notifyQueue.js` ＋
>   `v3/src/notifyQueueAsync.js`，`watcher.js` 13 處改 await，live parity **5/5**
>   （證據 `v3/evidence/pg-notify-queue-20260921/README.md`）。
> - 第 2 段：`enqueueListingEvent()` 決策鏈 —— PR #409（`80559f4`）—— `notifyEnqueueBuildContext()`
>   （純函式 ＋ 16 條 builder）＋ `v3/src/repository/notifyEnqueue.js` ＋ `v3/src/notifyEnqueueAsync.js`；
>   `watcher.js` 3 個事件點、enrich worker 的 `onFirstReady`、`crawlerWrites.setListingDetailAsync()` 的
>   `fee_update` 全部改走它。離線 parity 3/3，**09-22 補上 shadow live 5/5（0 skip）**；同一場把全部
>   live 檔一起跑 **61/61**（含 standby 可見性）。過程中修掉兩個**測試**問題（離線層的殘留列汙染 live
>   鏡射、比對對排序敏感），production 程式沒有改動。
>   證據 `v3/evidence/pg-notify-enqueue-20260921/`。
> **CRM outbox 的判定（2026-09-22）**：`crm_outbox` 只被 `crmOutbox.js` 碰；生產者 `crm.js`（8 個同步
> 呼叫點）與消費者 `crmDelivery.js` 共用同一個 handle（`db.js` 的 `opsDeliveryDb()` 就是 `return db;`）
> → 單容器切換可接受（同一個 store 進出，不是「寫 A 讀 B」）。只換一半會更糟（迴圈永遠撈不到），要就
> 整條連 `crm.js`（同步 CRUD）與 3 條 admin 路由一起 async 化＝獨立一包。
> **正式掛點：`docs/runbooks/postgres-cutover-bootstrap.md` 步驟 7「HA 前必須移植的孤島」**
> （同類：`jobQueue`／`jobWorker`／`geoQueue`／`listingEnrichQueue`）。
> **因此 ③ 對單容器切換已關閉；隔天第一件事＝④。**

1. ~~**佇列的讀＋寫**~~ ✅ 完成（見上）。
2. ~~**`enqueueListingEvent()` 的決策鏈**~~ ✅ 程式面完成（見上），**live parity 待補**：
   - 原本估要先補的三個讀取，最後是這樣收的：`settings`／search profile／listing group 都用
     `notifyEnqueueQueries()` 與 SQLite **同一份語句文字**發布，`settingsFromRows()` 讓兩個 driver
     共用同一套組裝（含 `withSystemCrawl` 與 role/plan 分支）；`users`／`flags` 沒有繞去
     `repository/users.js`／`flags.js`，因為那兩支是刻意挑過的欄位子集，而 `loadFlags()` 讀 `SELECT *`。
   - 決策本體的形狀：`notifyEnqueueDecision()` 吃「已解析好的輸入」（含三個去重讀取的結果）——
     去重讀取一律是唯讀 SELECT，先解析不會改變結果，所以兩個 driver 可以共用同一支判斷。

### ④ `enqueueSimilaritySafe`（pHash／相似度建議／爬蟲洞察）

**判定（2026-09-22，Owner 確認）**：**已知功能缺口，不阻塞單容器切換**。`persistListing()` 的 PG 分支刻意
不呼叫它（`db.js` 有註解）→ PG 模式下新物件不會進 `listing_image_phash`／`listing_similarity_suggestion`／
`listing_crawl_insight`（**不會寫壞資料**）；而這個功能是 **opt-in、預設關閉**（`phash_enabled` 預設 `false`，
洞察另外要啟用 LLM provider），正式站沒有在用。**要啟用該功能或走到 HA 之前必須移植。**

> **狀態（2026-09-23 補記）：④ 兩段都開工了，第一段已合併。**
> - **第 1 段（審核 UI／設定／清單）**：PR #442 —— `v3/src/repository/listingSimilarity.js`（共用 SQL
>   文字 builder）＋ `v3/src/listingSimilarityAsync.js`（driver 分派 ＋ `withFallback` ＋ fail-open ＋
>   `options.strict`）＋ `db.js` 三個 admin wrapper 改 async ＋ `server.js` 三條 admin 路由改 await ＋
>   `v3/test/listing-similarity-admin-parity.test.js`。離線 parity **4/4（1 skip）**、shadow live **5/5**、
>   既有 `listing-similarity.test.js` **11/11**；正式站行為不變（`phash_enabled` 預設 false）。
> - **第 2 段（佇列寫入）**：`recordListingPhash`／`suggestFromNewHash`／`recordCrawlInsight`／
>   `enqueueListingSimilarity` 的 driver-aware 版本，程式在分支 **`feat/pg-similarity-queue`**，
>   **測試待補、尚未開 PR**。資料本體（`listing_image_phash`／`listing_similarity_suggestion`／
>   `listing_crawl_insight`）改寫進「與 UI 同一個 store」（PG 模式＝PostgreSQL）——這正是
>   「後台讀得到、佇列填不進去」的修法；`db.js` 的 `persistListing()` PG 分支改呼叫
>   `enqueueSimilaritySafeAsync()`（best-effort、不擋入庫）。
>   **刻意的階段切法**：`loadEnabledProvider()`／`compareSameHouseWithLlm()`／`extractCrawlInsight()`
>   仍走 SQLite handle，因為 provider／budget 堆疊（`budgetGuard.js`／`providers/*`）本身還是 SQLite 島
>   → 要一起移植才能讓洞察「產生」也全 PG 化。
>   ⚠️ 該分支含第 1 段那顆 commit；合併 #442 之後要 **`git cherry-pick`** 到新 master 再開 PR，
>   不然會把第 1 段的內容再算一次。
> - **接手起手式**：`node --test v3/test/listing-similarity-admin-parity.test.js` —— 第 2 段的 **3 條 draft
>   測試已寫好但還沒跑過**（`suggestFromNewHashAsync` 直接餵 `recorded={post_id,phash,algo_version}`，
>   不必真的算圖；`recordCrawlInsightAsync` 用 `options.llmInsight` 注入 provider）。紅了先確認
>   `extractCrawlInsight` 的注入鍵名，再跑 live：
>   `PG_TEST_URL=postgres://postgres:<PG_SUPER_PASSWORD>@192.168.0.220:15432/5151_shadow`（目標 0 skip）。
>   這條測試會建立 3 張表並動 `settings`（用影子站／離線 shim 就好，別打正式站）。


**移植範圍與難點（給下一包用）**：`v3/src/listingSimilarity.js` **409 行、18 條同步語句**，而且「佇列寫入」與
「審核 UI」是同一條鏈：`recordListingPhash`／`suggestFromNewHash`／`recordCrawlInsight` 寫入，
`listSimilaritySuggestions`／`reviewSimilarity`／`getSimilarityAdmin`／`listRecentInsights` 讀取
（都是**同步**函式、被 admin 路由直接呼叫），另有 `phash_enabled`／`llm_insight_apply_enabled` 兩個 settings
與 `system_provider_configs`／`listings` 的讀取。只換一半＝寫 PG、UI 讀 SQLite → 建議做法是
「模組改成 async ＋ 注入 store」（③ 第 2 段同一套模式），並把 admin 路由一起 async 化；
`compareSameHouseWithLlm`／`extractCrawlInsight` 只是 fetch，driver 無關。
掛點：`docs/runbooks/postgres-cutover-bootstrap.md` 步驟 7。

### 切換清單（切換當天照做）

見 `docs/runbooks/postgres-cutover-bootstrap.md`：**步驟 0 的 ③（⛔）沒關掉就不要開始**。
固定流程：凍結寫入 → 快照＋匯入（`importStore`，含 identity sequence re-sync）→ **建索引** →
先切 web-A 驗證（`DB_DRIVER=postgres`＋`PG_URL=…pg-rw:25433`）→ 切正式站 → 觀察
（`/api/health`、`Server-Timing`、`pg_stat_activity`、`pg_stat_replication`）→ 回復（改回 `sqlite`＋回前一版 digest；
SQLite 檔不動故資料不丟，但切換期間寫進 PG 的資料要人工評估）。

## 5. 隔天開工的第一件事

```bash
git log --oneline -5                                     # 確認 master 至少有 ff442be
cat docs/handoffs/20260921-postgres-cutover-session.md    # 就是本文件
# 照 §3 起手式跑一次全部 live（11 檔 61/61）確認環境沒變。
# 然後：步驟 0 已無功能阻塞項 → 可以跟 Owner 排切換（凍結視窗、步驟 1-4）；
# 若要先補 ④（相似度／洞察）或 CRM outbox／job queue，見 §4 與 runbook 步驟 7。
```

