# 下一包：budget store「可用 handle」判準 ＋ PG_NO_SQLITE_OPEN 端到端（殘餘風險 1 與 storedSearchKeys）

- 上游：本包 #670（squash `ea15f36`）拆掉 `budgetGuardAsync.js ensureBudgetStoreOnce` 對 sqliteDb 的硬 throw。
- 狀態：**規格**。本包只寫這份，不改 `v3/src`。執行由下一包 worker 做。
- 授權邊界：只動 budget store 判準＋其直達呼叫端（executeWithProvider）＋`storedSearchKeys` 這一個同步讀點；不碰其他 32 個同步模組、sqliteFallback 政策、抓取重試/暫停/預算語意、v1/v2、NAS compose/正式 env。

## 沙盒開閘的原始事實（本包已取得，直接當輸入）

`PG_NO_SQLITE_OPEN=1` 開閘跑 3 輪（`crawl_sandbox`），三輪都在同一個點失敗：

```
business SQLite is closed (PG_NO_SQLITE_OPEN=1, DB_DRIVER=postgres):
synchronous SQLite handle access "prepare" reached at storedSearchKeys (file:///app/src/db.js:4410:6)
```

三輪 `fetched:0 jobs:0`、`duration_ms` 113770 / 178991 / 119536。**沒有** `requires the SQLite handle`、**沒有** budget 相關錯誤——失敗點已從 budget store 移到 `storedSearchKeys`。

---

## ① 判準：改用「可用的 handle」，不是「有值」

**現況（殘餘風險 1 的根）**：`budgetGuardAsync.js:91` 用 `if (sqliteDb)`（truthy）。但 `db.js:548-550` 開閘時 `db` 是 `createNoOpenSqliteProxy()` 回傳的 **Proxy（truthy）**；web/API 路把這個 proxy 當 `sqliteDb` 傳給 `budgetStore({ sqliteDb: db })`（`db.js:1150/1154/1158/1177`、`route.js:87`）→ `ensureBudgetStoreOnce` 的 `if (sqliteDb)` 誤走 legacy 鏡射 → `tableInfo(proxy)` → `proxy.prepare` 才報 `business SQLite is closed`。

**要做的**：把判準改成「**可用的 handle**」。實作選項（下一包擇一）：

- (a) `createNoOpenSqliteProxy()` 加一個不可枚舉 marker（例 `Symbol.for("pgNoOpenSqlite")` 或 `Object.defineProperty` 的隱藏欄），新增 `sqliteHandleIsUsable(handle)` 回 `false` 於 `null`/`undefined`/帶 marker 的 proxy；`ensureBudgetStoreOnce` 改 `if (sqliteHandleIsUsable(sqliteDb)) { legacy } else { native }`。
- (b) `db.js` 開閘時跳過綁定（現已是）**且** 讓所有 `budgetStore({ sqliteDb: db })` 呼叫端在開閘時改傳 `null`（需動 db.js 那幾處，成本較高、易漏）。

**建議 (a)**：單一判準集中一處，`budgetGuardAsync` 不用知道 db.js 的 proxy 內部。

**驗收證據（結案條件）**：
1. 單測：用 `createNoOpenSqliteProxy()`（或等價 fake 帶 marker）當 sqliteDb 呼叫 `ensureBudgetStoreOnceForTest`，斷言走 native（record 到 `budgetPgDdlStatements`＋`setval`），**不是** `proxy.prepare` 的 `business SQLite is closed`。
2. 回歸：real `DatabaseSync` 仍走 legacy（record 到 `ensurePgSchema` 鏡射＋`CREATE UNIQUE INDEX`＋`resyncIdentitySequences`）。

---

## ② executeWithProvider 的「無 handle 直接 fallback」在 PG 模式該不該 fallback

**現況**：`providers/executeWithProvider.js:55-58`：

```js
const database = db || getBoundBudgetDb();
const budget = store || budgetStore({ sqliteDb: database, options });
const fallback = async () => fallbackAction();
if (!database || typeof actionWithProvider !== "function") return fallback();
```

開閘時 `getBoundBudgetDb()` 為 null → provider 呼叫在進 budget store **之前**就 fallback，等於 budget 完全沒被用（本包沙盒也因此「budget 表無新列」）。

