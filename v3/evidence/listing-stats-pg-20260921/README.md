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

## 這還不是全部（切換前仍缺）

- `/api/state`（初始載入）仍用 `listListings()` ＋ SQLite `stats()`；PG 模式下它與 `/api/listings` 會不同源。
- 列表路徑以外的旗標／路線讀取、`enqueueSimilaritySafe`（pHash 佇列）、`listing_prep`、通知／CRM 佇列仍 SQLite-only。
- commute／fit 排序仍在 PG 的 SQL-first envelope 外（安全但回退 SQLite）；PG 的 EXPLAIN evidence 只涵蓋三種價格／新舊排序。
- PG schema bootstrap（app 只 ensure SQLite schema）與 `pgSchema.importTable` 的 COPY／分批版本、寫入凍結視窗。

