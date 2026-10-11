# 會員列表「唯讀快照」走 PostgreSQL 待機節點（`PG_RO_URL`）

狀態：**預設關閉**。未設 `PG_RO_URL` 時行為與加這包之前逐字相同（連待機連線池都不會建立）。
開閘／關閘都只有**一個環境變數**，不需要回滾程式碼。

實作：`v3/src/pgReadReplica.js`（路由與待機池）、`v3/src/pgReadSnapshot.js`（快照與寫入守門）、
`v3/src/memberWriteRecency.js` ＋ `v3/src/memberWriteMiddleware.js`（寫後新鮮期路由提示）、
`v3/src/listingSearchPage.js`（唯一的呼叫端）。測試：`v3/test/member-read-replica-routing.test.js`。

---

## 1. 為什麼（正式機 2026-10-12 06:01–06:02 實測）

同一份資料（`5151_shadow`、`listings` 189,492 列）、同一條 SQL、各跑 3 次取中位：

| 查詢 | primary（casa，load 1.6） | standby（syn，load 15.2） |
|---|---|---|
| `area_name` 分面 GROUP BY | 373 ms | 248 ms |
| `price_num` 區間計數 | 318 ms | 114 ms |
| `offline/hidden` 聚合 | 463 ms | 172 ms |
| `kind_name` 分面 | 354 ms | 128 ms |
| 42 欄取 11k 列掃描 | 220 ms | 65 ms |

待機複製延遲 **0.88 秒**（`pg_last_wal_replay_lsn()` 已追平 `pg_last_wal_receive_lsn()`、
`pg_is_in_recovery() = true`）。

現況是兩台 web 節點的**所有**請求（含純讀）都壓在 casa 的 Celeron primary 上；
兩台 HAProxy 都發布了 `pg_ro`（`25434`）卻沒有人用。

⚠️ HAProxy 那一側的後端排序（`pg_ro` 目前把 primary 排在第一位）**由 Owner 自行處理**，
這包不假設它已改、也不包含任何 HA 設定變更。

## 2. 開閘（一個環境變數）

在**兩台** web 節點的 compose `environment`（主機上的正本，不是 repo 模板）各加一行：

```yaml
PG_RO_URL: postgres://<user>:<password>@<haproxy>:25434/5151_shadow
```

* web-A（CasaOS，192.168.0.140）：範例 host:port ＝ `192.168.0.140:25434`
* web-B（Synology，192.168.0.220）：範例 host:port ＝ `192.168.0.220:25434`

值等同 `PG_URL`，只把**埠換成 `25434`（pg_ro）**。憑證只放在主機的 compose／`.env`，
不得進 repo／PR／commit。repo 裡的模板（`deploy/shadow-ha/web/web-a|web-b/docker-compose.yml`）
與 `.env.example` 只寫鍵名與範例。

生效方式：讓該容器重新建立（`docker compose up -d 5151-web-A`／`5151-web-B`）。
不必改碼、不必改 HAProxy。

**關閘＝刪掉這一個環境變數**後重建容器；程式不需要回滾（`PG_RO_URL` 未設時走原路）。

可選微調（都有安全預設，不設就好）：

| 鍵 | 預設 | 作用 |
|---|---|---|
| `MEMBER_READ_FRESHNESS_MS` | `5000` | 會員剛寫過之後，多久內的請求整趟走 primary（`0`＝關掉提示） |
| `PG_RO_RETRY_COOLDOWN_MS` | `3000` | 待機連線失敗後的冷卻（期間不再嘗試待機） |
| `PG_RO_CONNECT_TIMEOUT_MS` | `2000` | 待機連線逾時上限（一般 `PG_CONNECT_TIMEOUT_MS` 是 5000） |
| `PG_RO_POOL_MAX` | 同 `PG_POOL_MAX` | 待機池的最大連線數（注意：兩池各自計算，總數＝兩者相加） |

## 3. 開閘後要看的指標

1. **錯誤率**：`/api/listings` 的 5xx／`SEARCH_UNAVAILABLE` 不上升。待機連不上時應該是
   fail-safe（整趟退回 primary），而不是 5xx。
