# PR-B：30 秒現象的取證結果 ＋ preload 分層（2026-09-25）

## 一、兩個唯讀探針（真實鏡像、專用連線）

### 探針 A：候選 SQL — `v3/scripts/pg-explain-forensics.mjs`
`BEGIN READ ONLY` ＋ `SET LOCAL statement_timeout='3s'`，擷取 `pg_backend_pid()`、
`current_setting('statement_timeout')`、`EXPLAIN (VERBOSE)`，並區分 **57014（statement_timeout）**
與 **57P01/ECONNRESET（連線中斷）**。

| ability | outcome | runMs | rows |
|---|---|---|---|
| baseline | ok | **860** | 6625 |
| q=電梯 | ok | **1040** | 967 |
| kind=whole | ok | 607 | 6625 |
| sources=591 | ok | 711 | 6625 |
| areaMax=30 | ok | 638 | 6625 |
| wholeFloorOnly=1 | ok | 404 | 6625 |

⇒ **候選 SQL 只要 0.4–1.0 秒** ⇒ F3 的 30 秒**不是**候選 SQL ✗。
⇒ 另外：`kind`／`areaMax`／`wholeFloorOnly` 回傳 6625（＝未在 WHERE 過濾）⇒ 這些屬**投影／Node 端**
的顯示篩選 ✓（與 astra6 §1 假設的「WHERE 條件缺索引」不同 ✗）。

### 探針 B：真實路徑分階段（含單一快照 ＋ preload 分層）— `v3/scripts/pg-stage-forensics.mjs`
直接呼叫 `searchListingsNodePg(args, { pgDriver: { query, pool }, deps })`（真實候選 SQL ＋ PG context
＋ preload ＋ 分頁 ＋ 裝飾）：

| ability | totalMs | candidates | totalMatched |
|---|---|---|---|
| baseline | **6,641** | 6625 | 4476 |
| q=電梯 | **3,064** | 967 | 637 |
| kind=whole | **4,159** | 6625 | 2509 |
| sources=591 | **5,072** | 6625 | 4476 |
| areaMax=30 | **4,434** | 6625 | 4476 |
| wholeFloorOnly=1 | **4,326** | 6625 | 4476 |

**F3 對照**：`kind` 30,021ms／`sources` 30,042ms／`areaMax` 30,054ms／`wholeFloorOnly` 30,066ms／
baseline 989ms／`q` 878ms（皆為 `Connection terminated unexpectedly` ✗）
⇒ 現在：**3.0–6.6 秒、全部 `outcome=ok`** ✓✓（**4.5×–10×**，30 秒現象消失 ✓）。

> 註 ✗：這是**冷啟**數字（每個 ability 皆為首次呼叫、快取空）。`listingSearchNodePgPerf.mjs`
> 以 `RUNS=5` 量 warm 值 ⇒ 待補 warm p95。

## 二、本輪實作：preload 分層（已證明、已測試）

**證明**：`peerRows()`／`groupMemberRows()` 的唯一消費者是 `loadSameHousePeers()`（db.js:2856），
而它只被 `db.js:3443`（在 `decorateListingLite` 內）呼叫 ⇒ **只在裝飾路徑** ⇒ 這批逐列 I/O
屬**頁面層**，對「全部候選」預先載入是純浪費 ✗。

**作法**：
- `preloadDecorationProviderAsync()` 新增 `{ loader, peers }`：
  `peers: false` 只載入候選階段必需（`personalFlagMap`／`personalIndex`／`splitPairSet`／
  `prep`／`extras`，涵蓋候選本身 ＋ `match_post_id` ＋ `personalIndex.peers`）。
- `listingSearchNodePg`：候選階段以 `peers: false`；**分頁後**再以 `rows: paged.page` 呼叫一次
  （沿用**同一 loader**，memo 吸收重疊 id），裝飾改用該 provider。
- 測試：`list-sql-first`／`public-sql-first-parity`／`listings-search-repository`／
  `node-pg-provider` 共 **15/15 通過**（fail 0）✓。

## 三、探針踩到的兩個坑（已修，留給後人）
1. **不可自己把 `?` 換成 `$n`** ✗：builder 會產生 PG JSONB 運算子（`?`／`?|`／`?&`）⇒ naive 取代
   會改壞 SQL ⇒ `42601 syntax error`。一律用 `src/sqlDialect.js` 的 `toPostgresSql()` ✓。
2. **必須先算 district closure 再傳 `districtIds`** ✗：否則會掉進 SQLite 專用的 recursive CTE 分支
   ⇒ `42P19 recursive reference`，量到的就不是真實 PG SQL。用 app 自己的
   `districtClosureIds(exec, { districtNames, userId })`（`listingSearchNodePg.js` 已匯出）✓。

