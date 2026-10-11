# 背景逐筆讀取的 `settings` 瘦身（2026-10-12）

正式站 `5151_shadow` 上，`SELECT key, value FROM settings`（全域設定）在 **140 秒窗口被讀 1,113 次**
（≈8 次/秒），而且兩個窗口的速率一致（19:06:57→19:09:17Z 1,113 次、同期 40 秒窗口 313 次）
⇒ 是**常態的背景迴圈**，不是尖峰。上一包 #720（`32c323c6`）把 notify 入列／flush 的逐會員重讀
改掉之後，主因仍在。

這一包先歸因、再依歸因做最小修改；所有數字都由同一支腳本可重跑。

---

## 1. 歸因方法

兩支可重跑的探針（都在這個目錄的上一層 `v3/scripts/`）：

| 檔案 | 用途 |
|---|---|
| `v3/scripts/pg-callsite-trace.mjs` | 插樁 `pg.Pool.prototype.query`（抓**呼叫端**堆疊）＋ `pg.Client.prototype.query`（算次數、耗時），並在 **driver 物件**上再插一層。preload 或 `import` 都能用。 |
| `v3/scripts/settings-hot-read-count.mjs` | 用**真的 `runWatch()`** 在隔離庫跑 N 輪（住商夾具注入房源、`PG_TRACE_BLOCK_NET=1` 不打外站），把每一條全域設定讀取歸因到 `檔案:行號`。 |

為什麼插在三層（L-0709 的延伸）：

* **driver 層**（`dbDriverPostgres` 回傳的那個物件）是唯一能在**同步堆疊**上看到 repo 呼叫端的地方；
* **`pool.query`** 與 repo 呼叫端同步，但經 `pg-pool` 佇列後才呼叫 client，所以要用 SQL 文字 FIFO 配對；
* **`client.query`** 才能算到「一條 SQL 真的送了幾次、耗時多少」。

⚠️ 這次踩到一個新坑（已寫進 brain）：**`pg-pool/index.js:467` 用的是 callback 形式
`client.query(text, values, cb)`**。第一版只綁 promise（`result.then(...)`），於是
**所有走 pool 路徑的查詢一條都沒記到**（driver 層 607 條、client 層只記到 109 條，
driver/client 差 5.5 倍）。修法是把尾端的 callback 包一層再記。沒有這一步，接下來的
before/after 會是「看起來很漂亮但分母是假的」。

---

## 2. 歸因表（隔離 repro `PG_LIVE_REPRO_URL` ＝ 192.168.0.220:15434/repro）

同一支 `settings-hot-read-count.mjs`、同一個夾具、各 3 輪（每輪 17.1～17.7 秒、每輪落地 5 筆房源）：

### BEFORE（`master=32c323c6`）

| 呼叫端（`v3/src`） | 讀取種類 | 3 輪次數 | 每輪 | 每分鐘 |
|---|---|---|---|---|
| `watcher.js:1251`（明細補抓的逐筆迴圈） | settings（`listingDetailAsync.js:60`） | 50 | 16.7 | 57.4 |
| `watcher.js:696`（下架掃描的逐筆迴圈） | settings | 48 | 16.0 | 55.1 |
| `watcher.js:696`（下架掃描） | decoration（`listingDetailAsync.js:63` → `db.js:3371`） | 48 | 16.0 | 55.1 |
| `watcher.js:1251`（明細補抓） | decoration | 48 | 16.0 | 55.1 |
| `watcher.js:1165`（落地的逐筆重讀） | settings | 20 | 6.7 | 23.0 |
| `watcher.js:1165`（落地） | decoration | 20 | 6.7 | 23.0 |
| `watcher.js:1270`（來源套件的逐筆迴圈） | settings | 12 | 4.0 | 13.8 |
| `watcher.js:1270`（來源套件） | decoration | 12 | 4.0 | 13.8 |
| **合計** | | **258** | **86.0** | **296.4** |

> 一律是「**一筆一次、兩條**」：`getListingAsync()` 先為這一筆讀一次全域 settings
> （`listingDetailAsync.js:60`），再為它的裝飾資料讀第二次（`listingDetailAsync.js:63`
> → `db.js:3371`）。這些逐筆迴圈都有 400ms 節奏 ⇒ 正式站的「每秒 8 次」正是這個形狀。

