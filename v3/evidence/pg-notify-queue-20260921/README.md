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

## 追加：這一包已上正式站（2026-09-21 晚間）

Owner 決定先把 ③ 的**第 1 段**（佇列的讀＋寫，`4752b51`／PR #405）部署上正式站，**在 driver 還沒切**
的前提下先讓新的 async 路徑跑真實流量 —— 理由與結果如下（driver 沒切，所以 **會員行為不變**）。

| 步驟 | Run | 結果 |
|---|---|---|
| Build production image | `35605862498` | success |
| Production predeploy check | `35606208183` | success（`PREDEPLOY_CHECK_OK`） |
| Deploy v3 to CasaOS | `35606393475` | success（`DEPLOY_V3_OK`） |

- **Source SHA**：`64828a874177ab10d3ddffab08ade22d9008b28d`（當時的 master HEAD；程式內容等同
  `4752b51`，`64828a8` 只多了 #406 這份文件）。
- **Image digest**：`sha256:0f758bd6eab542429f68f16bd920107fe92abae781945e5b2a705b7ebef8af3e`
  （build 端自我驗證：`revision_label=64828a8…`、`source_label=https://github.com/Fyun48/5151`、
  `SHARP_OK`、`architecture_tested=linux/amd64`）。
- **部署前正式站**：`ghcr.io/fyun48/5151@sha256:937719ef…`（＝`939ecb0`，也就是 ①＋② 那版）、
  `container_state=running`、`node v22.23.2`、`sharp=SHARP_OK`、`integrity_check=ok`。
- **回復點（predeploy 備份）**：`/mnt/Storage1/docker_data/591-tracker-v3-backups/predeploy-20260921-133223`
  （`sha256:6cf1f045488cc760e97d2fcd1a51d7459a6cf171ef1c892047e077c64b2da707`，
  `db_original_size=442249216` / `db_backup_size=442261504`）。回前一版＝改回
  `sha256:937719ef…`（SQLite 檔不受影響）。
- **部署後驗證**：`container_image=…@sha256:0f758bd6…`（digest-pinned 候選）、只有 `591-tracker-v3`
  被 `Recreated/Started`、NAS 端也 `SHARP_OK`、NAS 健康證據（`container_running`／`health`／`landing`／
  `login`）四項皆 true；公開站 `GET /api/health` → `{"ok":true,"version":"3.57"}`、`/` → 200、
  OPS Console → 200。啟動瞬間有兩次 `curl: (56) Recv failure: Connection reset by peer`（開機窗），
  之後健康檢查即通過。
- **`DB_DRIVER` 仍 `unset`（＝sqlite）**：正式站的 compose 由頭到尾都沒有這個變數（`DB_DRIVER` 只出現在
  shadow 的 `deploy/shadow-ha/web/*/docker-compose.yml`，預設 `sqlite`），這次部署只換 image digest，
  沒有動 env → **會員端行為不變**。
- **為什麼 driver 沒切也要部署**：① 讓 `watcher.js` 那 13 處 `await` 化在新 async façade 上跑真實流量
  ——「漏 await」會變成 unhandled rejection，寧可在 sqlite 模式（可即時回前一版 digest）先撞到；
  ② 正式站 revision 對齊 master，之後切 driver 時 diff 只剩真正的新程式。
- **仍然阻塞切換**：③ 的第 2 段（`enqueueListingEvent()` 決策鏈）與 ④（見上）→
  `docs/runbooks/postgres-cutover-bootstrap.md` 步驟 0 **仍為 ⛔**。