## 四、✦ 請 astra 裁決（決策題，非實作問題）
1. **§1 索引／`kind_tokens`＋GIN 是否仍要做 ✗？** 證據顯示候選 SQL 只需 0.4–1.0 秒、
   真實路徑 3.0–6.6 秒 ⇒ 30 秒的病因**不在 SQL 層**（是連線／池層 ＋ 先前的 SQLite context ✗）。
   若 §1 的前提（WHERE 缺索引造成 30 秒）不成立，是否改為：**先量 warm p95 ＋ 逐階段拆解
   剩下的 3–6 秒**（preload ／ Node 投影／裝飾 ✓），再決定要不要動 schema／索引 ✗？
2. **§3 效能目標（p95 上限）**：可接受值是多少 ✗？（目前冷啟 3.0–6.6 秒；待補 warm 值 ✓）
3. **是否保留 `sql_pg`**：本 session 已把正式入口移除（`19d3821`）；若 astra 要保留作為
   debug 入口，需指定「僅測試可達」的形式 ✓。

## 六、✦✦ 重大發現：大候選集合時 `node_pg` 會以 `08P01` 打斷連線（＝ 30 秒現象的同類根因）

CI canary（`v3/test/pg-provider-canaries.test.js`，在容器內以真實 schema 執行）在**無行政區**
（`districts: []` ⇒ 候選＝全表 ~36k）時失敗：

```
not ok 2 - PG 整合：真實 PG 上跑完整路徑（node_pg）
error: 'bind message has 36300 parameter formats but 0 parameters'
code: '08P01'
  async loadListingPrepMap (src/repository/decorationData.js:173)
  async memo (…/decorationData.js:264)
  async Object.prepMap (…/decorationData.js:334)
  async preloadDecorationProviderAsync (src/db.js:3221)
  async searchListingsNodePgInner (src/listingSearchNodePg.js:213)
```

### 判讀
- PostgreSQL 的擴充查詢協定以 **int16** 表示參數個數／格式 ⇒ **每個 statement 最多 32,767 個參數** ✗。
  本例是 **36,300** 個佔位符 ⇒ 超過後 `pg` 送出格式陣列卻沒有對應參數 ⇒ `08P01` ⇒ **連線被打斷** ✗✗。
- 這是**既存缺陷** ✗（不是我這輪 preload 分層造成的）：`prepIds` 的大小由候選集合（＋match／peer id）
  決定，改動前後同量級 ✓；先前探針用 `districts: [西屯區]`（候選 6,625 ✓）所以沒踩到 ✓✓。
- ⇒ **F3 的「30 秒／`Connection terminated unexpectedly`」高度可能就是這個** ✓（大候選集合 ⇒ 逾協定上限
  ⇒ 連線被打斷；客戶端等到 timeout 才放棄 ⇒ 看起來像 30 秒 ✗）。
- 這也說明 astra6 §1 的「索引／`kind_tokens`＋GIN」**不是**這個現象的解 ✗。

### ✦ 更正（同一日、實測後）：§1 的索引工作**是必要的** —— 我上一段「不需要」的推論是錯的 ✗
修掉 `08P01`（見上）之後，**同一個 canary 全表案例**的錯誤變成：

```
error: 'canceling statement due to statement timeout'
code: '57014'
  async searchListingsNodePgInner (src/listingSearchNodePg.js:207)   ← 候選 SELECT
```

⇒ **真正的 30 秒 = 候選 SELECT 的 statement timeout（57014），而且只在「大候選集合」發生** ✓✓。
先前的探針之所以只量到 0.4–1.0 秒，是因為它傳了 `districts: [西屯區]`（候選 **6,625** ✓），
而 canary 是 `districts: []`（候選 **~36k** ✗）⇒ **不是同一個查詢** ✗✗。這是我上一段的推論錯誤 ✓，
在此更正：**astra6 §1（候選查詢的可索引性）確實必要** ✓；§3 的效能目標也必須以「全表候選」為最壞情況 ✓。

### 修正一：`08P01`（已完成 ✓）
`src/repository/decorationData.js` 新增成對 helper：

```js
// PG 的擴充協定以 int16 表示參數個數/格式 ⇒ 單一 statement 上限 32,767。
// IN ($1,$2,…) 傳上萬 id ⇒ 08P01（並打斷連線）。
function idFilter(column, ids, driver, offset = 0) {
  if (driver === "postgres") return { sql: `${column} = ANY(?::bigint[])`, params: [ids] };
  return { sql: `${column} IN (${inList(ids, driver, offset)})`, params: ids };
}
```
套用到 `loadGroupIds`／`loadPeerRows`／`loadListingPrepMap`／`loadListingExtras` ✓（SQLite 路徑完全不變 ✓）。
驗證：本地 15/15 通過 ✓；容器內 canary 的錯誤由 `08P01` 變為 `57014` ✓（＝上限問題已解 ✓）。