### AFTER（本 PR）

| 呼叫端 | 3 輪次數 |
|---|---|
| （全部逐筆路徑） | **0** |

**258 → 0 次**（每輪 86 → 0），同時逐會員的 `SELECT key, value FROM user_settings WHERE user_id = $1`
維持 **129 → 129**、`SELECT * FROM users` 維持 **129 → 129**、`SELECT * FROM listings WHERE post_id IN ($1)`
維持 **129 → 129** ⇒ 省下來的是**全域**設定重讀，**個人**設定照舊逐筆讀，語意沒被動到。

（未開閘時 `runWatch` 走 SQLite，`getListing()` 同步路徑不受影響；測試見下。）

---

## 3. 修法（最小而結構正確）

1. `crawlScheduleAsync.crawlRuntimeAsync()` 把這一輪已經讀到的原始列 `globalRows` 一併回傳
   （**同一輪的呼叫鏈**，不是跨輪快取）。
2. `watcher.runWatch()` 用那一批列組一次 `roundOptions`：
   `{ ...options, globalRows, requestContext: decorationRequestContextFromRows(roundRows) }`。
   `getSettingsAsync()` 認 `options.globalRows`（`settingsAsync.js:85`）、裝飾資料認
   `options.requestContext`（`db.js:preloadDecorationProviderAsync()`）——兩個 hook 都是 #720 既有的契約。
3. 把 `roundOptions` 傳進逐筆讀取：落地迴圈三處、明細補抓、來源套件、待通知定位
   （`resolvePendingNotifyLocations`）、批次定位（`ingestListingGeoBatch`／`ingestListingGeo`）；
   下架掃描多一個 `listingOptions`。

守住的不變量：

* **沒有**任何跨 tick／跨請求的 TTL 快取或版本號失效；一輪一份，後台改了設定**下一輪**就看到新值。
* **fail-soft 不動**：逐頁／逐筆 try/catch 與 `catch` 第一行的 `if (isCrawlCancelled()) throw error;` 原樣；
  取消旗標仍然是純記憶體（`crawlExecution.js`），**這一包完全沒有動取消語意**（所以「最壞情況多少毫秒停手」不變）。
* `totalMatched` 的來源（完整候選集）沒有動，也沒有加 LIMIT／抽樣／估算。
* 紅線檔（`db.js` 591 區塊／`geo591ScanQuery`、`geo591Cursor.js`、watcher 的 geo 游標那幾行、
  會員列表／統計路徑、`SCHEMA_MIGRATIONS`、`pg-island-inventory.mjs`）一個字都沒動；
  這一包**不需要**新索引，所以沒有 `v3/migrations/007_*.sql`。

---

## 4. 怎麼重跑

```bash
set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
export PG_URL="$PG_LIVE_REPRO_URL" DB_DRIVER=postgres PG_NO_SQLITE_OPEN=1 PG_SQLITE_FALLBACK=strict
export PG_TRACE_BLOCK_NET=1 PG_TRACE_OUT=/tmp/sethot-before.json
node v3/scripts/settings-hot-read-count.mjs --rounds 3 --label before
# 看這一條：jq '.globalSettingsReads' /tmp/sethot-before.json
```

整台 app（`APP_ROLE=all`）的窗口量測（同一支探針，改成 preload 到 server）：

```bash
export PG_TRACE_OUT=/tmp/trace-after-420.json
timeout -s SIGTERM 420 node --import /home/cline/lab/5151-sethot/v3/scripts/pg-callsite-trace.mjs v3/src/server.js
```

`v3/scripts/settings-hot-read-count.mjs` **只准打隔離庫**（它會拒絕非 `postgres://` 的 `PG_URL`，
而且開跑前把 `crawlSources` 換成「只留住商」、跑完還原）。

原始輸出：`repro-3rounds-before.json`（258）／`repro-3rounds-after.json`（0）、`mutation-check.txt`。

### 整台 app 的窗口（blocked-net、420 秒、7 輪，僅供對照）

| | 精確指紋 `^SELECT key, value FROM settings$` 次數 | watcher 逐筆呼叫端 |
|---|---|---|
| BEFORE | 306（43.7/分） | 88（下架掃描 47+41） |
| AFTER | 379（54.1/分）* | **0** |

