# PR-B 執行狀態（可接續）

> 本檔為**可接續狀態**，依 astra 2026-09-25 裁決 §7 維護。不含任何連線憑證 ✓。

## 1. 目前位置

| 項目 | 值 |
|---|---|
| 分支 | `fix/pr-b-persist-listing-transaction` |
| 被審查的 HEAD（裁決核對） | `79da24939e40f3079fa05e0979284540f7312bc6` |
| 本批之後的 HEAD | 見 `git log -1`（本檔隨該 commit 一起提交 ✓） |
| base | 同分支 upstream ✓（未 merge、未部署 ✓） |
| 工作樹 | 乾淨（本批提交後 ✓） |

## 2. 本批已完成（§6 第 1 項：撤回有問題的改動）

| 改動 | 處置 | 依據 |
|---|---|---|
| 正式入口窄欄位覆寫（`listingSearchAsync.js`） | **撤回** ✓ 恢復寬候選欄位 | 裁決 §2.1：`first_seen_at` 缺失會改變 `newest` 排序（寬 `[2,1]` vs 窄 `[1,2]` ✗） |
| 23 欄窄清單常數 | **刪除** ✗（保留撤回理由註解 ✓） | 同上；審計測試保留為工具 ✓ |
| 跨請求 `pgSearchKeyMemo`（8 秒 TTL） | **撤回** ✓ 改回每次請求查詢 | 裁決 §2.3：模組全域快取無 database／schema／交易範圍 ⇒ 破壞 PG 單一快照 ✗ |
| 模組全域 `SAFE_TABLE_EXISTS` | **撤回** ✓ 改回請求內（每 factory 一份） | 裁決 §2.4：只以 table name 為 key ⇒ 跨 schema 污染（反例 `42P01` ✓） |

## 3. 本批新增測試

- `v3/test/listing-sort-newest-relative-time.test.js` ✓
  - 反例回歸 ✓：`refresh_time: "1小時前"` ＋ 不同 `first_seen_at` ⇒ `newest` 必須 `[2,1]` ✓（實測通過 ✓）
  - 護欄 ✓：寬候選欄位必須含 `first_seen_at`／`last_seen_at`／`source_id`／`url` ✓
    （後三者是 `preferPrimaryListing()` 的 tie-break ✓）
- `v3/test/listing-search-entry-columns.test.js` ✓（裁決 §2.2）
  - 從 **`searchListingsAsync()`** 進入、**只給 driver、不注入 `deps`** ✓ ⇒ 走正式預設 ✓
  - 逐欄比對**實際送出的候選 SELECT** 等於官方 `LIST_CANDIDATE_COLUMNS` ✓，
    並在**入口層**守住 `first_seen_at`／`last_seen_at`／`source_id`／`url` ✓（§2.1 回歸 ✓）
  - 為什麼必要 ✓：`pg-provider-canaries.test.js` 直接呼叫 `searchListingsNodePg()` 並自行帶 deps ✗
    ⇒ 繞過正式入口，**不能**證明正式路徑 ✓

### 3b. 本批 CI 狀態（等待中 ✓）
| SHA | Job | 狀態 |
|---|---|---|
| `32c02b7`（含全部撤回 ✓） | Tests | `in_progress` ✓ |
| `41a8ad9`（本批最終 ✓） | Tests | `pending` ✓ |
| 兩者 | Code review (advisory) | `success` ✓ |
| 更早的 `af7e80b`／`e2ff73e` 等 | Tests | `cancelled` ✓（被後續 push 取代 ✓，**非失敗** ✓） |
⇒ 依裁決 §7：**最終提交後等該 SHA 的 CI 完成再判定** ✓。

### 3c. CI 完整結果與 skip 對照（`14fb8c8`，run `36132718164` ✓）

| Job | tests | pass | fail | skipped |
|---|---:|---:|---:|---:|
| **Run Tests** | 2610 | **2585** | **0** ✓ | 25 |
| **Run Tests (PostgreSQL integration)** | 114 | **113** | **0** ✓ | 1 |

