# PostgreSQL 列表頁統計（`stats()`）— 2026-09-21

`v3/evidence/pg-rw-drill-20260921/README.md` 的落差①：`DB_DRIVER=postgres` 時列表有資料、
`stats()` 讀的卻還是（空的）SQLite store → 頁面 1 筆、統計 0 筆。`v3/POSTGRES_SWITCH_PLAN.md`
§2.6 把它列為「PG 模式要能上線，至少要先解決」的那一項。這裡記錄它怎麼被接上、怎麼在**真實
shadow PostgreSQL** 上驗證。

## 問題

`GET /api/listings` 的卡片走 PostgreSQL（`listingSearchAsync.js`），同一支 handler 的計數器
`stats()` 卻是同步 SQLite（`db.js`）：兩個 store 不同源，數字必然矛盾。

## 改法（單一 pipeline，兩個 store 各自供料）

stats 被拆成「讀輸入」與「算數字」兩半，只有前者是 driver-specific：

| 部分 | 位置 | 說明 |
|---|---|---|
| 純管線 | `db.js`：`buildListingStatsRows()` + `summarizeListingStats()` | 個人旗標 overlay → 自己刊登可見性 → profile scope（行政區／租金／關鍵字／通勤／顯示）→ 計數 |
| 依賴包 | `db.js`：`listingStatsBuildContext()` | 產生 clause 的 helper（與搜尋路徑**同一批**）＋ candidate 欄位＋上面兩個純函式 |
| PostgreSQL 讀取 | `repository/listingStats.js` | candidates／statusCounts／watchedTotal／dbTotal／failedRouteJobs ＋ flag map，全部走注入的 `exec`（`?`→`$n`） |
| app 入口 | `listingStatsAsync.js` | driver dispatch；PG 走 repository ＋ 裝飾 provider（route cache 給 `missingRoute`），失敗才回 SQLite |
| handler | `server.js` `/api/listings` | `await listingStatsAsync({ userId: uid, diagnostics: statsDetails })` |

- SQLite 的 `stats()` 行為不變（同一批函式、同一順序，只是把純的部分搬出去給兩邊共用），
  `DB_DRIVER=sqlite` 的正式站不受影響。
- 通勤分支（`missingRoute`）在 PG 端改用裝飾 provider 讀 route cache：
  `applyProfileScope()` / `applyListingFilter()` 多收一個 optional `provider`，SQLite 呼叫端不傳 → 行為不變。
- `watchLimits.countWatched()` 的 SQL 抽成 `WATCHED_COUNT_SQL` 常數，PG 端跑同一份文字（額度與 `watchedTotal` 不會分叉）。
- int8 正規化：PG 的 BIGINT 以字串回來，candidate 列在邊界正規化（同 `repository/decorationData.js` 對卡片的做法）。

## 驗證

```bash
# 1) 本機（免 PostgreSQL；live 子測試自動 skip）
node --test v3/test/listing-stats-parity.test.js

# 2) 真實 shadow PostgreSQL（CasaOS 上的既有工具腳本）
sh ~/shadow-ha-tools/5151-run-pg-test.sh /root/pgtest/incoming v3/test/listing-stats-parity.test.js
```

| 測試 | 環境 | 結果（2026-09-21） |
|---|---|---|
| `listing-stats-parity.test.js`（sqlite wiring） | 本機 Windows | 1 pass / 0 fail |
| `listing-stats-parity.test.js` | shadow PG，image `ghcr.io/fyun48/5151:bcb6eb7f…` | **4 pass / 0 fail**（sqlite wiring ＋ 無通勤 ＋ 有通勤且 route_cache 命中） |
| `pg-live-integration.test.js`（回歸） | shadow PG | 10 pass / 0 fail |
| `write-path-parity.test.js`（回歸） | shadow PG | 2 pass / 0 fail |

parity 是**逐欄 deepEqual**：`total / unseen / watched / watchedTotal / same_source / hidden /
offline / offlineConfirmed / suspected / suspectedPending / elevator / stored / filteredOut /
missingGeo / missingRoute / dbTotal`。fixture（10 筆）刻意讓每個計數器都有值，並用斷言把
「兩邊都是 0」的假綠擋掉。

### live 跑出來的真問題（都已修）

1. **`{ one: true }` 被注入的 `exec` 忽略**（該 exec 只回 row array）→ `statusCounts`、
   `watchedTotal`、`dbTotal` 全變 0。修法：repository 內部用 `runOne()` 自行 unwrap，兩種 exec 形態都吃。
2. **測試 fixture 用 `upsertListing()` 設 `offline`／`match_level`／`geo_source`／`listed_by_user_id` 是無效的**
   （那些欄位不在 upsert 的欄位清單裡，`offline` 甚至被 ON CONFLICT 重設為 0）→ 測試改成 upsert 後用
   SQLite handle 補 UPDATE，否則對照組會兩邊都 0。

## 第二輪（同日）：`/api/state` 同源 ＋ 兩個 driver 的數值語意

`GET /api/state`（前端第一次載入的 payload）原本仍走 `stats()` ＋ `listListings()` 的 SQLite 鏈，
PG 模式下「首次載入」與「重新整理（`/api/listings`）」會是兩個 store。現在它也走同兩個 async 入口
（`listingStatsAsync` ＋ `searchListingsAsync`，參數與 `/api/listings` 一致）；`DB_DRIVER=sqlite`
時仍是原本那條鏈，只是改成 await。

