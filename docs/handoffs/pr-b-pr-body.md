# PR-B：投影／交易一致性與 F3 查詢能力下推

依 ChatGPT 指令文件（`docs/handoffs/5151_SQLite_Exit_PG_HA_DeepSeek_20260924.md`）的 PR-B 範圍實作。
目標：讓 PostgreSQL 熱路徑的「列／投影／修訂」一致，並把查詢能力逐項下推到 SQL，最後才移除回退。

## 一、本次包含的變更

### 1. 寫入一致性（交易化 + SAVEPOINT）

- `persistListing` PG 路徑改為**單一 `withTransaction`**：upsert／backfill → 讀 canonical row → 投影 → 修訂，
  途中失敗不會留下半套狀態。
- change-log 以 **SAVEPOINT** 隔離：失敗的 PG 語句會毒化整個交易，沒有 SAVEPOINT 時 `COMMIT` 會變成
  `ROLLBACK`（＝靜默資料遺失）。這是本次修掉的最關鍵語意問題。
- 新增測試 `test/persist-listing-transaction.test.js`、`test/change-log-identity.test.js`、
  `test/covering-bookkeeping.test.js`；`coveringBookkeepingAsync.js` 抽出成獨立模組。

### 2. 投影完整性（PG）— 已完成並驗證

- 問題：PG 轉換時只帶了 3 萬多列投影，舊列沒有重建 → 實查**缺 86,522 列**（其中 85,002 未隱藏且未下架＝本應可見）。
- 處置：以 PG 為主列來源的回填工具 `v3/scripts/projection-backfill.mjs`（可中斷、可重跑、只 INSERT/UPDATE 投影）。
- 結果：`finished=true, done=86522, failed=0, sec=2873, missingAfter=0`。
- 獨立唯讀複驗（另一個程式路徑，`REPEATABLE READ READ ONLY`，只有 SELECT）：
  `missing=0 missing_visible=0 orphan=0 dup=0 nulls=0 listings=119669 projection=119669 ok=1`。
- 常駐監控：`5151-projection-monitor.timer`（systemd，每 15 分鐘、唯讀），已有多次無人介入的成功紀錄。
- 完整證據：`docs/handoffs/pr-b-backfill-completion-20260924.md`。

### 3. F3 查詢能力下推（逐項、附等價性證據）

| 項目 | 狀態 | 語意依據／證據 |
|---|---|---|
| `sources` | ✅ 下推 | 授權已在上游 `server.js:3759` `authorizedListingSources()` 完成，SQL 只做集合比對，不繞過權限 |
| `areaMax` | ✅ 下推 | `floors.js:412-415`：area 為 NULL **不排除** → `(p.area IS NULL OR p.area <= ?)` |
| `kind` | ✅ 下推 | 新增投影欄位 `kind_keys`（由**同一支** `listingKindKeys()`／`listingMatchesKindKey()` 產生）；SQL 述詞逐行鏡射 `floors.js:matchesHousingKind` |
| `wholeFloorOnly` | ✅ 下推 | `db.js:6480/7183`：Node 以 `skipWholeFloor: Boolean(kind)` 呼叫 → **kind 有值時跳過整層過濾**（已在 SQL 用完全相同判斷） |
| `q` | ⏸ 暫緩（有明確阻塞原因）| `db.js:6446-6456` 是 4 個 `LIKE`，看似可直接下推；但**實測** `LIKE` 的大小寫語意兩邊不同 —— SQLite `'ABC' LIKE 'abc'` → `1`（真）、PG → `false` ⇒ 直接下推會讓 ASCII 查詢（例如 `q=Park`）在兩個 driver 得到不同結果。解法（建議）：改用可攜的 `lower(x) LIKE lower(?)`（CJK 兩邊一致，已實測），再以 Node↔PG parity 框架驗證後才啟用 |
| `filter ≠ all` | ⏳ 待做 | `watched` 走另一條管線；`suspected`/`offline` 用 `passesPriceFilter` 而非 `applyListingFilter`；另有 `listingMatchesListFilter`/`keepSelfListingForViewer` 後處理 |
| `sort=fit_desc`、`priceMin`、`minBuildingFloors` | ⏳ 待做 | 屬**評分**語意（`listingScore.js`），不是單表過濾 |
| `excludeKeywords`／`excludeAgents`／`excludeAgentIds`／`excludeBoxes`／`commuteKm` | ⏳ 待做 | 需文字／代理／幾何欄位，或為 per-user（投影的 `commute_km` 是單一使用者） |

