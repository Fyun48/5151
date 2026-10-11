# 背景輔助查詢瘦身（第二包）證據 — 2026-10-12

正式站 180 秒窗口（23:50–23:55）的四條高頻指紋裡，扣掉第一包（PR #719，會員請求路徑）
處理掉的 `user_listing_flags`，剩下三條都在**背景迴圈**：

| 指紋 | 窗口內次數 | 每次 | 窗口內耗時 | 來源 |
|---|---|---|---|---|
| `SELECT * FROM listing_enrich_jobs WHERE post_id = $1` | 480 | 6ms | +2,785ms | 補欄位佇列 seed（`enqueueViaExec`） |
| `SELECT detail FROM user_events WHERE user_id = $1 AND post_id = $2 AND type = $3 …` | 507 | 5ms | +2,379ms | 通知入列的去重讀取 |
| `SELECT key, value FROM settings` | 1,846 | 1ms | +2,170ms | 補欄位／通知入列／flush 的逐筆全域設定讀取 |

合計約 **+7,334ms／42,453ms ≈ 17%**。

這一包：
1. 先用插樁把三條指紋的**每輪呼叫次數與真實呼叫端**量出來（`v3/scripts/bg-aux-sql-count.mjs`）；
2. 補欄位 seed 與通知去重改集合式（`= ANY($1::bigint[])`），逐筆 fail-soft 與去重語意逐字不變；
3. 背景迴圈「同一輪 settings 讀一次、往下傳」（不跨 tick、不做 TTL）；
4. 新增 `v3/migrations/006_background_aux_indexes.sql`（**由 planner 手動套正式庫**）。

## 一、怎麼重跑

```bash
set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a   # 隔離庫 repro，不是正式庫
export PG_URL="$PG_LIVE_REPRO_URL" PG_TEST_URL="$PG_LIVE_REPRO_URL" DB_DRIVER=postgres

# 每輪呼叫次數（patch pg.Client.prototype.query，記錄 SQL＋參數＋呼叫端行號）
node v3/scripts/bg-aux-sql-count.mjs --phase notify-event --label after --out /tmp/notify.json
node v3/scripts/bg-aux-sql-count.mjs --phase enrich-seed  --label after --out /tmp/seed.json
node v3/scripts/bg-aux-sql-count.mjs --phase flush --unpend 60 --label after --out /tmp/flush.json

# EXPLAIN（索引那一半用交易區塊量完就回滾，不留在庫裡；會印「回滾後殘留的探針索引：0」）
node v3/evidence/background-aux-diet-20261012/explain.mjs --out v3/evidence/background-aux-diet-20261012/explain.json
```

`--unpend 60` 只在隔離庫用：flush 跑過一次就把事件推進重試退避，第二次沒有東西可跑。
`sql-count-*.json` 內的 `queries` 是**物件**（鍵＝SQL 文字），`totals` 是加總與三條指紋的次數。

## 二、每輪呼叫次數（repro＝正式庫凍結快照，同一支腳本、同一份資料）

| 量測 | 指紋 | 改動前 | 改動後 |
|---|---|---|---|
| 一次通知入列（22 位有效會員 × 1 個事件） | `listing_enrich_jobs WHERE post_id = $1` | 0 | 0 |
| | `user_events … user_id = $1 AND post_id = $2 AND type = $3` | **22** | **0** |
| | `user_events … user_id = ANY($1::bigint[]) AND post_id = …` | 0 | **1** |
| | `SELECT key, value FROM settings` | **23** | **1** |
| | 該輪總查詢數／耗時 | 343／1,635ms | 279／1,445ms |
| 一次補欄位 seed（40 筆候選） | `listing_enrich_jobs WHERE post_id = $1` | **80** | **0** |
| | `listing_enrich_jobs WHERE post_id = ANY($1::bigint[])` | 0 | **1** |
| | 該輪總查詢數／耗時 | 132／3,524ms | 53／2,944ms |
| 一次通知 flush（60 筆事件） | `SELECT key, value FROM settings` | **181**（3.02／事件） | **1**（0.017／事件） |
| | 該輪總查詢數／耗時 | 1,074／9,659ms | 894／9,340ms |

`ms` 只供參考：這台是 4 核 Celeron，量測時 `loadavg` 1～3，數字抖動大；**次數是結構性的**。

### 真實呼叫端（插樁抓堆疊，不是憑 grep 猜）

改動前（`sql-count-before-*.json` 的 `fingerprints[*].callsites`）：

- `listing_enrich_jobs WHERE post_id = $1` 80 次全部來自
  `v3/src/listingEnrichQueueAsync.js:246`（`enqueueViaExec` 先讀既有列）與
  `:249`（寫完回讀）——**不是**上一包以為的 `:424`（`requestClickRefreshAsync`，那條只有
  HTTP 的 `/go/:id` 與 `/api/listings/:id/click` 會走，背景輪次量到 0 次）。
- `user_events … user_id = $1 …` 22 次來自 `v3/src/repository/notifyEnqueue.js:70`；
- `SELECT key, value FROM settings` 23 次＝ `db.js:3371`（`preloadDecorationProviderAsync`
  在沒有 `requestContext` 時自己讀一次）22 次 ＋ `globalSettings()` 1 次；
  flush 一輪的 181 次＝ `settingsAsync.js:82`（每位會員重讀全域設定）60 次 ＋
  `listingDetailAsync.js:63`→`db.js:3371` 60 次 ＋ `memberMailAsync.js:94` 60 次 ＋ 迴圈起點 1 次。