- ✓ 裁決 §3 的失敗**已修** ✓（request-context 的 `DISTINCT search_key` 期望；撤回全域 memo 即為修因 ✓）；兩 job **fail 0** ✓
- ✓ PG job 步驟含 **Initialize containers** ＋ **Export disposable test URLs** ✓ ⇒ CI 本來就用**拋棄式 PG** ✓（正是裁決 §6.3 要的隔離環境 ✓）
- **一般 job 的 25 skip** ✓：全部為 `PG_TEST_URL not set` 類（該 job 刻意無 PG ✓＝`run-pg-integration.sh` 的 driver 隔離 ✓），
  含本 PR 新增的 `live PG：正式入口（不注入 deps）…` ✓
- **PG job 的 1 skip** ✓：`live：種子查詢讀的是 PostgreSQL，不是本機 SQLite`
  `# SKIP PG_SHADOW_URL is not set（需要匯入正式站資料的影子站；不屬於 CI 必要 gate）` ✓
  —— 正是裁決 §3 指出的那項 ✓

#### ✗ 由此發現的缺口（裁決要求處理 ✓）
- 「seed 讀 PG」契約的**另一份同名測試**（一般 job `ok 1565` ✓）**同樣以 `PG_SHADOW_URL` 為 gate** ✗
  ⇒ **CI 的兩個 job 都不覆蓋**這個契約 ✗ ⇒ 依裁決「同功能的『seed 讀 PG』契約仍要有 CI fixture 覆蓋」✓
  ⇒ **須新增以 `PG_TEST_URL`（CI 既有拋棄式 PG ✓）為 gate 的 fixture 版** ✓ ⇒ 列為下一批第一項 ✓
- ⚠️ CI **沒有 lint 步驟** ✗（`Run Tests` 步驟只有 `Install dependencies` → `Run Test Suite` ✓）
  ⇒ lint 仍須我在**隔離目錄 ＋ lockfile** 自行跑 ✓；現況 **`NOT_RUN`** ✗（不得以 Tests 綠燈冒充 ✓）



## 4. 可重跑命令（本地）

```bash
cd /workspace/repos/5151
node --check v3/src/db.js && node --check v3/src/listingSearchAsync.js
node --test v3/test/listing-sort-newest-relative-time.test.js
node --test v3/test/listing-search-request-context-pg.test.js v3/test/listing-search-request-context.test.js
node --test v3/test/listing-search-query-count.test.js
node --test v3/test/list-sql-first-wiring.test.js v3/test/search-contract-regression.test.js v3/test/listing-score.test.js
```
- ⚠️ `list-query-regression.test.js` **很慢（約 125–142 秒 ✓）不是卡住** ✓ ⇒ 給足 timeout ✓。
- ⚠️ 本地**無 `node_modules`／eslint** ⇒ **lint 必須標 `NOT_RUN`** ✓，不得把 Tests 綠燈稱為 lint 通過 ✗；以 CI 為 lint 權威 ✓。

## 5. 未完成（依 §6 順序）

1. **§6.2 正確性與 CI**
   - 修同 SHA CI 全部失敗 ✓（本批已修 request-context 的 DISTINCT 期望失敗 ✓，待 CI 驗證 ✓）
   - 補**正式入口**（`searchListingsAsync()` → 預設 deps）的 **live PG fixture** 測試 ✓
     —— 現有 `pg-provider-canaries.test.js` 直接呼叫 `searchListingsNodePg()` 並注入寬欄位，
     因此**不能**證明正式入口行為 ✓（裁決 §2.2）
   - 修 `listing-search-query-count.test.js` 缺口 ✓：吃掉例外 ✗、第二次無有效 gate ✗、
     參數應為 `userId`／`matchVoteUserId` ✗、只有 1 列假資料 ✗、需 `client.query` 計數與交易控制 SQL 另列 ✓
2. **§6.3 診斷環境**：精確 SHA 的隔離 checkout／測試映像 ✓、`toPostgresSql()` ✓、
   district closure ✓、同 client 唯讀快照 ✓、**buffers 不得逐節點加總**（父含子 ✗）✓、
   真正回傳 rows 的端到端量測 ✓