`kind` 的三重等價性證據（這是我認為可以上 SQL 的唯一理由）：

1. **述詞探針**（真實資料）：`v3/scripts/kind-parity-probe.mjs`，14 種查詢 × 2,000 列 → `mismatch=0`。
   過程中也因此抓到並修掉一個會**靜默漏列**的設計缺陷：手寫 key 全集漏了 `apartment_huaxia`
   （`kindsToQuery("apartment")` 會推入它），當時 `kind=apartment` 有 1,959/2,000 列不一致。
2. **單元測試**：SQL 述詞結構（含 `suite,yafang` 的 legacy 語意與 `wholeFloorOnly` 的 skip 規則）。
3. **生產資料驗證**：`v3/scripts/kind-column-verify.mjs`，PG 抽樣 5,000 列 → `kind_keys` 欄位與
   `listingKindKeys(同一列)` 重算 **5,000/5,000 完全相同**。

### 4. F2（可用性半）：PG 失效 → 503 + 穩定錯誤碼

- `listingSearchAsync.js`：新增 `SEARCH_UNAVAILABLE_CODE`／`ListingSearchUnavailableError`；
  `catch` 不再回退 SQLite（回退會讓清單與 PG 真相無聲分裂，也讓故障看不見）。
- `server.js`：`/api/listings` 包 try/catch → **503** + `{ code }` + 可讀訊息（原本無 catch，會落到預設 500）。
- 測試用 `options.sqliteFallback` 是**唯一**逃生門，且沒有環境變數開關。
- 仍未完成：**查詢落在 SQL 外框外**時的回退仍在，需待 F3 補齊後移除。

## 二、⚠️ 上線前置條件（部署前必須滿足）

1. **`kind_keys` 回填完成**：`listing_search_projection.kind_keys = ''` 的列數必須為 **0**
   （合法的空集合存成 `","`，不會是空字串）。否則 `kind` 查詢會回**空清單**。
   - 工具：`v3/scripts/kind-keys-backfill.mjs`（只寫該欄位；可中斷可重跑；容器內以 `/tmp/kk` 跑新版程式碼，
     不動 `/app`）。
   - 進度（本文撰寫時）：約 4.3 萬 / 11.97 萬列、失敗 0。
2. **新欄位遷移必須先跑**：SQLite 端在 `ensureListingSearchProjection()`（`db.js:549` 啟動時呼叫）；
   PG 端在 `repository/listings.js` 的 `PG_PROJECTION_MIGRATIONS`（`ALTER TABLE IF EXISTS …`）。
   `pgSchema.js` **只做 CREATE、沒有 ALTER**，少了這步 PG upsert 會多送一個值而整批失敗。
3. 部署後建議先跑一次 `projection-check`（唯讀）確認 `ok=1`。

## 三、驗證方式（可重現）

```bash
# 相關測試（本次改動範圍）
node --test test/listing-search-sql-kind.test.js test/listing-search-sql-sources.test.js \
  test/listing-projection-kind-keys.test.js test/listing-search-unavailable.test.js \
  test/persist-listing-transaction.test.js test/change-log-identity.test.js test/covering-bookkeeping.test.js

# 投影完整性（唯讀）
git show ops/readonly-projection-monitor:v3/scripts/projection-check.mjs \
  | ssh root@casa-nas 'docker exec -i -e SUMMARY=1 591-tracker-v3 node --input-type=module'

# kind 等價性探針（唯讀，容器內）
ssh root@casa-nas 'docker exec -i 591-tracker-v3 sh -lc "cd /app && node --input-type=module"' < v3/scripts/kind-parity-probe.mjs

# kind_keys 生產資料抽樣驗證（唯讀，需 /tmp/kk 已複製最新 src）
cat v3/scripts/kind-column-verify.mjs | ssh root@casa-nas 'docker exec -i -e LIMIT=5000 591-tracker-v3 sh -lc "cd /tmp/kk && node --input-type=module"'
```

