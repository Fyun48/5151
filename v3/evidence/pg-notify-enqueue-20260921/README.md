# 通知佇列的「填佇列」：`enqueueListingEvent()` 決策鏈 driver-aware（2026-09-21）

`watcher.flushPendingNotifications()` 的**讀＋寫**在上一包（`v3/evidence/pg-notify-queue-20260921/`）
已經走 driver-aware，但**決定什麼進佇列**的 `enqueueListingEvent()` 還是同步 SQLite 形狀 ——
PG 模式下等於「排得空佇列、填不進新事件」→ **會員收不到通知**（runbook 步驟 0 的 ③ 阻塞項）。
這一包把決策鏈、以及明細回填的 `fee_update` 事件，全部改成兩邊共用同一份推理與同一份 SQL。

## 改了什麼

| 檔案 | 內容 |
|---|---|
| `v3/src/db.js` | 決策抽成純函式：`notifyEventPayload()`／`notifyEventRow()`／`notifyEnqueueDecision()`；設定組裝抽成 `settingsFromRows()`／`systemCrawlFromRows()`（`getSettings()`／`getSystemCrawl()` 改用它，SQLite 行為不變）；新增 `notifyEnqueueQueries()`（16 條 builder）與 `notifyEnqueueBuildContext()`；`enqueueListingEvent()` 改成呼叫上面這些純函式 |
| `v3/src/repository/notifyEnqueue.js`（新） | PG 端：用注入的 builder 讀 members／settings／search profile／flags／group／user_events，裝飾列走 `preloadDecorationProviderAsync()`＋`decorateRowsWithProvider()`，再跑同一支 `notifyEnqueueDecision()`，最後 INSERT（`RETURNING id`） |
| `v3/src/notifyEnqueueAsync.js`（新） | `enqueueListingEventAsync()`：sqlite → 原同步函式；postgres → repository；失敗 fail-open 回 SQLite（`strict` 可關） |
| `v3/src/searchProfiles.js` | 匯出 `ACTIVE_PROFILE_SQL`／`ACTIVE_PROFILE_ORDER_SQL`／`DEACTIVATE_PROFILES_SQL`，PG 端跑同一份文字（含「多筆 active 的修復」讀寫） |
| `v3/src/watcher.js` | 3 個事件點改 await（`onFirstReady`、`queueOfflineEvent`、爬行迴圈的事件點） |
| `v3/src/listingEnrichQueue.js` | enrich worker 的 `onFirstReady` 改為 await（讓非同步 enqueue 的失敗能被上面那層看到） |
| `v3/src/crawlerWrites.js` | `setListingDetailAsync()` 的 PG 分支補上 `fee_update` 事件（`repository/listingFields.js` 的 `setListingDetail()` 早就把 `feeChange` 回傳給呼叫端等這一包接） |
| `v3/test/notify-enqueue-parity.test.js`（新） | 離線層＋live 層（見下） |

## 怎麼跑

```powershell
# 離線（不需要 PostgreSQL）：把 PostgreSQL 那條路徑跑在 SQLite fixture 上
node --test v3/test/notify-enqueue-parity.test.js

# live shadow PG（證據補齊用）
$env:PG_TEST_URL = 'postgres://postgres:<PG_SUPER_PASSWORD>@192.168.0.220:15432/5151_shadow'
node --test v3/test/notify-enqueue-parity.test.js
```

離線層的作法：`exec` 由 SQLite fixture 回答，但它同時要能吃裝飾 loader 產生的 `$n` 與 builder 的 `?`，
以及 insert 需要的 `RETURNING id` —— 也就是把「PostgreSQL 執行器」的介面整個餵給
`enqueueListingEventAsync({ driver: "postgres", exec, strict: true })`。因此 member 迴圈、設定組裝、
裝飾、決策、寫入全部真的跑過，不是只比對 builder 文字。

## 實測結果

```
# 有 PG_TEST_URL（shadow PG，primary 192.168.0.220:15432 / standby 192.168.0.140:15432）
✔ the decision chain answers with the reasons the SQLite path acts on
✔ the PostgreSQL enqueue answers the SQLite rows through its own executor
✔ every event site goes through the driver-aware entry point
✔ live PostgreSQL: the enqueue writes the queue the site reads
ℹ tests 5 / pass 5 / fail 0 / skipped 0

# 沒有 PG_TEST_URL（CI 與離線開發）
ℹ tests 4 / pass 3 / fail 0 / skipped 1

# 同一場把全部 live 檔一起跑（切換前的現況快照）
11 個檔、61 tests / pass 61 / fail 0 / skipped 0（exit=0）
含 pg-live-integration 的「測試 schema 在 standby 可見（串流複寫）」= ok
```

