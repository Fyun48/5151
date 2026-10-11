# 會員列表「唯讀快照」走 PostgreSQL 待機節點（`PG_RO_URL`）

狀態：**預設關閉**。未設 `PG_RO_URL` 時行為與加這包之前逐字相同（連待機連線池都不會建立）。
開閘／關閘都只有**一個環境變數**，不需要回滾程式碼。

實作：`v3/src/pgReadReplica.js`（路由、待機池、複製衝突判定）、`v3/src/pgReadSnapshot.js`（快照、寫入守門、衝突後整趟重跑）、
`v3/src/memberWriteRecency.js` ＋ `v3/src/memberWriteMiddleware.js`（寫後新鮮期路由提示）、`v3/src/listingSearchPage.js`（唯一的呼叫端）。
測試：`v3/test/member-read-replica-routing.test.js`。

---

## 0. 這一包的責任邊界（不要搞混）

* **程式只負責「設了 `PG_RO_URL` 就用它」**：把會員列表唯讀快照的每一句都放到那條連線上
  （`application_name = <PG_APPLICATION_NAME>-ro`）。
* **程式不假設 `25434` 今天會送到待機，也不需要 HA 先改好**：未設／連不上／冷卻中 ⇒ 整趟走 `PG_URL`，行為與以前相同。
  開閘後若 `scan;dur` 沒降，那是**流量還沒真的到待機**（用 §3 第 2 個指標確認），不是這一包的缺陷。
* HAProxy 的 `pg_ro` 後端排序由 Owner 處理；這份文件與 PR **不包含**任何 HA 設定變更步驟。

## 1. 為什麼（正式機實測）

Owner 2026-10-12 06:01–06:02（同一份資料 `5151_shadow`、`listings` 189,492 列、同一條 SQL、各 3 次取中位）：

| 查詢 | primary（casa，load 1.6） | standby（syn，load 15.2） |
|---|---|---|
| `area_name` 分面 GROUP BY | 373 ms | 248 ms |
| `price_num` 區間計數 | 318 ms | 114 ms |
| `offline/hidden` 聚合 | 463 ms | 172 ms |
| `kind_name` 分面 | 354 ms | 128 ms |
| 42 欄取 11k 列掃描 | 220 ms | 65 ms |

Owner 2026-10-12 07:10 的路由實讀：`25433 → in_recovery=false`、**`25434 → in_recovery=false`（今天也還是 primary）**；
同一條分面 25433＝418/414/393 ms、25434＝414/482/403 ms（同速 ⇒ 真的還沒去待機），HA stats 顯示 `pg_standby_first`
只有 1 條連線且落在 `pg-a`。**直連 `192.168.0.220:15432` 才看到 `in_recovery=true`**，同一份 `listings` 189,506 列
（待機確實能服務讀取、資料一致）。⇒ **HA 的後端排序未改之前，開這個閘不會有任何效能變化。**
待機複製延遲（Owner 06:01 量測）**0.88 秒**。

## 2. 開閘（一個環境變數）

在**兩台** web 節點的 compose `environment`（主機上的正本，不是 repo 模板）各加一行：

```yaml
PG_RO_URL: postgres://<user>:<password>@<haproxy>:25434/5151_shadow
```

* web-A（CasaOS，192.168.0.140）：範例 host:port ＝ `192.168.0.140:25434`
* web-B（Synology，192.168.0.220）：範例 host:port ＝ `192.168.0.220:25434`

值等同 `PG_URL`，只把**埠換成 `25434`（pg_ro）**；憑證只留在主機（不得進 repo／PR／commit）。
repo 的模板（`deploy/shadow-ha/web/web-a|web-b/docker-compose.yml`）、產品 compose（`docker-compose.yml`、`casaos-compose.yml`）
與 `.env.example` 只寫鍵名與範例 host:port。

生效方式：讓該容器重新建立（`docker compose up -d 5151-web-A`／`5151-web-B`）。**關閘＝刪掉這一個鍵、重建容器**（程式不需要回滾）。

可選微調（都有安全預設，不設就好）：

| 鍵 | 預設 | 作用 |
|---|---|---|
| `MEMBER_READ_FRESHNESS_MS` | `5000` | 會員剛寫過之後，多久內的請求整趟走 primary（`0`＝關掉提示） |
| `PG_RO_RETRY_COOLDOWN_MS` | `3000` | 待機連線失敗後的冷卻（期間不再嘗試待機） |
| `PG_RO_CONNECT_TIMEOUT_MS` | `2000` | 待機連線逾時上限（一般 `PG_CONNECT_TIMEOUT_MS` 是 5000） |
| `PG_RO_POOL_MAX` | 同 `PG_POOL_MAX` | 待機池的最大連線數（兩池各自計算，總數＝兩者相加） |