\* 兩次窗口的**絕對值不能直接比**：`listingEnrichQueue` 的佇列狀態在兩個窗口之間變了
（這一包沒動 enrich 那條路，它每次載入仍讀 2 次），而 `pauseIdleMembersAsync()` 的次數也隨
會員狀態浮動（26 → 72）。可以比的是**同一條路徑的歸因**：watcher 的逐筆呼叫端 88 → 0。

---

## 5. 正式庫該驗的具體預期數字

**窗口：140 秒（與你 03:06–03:09 那次的量法完全相同，`pg_stat_statements` 增量、
正則 `^SELECT key, value FROM settings$`）**

> ### 預期：**Δ次 ≤ 63**

推導（每一項都是上面歸因表或程式碼的常數，不是湊的）：

| 來源 | 每分鐘 | 140 秒 |
|---|---|---|
| `pauseIdleMembersAsync()`（`server.js:4656` → `accountMaintenanceAsync.js:92`，每位會員 1 次／tick） | repro AFTER 實測 10.29/分 | 24.0 |
| `listingEnrichQueue` 逐筆載入（每筆 2 次；時鐘 30 秒 4 筆 ⇒ 上限 8/分） | 8 | 18.7（上限 32） |
| `coveringBookkeepingAsync.js:48/64`（每 tick 1–2 次） | 1.5 | 3.5 |
| `flushPendingNotifications()`（每次呼叫 1 次） | ~1 | 2.3 |
| 合計 | | **≈ 63** |

同時請看另外兩條指紋（它們用**別的字串**，不該被這包影響）：

* `SELECT key,value FROM settings`（無空白，`crawlRuntimeAsync`／`readPlan`）：每輪 3 次 ⇒ 140 秒 ≈ 7 次。
* `SELECT value FROM settings WHERE key = $1`（單鍵讀取，`commuteRushEnabledAsync` 等）：
  repro 實測 16 次／3 輪 ⇒ 140 秒 ≈ 12 次。

**如果驗到的數字遠大於 63**，代表還有未涵蓋的逐筆路徑（最可能是 `listingEnrichQueue`
或 `queueGeoBackfill` 內每圈各呼叫一次的 `flushPendingNotifications`）——把那 140 秒窗口的
呼叫端表給我（同一支 `pg-callsite-trace.mjs` 可以在影子站跑），我再做下一包。

---

## 6. 變異牙齒

`node v3/scripts/mutation-check.mjs v3/test/settings-hot-read-diet.test.js`——7 條變異全部 KILLED
（逐字輸出見 `mutation-check.txt`）：

```
[OK  ] crawlRuntimeAsync 不再回傳當輪的原始設定列（逐筆又開始各自重讀）→ 已失敗 ✓
[OK  ] runWatch 不組當輪快照（逐筆回到各自讀一次全域設定）→ 已失敗 ✓
[OK  ] 落地迴圈的逐筆讀取不帶當輪快照→ 已失敗 ✓
[OK  ] 下架掃描的逐筆讀取不帶當輪快照→ 已失敗 ✓
[OK  ] 下架掃描的呼叫端不傳當輪快照→ 已失敗 ✓
[OK  ] 待通知定位的逐筆讀取不帶當輪快照→ 已失敗 ✓
[OK  ] ingestListingGeo 不接受呼叫端傳下來的當輪快照→ 已失敗 ✓
共 7 條變異：KILLED 7、SURVIVED 0、SKIP 0
```

（把任一條改回「逐筆各自讀」，`v3/test/settings-hot-read-diet.test.js` 就紅。）

---

## 7. 這一包**沒有**處理的

* `listingEnrichQueue`（`listingEnrichQueue.js:616/650/680/702`）：每筆仍讀 2 次全域設定。
  正式站的量受時鐘上限約束（30 秒 4 筆 ⇒ ≤8 次/分），不是主因；要收掉需要把
  `listingEnrichHelpers()` 的 `options` 也帶上當輪快照。
* `queueGeoBackfill()`（`server.js:4505/4547/4560`）每圈各呼叫一次 `flushPendingNotifications()`；
  那一支為了「管理頁改了同一輪就看到」而每次重讀一次，刻意沒有做成跨圈的快照。
* HTTP 請求路徑的每請求 1 次（`getSettingsAsync(uid)`）維持不變。