3. **§6.4 parity**：同 fixture 雙向（集合／`totalMatched`／順序／same-house 角色／個人狀態／分頁 ✓）；
   PG 熱路徑 **SQLite 存取為零** ✓；缺 provider／必要 PG 資料時 **fail-closed** ✓
4. **§6.5 優化取捨**：只保留有實測收益者 ✓；優先前置說明（請求內去重／批次 preload ✓）；
   合併查詢**非必做** ✓
5. **§6.6 驗收**：暖機 5 次後量 **50 個完整請求** ✓；C1／C4、全區／單區、event-loop lag、
   RSS、錯誤數 ✓；更新 PR 本文與 gate 表 ✓
6. 既有工作：`sql_pg` 實驗 dispatcher 移到獨立診斷模組 ✓、清掉過時 SQLite fallback／SQL-first 註解 ✓

## 6. 已保留的工具（非正式路徑 ✓）

- `v3/test/listing-search-projection-read-audit.test.js` ✓
- `v3/test/listing-search-pipeline-read-audit.test.js` ✓（含護欄：整列展開只允許在 `fit_desc` ✓）
- `v3/test/listing-search-query-count.test.js` ✓（離線診斷；待依裁決修正 ✓）
- `v3/scripts/pg-stats-check.mjs` ✓／`pg-analyze-table.mjs` ✓／`pg-columns-ab.mjs` ✓（待修正：方言／closure／buffers ✓）
- `v3/scripts/pg-explain-forensics.mjs` ✓／`pg-stage-forensics.mjs` ✓

## 7. 已知陷阱（血淚教訓，勿重蹈）

1. **單次量測對快取結構性無效** ✗ ⇒ 快取類改動必須量「穩態」✓。
2. **本地套件慢 ≠ 卡住** ✗（`list-query-regression` 約 125 秒 ✓）。
3. **鏡像跑的是部署映像** ✗（舊於本分支 ✓，部署版缺新 exports ✓）⇒ 需精確 SHA 的隔離環境 ✓；
   `run-in-container.sh` 把腳本放 `/app/tmpkk` ⇒ `../src/db.js` 會解析到 **`/app/src/db.js`** ✗（舊碼 ✓）。
4. **`expandSearchKeysAgainst` 用 `sameSearch()` 正規化比對** ✓ ⇒ 任何 `= ANY(keys)` 改寫都不等價 ✗（會靜默少資料 ✗）。
5. **審計（動態讀取）≠ parity** ✗ ⇒ 只能輔助 ✓。

## 8. 本批更正我自己先前的紀錄錯誤（誠實簿記）

| 先前回報 | 問題 | 更正後 |
|---|---|---|
| 「離線基準 19 筆／請求」 | 用**錯誤參數名**（`uid`／`voteUid` ✗）呼叫 ⇒ **不是正式入口** ✗（裁決 §3 指出） | 正式參數名（`userId`／`matchVoteUserId` ✓）下為 **17 筆／請求** ✓ |
| 「穩態 19 → 13」 | 13 是**跨請求快取**（`SAFE_TABLE_EXISTS` 共享 ＋ `pgSearchKeyMemo`）的產物 ✗；兩者已依裁決 §2.3／§2.4 **撤回** ✗ | 現況 **run1 = run2 = 17** ✓（純每請求成本 ✓，不含跨請求節省 ✓） |
| `ab06f0e`「不是效能收益」→ 又改口「是收益」 | 兩次都是**量測設計問題** ✗（先量單次 ✗，後量到的是即將被撤回的全域快取 ✗） | 該改動**已撤回** ✗ ⇒ 不再主張任何收益 ✓ |

⇒ 依裁決 §5：**正式驗收數字一律以真 PG ＋ `client.query` 計數為準** ✓；
本檔的 **17** 只是**離線診斷基準**（1 列假資料、無配對／分頁／通勤／真 snapshot client ✓），
**不得**當成驗收數字 ✗。

