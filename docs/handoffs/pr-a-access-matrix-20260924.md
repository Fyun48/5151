# PR-A：入口 × 資料來源存取矩陣（2026-09-24）

> 基準 commit：`9c6b7b04f9801717cb6696e8e095fde4c309473f`（與 ChatGPT 審查基準相同）
> 圖例：**PG** = 已確認走 PostgreSQL；**SQLITE** = 已確認仍走節點本機 SQLite；**?** = 尚未確認（不填 PASS）
> 對應：F# = ChatGPT 指令文件的發現編號；G# = 該文件參考的程式位置。
> 入口全量清單（288 route）見 `pr-a-entrypoint-inventory-20260924.md`（機械抽取）。

## A. 已確認「正式入口確實走 PostgreSQL」

| 入口／情境 | 實作 | 讀 | 寫 | fallback／吞錯 | 交易 | 證據 |
|---|---|---|---|---|---|---|
| `/api/state` 初始載入 | `listingStatsAsync()` ＋ `searchListingsAsync()` | PG | — | 讀取 fail-open（`sqliteFallback`） | — | `POSTGRES_SWITCH_PLAN` §1；`listing-stats-parity` 5/5（shadow） |
| 房源列表搜尋（會員） | `listingSearchAsync.js` → `repository.searchPage` | PG（SQL-first） | — | **有**：查詢不支援 → SQLite；例外 → SQLite（F2／G3） | — | 程式碼確認（`listingSearchAsync`） |
| 爬蟲入庫 | `db.js persistListing()` → `repository/writePath` | — | **PG** | 寫入 fail-closed（`sqliteFallback`） | **未包整段交易**（F7／G9）→ 主列／投影可能部分成功 | 今日實測：`listings` 118,762 持續增加 |
| 變更紀錄 `data_revision` | `writePath.bumpRevision` | — | **PG** | best-effort（#492 加註） | 同 F7 | `data_revision` 734,217（10 分鐘 +3,436） |
| 通知事件佇列 `user_events` | `notifyEnqueueAsync`／`notifyQueueAsync` | PG | **PG** | 寫入 fail-closed、讀取 fail-open | — | 今日 `user_events` 7,331 且持續增加 |
| 會員設定／搜尋設定檔 | `settingsAsync.js` → `repository/memberSettings.js` | PG | **PG** | 寫入 fail-closed | `withTransaction` | `settings-driver-parity` 4/4＋live 1/1 |
| 離線／存活探測狀態寫入 | `crawlerWrites.js` ＋ `repository/listingState.js` | PG | **PG** | 寫入 fail-closed | — | `listing-state-writes` 4/4（live PG） |
| 抓取「完成」紀錄（本日新增） | `coveringBookkeepingAsync.markCoveringCompletedAsync` | PG | **PG** | — | — | PR #493／#495；容器內實測寫入成功 |

## B. 已確認「仍走節點本機 SQLite」（正式路徑）