2. **`pg_stat_activity` 落在哪個 host**：待機池的連線一律帶
   `application_name = 5151-v3-ro`（`PG_APPLICATION_NAME` 的後綴 `-ro`）。

   ```sql
   SELECT application_name, count(*), inet_server_addr()
     FROM pg_stat_activity WHERE application_name LIKE '5151-v3%' GROUP BY 1, 3;
   ```

   預期：`5151-v3-ro` 出現在**待機（syn）**，`5151-v3` 出現在 primary。
3. **端對端 `Server-Timing`**（同一窗口對帳）：`list;dur`／`stats;dur` 不變，新增的
   `scan;dur` 與 `total` 應該下降（見 §6 的推導區間）。
4. **log**：待機失敗會有一條可 grep 的 warning
   `[pg-read] PG_RO_URL unavailable`（每 `PG_RO_RETRY_COOLDOWN_MS` 最多一條，不會洗版）；
   待機第一次啟用時每個行程記一次 `[pg-read] 會員列表唯讀快照改走 PG_RO_URL 待機節點`。
5. 行程內計數器（診斷用，`v3/src/pgReadReplica.js`）：`sharedReadReplicaStats()` 的
   `replicaReads`／`primaryReads`／`fallbacks`／`cooldownSkips`。

## 4. 契約（紅線）

1. **未設 `PG_RO_URL` ⇒ 行為與以前逐字相同**（連待機池都不建立）。
2. 只有「會員列表的唯讀快照」（`loadListingPage`）用這條路；公開搜尋、`/api/state`、
   診斷腳本不受影響（它們不傳 `memberReadSnapshot`）。
3. **一條連線、一個 snapshot**：list 段、stats 段與共趟掃描都在同一條連線的同一個 snapshot 上
   （`BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY` ＋ `SET LOCAL jit = off`／
   `cursor_tuple_fraction = 1`）。`totalMatched` 仍由完整候選集合決定（沒有 LIMIT／抽樣／`reltuples`）。
4. **fail-safe 是「整趟」而不是「一半」**：進快照之前**一次**決定用哪條路；待機拿不到連線時
   整個快照都用 `PG_URL`，不會出現「一半 primary、一半待機」的混合快照。
5. **寫入守門在應用層**：任何寫入語句（含 `SELECT … FOR UPDATE`）企圖進入這條快照時直接拋
   `ReadOnlySnapshotViolationError`（`code = READ_ONLY_SNAPSHOT`），訊息說明白是誰、哪條路、
   該去哪寫；不讓人看到沒有上下文的 `cannot execute INSERT in a read-only transaction`。

## 5. 「會員自己剛存的東西不能看到舊的」

待機有 0.88 秒的複製延遲，而 `/api/listings` 的回傳含**會員自己**的狀態。屬於會員自己寫的欄位
（讀完代碼後的最小清單，全部都在這條請求路徑上被讀到）：

| 來源 | 欄位／用途 | 寫入路徑 |
|---|---|---|
| `user_listing_flags` | `viewed`／`watched`／`hidden`／`watch_note` ＋ 三個 `*_at` | `POST /api/listings/:id/flags`、`/hide-many` |
| `user_settings` | 通勤（`commuteKm`／`workLat`…）、篩選預設 | `PATCH /api/profile`、設定頁 |
| `user_same_house_members` | 會員自己的同屋源群組（影響 `sameHouse` 篩選） | 同屋源合併／管理 |
| `user_match_votes` / `user_match_signals` | 「不是同一間」的票 | `POST /api/listings/:id/reject-match` 等 |

（房源本身、爬蟲欄位不是會員寫的；它們落後 0.88 秒是可接受的。）

**選定的做法：寫後新鮮期路由（選項 ii）**——行程內記「這個 uid 最近一次寫入的時刻」，
`MEMBER_READ_FRESHNESS_MS`（預設 5 秒）內的請求**整趟**走 primary。server.js 用一條
middleware 掛在**所有** mutating 請求上（成功的、帶 uid 的才記），所以不需要逐條路由列舉寫入點。
它是**路由提示，不是資料快取**：唯一的狀態是 `uid → 時刻`，沒有存下任何資料列或回應。

