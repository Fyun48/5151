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

#### ✗✓ 更正上面的「缺口」判斷（我下得太快 ✗）
- 讀 `v3/test/listing-enrich-parity.test.js:302` 本文後發現：**該測試自己的註解已說明為何必須用 `PG_SHADOW_URL`** ✓：
  ```
  // 這個測試本質上需要「影子站」（＝正式站資料的匯入）：它斷言 PG 分支挑得到候選 ✗，
  // 而 CI 的拋棄式 PG 是空的 ⇒ 不能用 PG_TEST_URL 假裝有影子站 ✗。
  // 依 astra §3.4「必要測試不得 skip」：此測試不是 PR-B 的必要 gate，故以專屬 PG_SHADOW_URL 明確 gate
  ```
- ⇒ 若硬把它改成 `PG_TEST_URL` ✗ ⇒ **會直接失敗** ✗（空 PG ⇒ seed 0 筆 ⇒ `assert.ok(seeded > 0)` 掛 ✓）。
- ⇒ 裁決要的是**同契約的 CI fixture 版** ✓（不是放寬現有那支 ✗）。設計（下一批機械執行 ✓）：
  1. 以 `PG_TEST_URL` 為 gate ✓；測試**自己在 PG 建 fixture 候選**
     （insert 一筆 `source='houseprice'`、`offline=0`、無 `listing_prep` 列 ✓ ⇒ 符合 seed 的候選條件 ✓）
     ⇒ 這樣就**不需要影子站** ✓，也**不假裝** PG 有正式資料 ✓。
  2. 斷言 **`seedHousepriceEnrichJobsAsync(..., { driver: "postgres" })` > 0** ✓（挑到剛建的候選 ✓）
  3. 斷言**本機 SQLite 的 `listing_enrich_jobs` 仍為 0** ✓（PG 模式不得寫本機 SQLite ✓）
  4. 測試結束**自行清理**（刪掉自己建的候選與工作列 ✓）
  5. 放在 `listing-enrich-parity.test.js` 內 ✓（**沿用該檔既有 import 與 fixture 輔助** ✓，
     避免猜測模組路徑 ✗）

### 3d. seed 契約 fixture 版**已在 CI 執行並通過** ✓✓（`45ff485`，run `36133652882` ✓）

| Job | tests | pass | fail | skipped |
|---|---:|---:|---:|---:|
| Run Tests（一般） | completed success ✓ | — | **0** ✓ | — |
| **Run Tests (PostgreSQL integration)** | **115** ✓（前一版 114 ＋ 1 ＝ 新測試 ✓） | **114** ✓ | **0** ✓ | **1** ✓ |

- ⇒ 新測試 `live：種子查詢在 PG（CI fixture 自建候選）挑得到，且不寫本機 SQLite` ✓
  **確實被執行且通過** ✓（log 出現該名稱 ✓；PG job 的 **skip 數未增加** ✓＝**沒有**被 skip ✓✓）
  ⇒ 符合裁決「必要 PG 功能測試不得 skip」✓ ⇒ **裁決 §3 的 seed 契約缺口以 CI 證據關閉** ✓✓
- 仍為 1 的 skip ✓ 就是 `PG_SHADOW_URL` 那支 ✓（其自身註解已說明定位且非 PR-B 必要 gate ✓，
  依裁決「需要正式鏡像資料的規模探針可以另列」✓）

### 3e. queue claim 偶發：唯讀根因分析（**修法待實作** ✓）
`v3/test/job-queue-parity.test.js:72` ✓ —— 測試以 `priority: 10_000` 排入後 `claim({ limit: 5 })` ✓，
再斷言「剛排進去的要搶到」✓。三個可解釋偶發的機制 ✓（正是裁決要查的隔離／清理時序／並行 ✓）：

| # | 機制 | 為什麼偶發 |
|---|---|---|
| 1 | **並行搶同一張表** ✗ | CI 以 `node --test` **多檔並行** ✓ ⇒ 另一個 PG 測試檔在同一張 `job_queue` 上 `claim` ✓ 把我們那筆搶走 ✓ ⇒ 前 5 筆裡沒有它 ✗（**最可能** ✓） |
| 2 | **殘留 ＋ `LIMIT 5`** ✗ | 測試自己註解已言「影子站還留著先前工作列」✓；`priority` 只保證**同優先權內**依 `created_at ASC` ✓ ⇒ 先前同為 10,000 的殘留排在前面 ✓；殘留 ≥5 筆（前次未清理 ✓）⇒ 被擠出前 5 ✗ |
| 3 | **時間戳競態** ✗ | `const now = Date.now()` 同時給 enqueue 與 claim ✓；若 enqueue 內部另取時間使 `run_at/available_at` 略大於 `now` ✓ ⇒ claim 看不到 ✗ |

