# PG 模式 startup 與 fallback 稽核（2026-09-26）

範圍：2026-09-26 上線收尾指令第二節最後一項「PG 模式 startup／fallback：不自動 seed／更新本機
SQLite；不得 PG 失敗後偷偷回本機庫讀寫業務資料」。
受查版本：`4bda6e8` 之後的分支 `fix/pr-b-persist-listing-transaction`。

## 一、啟動時對本機 SQLite 做什麼

| 事實 | 位置 | 判定 |
|---|---|---|
| SQLite 檔**無條件**開啟（`new DatabaseSync(DATA_DIR/v3.db)`），不論 driver | `v3/src/db.js:500` | 保留：檔案存在本身不寫業務資料 |
| `CREATE TABLE IF NOT EXISTS …` schema 區塊**無條件**執行 | `v3/src/db.js:505+` | 保留：只建空表，沒有 seed 業務列；PG 模式不讀它 |
| `listing_search_projection` 補建排程**有** driver gate | `v3/src/db.js:570`（`if (resolveDbDriver() !== "postgres")`） | 正確：PG 模式不會去寫本機 projection |
| `server.js`／`watcher.js` 沒有任何 `db.prepare(` 或 `sqliteHandle()` | 全檔 grep | 正確：持久化一律走島嶼函式，沒有繞過 driver 的直接寫入 |

結論：**PG 模式不會自動 seed 業務資料，也不會更新本機 projection。** 唯一無條件發生的是
「建立空表」，不構成資料分歧。

## 二、PG 失敗時會不會偷偷回本機庫

政策在 `v3/src/sqliteFallback.js`，控制點是環境變數 `PG_SQLITE_FALLBACK`：

| 模式 | 寫入 | 讀取 |
|---|---|---|
| `open`（`open`／`all`／`1`／`true`） | 回退 | 回退 |
| `closed`（**預設**） | **不回退**（往上丟） | 回退 |
| `strict`（`strict`／`none`，本輪新增） | **不回退** | **不回退** |

正式站實測（2026-09-26，`591-tracker-v3` 與 `5151-web-A` 容器內）：

```
PG_SQLITE_FALLBACK=<unset>
```

所以正式站目前是 `closed`：**業務寫入絕不落回本機 SQLite**（這正是 2026-09-23 那次
「寫進沒有人讀的 store」事故的防線），讀取在 PG 發生錯誤時仍會 fallback 到本機 SQLite
（既有設計：寧可回舊資料也不要讓整個站 500）。

## 三、本輪新增：`strict` 模式

`PG_SQLITE_FALLBACK=strict`（或 `none`）讓**讀取也不回退**。用途是把「PG 模式還殘留哪些
SQLite 依賴」變成看得見的失敗，而不是靜默讀到別台節點的舊資料：

```bash
# 在單一節點、可回退的時段使用；打開後任何回退都會變成 5xx／錯誤日誌
PG_SQLITE_FALLBACK=strict
```

預設行為完全不變（`closed`）。`options.strict=true` 與 `options.fallback="open"` 的優先序也不變
（`strict` 最優先，其次 `open`）。回歸：`v3/test/sqlite-fallback-policy.test.js`。

## 四、本輪把哪些業務路徑從本機 SQLite 移到 PG

| 路徑 | 修正 | 回退策略 |
|---|---|---|
| watcher 配對／群組／評估（`setListingMatch`／`reconcileListingById`） | `listingMatchAsync.js` ＋ `listingGroupsAsync.js` | PG 分支不回退 |
| 樂屋抓取游標（`get`／`saveRakuyaPageCursors`） | `crawlerProgressAsync.js` | PG 分支**完全**不回退（業務進度） |
| source-kit 重試（`markSourceKitRetry`） | `crawlerWrites.markSourceKitRetryAsync` | 沿用 `closed`（寫入 fail-closed） |
| 爬蟲基線（`saveSettings({hasBaseline:true})`） | `settingsAsync.saveSettingsAsync` | 沿用既有 |
| 上班地址座標（`ensureWorkCoords`） | `settingsAsync` | 沿用既有 |
| 帳號維護 tick（`expireStaleVerifyTokens`／`pauseIdleMembers`） | `accountMaintenanceAsync.js` | PG 分支不回退 |

## 五、仍然存在的界線（未假裝完成）

1. **讀取仍 fail-open**（預設 `closed`）。要完全滿足「不以 SQLite 作為業務讀取或故障回退來源」，
   需在正式站開 `PG_SQLITE_FALLBACK=strict`，這會把 PG 的短暫錯誤直接變成使用者可見的失敗，
   屬可用性取捨，因此本輪只提供開關並記錄，未擅自切換。
2. **本機 SQLite 空表仍會被建立**（`db.js:500`、`505+`）。不改的原因是舊檔要保留為備份，
   而且關掉它會動到 SQLite 分支的啟動路徑；屬非必要整理。
3. **`geo_cache` 等純快取**仍有同步寫入點（例如 `server.js` 的 `setCachedGeo`）。
   快取不是業務資料，未列入本輪；若之後要完全零 SQLite 寫入再處理。
4. 本稽核是**靜態＋環境實測**；實際「PG 模式下還有沒有寫入本機 SQLite」要以部署後
   對 `v3.db` 的 mtime 與業務表列數不再成長來驗證（見上線後待辦）。