**要決定的**：PG 模式（`resolveDbDriver()==="postgres"`）下，無 handle 時**不該**直接 fallback——因為 PG budget store（① 之後）不需要 handle。改成：PG 模式照常進 `budget.loadEnabled` → `reserve` → `settle/release/hold`（走 PG 原生）；只有 SQLite 模式（真正需要 handle 的 fallback）才維持原 `if (!database) return fallback()`。

**⚠️ 這一步與 ① 必須同一包**：沒有 ②，① 的 native 路徑在現有呼叫端裡根本不會被走到（爬蟲路在 executeWithProvider 就短路）。

**驗收證據（結案條件）**：
1. 單測：`executeWithProvider({ db: undefined, options: { driver: "postgres", pgDriver: fake } })` 且 `stub_paid` 啟用時，走到 `actionWithProvider`（reserve→settle），不回 fallback。
2. 沙盒開閘實跑後，`crawl_sandbox` 的 `call_reservations`／`provider_usage_logs` 列數**前進**（`SELECT count(*)` 原文），證明 budget 真的被寫。

---

## ③ storedSearchKeys（listings 搜尋鍵）：下一個要拆的切面 ＋ H1 判定

**現況呼叫鏈**（本包已用 grep/讀碼確認）：

```
watcher.js:1071  listingCountForSearch(batch.searchUrl)   // 落地階段逐批
  → db.js:8718   listingCountForSearch(searchKey)
  → db.js:4380   expandSearchKeys(keys)
  → db.js:4406   storedSearchKeys()
  → db.js:4410   db.prepare("SELECT DISTINCT search_key FROM listings").all()   // ← 同步 SQLite 讀，開閘即炸
```

`watcher.js:1071` 的結果寫進 `searchReports[].baseline`（`isSearchBaseline = listingCountForSearch(...) === 0`）——**結果被消費**。

**H1 判定（「storedSearchKeys 在 PG 模式本就是死碼？」）**：本包沙盒開閘 3 輪**已初步否決「死碼」**——它被 `watcher.js:1071` 在落地階段逐批呼叫、結果寫進 `searchReports[].baseline`，是活碼不是死碼。但「在 PG 模式這個同步 SQLite 讀是否該被 PG 原生取代」仍需下一包完整證明（見下）。`db.js` 內 `astra6 §0.2` 註解已點出 PG 端對等語意＝`expandSearchKeysAgainst(PG 的 SELECT DISTINCT search_key, keys)`（`db.js:4343/4384` 已有純函式 `expandSearchKeysAgainst`），遷移路已半鋪好。

**要做的**：把 `listingCountForSearch`（或其唯一呼叫點 `watcher.js:1071`）改走 PG 原生／async（`SELECT DISTINCT search_key FROM listings` 或 context.searchKeys 契約），拆掉 `storedSearchKeys` 這條同步 SQLite 讀。

**驗收證據（結案條件，H1 用「呼叫圖＋沙盒開閘實跑」證明，不准只用推論）**：
1. 呼叫圖（靜態）：grep `expandSearchKeys|storedSearchKeys|listingCountForSearch`，列出全部呼叫點與消費端，證明「結果是否被消費」。
2. 沙盒開閘 3 輪 jsonl 原文：斷言失敗點**從 `storedSearchKeys` 移到「下一個」同步讀點**（或三輪無任何 `business SQLite is closed`）。
3. 同值比對：隔離庫上 `SELECT DISTINCT search_key FROM listings`（PG）與 SQLite `storedSearchKeys()` 的集合一致（零語意漂移）。

---

## ④ 證據型態統整（每條拿什麼結案）

| 條 | 結案證據 |
|---|---|
| ① | 單測：fake proxy(marker)→native；real DatabaseSync→legacy |
| ② | 單測：executeWithProvider PG 無 handle 走 reserve→settle；沙盒 budget 表列數前進（count 原文） |
| ③ | 呼叫圖（grep 全呼叫點）＋沙盒 jsonl 原文（失敗點位移）＋隔離庫同值比對 |

補充可用觀測：`pg_stat_user_tables`（seq/idx 掃描）、節點 log 原文（`business SQLite is closed … at <fn>`），都算可接受證據。

## 明確排除（下一包也不准碰）

其他 32 個同步模組、sqliteFallback 政策、抓取重試/暫停/預算語意、v1/v2、NAS compose／正式 `.env`、build/predeploy/deploy。