| # | 入口／情境 | 位置 | 影響 | 對應 |
|---|---|---|---|---|
| B1 | **`/api/public/listings`（訪客搜尋）** | `server.js:543` → `db.js listPublicListingsFast:7100`（G1／G2）。實查邏輯：`if (!publicListingsSqlFirstEnabled) return listPublicListings(args)` → **SQL-first 預設關閉，直接走同步 Node／SQLite 路徑**；投影未就緒時也回退同一條 | 訪客搜尋**完全**讀本機 SQLite；投影／可見性／total 全部來自舊庫 | **F1** |
| B2 | 會員搜尋的 fallback 兩條 | `listingSearchAsync.js:65`（G3） | PG 健康時仍可能因「查詢不支援」回 SQLite；`strict` 只擋 catch | **F2／F3** |
| B3 | 爬蟲計畫／狀態 | `db.js coveringPlan`（G8）、`watcher.js replaceCrawlCovers`（G7）、`listingCount()`／`listingCountForSearch()` | 每輪覆蓋條件只寫 SQLite；PG 仍停匯入時 38 筆 | **F6** |
| B4 | 抓取切片與完成提交 | `crawlPolicy.rotateCoveringJobs`（wall clock，G11）＋ `coveringBookkeepingAsync` 的整表 `UPDATE crawl_covers`／全量 `includedUserIds` | 舊窗重複、可能漏組；把未跑的會員／條件標成完成 | **F9／F10／G12** |
| B5 | **同屋源配對評估** `listing_match_evaluations` | `listingGroups.js:161` `recordMatchEvaluation`（`try` 於 163 全表吞錯；INSERT 於 165）（G5／G14） | 全表吞錯；實測 93 秒 **+13 筆**只長在 SQLite | **F4** |
| B6 | 啟動與 migration | `db.js:496` `new DatabaseSync(...)`（WAL、DDL、projection 回填，G6）＋ `pgSchema` 從 SQLite schema 推導；另有 `dbDriver.js:26`、`diagnoseRakuya.js:8`（唯讀診斷） | **PG 模式仍需 SQLite 檔才能啟動** | **F5** |
| B7 | 逾時控制 | `crawlWatchdog.withBudget`（`Promise.race`，G10）＋ tick gate（程序內記憶體） | 逾時後工作仍繼續執行、仍可能提交 | **F8** |
| B8 | 後台全站抓取設定 | `db.js getSystemCrawl()`／`saveSystemCrawl()`（同步） | 管理員改的間隔只落在一台 | 原報告 §5-6 |
| B9 | site 鍵／統計 | `writeSettingKey`／`settingKey`／`refreshSiteCatalogStats`（`db.js`） | 跨節點不一致（covering 時間戳已改 PG） | 原報告 §5-7 |
| B10 | 樂屋游標／source-kit 重試 | `getRakuyaPageCursors`／`saveRakuyaPageCursors`／`markSourceKitRetry` | 抓取進度跨節點不一致 | 原報告 §5-4 |

## C. 尚未確認（不填 PASS；需逐入口追）

| 範圍 | 為何未確認 | 已知資訊 |
|---|---|---|
| `/api/admin/*`（122 route） | 逐 route 追 facade 成本高 | 至少 `system-crawl`（B8）、`catalog`（B9）仍同步 SQLite |
| `demand`（65 處 `db.prepare`）、`wishOffers`（33） | 未確認入口是否已有 Async 版 | PG 有對應表 |
| `selfListings`（35）／`listingTools`（36） | 同上 | 會員刊登主流程 |
| `memberMedia`（25） | metadata 在 SQLite，檔案已走共享目錄／R2 | 跨節點可見性需實測 |
| `support`（59）／`feedback`（12）／`feedbackOutbox`（13）／`rentalNotify`（59）／`comms`（21） | 未逐入口確認 | — |
| `crm`（37）／`crmAsync`／`crmOutboxAsync` | 有 Async 模組，但入口是否全接通未確認 | 指令文件特別點名 |
| `auth`／`users`／`sessions`／權限 | 未逐入口確認 | 跨節點一致性要求最高 |
| `budgetGuard`（22）／`budgetGuardAsync` | 兩者並存，正式路徑走哪條未確認 | 付費 provider 啟用前必須完成（GATE） |
| `jobQueue`（13）／`queueDispatch` | 與 enrich worker claim 的關係未確認 | 影響多 worker ownership |
| `listingSimilarity`（18）／`userSameHouse`（11） | 同上 | — |

## D. 本輪 PR-A 尚缺（明確列出，不假裝完成）

1. **逐 route 的完整矩陣**：目前只有 domain 級（B／C）＋機械抽取的 288 route 清單；A 表只填「已確認走 PG」的關鍵入口。
2. **資料保存（SQLite 一致快照＋PG 備份資訊）**：尚未執行（腳本與清單待做；須先於任何資料處理）。
3. **違規錯誤碼 `SQLITE_ACCESS_FORBIDDEN_IN_PG` 與錯誤邊界**：尚未實作。
4. **執行追蹤（呼叫路徑清單＋執行攔截）**：尚未實作（目前只有靜態 grep ＋ 全表快照 diff）。
5. web-B（Synology）採證：未執行（`root` 需密碼）→ 依指令文件 §7 產出唯讀採證腳本，或由 Owner 執行。
