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



### 附註（憑證）
容器實測環境只有 `PG_URL`（整串連線字串）＋ `DB_DRIVER=postgres`，**沒有** `PGHOST` 等分散變數 ✓
⇒ canary 的略過條件改為「真的能建出可用的 PG driver」✓（不能只檢查 `PGHOST` ✗）；
CI 的 PG job 也一併帶上 `PG_URL` ✓。**連線字串值只在容器環境／`~/.secrets`，不得進 repo 或對話** ✓。