## 3. 開閘後要看的指標

1. **錯誤率**：`/api/listings` 的 5xx／`SEARCH_UNAVAILABLE` 不上升。待機故障或複製衝突應該是 fail-safe
   （整趟退回 primary 或整趟重跑），不是 5xx。
2. **`pg_stat_activity` 落在哪個 host**：待機池的連線一律帶 `application_name = 5151-v3-ro`。

   ```sql
   SELECT application_name, count(*), inet_server_addr(), inet_server_port()
     FROM pg_stat_activity WHERE application_name LIKE '5151-v3%' GROUP BY 1, 3, 4;
   ```

   預期：`5151-v3-ro` 出現在**待機（syn）**；若它仍在 primary，代表 HA 的 `pg_ro` 還沒把待機排到前面（§0）。
3. **端對端 `Server-Timing`**：`list;dur`／`stats;dur` 不變、`scan;dur` 下降（§8 的區間）。
4. **log**（容器日誌，可直接 grep）：
   * `[pg-read] 會員列表唯讀快照改走 PG_RO_URL 待機節點`（每個行程一次，正向訊號）
   * `[pg-read] PG_RO_URL unavailable`（連不上待機 ⇒ 整趟退回 primary；每冷卻窗口最多一條）
   * `[pg-read] standby conflict`（待機複製衝突 ⇒ 整趟退回 primary 重跑一次；含 `uid`／`sqlstate`／第一次嘗試耗時）
5. **行程內計數器**（診斷）：`sharedReadReplicaStats()` ＝ `{replicaReads, primaryReads, fallbacks, cooldownSkips, standbyConflicts}`。

## 4. 待機延遲門檻與關閘規則（上線後要盯的）

在**待機**上量（或從 primary 看 `pg_stat_replication`）：

```sql
-- 待機自己
SELECT pg_is_in_recovery() AS standby,
       extract(epoch FROM (now() - pg_last_xact_replay_timestamp()))::numeric(10,2) AS replay_lag_s,
       pg_last_wal_replay_lsn() = pg_last_wal_receive_lsn() AS caught_up;
-- primary
SELECT client_addr, state, replay_lag FROM pg_stat_replication;
```

判讀與處置（建議值）：

| 觀察 | 判讀 | 動作 |
|---|---|---|
| `replay_lag_s` ≤ 2 秒（基線 0.88 秒） | 正常 | 不動 |
| `replay_lag_s` 持續 > **5 秒**（基線的 5.7 倍，連續 5 分鐘） | 待機已經跟不上 ⇒ **全站讀取都變舊**（不只會員列表） | **關閘**：刪掉 `PG_RO_URL`、重建容器；並查 primary 寫入是否暴增／待機 IO 是否飽和 |
| 日誌密集出現 `[pg-read] standby conflict`（例如 > 10 次／分鐘） | 待機在為了追 WAL 砍查詢；每次都多跑一次 primary（成本 ×2） | 先關閘，再評估 §5 的 GUC 取捨 |
| primary 的 `pg_stat_replication.replay_lag` 長期 > 5 秒 | 複製本身有問題 | 關閘 |

**關閘永遠是「刪掉 `PG_RO_URL` 這一個環境變數 ＋ 重建容器」**：不需要改碼、不需要回滾版本、不需要動 HA。

驗證這一包在**隔離庫**上跑得完（不是正式站）：

```bash
set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
export PG_TEST_URL="$PG_LIVE_REPRO_URL" PG_URL="$PG_LIVE_REPRO_URL" DB_DRIVER=postgres
PG_RO_URL="$PG_LIVE_REPRO_URL" node -e '
const run = async () => {
  const { loadListingPage } = await import("./v3/src/listingSearchPage.js");
  const page = await loadListingPage({filter:"all",kind:"",sources:"",q:"",sort:"newest",
    limit:20,offset:0,districts:[],userId:1,matchVoteUserId:1,sameHouse:true},{driver:"postgres"});
  console.log("stats_stages:", JSON.stringify(page.timing.stats_stages));
  console.log("query_ms:", page.timing.query_ms, "stats_ms:", page.timing.stats_ms, "total_ms:", page.timing.total_ms);
}; run();'
# 實測（repro 隔離庫，2026-10-12）：scan_ms=546、inputs_ms=1254、query_ms=831、stats_ms=1424、total_ms=2255
#   ⇒ scan_ms 佔 inputs_ms 的 44%：只看 stats;dur 會以為大頭在計數，其實是掃描（B 的理由）。
```

