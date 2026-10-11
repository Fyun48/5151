# settings 熱讀第二包：歸因、收束與「還值不值得上線」

- 起點：`master=14438e43f6`（第十二輪，PR #723 已合併）
- 分支：`settings-hot-read-diet-2`
- 指紋：`SELECT key, value FROM settings`（＝`repository/memberSettings.js:GLOBAL_SETTINGS_SQL`，**有空格**）
- 觀測只對隔離庫 `repro`（`5151-live-repro.env` 的 `PG_LIVE_REPRO_URL`）；正式站全程唯讀。

## 0. 一句結論

**這包不值得為了 CPU 單獨上線。** 殘留 2.8 次/秒在正式機是 ≈3.2ms/秒 ≈ **0.32% 單核**；
本包收掉的部分（≥60%）只省 ≈0.19% 單核，全部收光上限也只有 0.32%。
但歸因本身有意義：剩下的 60% 不是我原先猜的逐筆迴圈，而是**通知入列每一筆事件各讀一次**
（`repository/notifyEnqueue.js:34`），它在同一輪裡把同一份全域列讀了 N 次。
建議：與下一個動到同檔案的改動一起上（或直接關掉這個 PR），不要為它單獨發一次版。

## 1. 歸因（≠ grep 猜；插樁打在 driver／`pg.Pool.prototype.query`／`pg.Client.prototype.query` 三層）

工具：`v3/scripts/pg-callsite-trace.mjs`（沿用 L-0709／L-0719：`pg-pool` 是 callback 形式，
只綁 promise 會整條漏掉）＋本包新增的 `v3/scripts/settings-hot-read-attribution.mjs`
（每個場景一個行程，避免場景互相污染計數）。

原始 JSON 就在本目錄，`summary.json` 是**只用檔自己的鍵**（`byFingerprint`／`windowMs`／`totalQueries`）
重算出來的差表；重跑：

```bash
set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
export PG_URL="$PG_LIVE_REPRO_URL" PG_TEST_URL="$PG_LIVE_REPRO_URL" DB_DRIVER=postgres
export PG_NO_SQLITE_OPEN=1 PG_SQLITE_FALLBACK=strict PG_TRACE_BLOCK_NET=1
PG_TRACE_OUT=/tmp/attr.json node v3/scripts/settings-hot-read-attribution.mjs --scenario enqueue --items 20 --snapshot 1
```

| 呼叫端堆疊（tracer 的 `driverSettingsSites` 鍵） | 一次呼叫發幾條 | repro 實測 | 對正式機殘留的貢獻 |
| --- | --- | --- | --- |
| `settingsAsync.js:85 ← repository/notifyEnqueue.js:34`（每一筆事件） | 1 | 20 次 `enqueueListingEventAsync` ⇒ **20** 條 | **≥328/196s＝≥60%**（見 §3 推導） |
| `settingsAsync.js:85 ← settingsAsync.js:195/196`（`collectCommuteSettingsAsync` 逐會員） | N 位會員 ＋1 | 23 位 ⇒ **23** 條 | 未定（條件式，見 §3） |
| `settingsAsync.js:85 ← accountMaintenanceAsync.js:92`（`pauseIdleMembersAsync` 逐位候選會員） | 2×I（讀一次、`saveSettingsAsync` 再讀一次） | 18 位 ⇒ **18** 條 | ≈每 60 秒一次 × I |
| `watcher.js:582/585`（flush **第二圈**逐位要通知的會員） | 2×M（會員設定＋信件範本） | 60 筆事件、1 位會員 ⇒ 實測 1（`silent` 模式跳過第二圈） | 有通知要送時才走 |
| `watcher.js:474`（`readGlobalSettingsRowsAsync`，flush 開頭） | **1 每批** | 1 | 已經是下限，不動 |
| `db.js:3371`（`preloadDecorationProviderAsync` 沒帶 `requestContext` 時） | 1／次 | 0（#723 已讓輪內都帶 `requestContext`） | 逐請求單讀，**不准跨請求快取 ⇒ 不收** |
| `server.js:4460/4746/4768/4844/4886/4894/5290`（`/api/settings`、`/api/commute/*`、`/api/listings/:id` 等） | 1／請求 | 0 | 逐請求單讀，**不收**（夜間流量低；非 admin 輪詢就是會員請求） |