**修法方向** ✓（**不是**「重跑後綠」✗）：
1. 斷言改為**針對自己那筆** ✓（以 `idempotency_key` 直接查／或確保它一定被回傳 ✓）
2. 測試前後**清掉自己前綴**的殘留（`WHERE idempotency_key LIKE 'live-job-%'` ✓）
3. **避免與其他檔競爭同一張表** ✓（專屬 schema／表前綴 ✓，或讓此檔序列執行 ✓）
4. **保留** `attempts`／`state`／`lease_owner` 等契約斷言 ✓（不為穩定性拿掉契約 ✗）

### 3f. lint 狀態：**本 repo 未配置 lint ⇒ 不適用（不是「沒跑」）** ✓✓
依裁決要求「只回報實際執行的 lint／test；沒有跑 lint 就標 `NOT_RUN`」✓，本次以**實證**釐清 ✓：

| 檢查 | 結果 |
|---|---|
| eslint／biome／prettier／standard 設定檔（含 `.eslintrc*`、`eslint.config.*`） | **不存在** ✗ |
| `package.json` 或 `.github/workflows/*.yml` 提及 `eslint` | **0 筆** ✗ |
| `package.json` 的頂層鍵 | `name, version, private, type, description, scripts, engines, dependencies` ⇒ **連 `devDependencies` 都沒有** ✗ |
| `scripts` | `start, start:v3, start:ops, dev, dev:v3, dev:ops, test, test:pg, pack:kit` ⇒ **無 `lint`** ✗ |
| dependencies | `express, pg, sharp, web-push`（僅執行期 ✓） |
| CI（`test.yml`）步驟 | `Install dependencies` → `Run Test Suite` ⇒ **無 lint 步驟** ✗（Node 22 ✓，與本地 v22.23.2 一致 ✓） |

⇒ **結論** ✓：本 repo **沒有可執行的 lint**（無設定／無依賴／無 script／CI 亦無 ✓）
⇒ 因此正確標記是 **`lint: N/A（repo 未配置）`** ✓ —— 比 `NOT_RUN` 更精確 ✓，且**不**以 Tests 綠燈冒充 lint 通過 ✓。
⇒ **不自行安裝 eslint** ✗：沒有 repo 設定可比對 ⇒ 跑出來的結果**無意義** ✗（會變成拿任意規則評別人的碼 ✓）。
⇒ 證據可一行重現 ✓：`grep -rn eslint package.json .github/workflows/*.yml; ls -a | grep -i eslint` ⇒ 皆無輸出 ✓。

### 3g. 環境對齊（供下一批 lint／A/B 使用 ✓）
- 本地 Node **v22.23.2** ✓、npm 10.9.8 ✓；`engines.node: ">=22"` ✓；CI 用 Node **22** ✓ ⇒ **一致** ✓
- `package-lock.json` **存在** ✓（60 KB ✓）⇒ 若日後新增 lint 工具，可用 `npm ci` 鎖定版本 ✓

### 3h. CI 全綠（`4878902`，run `36134589639` ✓）＋ 一個操作陷阱 ✓

| Job | tests | pass | **fail** | skipped |
|---|---:|---:|---:|---:|
| Run Tests | 2611 | 2585 | **0** ✓ | 26 |
| Run Tests (PostgreSQL integration) | 115 | 114 | **0** ✓ | 1 |

- 一般 job 的 skip 由 25 → **26** ✓：**＋1 就是本 PR 新增的 PG-gated seed fixture 測試** ✓（該 job 無 PG ⇒ 正確跳過 ✓）
- PG job 仍為 **1 skip** ✓ ⇒ 新測試在該 job **確實執行** ✓✓ ⇒ **裁決 §3 的 seed 契約缺口以 CI 證據關閉** ✓✓
- ✗ **操作陷阱（已實測）**：`gh run view --job <id> --log` 在**整條 run 尚未完成**時會回
  `logs will be available when it is complete` 並輸出**空檔** ✗ ⇒ **日誌是以整條 run 為閘，不是以 job 為閘** ✓
  （先前數次「抓不到日誌」的真正原因 ✓，不必再猜 ✓）
