# 爬蟲節奏與通知規則（權威說明）

本文件由 **Owner 2026-09-24 口述規則**，並逐條**核對程式碼**後記錄。若程式與本文件不一致，
以程式為準並回頭修正本文件；改動這些行為時請一併更新這裡。

## 1. 三個節奏

| 節奏 | 誰決定 | 值 | 程式位置 |
|---|---|---|---|
| **全站底庫** | 後台管理員（IA／底庫頁，`/api/admin/system-crawl`） | 生產站目前 **20 分鐘**（`settings.systemCrawlIntervalMinutes`）；未設定時預設 **15**（`crawlPolicy.js` 的 `SYSTEM_CRAWL_INTERVAL_MINUTES`） | `db.js` `systemCrawlFromRows()` / `crawlIntervalMinutes()`；排程器 `server.js` `schedule()` 每 **60 秒**一個 tick |
| **一般會員自己的抓取** | 方案（會員不能改；`intervalAdminSet=false` 時一律用方案預設） | **8 分鐘**（`settingsState.js` `MEMBER_INTERVAL_MINUTES`） | `settingsState.js` `planIntervalMinutes()` / `applyMemberScheduleLocks()` |
| **贊助會員自己的抓取** | 同上 | **5 分鐘**（`SPONSOR_INTERVAL_MINUTES`） | 同上 |

會員鎖定／上限（`applyMemberScheduleLocks()`，會員不能改）：

- `pagesPerWatch = 40`（`MEMBER_PAGES_PER_WATCH`）
- `offlineConfirmDays = 7`（`MEMBER_OFFLINE_CONFIRM_DAYS`）
- `intervalMinutes`：`intervalAdminSet=false` → **方案預設（8／5）**；`true` → 使用者自填但被 `clampIntervalMinutes()` 夾在 1–120。
- 後台管理員的間隔下限 `ADMIN_MIN_INTERVAL_MINUTES = 1`。
- 只影響自己的其他上限：`MEMBER_MAX_PROFILE_DISTRICTS = 10`、`MEMBER_MAX_PROFILES = 3`（管理員 30）。

> ⚠️ **除錯提醒**：`settings.intervalMinutes` 若與方案預設不同（例如資料庫裡留著舊值 3），
> 只要 `intervalAdminSet=false`，實際生效的是**方案預設**。別被舊欄位值誤導。

## 2. 「基地 ＋ 補充」：會員抓取優先吃全站底庫

1. 全站底庫依後台間隔（生產站 **20 分**）抓取；各會員的條件會被**合併成覆蓋任務**（covering jobs）
   —— `covering.js` `mergeCovers()` / `coveringJobsFromMembers()`（開機日誌的「第一次檢查：19 組覆蓋條件」就是這個）。
2. 會員自己的抓取（8 分／5 分）只在「**該會員的條件不在剛跑完的基地裡**」時才出去抓：
   - `settingsState.js` `memberShouldContributeCrawl()`：需 ①通知未暫停 ②有自己的抓取範圍 ③`memberFetchDueAt` 到期 ④**沒有與最近的 covering 撞期**。
   - 撞期判斷 `memberFetchCollision()`：`RECENT_COVERING_MS = 90 秒` —— 也就是**基地剛跑完的 90 秒內，會員不重複抓**（＝優先使用那輪基地）。
3. 會員自己的過濾比對用 `covering.js` `listingInMemberScope()`（縣市／行政區／租金範圍，含 `priceMaxIncludesExtras`）。

## 3. 通知規則

通知矩陣四列（`notifyMatrix.js`）：**全新物件 `new`**、**同屋源重刊 `same_source`**、
**價格變動 `price`**、**標題變更 `title`**。

| 情況 | 觸發條件 | 預設 |
|---|---|---|
| **新物件**（`new`） | 依通知設定（`notifyNew`／`notifyMatrix.new`，含 dock／push／webhook） | `notifyNew = true` |
| 同屋源重刊（`same_source`） | 依設定 | `notifySameSource = true` |
| **價格變動／標題變更** | 依設定，且**只作用在「特別關注」（watched）的物件** | 勾選制 |
| 其他（瀏覽過等） | `notifyViewed` | `false` |
| 特別關注的物件 | `notifyWatchedAlways` —— 加入特別關注後，相關變動一律通知 | `true` |

事件型別 → 通知列的對應：`price_drop`／`price_update`／`fee_update` → `price`；`title_update` → `title`；
`new`／`same_source`／`update`／`offline`／`relist` → 依事件語意歸列（見 `notifyMatrix.js` `rowKeyForEvent()`）。

## 4. 用什麼指標判斷爬蟲健康？

**不要用 `listings.last_seen_at` 當健康指標**：它只代表「曾經寫入底庫」。
程式自己就寫了這段警語（`adminOverview.js`）：

> 「`last_seen` 只代表『曾經寫入底庫』，不是現在健康。沒有 runtime probe 就不要標綠色正常。」

要看健康，請用**管理員後台的 IA／底庫頁**（`admin-ia.js`：全站抓取間隔、確認已下架天數、行政區 coverage、
**底庫與最近一輪結果**）—— 那裡的「最近一輪結果」才是每輪實際抓取量與錯誤的真實來源。

## 5. 相關檔案一覽

| 主題 | 檔案 |
|---|---|
| 節奏常數（系統 15 分預設、每輪頁數） | `v3/src/crawlPolicy.js` |
| 會員／贊助間隔、鎖定、貢獻判斷、撞期窗口 | `v3/src/settingsState.js` |
| 後台全站抓取設定（讀寫） | `v3/src/db.js`（`getSystemCrawl` / `saveSystemCrawl` / `crawlIntervalMinutes`）、`v3/src/server.js`（`/api/admin/system-crawl`） |
| 覆蓋任務（基地）與會員範圍 | `v3/src/covering.js` |
| 排程與 tick 預算 | `v3/src/server.js`（`schedule()`、`tick()`、`TICK_BUDGET_MS`） |
| 通知矩陣 | `v3/src/notifyMatrix.js`、`v3/src/settingsState.js`、`v3/src/db.js`（DEFAULTS） |