fixture 是四個會員 × 三筆物件，故意讓每個分支都有主：

| 事件 | 結果 |
|---|---|
| `new`（section 8，`watcher` 有特別關注、`inScope` 的搜尋 profile 覆蓋 1-8） | 兩人都進佇列（`watcher` 靠 watch、`inScope` 靠 cover） |
| `price_drop`（同 detail 已存在於 `watcher`） | 跳過（`detail_dedupe`）；`inScope` 不在其覆蓋範圍 → `out_of_scope` |
| `new`（同 post 已有 `new`） | 跳過（`new_dedupe`） |
| `new`（群組已通知過、`new` 是終身一次） | 跳過（`group_dedupe`） |
| `offline`（同群組但非終身一次 → 依 detail 去重） | `watcher` 進佇列（證明群組去重的另一條分支沒被擋） |
| `paused` 會員（在覆蓋範圍內但暫停通知） | 跳過（`channel`） |

比對內容是「這次寫入的每一列」逐欄（`user_id`／`post_id`／`type`／`title`／`detail`／`source_key`／
`created_at`／`notified`／`group_id`／`notify_profile_id`／`notify_profile_version`），
以及 `notify_profile_id`／`version` 確實來自主動的搜尋 profile（fixture 的 version 3）。

## 這一輪抓到的坑

1. **build context 是攤平的**（跟既有的 `notifyBuildContext()` 同風格）→ repository 要用 `deps`
   本身當 builder 集合，不能呼叫 `deps.notifyEnqueueQueries()`。第一次跑測試就直接 TypeError 抓到。
2. **兩種佔位符並存**：裝飾 loader（`repository/decorationData.js`）在 `driver: "postgres"` 時吐 `$n`，
   而 enqueue 的 builder 吐 `?`；真 driver 的 `toPostgresSql()` 只換 `?`、`$n` 原樣通過，所以兩者可以共存。
   任何自己接 exec 的地方（測試、工具）都要同時應付。
3. **測試自己踩的坑**：第一版比對「該 post 的所有列」，把 fixture 先種下的去重列也算進去，
   讓「正確的跳過」看起來像失敗。改成用 `id > seedMaxId` 只比對「這次寫入的列」才對得上。
4. **`notifyJobSnapshotFor()` 是 SQLite 的行程內快照**（`watcher.bindNotifyJobSnapshots()` 爬行開始時從
   SQLite 填），PG 路徑刻意**不**用它、直接讀 active profile 那一列。差異只在「同一輪爬行中會員改了
   搜尋條件」時才看得到，屆時 PG 的答案比凍結快照更新。已寫在 `repository/notifyEnqueue.js` 註解。

## 這一輪只有 live 才照出來的兩個測試修正

第一次跑 live 時 `ids` 全是空的（PG 端「看起來」什麼都沒寫），追下去發現**兩個都是測試自己的問題**，
production 程式是對的：

1. **離線測試把列留在 fixture 裡**：離線層跑完 exec 形狀的那一輪後沒有清理，live 層 `importStore`
   鏡射時把那 3 列一起帶進 PG → 那些列剛好觸發 `new_dedupe`／`detail_dedupe`，live 於是全部跳過。
   修法：離線測試結束時 `clearEvents(db, seedMaxId)`，live 子測試鏡射前也先清一次（不依賴測試順序）。
2. **比對對排序敏感**：`eventRows()` 是照 `POSTS` 逐筆讀，而 PG 那條查詢是 `ORDER BY user_id, id`
   —— 兩邊列完全相同、只是順序不同。修法：比對前兩邊都用 `(post_id, user_id)` 排序，
   並在註解寫明「比內容、不比兩個 store 剛好回傳的順序」。

診斷方式：把測試複製成 debug 副本、在 `exec` 外面包一層印出「SQL 前 70 字＋params＋回傳列數」，
一眼就看到 INSERT 其實回了 1 列、是決策端的讀取把它們 skip 掉的。

## 仍未完成（切換阻塞）

- **④ `enqueueSimilaritySafe`（pHash 佇列）** 仍是 SQLite-only：PG 模式下新爬進來的物件不會進
  `listing_image_phash`／`listing_similarity_suggestion`／`listing_crawl_insight`（功能缺口，不會寫壞資料）。
  這是 ③ 收掉之後**唯一**還在擋切換的項目。