- ✗ **推送節奏陷阱（已犯 2 次）**：在 run 尚未完成時推送**任何** commit（**含純文件** ✗）都會
  **取消該 run** ✓ ⇒ 規則：**要等目前 run 結束再批次推送** ✓（本檔即為此而合併推送 ✓）

### 3i. 已加入 CI 的 A/B 診斷步驟（§5A／§6.3 ✓）
`.github/workflows/test.yml` 於 `Run PostgreSQL integration tests` **之後**新增
`Columns A/B (diagnostic, non-gating)` ✓：
- 同一顆已灌好 schema ＋ 可重現列的**拋棄式 PG** ✓（不需另行建環境 ✓）
- `DATA_DIR="$(mktemp -d)"` ✓（§6.3：不可繼承正式 `/data` ✓）
- repo 內路徑 ⇒ `import "../src/db.js"` 正確解析 ✓（**不會**再讀到舊部署映像 ✗）
- `continue-on-error: true` ✓ ⇒ **診斷不當 gate** ✓（不影響通過條件 ✓），數字作為 PR 證據 ✓

### 3j. A/B 診斷首次執行：**我的腳本 SQL 組裝錯誤** ✗（非產品問題 ✓）
`51a8e4a` 的 CI ✓：兩 job 仍**全綠** ✓（PG `115/114/0/1` ✓、一般 `2611/2585/0/26` ✓）；
`COLAB-WHERE` 有印出 ✓ 但 **`COLAB-SUMMARY` 缺席** ✗ ⇒ 步驟在印出 WHERE 之後失敗 ✓（`continue-on-error` ✓ 故 job 不受影響 ✓）。

**錯誤（精確）** ✓：
```
error: recursive reference to query "district_related" must not appear within its non-recursive term
code: '42P19'   position: 3462
at async measure (v3/scripts/pg-columns-ab.mjs:69)
```
- **根因** ✗：`built.where` 內含 **`WITH RECURSIVE` 的 district closure** ✓，而我把語句拼成
  `SELECT ${columns} FROM listings ${where} ORDER BY post_id` ✗ ⇒ `WITH` 子句被塞到 `FROM` 之後 ✗
  ⇒ 語法結構錯誤 ⇒ PG 回 42P19 ✓。
- **明確界線** ✓：這是**診斷腳本**的錯 ✗，**不是產品路徑的錯** ✓ —— 同一顆 PG 上
  `115/114/0 fail` ✓ 全過 ✓ ⇒ 應用自身的查詢沒問題 ✓。
- **修法（下一批機械執行 ✓）**：**不要自行包 `SELECT … FROM listings ${where}`** ✗。
  正確做法是把 builder 產生的**完整語句**（含其 `WITH RECURSIVE` 前綴 ✓）整段交給
  `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)` ✓ —— 即先取得完整 statement（或其
  SELECT 清單注入點 ✓），或改用**正式路徑**跑查詢、再對**同一段語句**取 EXPLAIN ✓；
  亦可參考既有 `pg-explain-forensics.mjs` 的合法組裝方式 ✓（它先前產出過有效計畫 ✓）。

#### ✗✓ 再更正（更精確的根因 ✓）：不是「拼字串」而已，是我**用錯 clause builder**
- 既有證據 ✓：`db.js:6670` 的註解自己寫著
  > `// SQLite 路徑維持 appendDistrictCandidates（含原本的 recursive CTE）。`
  ⇒ **PG 路徑並不用那個 recursive CTE** ✓（PG 有自己的一條 ✓）。
- 而我的 A/B 腳本直接呼叫 `buildListListingsClauses(...)` ＋ 自行拼
  `SELECT … FROM listings ${where}` ✗ ⇒ 拿到的是**SQLite 風味**（含 `WITH RECURSIVE district_related` ✓）
  ✗ ⇒ PG 以 **42P19** 拒絕 ✓（錯誤訊息裡的 `district_related` 正是來源 ✓）。