### 被排除的候選（用證據排除，不是憑印象）

- **#3 逐筆 similarity（`listingSimilarityAsync.js:175 ← repository/listingSimilarity.js:80`）**：
  它的 SQL 是 `SELECT value FROM settings WHERE key = $1`（`attr-similarity.json`：15 筆×2 ＝ 30 條），
  **與被監控的指紋不同一串文字** ⇒ 不可能出現在 `^SELECT key, value FROM settings$` 的計數裡。
  同一份 trace 裡目標指紋是 **0**。
- **#5 `db.js` 的同步發射器（2874／5972／7140）**：那些是 `db.prepare(...)`，走的是**本機 SQLite**，
  不會進 `pg_stat_statements`。`db.js:3371` 才是 PG 分支，而它已被 `requestContext` 擋住（輪內 0 條）。
- **整個爬蟲輪次**：在 `master` 上跑 2 輪真的 `runWatch()`（`round-watch-harness-master-14438e4.json`，
  137.6 秒、1,218 條查詢）→ 目標指紋 **0** 條。也就是說 **#723 已經把輪內的來源收乾淨了**，
  殘留一定來自輪外。輪內唯一 settings 讀取是 `crawlScheduleAsync.js:15/55` 的
  `SELECT key,value FROM settings`（**逗號後沒有空格**，另一條指紋），一輪 3 條。
  同一支夾具在本包改動後再跑（`round-watch-harness-diet2.json`，101 秒、1,218 條查詢、
  `fetched=5`、`error=""`）→ 目標指紋一樣 **0**，形狀與張數完全相同（沒有回歸）。

## 2. 這包改了什麼（全部是「同一輪／同一批內重複讀同一份全域列」）

| 檔案 | 改動 | 一次呼叫的目標讀取 |
| --- | --- | --- |
| `v3/src/repository/notifyEnqueue.js` | 吃 `globalRows`／`requestContext`（呼叫端已讀過就沿用） | 事件數 → **1 批 0 條** |
| `v3/src/notifyEnqueueAsync.js` | 把 `options.globalRows`／`requestContext` 轉給 repo | — |
| `v3/src/watcher.js:1240` | 逐筆入列傳 `roundOptions`（當輪快照） | — |
| `v3/src/settingsAsync.js`（`collectCommuteSettingsAsync`） | 整份清單先讀一次全域列，往下傳 | N＋1 → **1** |
| `v3/src/accountMaintenanceAsync.js`（`pauseIdleMembersAsync`） | 同上（讀與 `saveSettingsAsync` 的內部讀都吃同一批） | 2N → **1** |
| `v3/src/watcher.js:582/585` | flush 第二圈改用 `roundOptions`（第一圈本來就用） | 2M → **0（吃開頭那一批）** |

**沒有**引入 TTL／版本號／跨 tick 或跨請求快取；沒有動 `isCrawlCancelled()`／取消旗標；
沒有動 `totalMatched` 的候選集語意；紅線檔（`db.js` 591 區塊、`geo591ScanQuery`、`geo591Cursor.js`、
watcher geo 游標、`listingSearch*`／`listingStats*`、`SCHEMA_MIGRATIONS`、`pg-island-inventory.mjs`、
`migrations/**`）**一個字都沒動**（`git diff --stat` 可驗：只有 6 個 src／test／script 檔）。

### 離線牙齒（`v3/test/settings-hot-read-diet-2.test.js`，5 條）

```bash
node --test v3/test/settings-hot-read-diet-2.test.js
node v3/scripts/mutation-check.mjs v3/test/settings-hot-read-diet-2.test.js
# → 共 6 條變異：KILLED 6、SURVIVED 0、SKIP 0
```

改動會連帶讓兩條既有的原始碼層斷言失效，已一起更新：
`notify-flush-settings.test.js`（`getSettingsAsync(userId, options)` → `roundOptions`）、
`notify-enqueue-parity.test.js`（`enqueueListingEventAsync(saved, evt)` → 帶 `roundOptions`）。

## 3. 正式機的預期數字（140 秒窗口）

用同一條指紋、「累計計數器做差」的口徑推導：