## 三、EXPLAIN（`docs/runbooks` 的 L-0700：一律 `SET jit = off`）

| 查詢 | 現況（無索引） | migration 006 的索引 |
|---|---|---|
| 補欄位集合式 `… WHERE post_id = ANY($1::bigint[])` | Seq Scan，Rows Removed by Filter 11,116，Buffers hit=656，**4.817ms** | Bitmap Index Scan，**0.261ms** |
| 去重集合式 `… user_id = ANY($1::bigint[]) AND post_id = …` | Seq Scan，Rows Removed 9,491，Buffers hit=408，**3.500ms** | Index Scan，**0.166ms** |
| 去重逐會員版（改動前那一條，× 22 位） | Bitmap Heap Scan（`idx_user_events_user`）／位 **3.172ms** ⇒ 69.8ms／事件 | — |

`PostgreSQL` 的 `listing_enrich_jobs` **沒有** post_id 索引（SQLite 的
`post_id INTEGER NOT NULL UNIQUE` 沒有鏡射過來），所以改動前 seed 一輪是 80 次 seq scan。
原始輸出在 `explain.json`（含回滾後探針索引殘留數＝0）。

## 四、語意怎麼守住

- **逐筆 fail-soft（補欄位 seed）**：`seedHousepriceEnrichJobsDetailedAsync()` 每一筆各自
  `try/catch`，失敗只損失那一筆並收進 `errors[]`，已成功的照樣落地；對外入口
  `seedHousepriceEnrichJobsAsync()` 仍回「筆數」，呼叫端契約不變。
  護欄：`v3/test/background-aux-diet.test.js`「補欄位 seed：一筆壞掉只損失那一筆…」。
- **去重語意（通知入列）**：判斷函式 `notifyEnqueueDecision()` 與 `notifyGroupAlreadySent()`
  一行都沒改，只把「逐會員讀 1~3 條」換成「同一批列查表」。`ORDER BY user_id, id DESC` ⇒
  每位會員的第一列就是原本 `ORDER BY id DESC LIMIT 1` 會拿到的那一列；
  `newEventExists` 變成「user_id 在集合裡」；群組去重 once-ever 看「有沒有列」、
  否則逐列比對正規化 detail。順序／race 論證與護欄寫在
  `v3/src/repository/notifyEnqueue.js` 的註解，主要護欄是既有的
  `v3/test/notify-enqueue-parity.test.js`（PostgreSQL 路徑與 SQLite 逐列比對，
  含 detail 去重、new 去重、群組 once-ever 與 detail 兩個分支）。
- **同一輪 settings 讀一次**：`flushPendingNotifications()` 一輪讀一次
  `readGlobalSettingsRowsAsync()`，把 `globalRows`＋`decorationRequestContextFromRows()` 往下傳
  （`getSettingsAsync`／`getListingAsync` 的裝飾／`getMemberMailBundleAsync`／通知入列的裝飾）。
  **沒有 TTL、沒有跨 tick 快取**：管理頁改了，下一次 flush／下一個事件就生效。
  護欄：`v3/test/background-aux-diet.test.js`「一輪只讀一次 settings」＋
  `v3/test/notify-flush-settings.test.js`（暫停旗標仍以 PG 為準）。

## 五、套完 migration 後在窗口要驗什麼

套用（planner 手動，**不要**接進 `SCHEMA_MIGRATIONS`）：

```bash
psql "$PG_URL" -v ON_ERROR_STOP=1 -f v3/migrations/006_background_aux_indexes.sql
```

然後在同樣的 180 秒窗口（一樣壓 8 個會員情境）比對 `pg_stat_statements`：

1. `SELECT * FROM listing_enrich_jobs WHERE post_id = $1` → **0 次**（整條消失），
   改成 `… WHERE post_id = ANY($1::bigint[])` 出現，並且 **≤ 10 次**（每輪 seed 1 次）。
2. `SELECT detail FROM user_events WHERE user_id = $1 AND post_id = $2 AND type = $3 …` → **0 次**，
   改成 `SELECT user_id, detail FROM user_events WHERE user_id = ANY($1::bigint[]) AND post_id = $2 AND type = $3`，
   次數約等於「窗口內的事件數」≈ **20～25 次**（原本 507）。
3. `SELECT key, value FROM settings` → 從 **1,846 次降到 ≤ 50 次**
   （通知入列的每個事件 1 次 ＋ flush 每輪 1 次）。
4. 窗口總耗時預期少 6～7 秒（17% → 1% 以內）；`user_events`／`listing_enrich_jobs` 的新索引
   讓單次查詢從 3～5ms 掉到 0.2～0.3ms（`explain.json`）。

## 六、檔案

- 量測腳本：`v3/scripts/bg-aux-sql-count.mjs`
- EXPLAIN 腳本：`v3/evidence/background-aux-diet-20261012/explain.mjs`（`explain.json`）
- 原始 JSON：`sql-count-{before,after}-{notify-event,enrich-seed,flush}.json`
- 新測試：`v3/test/background-aux-diet.test.js`
- 遷移：`v3/migrations/006_background_aux_indexes.sql`（手動套用）