- ⇒ **正確修法** ✓：A/B 必須用**PG 路徑自己用的那條 clause builder／組裝方式** ✓
  （即 `searchListingsNodePg` 用的那一套 ✓），並沿用其參數傳遞（含陣列參數 ✓）；
  **不要**自行以 SQLite 路徑的 builder ＋ 手拼 `SELECT … FROM listings ${where}` ✗。
- ⇒ 這也再次印證 ✓：**診斷腳本若繞過正式路徑，就會驗到不存在的問題** ✗
  （與 §2.2「canary 注入 deps 繞過正式入口」是同一類錯誤 ✗）⇒ 修法一律**沿正式路徑** ✓。

#### ✗✓ 第三次收斂（連我上一批的建議也不夠準 ✓）
- 事實 ✓：`listingSearchNodePg.js:216` 用的**就是** `SELECT ${candidateColumns} FROM listings ${built.where} ORDER BY post_id` ✓
  —— **與我 A/B 的組裝一模一樣** ✓ ⇒ 所以問題**不在**「手拼字串」 ✗，而在 **`built.where` 是怎麼產生的** ✓。
- 真正的差異 ✓：我傳 `districts: ["西屯區"]` ✗ ⇒ builder 走 **SQLite 的 recursive CTE** ✗ ⇒ 42P19 ✓；
  **PG 路徑用的是 `districtClosureIds`** ✓（**CI 證據**：skip 清單中即有一支
  「PG 整合：`districtClosureIds` 走 PG（不得拋錯；不需行政區條件時可為 null）」✓✓）。
- ⇒ **修法（下一批機械執行 ✓）**：A/B 要以 **PG 的方式**取得行政區條件 ✓
  （`districtClosureIds` ✓／或 PG 專屬的 clause 產生路徑 ✓），**不要**用 `districts:` 觸發 SQLite CTE ✗；
  其餘組裝（`SELECT … FROM listings ${where} ORDER BY post_id` ✓）**照抄 `searchListingsNodePg`** ✓ 即可。
- ⇒ 方法論 ✓：這一題連續三層修正（拼字串 ✗ → 用錯 builder ✗ → **傳錯參數觸發 SQLite 路徑** ✓）
  全部由**讀既有程式與 CI 訊息**得出 ✓ —— 再次說明「先讀再改、沿正式路徑」是唯一有效率的做法 ✓。

### 3k. A/B 第二次執行：**機制修好了 ✓ 但資料集退化（0 列）** ✗（不得當證據 ✓）
`aec1bd2` 的 CI ✓（run `36135802665`，Tests `completed success` ✓）——A/B 步驟**這次有產出** ✓：
```
COLAB-WHERE  { … "params": 10 }
COLAB-SUMMARY {"label":"43cols","runs":5,"wallMsMedian":1.04,"wallMsMin":1.01,"wallMsMax":5.01,
               "rows":0,"payloadKB":0,"rootBuffers":{hit:0,read:0,dirtied:0,tempRead:0,tempWritten:0}, hot:[Sort…]}
COLAB-SUMMARY {"label":"23cols","runs":5,"wallMsMedian":0.91,"wallMsMin":0.86,"wallMsMax":0.96, …同上…}
```
- ✓ **已修好的部分**：不再有 42P19 ✓（走 PG 的 `districtClosureIds` ✓）；緩衝區**只取根節點** ✓；
  A/B 交替 ＋ 暖機 ✓；端到端 wall／rows／payload 都有量 ✓；`Sort` 為熱點＝查詢確實執行過 ✓
- ✗ **退化點**：**`rows: 0`** ⇒ 查詢**沒撈到任何資料** ⇒ `wallMsMedian 1.04 vs 0.91`
  （≈1 ms、`rootBuffers` 全 0 ✓）**不具任何意義** ✗ —— **我明確不把這個差異當成 43→23 的收益** ✗
- 可能原因 ✓：`WHERE` 含 `search_key IN (?…)`（10 個參數 ✓），而 CI 的拋棄式 PG 內是
  `pg-integration-setup` 鏡射的**少量可重現列** ✓ ⇒ 這些列的 `search_key` 與我算出的鍵**對不上** ⇒ 0 列 ✓