## 5. 待機複製衝突（recovery conflict）與「為什麼不乾脆 `hot_standby_feedback=on`」

正式機兩台 GUC 實讀（Owner 07:10）：`hot_standby = on`、**`hot_standby_feedback = off`**、
**`max_standby_streaming_delay = 30000ms`**、`max_standby_archive_delay = 30000ms`、`wal_level = replica`。
這種設定下，一個跑數秒的會員唯讀快照會遇到兩種下場之一：

1. 待機為了不把 WAL 套用拖超過 30 秒，**把我們的查詢砍掉** ⇒ `canceling statement due to conflict with recovery`
   （SQLSTATE `40001` `serialization_failure`）；
2. 或者待機選擇**拖住 WAL 套用** ⇒ 複製延遲從 0.88 秒暴漲，全站讀取都變舊、primary 的死列也清不掉。

**應用層的對策（已實作、有測試）**：

* 用 `error.code`（SQLSTATE）判，不比對訊息字串；家族＝`40001`／`25006`／`55006`
  （`v3/src/pgReadReplica.js` 的 `STANDBY_CONFLICT_CODES`／`standbyConflictCode()`），
  而且會沿著 `cause` 鏈找（list／stats 管線會把原始錯誤包成 `SEARCH_UNAVAILABLE`）。
* 命中 ⇒ **整個快照退回 primary 重跑一次**（丟棄待機那一趟的結果；不是逐條重試 ⇒ 不會出現同一請求兩個 snapshot 混用），
  並記一條可搜尋的 warning：`[pg-read] standby conflict：整趟退回 PG_URL 重跑一次（uid=…, sqlstate=40001, 第一次嘗試 …ms）`。
* **不吞**：待機那趟的 40001 不會被當成成功；重跑若又失敗，錯誤原樣往外丟（不會無限重試）。
* 計數器 `standbyConflicts` 讓「衝突多不多」變成可觀測的事（§3 第 5 點）。

**為什麼不建議改成 `hot_standby_feedback=on`（取捨，僅供判斷；不改 GUC）**：

* 它會讓待機把「我還在用的最舊 xmin」回報給 primary ⇒ primary 的 vacuum **不能清掉待機還在看的死列**，
  長時間會造成表／索引膨脹、autovacuum 追不上——把「待機砍查詢」換成「primary 膨脹」，而 primary 正是我們要減壓的那一台。
* 它也不會消滅所有衝突：只影響「清理造成的取消」那一類；`max_standby_streaming_delay` 到期後的行為與待機上的 DDL／鎖衝突仍在。
* 真正同時影響衝突與延遲的是 `max_standby_streaming_delay`（更大＝更少取消、但複製更舊），
  那同樣是「用新鮮度換穩定度」的取捨，不是免費的。
* 因此這一包的立場：**不動 GUC**（Owner 明示不會憑代理人的建議改），衝突由應用層 fail-safe 處理；
  若衝突真的頻繁，就用 §4 的規則關閘。

## 6. 契約（紅線）

1. **未設 `PG_RO_URL` ⇒ 行為與以前逐字相同**（連待機池都不建立）。
2. 只有「會員列表的唯讀快照」（`loadListingPage`）用這條路；公開搜尋、`/api/state`、診斷腳本不受影響。
3. **一條連線、一個 snapshot**：list 段、stats 段與共趟掃描都在同一條連線的同一個 snapshot 上
   （`BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY` ＋ `SET LOCAL jit = off`／`cursor_tuple_fraction = 1`）；
   `totalMatched` 仍由完整候選集合決定（沒有 LIMIT／抽樣／`reltuples`）。衝突重跑是**另一條**完整的快照（primary），不是接續。
4. **fail-safe 是「整趟」而不是「一半」**：連不上待機或遇到複製衝突時，整條快照改用 `PG_URL`（或整趟重跑），
   不會出現「一半 primary、一半待機」的混合快照。