**為什麼放棄 (i) 把會員狀態留在 primary 讀**：那會讓同一個請求有兩個來源（兩條連線、兩個快照），
直接違反契約 3（一條連線、一個 snapshot）；而且會出現「房源清單是 0.88 秒前、旗標是剛剛」
的撕裂畫面——比慢 1 秒更難解釋。

**為什麼放棄 (iii) 只有非會員狀態的掃描段走待機**：(i) 的問題一個都沒解（仍然是同一請求兩個來源），
而且把最貴的那一段（42 欄掃描、4 萬多列的 hydration）留在 primary，等於只賺到零頭。

**最壞後果（寫清楚）**：

* **行程重啟**：提示表是空的 ⇒ 重啟後 5 秒內的第一批請求會走待機 ⇒ 最壞是複製延遲窗口（實測
  0.88 秒）內看到自己稍舊的狀態。方向是「回稍舊的自身狀態」，不會回別的會員、也不會回錯的房源。
* **多節點（web-A／web-B 各自一個行程）**：兩台的提示表不同步。在 A 寫、下一個請求被 HAProxy
  送到 B 時，B 沒有提示 ⇒ 同樣落在複製延遲窗口內。
* 上述兩個情況都由「待機目前落後多少」封頂；`pg_stat_replication`／`pg_last_wal_replay_lsn()`
  若發現待機明顯落後（超過幾秒），應該關閘（刪掉 `PG_RO_URL`）。
* 提示失效的方向永遠是「多走一次 primary」（保守），不是「少走一次」。

釘住它的測試（`v3/test/member-read-replica-routing.test.js`）：
`剛寫過的 uid 在窗口內整趟走 primary`（含對照組：沒有提示走待機、別人的 uid 不受影響）、
`多節點／重啟：提示表各自獨立`（兩個實例、最壞後果逐條斷言）、
`memberWriteMiddleware：只有「mutating 且成功」才記提示`，以及 mutation-check 的兩條變異
（提示失效／窗口失效）都必須被殺掉。

## 6. 預期效果（`scan;dur` 與總耗時）

數字來自 §1 的正式機實測（primary vs standby，同一份資料、各跑 3 次取中位）：

* 42 欄取 11k 列的掃描：**220 ms → 65 ms**（−155 ms）。
* 這一段先前**沒有獨立欄位**，只以總和的形式躲在 `stats;dur`（`statsPrepareMs` 含共趟掃描）；
  新增的 `scan;dur` 會讓它現身（B 的觀測拆分）。
* 端到端 `total;dur` 的下降幅度＝掃描那一刀的**一部分**（掃描只是整條請求的一段）：
  可期待的區間是 **−60 ms ～ −155 ms**（扣除其他仍留在 primary 上的輔助讀取與事件迴圈成本）；
  同一窗口內 `list;dur`／`stats;dur` 的**數字與語意不變**（B 只新增 `scan;dur`）。
* 開閘後請用同一組參數、同一窗口對帳：`scan;dur` 應落在 **60–100 ms**（待機上 65 ms ＋ 傳輸），
  `total` 相對未開閘的基線下降 **60–155 ms**。若 `scan;dur` 沒有降、或 `total` 反而上升，
  第一個要查的是 `pg_ro` 後端的角色（HAProxy 目前把 primary 排在 `pg_ro` 的第一位 ⇒ 開閘也未必
  真的打到待機；用 §3 的 `application_name` 確認）。

## 7. 怎麼重跑驗證

```bash
# 離線（不需要 PG；15 條 ＋ 3 條 live skip）
node --test v3/test/member-read-replica-routing.test.js
node --test v3/test/listing-server-timing.test.js

# 隔離庫的 live 驗證（不要用正式庫；允許清單：repro／tracker_test／repro2／crawl_sandbox）
set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
export PG_TEST_URL="$PG_LIVE_REPRO_URL" PG_URL="$PG_LIVE_REPRO_URL" DB_DRIVER=postgres
node --test v3/test/member-read-replica-routing.test.js     # 18/18，包含 application_name 與 fallback

# 變異測試（拿掉修正，對應的測試必須變紅）
node v3/scripts/mutation-check.mjs v3/test/member-read-replica-routing.test.js   # SURVIVED 0
node v3/scripts/mutation-check.mjs v3/test/listing-server-timing.test.js        # SURVIVED 0
```