- ⇒ **修法（下一批機械執行 ✓）**：讓 A/B 的量測查詢**一定能撈到資料** ✓ ——
  ① 以 **PG 自身**取得鍵集（`SELECT DISTINCT search_key FROM listings` ✓）再帶入 ✓；
  ② 或改用**不依賴鍵集**的候選查詢（例如只以 `offline` 等固定條件 ✓）當 A/B 的受測語句 ✓；
  ③ 並**斷言 `rows > 0`** ✗ 否則直接標記「量測無效」✓（避免再次產出退化數字 ✓）。
- ⇒ 記取教訓 ✓：**量測必須先驗證「受測查詢真的有回資料」** ✗，否則報告出來的百分比只是雜訊 ✓
  （這是我第 3 次量測設計錯誤 ✓ —— 前兩次：快取量單次 ✗、參數名錯導致 19／13 ✗）。

### 3l. §6.4 parity 現況盤點（唯讀 ✓）與唯一缺口
**既有** `PG_TEST_URL`-gated parity 檔 ✓（PG job 自動收斂 ✓）：
`budget`／`crawler-reads`／`crm`／`decoration-data`／`job-queue`／`listing-detail`／`listing-enrich`／
`listing-fields`／`listing-similarity-admin`／`listing-state-writes`／`listing-stats-parity`
＋ 本 PR 新增的 `listing-search-entry-live-pg` ✓
- ✓ 「**PG 熱路徑不得碰 SQLite**」**已有覆蓋** ✓：`v3/test/listing-search-no-sqlite-io.test.js` ✓ ⇒ 直接沿用 ✓
- ✗ **唯一缺口**：**列表搜尋的「同 fixture 雙向（SQLite vs PG）」parity** ✗
  —— 既有 parity 是 stats／detail／enrich／job-queue 等 ✓，**沒有 list search** ✗
- ⇒ **待補（下一批 ✓）**：
  1. 同 `args`／`settings`／`asOf` 下，以**同一 fixture**比對 SQLite 與 PG 的
     **集合／`totalMatched`／順序／same-house 角色／個人狀態／分頁** ✓
  2. **fail-closed** ✓：缺 provider／缺必要 PG 資料時必須**失敗**而非回空 ✓
  3. 風格照既有 parity 檔 ✓（`PG_TEST_URL` gate ⇒ PG job 收斂 ✓、一般 job 正確 skip ✓）

### 3m. A/B 第三次執行：**精確根因＝CI 的 PG 裡 `listings` 沒有資料** ✓✓（無效訊號忠實生效 ✓）
`ba5ff62` 的 run（`36136500921`，Tests `completed success` ✓）：
```
COLAB-KEYS {"count":0}                                   ✗ PG 沒有任何可用 search_key
COLAB-INVALID {"label":"43cols","rows":0, note:"…量測無效…"}   ✓ 新加的無效訊號正確觸發 ✓
COLAB-INVALID {"label":"23cols","rows":0, …}             ✓
COLAB-SUMMARY 43cols: rows 0, wallMsMedian 0.94, rootBuffers 全 0   ← 沒有被誤讀成收益 ✓
```
- ⇒ **根因** ✓：CI 的拋棄式 PG 內 `listings` **沒有資料** ✗（`count: 0` ✓）
  ⇒ 這**同時解釋**了前一版的 `rows 0` ✓，以及**為什麼我的 seed fixture 測試必須自己 `INSERT` 一筆候選** ✓
  （CI 的 PG 是空的 ✓；只有影子站才有正式站資料 ✓）。
- ⇒ **修法（下一批機械執行 ✓）**：A/B 必須**自建 fixture**（照 seed 測試那樣自行 `INSERT` ✓），
  例如數百～數千列、**欄位寬度有變化** ✓，再量 43 vs 23 ✓；並沿用 `COLAB-INVALID` 守門 ✓。
- ⇒ **設計驗證** ✓：`COLAB-INVALID` ＋ `process.exitCode=1`（步驟 `continue-on-error` ⇒ job 仍綠 ✓）
  成功阻止了「0.94 ms 被當成 43→23 收益」✗✓ —— 這個訊號是本 PR 值得保留的資產 ✓。
- ⇒ 教訓補充 ✓：**A/B 的「受測資料前提」必須先驗證** ✗（`COLAB-KEYS count 0` 就是那個前提 ✓）。

