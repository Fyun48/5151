# Shadow PostgreSQL 實測：通知佇列的讀與寫（2026-09-21）

`watcher.flushPendingNotifications()` 原本用同步 SQLite 的 `pendingNotifyEvents()` 取批次、
用 `updateEventNotify()`／`markEventNotified()` 把每個通道的結果寫回 —— PG 模式下等於「讀空佇列、
寫錯 store」。這一批把這三個呼叫改成 driver-aware。

## 怎麼跑

```powershell
$env:PG_TEST_URL = 'postgres://postgres:<PG_SUPER_PASSWORD>@192.168.0.220:15432/5151_shadow'
node --test v3/test/notify-queue-parity.test.js
```

## 實測結果

```
✔ the notification queue reads and writes through the driver-aware entry point
  ✔ the pending page matches SQLite (rows and order)
  ✔ updateEventNotify writes the same columns as SQLite
  ✔ markEventNotified takes the event out of the queue it wrote to
ℹ tests 5 / pass 5 / fail 0
```

比對內容：

- **待處理頁整列**（`user_events LEFT JOIN listings`），包含 `ORDER BY` 的排序契約 —— fixture 為每個
  分支各放一列：`notify_decide='ready'`（rank 0）、`line_job_state='retry'`（rank 1）、
  有座標的物件（rank 2）、其餘（rank 3，其中兩列用 `notify_next_at` 比出先後），
  另有 `notified=1`／`notify_decide='cancelled'`／`notify_next_at` 在未來三列必須被排除；
  同一列在 PG 與 SQLite 都要落在相同位置。
- **`updateEventNotify` 的 12 個欄位**（`notify_decide`／`_reason`／`_retry_count`／`_last_error`／
  `_next_at`／`_ready_at`／`_coord_version`／四個 `*_job_state`／`notified`）：PG 寫一列、SQLite 寫孿生列，逐欄相等。
- **`markEventNotified`**：PG 寫入後事件從 PG 的待處理頁消失、`notified=1`，而 SQLite 的孿生列仍是 0
  —— 這正是這批要消除的「兩邊不同步」。

## 這一輪抓到的細節

- `pendingNotifyEvents()` 現在回一般物件（`.map((row) => ({ ...row }))`）：`node:sqlite` 給的是
  null-prototype 物件、`node-postgres` 給一般物件，不複製的話 async  twins 的回傳形狀與同步版不同
  （`deepStrictEqual` 會直接失敗）。同 AliveCheck 那批的處理。
- 事件的 `id`（`user_events.id`，佇列排序用）與 `post_id` 是兩回事；fixture 一開始混用，測試直接
  `Cannot read properties of null` 抓到。

## 仍未完成（切換阻塞）

`enqueueListingEvent()` 的**決策鏈**（決定什麼進佇列）仍讀 SQLite：`listUserIds()`／`getSettings()`／
`notifyJobSnapshotFor()`（search profile）／`loadFlags()`／`groupIdForPost()`／`watchedInGroup()`／
`alreadyNotifiedGroup()`／`getMemberMailBundle()`。其中 `users`／`flags` 的 repository 已存在，
`settings`／search profile／listing group 尚未接。因此在 PG 模式下目前是「排得空佇列、填不進新事件」，
**會員仍收不到通知** → `docs/runbooks/postgres-cutover-bootstrap.md` 步驟 0 仍標 ⛔。