5. **寫入守門在應用層**：任何寫入語句（含 `SELECT … FOR UPDATE`）企圖進入這條快照時直接拋
   `ReadOnlySnapshotViolationError`（`code = READ_ONLY_SNAPSHOT`），訊息說明白是誰、哪條路、該去哪寫；
   不讓人看到沒有上下文的 `cannot execute INSERT in a read-only transaction`。

## 7. 「會員自己剛存的東西不能看到舊的」

待機有 0.88 秒的複製延遲，而 `/api/listings` 的回傳含**會員自己**的狀態。屬於會員自己寫的欄位
（讀完代碼後的最小清單，全部都在這條請求路徑上被讀到）：

| 來源 | 欄位／用途 | 寫入路徑 |
|---|---|---|
| `user_listing_flags` | `viewed`／`watched`／`hidden`／`watch_note` ＋ 三個 `*_at` | `POST /api/listings/:id/flags`、`POST /api/listings/hide-many` |
| `user_settings` | 通勤（`commuteKm`／`workLat`…）、篩選預設 | `PATCH /api/profile`、設定頁 |
| `user_same_house_members` | 會員自己的同屋源群組（影響 `sameHouse` 篩選） | 同屋源合併／管理 |
| `user_match_votes`／`user_match_signals` | 「不是同一間」的票 | `POST /api/listings/:id/reject-match` 等 |

**做法：寫後新鮮期路由**——行程內記「這個 uid 最近一次寫入的時刻」，`MEMBER_READ_FRESHNESS_MS`
（預設 5 秒）內的請求**整趟**走 primary。`server.js` 用一條 middleware 掛在**所有** mutating 請求上
（成功的、帶 uid 的才記），不必逐條路由列舉寫入點。它是**路由提示，不是資料快取**：唯一狀態是 `uid → 時刻`。

**為什麼不改成「會員狀態留在 primary 讀」或「只有非會員段走待機」**：那兩條都會讓同一個請求
有兩條連線／兩個 snapshot（違反 §6.3），畫面會變成「房源是 0.88 秒前、旗標是剛剛」的撕裂；
後者還把最貴的 42 欄掃描留在 primary，只賺到零頭。

**最壞後果**：行程重啟（提示表空）或另一台 web 節點（提示不同步）時，最壞是複製延遲窗口內看到自己稍舊的狀態；
只會回稍舊的自身狀態，不會回別的會員或錯的房源；提示失效的方向永遠是「多走一次 primary」。

## 8. 預期效果（`scan;dur` 與總耗時）

**前提**：§1 的「待機比 primary 快」只有在 HA 的 `pg_ro` 真的把待機排到前面之後才成立（今天 25434 仍落 primary）。
下面的數字是**HA 排序改好之後**的預期；程式不假設它已改。

推導：42 欄取 11k 列掃描是 `scan;dur` 的主體（共趟掃描 ＋ 旗標預讀），primary 220 ms → standby 65 ms。

* **`scan;dur`：由 ~220–260 ms 降到 65–90 ms**（待機上的 65 ms ＋ 傳輸與旗標預讀）。
* **總耗時 `total;dur`：下降 250–1000 ms**。下界取「只有掃描這一段移走」（−155 ms，保守加上其他輔助讀取的貢獻 → −250 ms）；
  上界取「表上五段都移走」的差額（primary 1731 ms → standby 727 ms，約 −1.0 s）。
  這五個數字是**同一份資料上的單查詢微基準**，不是同一個請求；實際值用同窗口的 `total;dur` 前後對帳。
* 同一窗口內 `list;dur`／`stats;dur` 的**數字與語意不變**（B 只新增 `scan;dur`）。

## 9. 怎麼重跑驗證

```bash
# 離線（不需要 PG；20 條 ＋ 5 條 live skip）
node --test v3/test/member-read-replica-routing.test.js
node --test v3/test/listing-server-timing.test.js

# 隔離庫的 live 驗證（不要用正式庫；允許清單：repro／tracker_test／repro2／crawl_sandbox）
set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
export PG_TEST_URL="$PG_LIVE_REPRO_URL" PG_URL="$PG_LIVE_REPRO_URL" DB_DRIVER=postgres
node --test v3/test/member-read-replica-routing.test.js     # 25/25（真管線、application_name、fallback、衝突家族、寫入守門）

# 變異測試（拿掉修正，對應的測試必須變紅）
node v3/scripts/mutation-check.mjs v3/test/member-read-replica-routing.test.js   # SURVIVED 0
node v3/scripts/mutation-check.mjs v3/test/listing-server-timing.test.js        # SURVIVED 0
```