## 七、✦✦✦ 最終定論（受控探針，直接重現）

同一支探針（`pg-explain-forensics.mjs`，`SET LOCAL statement_timeout='3s'` 當閘門）加入
「**無行政區**」案例後：

| 案例 | `districtIds` | sqlChars | paramCount | outcome | runMs |
|---|---|---|---|---|---|
| baseline（西屯區） | 6874 | 1514 | 33 | ok ✓ | 500 |
| q=電梯 | 6874 | 1808 | 38 | ok ✓ | 489 |
| kind=whole | 6874 | 1514 | 33 | ok ✓ | 472 |
| sources=591 | 6874 | 1514 | 33 | ok ✓ | 535 |
| areaMax=30 | 6874 | 1514 | 33 | ok ✓ | 492 |
| wholeFloorOnly=1 | 6874 | 1514 | 33 | ok ✓ | 728 |
| **full-table（`districts: []`）** | **null** ✗ | 1483 | 32 | **statement_timeout(57014)** ✗✗ | **>3000（被閘門中止）** |

### 機制（已用程式碼＋量測雙重確認 ✓）
1. `districtClosureIds()` 對「無名單或等於全體」**刻意回傳 `null`**（`listingSearchNodePg.js:42` 起 ✓）。
2. builder 在 `districtIds === null` 時走 `appendDistrictCandidates(districtNames, …)`，
   而它對**空名單**是 **no-op**（`listDistrictSql.js:41` `if (!selected.size) return;` ✓）
   ⇒ **SQL 完全沒有行政區子句** ✓ ⇒ 候選查詢變成**對 listings 全表**套其餘條件 ✗。
3. 因此「有行政區」＝候選 6,647／≤0.7 秒 ✓；「無行政區」＝**同一句 SQL 逾時** ✗✗。
4. `dbDriverPostgres.js:35`：`statement_timeout: intFromEnv(env, "PG_STATEMENT_TIMEOUT_MS", 15_000)`
   ⇒ **driver 預設 15 秒** ✗（未設 env 的環境：CI／本機 ✓；容器設 5min ✗）。
   ⇒ 真實世界（F3 的 30 秒／`Connection terminated unexpectedly`）就是這條路徑 ✓✓。

### 結論（給 astra §1／§3 的依據）
- **astra6 §1 的可索引性工作是必要的** ✓✓ —— 而且**目標非常明確**：**沒有行政區子句的那句候選 SELECT**
  （全表掃描 ✗）。不是 `kind_tokens` 的顯示篩選 ✗（那些在 WHERE 根本沒過濾 ✓：kind／areaMax／
  wholeFloorOnly 皆回傳 6647 列 ✓）。
- 建議先做：對該查詢 `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF)`（在 `BEGIN READ ONLY` 內 ✓）找出
  掃描／排序熱點；再決定索引（候選條件為 `search_key`／`fixture_namespace`／`NOT EXISTS(flags)` ✓）。
- **§3 效能目標**應以「無行政區」為最壞情況（目前：**逾時** ✗）。



## 八、✦ astra 裁決後的更正（2026-09-25，必須以本節為準）

astra 已讀取本檔並指出下列敘述有誤／過度推論，**本節覆蓋前文**：

1. **PG 16 的 query parameter 上限是 65,535，不是 32,767** ✗（前文寫錯）。
   單憑「36,306 個 placeholder」不能證明超過協定上限，錯誤訊息裡的 format count 也不必然等於
   應用傳入的清單長度 ⇒ 需另記錄真正的 `params.length`、最大 placeholder 編號與原始錯誤。
   `= ANY(bigint[])` 的改法**保留** ✓，但要補「真的跑到四個 loader」的大清單測試
   （>32,767 與 >65,535 個 ID，驗證回讀集合完整）；**不能**用「錯誤碼從 08P01 變成 57014」
   單獨證明陣列修復已通過（後者是候選 SELECT 早在 loader 之前就 timeout ✗）。
2. **三組事件不是同一個原因** ✗：舊 `sql_pg count` 的 30 秒斷線、新 `node_pg` preload 的 `08P01`、
   新全區候選的 `57014` 是**不同 SQL／不同階段**。目前已定位的是「全區候選逾時」；
   歷史 30 秒斷線不可一律歸因於此。
3. **不可宣稱「4.5–10× 優化」** ✗：先前 3.0–6.6 秒是**行政區過濾**的小候選案例，與 F3 的全區案例
   不是同一個查詢；兩者不可相減。
