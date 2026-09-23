# 2.2 CRM 領域移植計畫（PostgreSQL，2026-09-23）

> 前置：③（通知佇列）與 ④（相似度／洞察）已完成並合併（#405/#409/#442/#447）。
> 本檔是 **2.2 CRM** 的可執行計畫：照 ③④ 的模式做，預估 **兩個 PR**。

## 為什麼一定要做（HA 阻塞項）

- 資料本體（`crm_contacts`／`crm_cases`／`crm_notes`／`crm_todos`／`crm_outbox`）在 PG 模式下仍寫**本機 SQLite** ✗。
- `createCaseFromFeedback`／`enqueueCrmFromFeedback` 會**跨 store**：客訴資料在 PG、CRM 在 SQLite ✗。
- `db.js` 的 `opsDeliveryDb()` 直接 `return db`（SQLite handle）✗ → 投遞迴圈寫的地方與後台讀的地方不一致。
- 只換一半會更糟（迴圈永遠撈不到）→ **要就整條一起 async 化**。

## 現況清單（2026-09-23 實查）

| 檔案 | 內容 |
|---|---|
| `v3/src/crm.js` | 17 個 `(db, …)` 同步函式：`ensureCrmSchema`／`crmOverview`／`crmModule`／`setCrmEnabled`／`snapshotContact`／`listContacts`／`getContact`／`createContact`／`updateContact`／`createCase`／`updateCase`／`addNote`／`addTodo`／`setTodoDone`／`enqueueCrmFromFeedback`／`createCaseFromFeedback`／`restoreContactsFromHandoff` |
| `v3/src/crmOutbox.js` | 佇列：`ensureCrmOutboxSchema`／`enqueueCrmOutbox`／`claimCrmOutboxBatch`／`markCrmOutboxSent`／`markCrmOutboxFailure`／`crmOutboxStats`（含 `res.changes`，PG 要改 `rowCount`） |
| `v3/src/crmDelivery.js` | `isLocalCrmSyncStopped`／`setLocalCrmSyncStopped`／`crmDeliveryControl`／`deliverCrmOutboxOnce`／`startCrmDeliveryLoop` |
| `v3/src/db.js` | 已有包裝層（約 1901–1946 行）：`getCrmOverview`／`getCrmContact`／`createCrmContact`／`updateCrmContact`／`createCrmCase`／`updateCrmCase`／`addCrmNote`／`addCrmTodo`／`setCrmTodoDone`／`getCrmModule`／`setCrmModuleEnabled`／`getCrmDeliveryControl`；另有 `opsDeliveryDb()`（目前 `return db`） |
| `v3/src/server.js` | CRM admin 路由：`GET /api/admin/crm`、`PUT /crm/module`、`PUT /crm/sync`、`GET/POST /crm/contacts`、`/crm/contacts/:id`、cases／notes／todos（共 12+ 條）；啟動時 `startCrmDeliveryLoop(opsDeliveryDb(), …)` |

## 切法（沿用 ③④ 的模式，兩包）

**2.2a — CRM CRUD ＋ admin 路由**
1. `v3/src/repository/crm.js`：把 `crm.js` 的每條語句抽成 builder（共用 SQL 文字）。
2. `v3/src/crmAsync.js`：`withFallback(options, runPostgres, runSqlite)` ＋ `options.exec` 短路 ＋ `options.strict` ＋ fail-open；決策（例如 `crmModule`／`crmOverview` 的組裝）**逐字沿用** `crm.js`。
3. `db.js` 的 12 個包裝改 `async` 並分派；`server.js` 對應路由改 `await` ＋ try/catch（同 #442 的作法）。
4. 測試：`v3/test/crm-parity.test.js`（離線 shim：`$n`→`?` 跑同一個 SQLite fixture，比對兩 driver 的輸出）＋ live `PG_TEST_URL`。

**2.2b — `crm_outbox` 佇列 ＋ 投遞迴圈**
1. `v3/src/repository/crmOutbox.js` ＋ `v3/src/crmOutboxAsync.js`（`claimCrmOutboxBatch` 是 `UPDATE … RETURNING`，PG 端用 `rowCount`）。
2. `crmDelivery.js` 的控制讀寫（`isLocalCrmSyncStopped`／`setLocalCrmSyncStopped`／`crmDeliveryControl`）改走 async；`deliverCrmOutboxOnce`／`startCrmDeliveryLoop` 改 await。
3. `db.js` 的 `opsDeliveryDb()` 在 PG 模式下要回能用 async 的 façade（不要把 PG 連線硬塞進同步 API）。
4. 測試：`v3/test/crm-outbox-parity.test.js` ＋ live。

## 移植前的檢查清單（SQLite-only 寫法）

```bash
cd /workspace/repos/5151
grep -nE "INSERT OR |last_insert_rowid|datetime\(|julianday|SELECT changes\(\)|res\.changes|\|\|" \
  v3/src/crm.js v3/src/crmOutbox.js v3/src/crmDelivery.js
```

- `INSERT OR IGNORE` → `ON CONFLICT(...) DO NOTHING`；`INSERT OR REPLACE` → `ON CONFLICT(...) DO UPDATE`。
- `last_insert_rowid()` → PG 用 `INSERT … RETURNING id`。
- `res.changes` → PG 的 `rowCount`（`dbDriverPostgres.js` 已回傳）。
- `? IS NOT NULL` → 要 `CAST(? AS …)`；`CASE WHEN ?` → 要 `CASE WHEN ? = 1`（③④ 踩過）。
- 布林欄位：SQLite 綁 0/1，PG 要 boolean（比照 ② 的作法）。

## 驗證配方

```bash
# 憑證（2026-09-23 起集中在共用庫，勿把值寫進任何檔案）
set -a; . /home/cline/.secrets/postgres/5151-agent-pg.env; set +a   # 內含 PG_TEST_URL / PG_TEST_STANDBY_URL
node --test v3/test/crm-parity.test.js                            # 離線：0 fail
PG_TEST_URL="$PG_TEST_URL" node --test v3/test/crm-parity.test.js  # live：0 skip
node --test v3/test/crm*.test.js                                  # 既有 CRM 測試不得回歸
```

## 完成定義（DoD）

- 離線 parity 全綠、live parity **0 skip**、`npm test` 無新增失敗、CI 三項綠。
- PR 說明寫明：資料本體改寫 PG；**尚未移植的部分**（若 2.2b 未合併）與其影響。
- 正式站行為不變（CRM 模組預設關閉與否以現況為準）。