## 四、風險與回退

- 部署前：本分支對正式環境**沒有行為影響**（程式碼未部署；PG 只多了一個空欄位）。
- 部署後若 `kind_keys` 尚未回填完成：`kind` 查詢會回空清單 → **務必先完成前置條件 1**。
- 回退：直接 revert 本 PR 的 commit 即可（投影多出的欄位無害，可保留）。

## 六、測試狀態（誠實版）

### 全跑結果（本 PR 分支，實測）

```
# tests 1648   # pass 1626   # fail 2   # skipped 20
```

### 修掉一個會讓整套卡死的問題（不是本 PR 的功能變更，但影響每個審查者）

- 現象：兩次獨立全跑都**停在 253 個測試後零進度**（確定性阻塞，不是慢）。
- 根因：`v3/test/commute-route-live.test.js` 的 `runIsolated()` 用 `spawnSync` 跑子程序但**沒有 timeout**；
  子程序一卡住，`spawnSync` 就永久阻塞，父層 runner 無法中斷。
- 處置：加 `timeout: 30_000`（commit `3362945`）→ 全跑因此能完成（253 → 1648 個測試）。

### 兩個失敗的判定

| 失敗 | 判定 | 依據 |
|---|---|---|
| `cursor walks past the old 2000-row candidate cap`（`commute-route-live.test.js:141`）| **環境性、與本 PR 無關** | 同一個測試、同樣 100 秒上限：`origin/master` → `exit=124`（卡住、無結果）；本分支 → `exit=1`（快速失敗且可見）⇒ 本 PR 只是把「無聲卡死」變成「明確失敗」 |
| `guest SQL-first 只在一模一樣的等價範圍內接手，其餘回退 Node 路徑` | **本 PR 的預期影響**（我刻意把 `areaMax` 移出外框）| 用測試自身的量測確定範圍：`{q:null, kind:null, sources:null, fit:null, priceMax:null, areaMax:有值, commuteKm:null, watched:null}` ⇒ 訪客路徑**只有 areaMax** 改走 SQL；測試已改為斷言該行為，現為 6/6 通過 |

（過程中我兩次用推論代替量測而寫錯斷言，已改為「先讓測試自己輸出事實、再寫斷言」。）

### 已知尚未完成

- F3 剩餘項與 F2 的「外框外」回退（見第一節表格）。
- 端到端（正式 SQL 對 PG 真實資料）的 kind 計數比對：腳本已寫但在 PG 被回填佔用時
  count 查詢會撞 `statement_timeout`／連線被中止 ⇒ 排在 `kind_keys` 回填完成、PG 閒置時執行。
- **GATE-1～12 證據表**：已建立 `docs/handoffs/gate-1-12-evidence-20260924.md`（判定 PASS／PARTIAL／NOT_RUN／BLOCKED／**FAIL**，
  含可重現證據位置與缺口；其中 **GATE-12 判為 FAIL**：實跑顯示 20 個 PG 依賴測試因缺 PG 而 skip）。


- F3 剩餘項（`q`、`filter ≠ all`、`sort=fit_desc`、評分／per-user 類 settings）——將以 repo 既有的
  Node↔PG parity 框架（`withMirroredSchema` + `strict: true`）逐項驗證，不用手寫 SQL 推論。
- F2 的「外框外」回退移除。
- PG WAL 封存／PITR runbook。
- PR-C（排程／擁有權／AbortSignal）、PR-D（`listing_match_evaluations` → PG）、PR-E（網域／媒體／認證）、
  PR-F（PG 模式下不再有業務 SQLite）。
- GATE-1～12 證據表。