4. **`onlySqlite=0`／`onlyPg=22` 不是「零語意漂移」驗收** ✗：兩側使用者資料不同
   （容器 SQLite 4 位 vs PG 28 位）⇒ 不具可比性。要驗收需**同一 fixture／快照**、雙向集合差為 0、
   `totalMatched` 相等，再看順序與回傳狀態。
5. **`districts: []` 不一定等於全區** ✓：`resolveListDistrictNames()` 會退回會員設定的行政區
   ⇒ 必須分開測「請求名單為空但會員有設定」與「解析後確實為空」。後者不加行政區子句是**正確語意** ✓，
   不能當成程式缺陷。
6. **Sequential Scan 不自動代表缺索引** ✓：要看 rows／loops／buffers／等待與傳輸成本。
7. **CI 的 15 秒推論作廢** ✗：workflow 明確設 `PG_STATEMENT_TIMEOUT_MS=300000`（5 分鐘），
   不是 driver 預設 15 秒 ⇒ 不可再用「CI 沒設 env 所以必踩 15 秒」解釋 CI 結果。

## 九、本輪依裁決完成的修正（2026-09-25）

| 裁決 | 實作 | 驗證 |
|---|---|---|
| §2.1 watched／瀏覽隔離**不得回退讀 SQLite** | 新增 `browseIsolationClause(context, sqliteDb, table)`：有 context 用 context、`sqliteDb==null` **明確拋錯**；`listingVisibilityClauses` 接受 `{ sqliteDb }`；watched 分支改走同一條；`node_pg` 以 `{ sqliteDb: null }` 呼叫 | 新增 `listing-search-no-sqlite-io.test.js`：**以間諜計數**存取嘗試，all／watched／hidden／unseen／viewed 皆為 **0** ✓；缺 isolation 必拋錯 ✓；SQLite 路徑不受影響 ✓（8/8）|
| §2.2 flags 消費端必須用 uid | `preloadDecorationProviderAsync` 新增 `flagUserId`（`personalFlags` 依它載入；`personalIndex`／`splitPairSet` 仍依 voteUid）；`node_pg` 的 `flagMap` 改 `personalFlagMap(uid)` | 新增 `listing-search-pipeline-flags-identity.test.js`：**真正走完 node_pg**、uid=101／voteUid=202 兩人 watched／hidden／viewed 相反，涵蓋 `all` 對稱、`hidden`、`unseen`，並斷言所有 flags 查詢都以 uid 發出（4/4）|
| §5.6 正式模組不得有引擎入口 | `listingSearchAsync` 移除 `searchEngine()` 與 SQL-first 分支；舊路徑改為 `searchListingsSqlPgDiagnostic()`（不支援回報 `unsupported`）| 原「原始碼字串斷言」改為**行為驗證**：硬塞 `options.engine=sql_pg` 仍走 `node_pg` ✓、`searchEngine` 已不存在 ✓ |
| §3 CI 缺陷 | PG job 改走獨立入口 `npm run test:pg`（先 `pg-integration-setup.mjs` 鏡射 schema，再跑 canary ＋ 所有 `PG_TEST_URL` 檔）；**不再** job 全域 `DB_DRIVER=postgres`；`PG_URL`／`PG_TEST_URL` 統一到同一拋棄式容器；image 固定 `postgres:16.14-alpine`；canary 移除 `PG_SKIP_CANARIES` 與 42P01 放行（連不上／缺 schema 必失敗）；計數改包 **client.query** 並分開交易控制語句 | canary 在**真 PG** 上 **4/4** ✓（`connects=1`、`wrapperQueries=0`、資料查詢皆走快照 client、BEGIN 存在）；`notify-enqueue-parity` 的模擬 executor 支援 `= ANY(?::bigint[])`／`$n` 與型別轉換 ⇒ 由失敗轉 **ok** ✓ |

## 十、下一步（依裁決 §6 順序）
1. §4 量測修正：探針把 `areaMax`／`wholeFloorOnly` 放進 `settings`（`wholeFloorOnly` 用 boolean）、
   每個能力加「必定被排除」的 fixture 並斷言生效；`pg-stage-forensics` 輸出 `queryDetails` 各階段與
   per-request PG 查詢數；`pg-explain-forensics` 的 `failedAfterMs` 從**失敗階段**起算；
   移除「普通 EXPLAIN 不受 timeout 影響」的錯誤註解。
2. B4：固定 `asOf` ＋ 明確候選順序（REPEATABLE READ 不會固定 JS 現在時間）。
3. 全區候選的 `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF)`（唯讀）→ 依計畫決定等價改寫或索引 → 鏡像／CI 驗證。
4. 補四個 loader 的大清單測試（>32,767、>65,535）與同 fixture 的雙向 parity。