新增的 live 子測試把 **`/api/state` 那 500 筆頁面**逐欄 deepEqual（SQLite `listListings()` vs
PG `searchListingsAsync()`），第一次跑就抓到一個**真的會上線的缺陷**：

> node-postgres 把 BIGINT（int8, OID 20）以**字串**回傳，`node:sqlite` 是數字。
> 於是 PG 模式下的卡片長成 `post_id: "900001"`、`price_num: "25000"`、`offline: "0"`、
> `community_id: "0"`、`content_seq: "1"` …（**`/api/listings` 也一樣**，因為共用同一條 hydrate
> 路徑），SQLite 則是數字 —— 任何 `===`、物件鍵或前端運算都會不同。

修法：`dbDriverPostgres.js` 的 `applySqliteNumberSemantics()` 在建立 driver 時把 int8 的 parser
換成 `Number`（`createPostgresDriver()` 內套用），讓兩個 driver 對 INTEGER 有同一個語意。
安全性：本 schema 的 id ~1e9、epoch 毫秒 ~1.7e12，遠低於 `Number.MAX_SAFE_INTEGER`（9.007e15）；
NUMERIC/DECIMAL（OID 1700）不動（schema 鏡射把 SQLite REAL 映成 DOUBLE PRECISION，目前沒有這種欄位）。

驗證（shadow PG，image `ghcr.io/fyun48/5151:bcb6eb7f…`）：

| 測試 | 結果 |
|---|---|
| `listing-stats-parity.test.js`（含新的 state 頁面 parity） | **5 pass / 0 fail** |
| `pg-live-integration.test.js`（回歸） | 10 pass / 0 fail |
| `write-path-parity.test.js`（回歸） | 2 pass / 0 fail |
| `decoration-data.test.js`（回歸；SQLite 與真實 PG 逐值比對） | 3 pass / 0 fail |
| `pg-driver.test.js`（本機；新增數值語意單測） | pass |

## 第三輪（同日）：詳情頁讀取（`getListing`）

列表與初始載入都同源了，但**詳情頁**還沒有：`db.js` 的 `getListing(postId, userId, options)` 是同步
SQLite 讀取（`SELECT * … WHERE post_id = ?` → fixture 可見性 → 該會員的旗標 → 共用裝飾器）。PG 模式下
列表會出現只存在於 PG 的物件，點進去卻 404（`/go` 通知連結、`/api/listings/:id/history`、recheck、
report-gone 全都一樣）。

`v3/src/listingDetailAsync.js`：PG 模式用 listings repository 的 `hydrate([id])`（同一句 `SELECT *`）
讀列，再跑**同一個** `listingVisibleOnSurface`（`MEMBER_DETAIL`）與同一組裝飾器
（`preloadDecorationProviderAsync` ＋ `decorateRowsWithProvider`）；`DB_DRIVER=sqlite` 直接轉呼叫
`getListing()`。四個 server 呼叫點（`/go/:id`、history、recheck、report-gone）改成 await。

驗證：`v3/test/listing-detail-parity.test.js` —— 本機（sqlite driver 逐欄等於 `getListing()`）＋
shadow PG **4/4**：五種列形（peer＋match、有旗標、houseprice 走 `listing_prep` gate、
fixture 列不可見 → `undefined`、不存在的 id → `undefined`），外加 `sameHouse:false` 的爬蟲讀法。
回歸 `listing-stats-parity` 5/5。

## 這還不是全部（切換前仍缺）

- ~~`/api/state`（初始載入）~~ → **已同源（2026-09-21）**：它現在也走 `listingStatsAsync()` ＋
  `searchListingsAsync()`，live 測試把那 500 筆頁面逐欄 deepEqual（也因此抓到 BIGINT 型別缺陷）。
- ~~列表路徑以外的讀取（詳情頁）~~ → **已接上（2026-09-21）**：`getListingAsync()` 走 listings repository
  的 `hydrate()` ＋ 同一組可見性／裝飾器，`/go`、history、recheck、report-gone 都改成 await；
  live parity 4/4（`v3/test/listing-detail-parity.test.js`）。
- **爬蟲／enrich／通知管線的讀取仍是 SQLite，而且是同步的**：`watcher.js` 的 `listingForWatch()`
  （＝ `getListing`）與整條 enqueue/notify 鏈用的 `loadAnyoneFlagMap`／`findBySourceKey`／
  `listMatchCandidates`／`getRouteJob`… 都綁 `node:sqlite`。寫入已可走 PG，但爬蟲「寫完再讀」若仍讀
  SQLite，PG 模式下會看不到自己剛寫的列（重複建立、變更偵測失效）→ **爬蟲的讀取必須與寫入同批上線**，
  這是剩下的最大一塊。
- 其餘寫入仍 SQLite-only：`enqueueSimilaritySafe`（pHash）、`listing_prep`、通知／CRM 佇列。
- 列表路徑以外的旗標／路線讀取、`enqueueSimilaritySafe`（pHash 佇列）、`listing_prep`、通知／CRM 佇列仍 SQLite-only。
- commute／fit 排序仍在 PG 的 SQL-first envelope 外（安全但回退 SQLite）；PG 的 EXPLAIN evidence 只涵蓋三種價格／新舊排序。
- PG schema bootstrap（app 只 ensure SQLite schema）與 `pgSchema.importTable` 的 COPY／分批版本、寫入凍結視窗。