```
Δ140s(SELECT key, value FROM settings) ≈
    Δ140s(通知入列)            × 1        ← 本包收成 0
  + Δ140s(collectCommute 呼叫) × N_會員   ← 本包收成 ×1
  + Δ140s(pauseIdle 執行)      × 2×I_閒置 ← 本包收成 ×1
  + Δ140s(flush 要通知的會員)  × 2        ← 本包收成 0
  + 逐請求單讀（admin／會員，收不掉）
```

- 你的 196 秒實測：Δ＝**543**（＝140 秒等價 ≈ 388）。
- `4_userevents_batch` Δ＝**328/196s**。若它就是你貼的那條
  `SELECT user_id, detail FROM user_events WHERE user_id = ANY(...) AND post_id = … AND type = … ORDER BY user_id, id DESC`
  （`db.js` 的 `lastEventDetailsBatch`），那它在 `enqueueListingEvent()` 裡**一次呼叫剛好發一次**
  ⇒ 328 就是這 196 秒內的**入列次數**，而每次入列正好換 1 條目標讀取（本包實測：20 次入列 ⇒ 20 條）。
- ⇒ **本包之後：140 秒 Δ ≈ 388 − 328×(140/196) ＝ 154**（≈1.1 次/秒）。
  要把 ≤63 也達到，還得把剩下 40% 的 (b)(c)(d) 一起收掉（本包已一併改好，但 (b)(c)(d) 的
  **呼叫次數**在你手上才量得到）。

在正式機確認（**唯讀**；`calls`／`total_exec_time` 都是累計值，取兩個時間點做差）：

```sql
-- ① 目標指紋
SELECT queryid, calls, round(total_exec_time::numeric, 1) AS ms, query
FROM pg_stat_statements
WHERE query ~ '^SELECT key, value FROM settings$';

-- ② 確認「4_userevents_batch」是不是入列的去重查詢（若是，calls 差＝入列次數）
SELECT queryid, calls, round(total_exec_time::numeric, 1) AS ms, query
FROM pg_stat_statements
WHERE query ILIKE '%FROM user_events%' AND query ILIKE '%ORDER BY user_id, id DESC%';

-- ③ 其餘 40% 的呼叫次數（同一窗口做差）：這三條各自一呼叫就換 1 條①
SELECT queryid, calls, query FROM pg_stat_statements
WHERE (query ILIKE '%FROM user_settings%' AND query ILIKE '%user_id = $1%')  -- 逐會員設定的代理指標
   OR query ILIKE '%COALESCE(last_login_at, created_at)%'                    -- pauseIdle 掃描
   OR (query ILIKE '%FROM user_settings%' AND query ILIKE '%key IN%');       -- pauseIdle 還原用的批次讀
```

## 4. 成本效益（照你的口徑）

- 殘留成本：543 條 × 1.17ms ≈ 636ms／196s ＝ **3.2ms/秒 ≈ 0.32% 單核**。
- 本包收掉 ≥328/543（≥60%）⇒ 省的 CPU 上限 ≈ **0.19% 單核**。
- 全收光（連同逐請求單讀也不可能收）上限 **0.32% 單核**。
- 同一條路徑上真正的成本不在這裡：20 次入列＝4,987 條查詢，其中目標指紋只占 **20 條（0.4%）**，
  其餘是逐會員的 `user_settings`／`users`／`user_events` 讀取（**那是 #720 契約明講不變的語意**）。
- 會員端對端的痛（`stats;dur` 3.3–5.4 秒）與這條指紋無關。

**判斷：不值得為這條指紋單獨上線。** 這 6 個檔案的改動是低風險的同批收束（且會隨會員數／事件數
線性放大的那個乘數被拿掉），但以正式機現在的量體，它只值 0.2% 單核 —— 我不建議為它開一次發版。

## 5. 要我裁決的點

1. 這個 PR 要「留著等你跟下一個改動一起上」還是「直接關掉」？（我不會自行 merge／部署。）
2. 剩下那 40% 要不要再算準？要的話請在正式機跑 §3 的 ②③，把兩個時間點的 `calls` 貼回來，
   我就能把 140 秒 Δ 的預測值從 ≈154 收斂到單一條路徑。
