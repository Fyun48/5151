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

## 五、下一步（我會繼續做，不等裁決的項目）
- warm p95（`RUNS=5`）＋ 用 `RUNS` 對照 preload 分層前後（有/無 `peers:false`）。
- B4 決定性（`asOf`、明確候選順序）→ CI PG service container（讓 provider／LIMIT／SQLite I/O
  回歸**先真的失敗**）→ 版本化回填 → 分層 gate ＋ PR 本文改寫。