### 3n. ✅ A/B 終於量到**有效數字**（`1bdb1ea`，run `36138645348` ✓）——並推翻我先前的解讀 ✗✓
```
一般 job ： 2612 / 2585 / 0 fail / 27 skip ✓      PG job ： 116 / 114 / 0 fail / 2 skip ✓（恢復全綠 ✓）
COLAB-FIXTURE {"requested":500,"present":500} ✓     COLAB-KEYS {"count":20} ✓（rows 20 > 0 ⇒ 有效 ✓）
43cols： median 2.85 ms（2.78–3.03），rows 20，payload 16 KB，rootBuffers {hit:2103, read:0}
23cols： median 2.70 ms（2.63–2.86），rows 20，payload  8 KB，rootBuffers {hit:2103, read:0}
```
| 指標 | 43 → 23 | 判讀 ✓ |
|---|---|---|
| **payload** | **16 KB → 8 KB（−50%）** ✓ | **明確且可重現的收益** ✓（欄位減半 ⇒ 傳輸／反序列化／配置減半 ✓） |
| **wall（median）** | 2.85 → 2.70 ms（−5%） | **不算結論** ✗：兩區間幾乎重疊（2.78–3.03 vs 2.63–2.86 ✓）、n=5 ✓ ⇒ 只能說「不變差」 ✓ |
| **rootBuffers.hit** | **2103 → 2103（不變）** ✗✓ | **關鍵發現** ✓：縮欄位**沒有**降低 heap buffer 存取 ✓ —— 正是裁決 §5A 預告的「不保證 heap buffers 必降」✓✓ |
- ⇒ **推翻我先前解讀** ✗✓：我一度把「33,541 buffers」當成候選欄位寬度的成本 ✗，實測顯示**該數字來自種子／`DISTINCT` 那條查詢的掃描** ✓，與欄位寬度**無關** ✓。
  （這是本題第 **4** 次收斂 ✓：拼字串 ✗ → 用錯 builder ✗ → 傳錯參數 ✗ → **fixture 前提** ✓ → **buffer 歸因** ✓）
- ⚠️ **必須標註的範圍限制** ✗：以上是 **CI 假資料規模**（自建 500 列、命中 20 列 ✓）⇒ **不是 NAS 成績** ✗，
  不可當成正式站數字 ✓（裁決 §4：純 CI 數字不冒充 NAS 成績 ✓）。
- ⇒ **§6.5 取捨的依據** ✓：窄欄位的**確定收益＝payload 減半** ✓；若要把窄欄位留在正式路徑 ✓，
  仍必須先有**完整 parity**（集合／`totalMatched`／順序／角色／卡片狀態完全相同 ✓）⇒ 這是 §6.4 的工作 ✓。

### 3o. parity 實作前的 API 確認（唯讀 ✓）——並發現**範圍比原估大** ✗
1. **`buildListRequestContextFromPg()` 回傳**（`db.js:4146` ✓）：
   `{ crawlSources, isolation, searchKeys, degraded, asOf }` ✓
   - ⇒ `searchKeys` ＝ **展開後的 stored keys** ✓✓ ⇒ **可直接當兩邊 fixture 的 `search_key`** ✓（不必猜 URL 格式 ✓）
   - ⇒ **B4 的 `asOf` 已存在** ✓（`new Date().toISOString()` ✓，註解自述「整個請求共用同一個時間戳」✓）
     ⇒ B4 待辦是**把它真正串到相對時間／primary 比較／排序** ✗（**不是**新增欄位 ✓）
2. **`currentSearchKeys()`**（`db.js:4046` ✓）回傳的是 **URL 清單** ✗（user ＋ global ＋ `crawl_covers` ✓、trim／dedupe ✓），**不是 key** ✗
3. ✗ **新發現（影響實作範圍）**：SQLite 的鍵集來自**它自己 DB 的 `settings`／`user_settings`**
   ✗（**不是** `args.settings` ✗）⇒ 要兩引擎集合相等 ✓ ⇒ **必須兩邊都種相同的 settings 來源** ✓
   （PG 側的 settings 來自 `pg-integration-setup` 的鏡射列 ✓；SQLite 側來本機 fixture ✓）
   ⇒ **parity 測試的實作要點** ✓：兩邊各補種相同的 `settings`／`user_settings`（含同一組 `searchUrls` ✓），
     或以**不依賴 settings 的 args** 建立可達集合 ✓ —— 明示為開放項 ✗，不可略過 ✓。












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

