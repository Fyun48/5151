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

## 十一、§4 量測證據（2026-09-25，探針已依裁決修正）

### 探針修正（§4.1）
- 能力參數移入 **`settings`**（顯示篩選讀 settings），`wholeFloorOnly` 改 **boolean** ✓；
  每個能力與 baseline 對照並輸出 `effective` ✓。
- 新增 `failedStage`／`failedAfterMs`（**從失敗階段起算** ✓，不再沿用 EXPLAIN 耗時 ✓）。
- 輸出 `paramCount`／`paramTypes`（含 `array[N]`）✓；移除「EXPLAIN 不受 timeout 影響」的錯誤註解 ✓。
- `pg-stage-forensics` 改為輸出 `queryDetails` 各階段數值 ＋ 每請求 `{connects, clientQueries, txnQueries, wrapperQueries}` ✓。

### 候選 SQL（有行政區 vs 全區；3 秒閘門）
| 案例 | rows | effective | runMs | EXPLAIN 形狀 | cost |
|---|---|---|---|---|---|
| baseline（西屯區） | 6647 | — | 420 | `Merge Anti Join` ＋ **`Index Scan listings_pkey`** | 114,679 |
| q=電梯 | 968 | **true** ✓ | 222 | `Nested Loop Anti Join` ＋ Index Scan | 163,636 |
| kind=whole | 6647 | **false** ✗ | 410 | 同 baseline | 114,679 |
| sources=591 | 6647 | **false** ✗ | 369 | 同 baseline | 114,679 |
| areaMax=30 | 6647 | **false** ✗ | 400 | 同 baseline | 114,679 |
| wholeFloorOnly=1 | 6647 | **false** ✗ | 386 | 同 baseline | 114,679 |
| **full-table（`districts: []`）** | — | — | **57014** ✗（`failedStage=run`、`failedAfterMs=4597`）| **`Seq Scan on listings`** ✗ ＋ `Nested Loop Anti Join` ＋ **`Join Filter`** ✗ | **1,894,939** ✗ |

⇒ `kind`／`sources`／`areaMax`／`wholeFloorOnly` **在候選層不生效** ✗ ⇒ 它們是 **Node 端的顯示篩選** ✓
（候選 SQL 不縮小集合，與 astra「可以是刻意保留語意」一致 ✓）。

### 全區案例的真實計畫（節錄）
```
Nested Loop Anti Join  (cost=0.35..1894939.42 rows=577 width=739)
  Join Filter: (f.post_id = listings.post_id)                 ← flags 反連接逐列過濾 ✗
  ->  Seq Scan on public.listings  (cost=0.07..1894923.67 rows=577 width=739)
        Filter: (... AND listings.search_key = ANY('{…32 個…}')
                 AND Coalesce(match_verdict,'') <> 'yes'
                 AND (offline <> 1 OR offline_confirmed <> 1) ...)
        ->  Index Scan using idx_user_flags_user_post on user_listing_flags f_1
              Index Cond: ((f_1.user_id = '0') AND (f_1.post_id = listings.post_id))
        ->  Seq Scan on public.listing_prep p  (cost=0.00..16.44 rows=1 width=8)
              Filter: (p.display_ready = 1)                        ← hpDisplayReadySql 逐列 subplan ✗
  ->  Index Scan using idx_user_flags_user_post on user_listing_flags f
        Index Cond: (f.user_id = '0')   Filter: (f.hidden = 1)
```

### 兩個候選熱點（**依 astra §4.2：這些是待驗證方向，尚未確診** ✗）
1. **`hpDisplayReadySql`／`listing_prep` 的逐列 subplan** ✗（計畫中為 `Seq Scan on listing_prep`
   ＋ `display_ready = 1` 過濾；若 `listing_prep` 不小，等價改寫成 LEFT JOIN 或補
   `(post_id, display_ready)` 索引都可能是解 ✓）。
2. **flags 反連接採 `Nested Loop` ＋ `Join Filter`** ✗ 且**估計 577 列 vs 實際 6,647 列** ✗
   ⇒ 統計估計偏差 ✓（`ANALYZE` 是否生效需確認 ✓）；astra 提到若 `(user_id, post_id)` 唯一，
   可評估一次 LEFT JOIN／等價 EXISTS 改寫（缺列與 NULL 語意需一致 ✓）。

### 下一步（需受控資料副本）
在**受控副本**上取 `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)`（CI 的 ~12 萬列固定資料集 ✓；
鏡像端維持 3 秒閘門 ✓，不關 timeout、不強制關 seq scan ✓），並同時記錄 `rows`／`loops`／`buffers`／
等待與傳輸成本，再決定等價改寫或索引 ✓。

## 十二、剩餘工作（依裁決 §6 順序；本輪量到的新缺口已列入）

### 本輪量到的兩個**具體**缺口（astra §4.3 門檻）
1. **每請求資料查詢數超標** ✗：實測 `clientQueries` = **19（baseline／kind／sources）／29（q）**，
   目標是「一般 ≤ 12；通勤 ≤ 16」⇒ 需定位多出的查詢（`q` 多 10 筆，疑似 chunked
   `prepMap`／`extrasMap`／`groupIds` ✗）。交易控制語句另計（`txnQueries: 2` ✓）。
2. **階段別耗時集中在 Node 端** ✗（真實路徑、單一快照）：
   | 階段 | baseline | q=電梯 | 備註 |
   |---|---|---|---|
   | total | 5979 | 2722 | 首次（冷）呼叫 |
   | **prepare_ms** | **1495** | **1088** | builder ＋ PG context ＋ `districtClosureIds` ✗ |
   | sql_ms | 634 | 299 | 候選查詢 ✓（與 EXPLAIN 相符）|
   | preload_ms | 311 | 63 | 候選層 preload ✓ |
   | profile_ms | 244 | 12 | 屬性／價格篩選 ✓ |
   | **relations_ms** | **2593** | **464** | `attachSameHouseRoles`（O(candidates)）✗ |
   | display_ms | 230 | 19 | 顯示篩選 ✓ |
   | sort_ms | 35 | 4 | 分頁排序 ✓ |
   | preload_page_ms | 258 | 380 | 頁面層 preload ✓ |
   | hydrate_ms | 169 | 389 | 頁面列 ＋ 裝飾 ✓ |

⇒ 最佳化目標應是 **`prepare_ms` 與 `relations_ms`**（而非只盯 SQL ✗）；`sql_ms` 只佔 5–10% ✓。

## 十四、CI 綠燈里程碑（2026-09-25）

### 現況（PR #497，run `36112489341`，HEAD `cb61597`）
| 檢查 | 結果 |
|---|---|
| `Run Tests`（一般 job，driver 隔離保留 ✓）| ✅ SUCCESS（2m59s）|
| `Run Tests (PostgreSQL integration)`（本輪新建的獨立入口 ✓）| ✅ SUCCESS（46s；113 tests／0 skip ✓）|
| `Review diff with the configured model` | ✅ SUCCESS |
| `GitGuardian Security Checks` | ✗ FAILURE ← **歷史 incident**（見下）|

### 為達成綠燈所修的 CI 缺陷（全部有 CI 實測依據 ✓）
1. **`function instr(text, unknown) does not exist` ✗ → 整個 job 崩潰**：`pg-integration-setup` 原本用
   `ensurePgSchema(..., { indexes: true })`，把 SQLite 的表達式索引 DDL 搬到 PG ✗。改為
   `importStore(..., { indexes: false })`（表 ＋ 可重現列 ＋ identity 序號重設 ✓），**之後**才逐句建立
   不含 SQLite 專用函式／語法（`instr`／`julianday`／`strftime`／`datetime`／`date`／`COLLATE NOCASE`／
   `GLOB`／`printf`）的索引 ✓（CI 實測：`created:132`、只跳過 `listings` ✓）。
2. **兩個脆弱的原始碼文字斷言 ✗**（`listing-score`／`search-contract-regression`）：依 astra §3.6 改寫為
   **行為驗證** ✓（顯示篩選套用在全部候選 ✓、分頁只回切片 ✓、裝飾只碰頁面列 ✓、成員行政區來自 settings ✓、
   公開路徑不需使用者身分 ✓）。一般 job 因此轉綠 ✓。
3. **GitGuardian 標記硬寫帳密** ✗：CI 內改 `POSTGRES_HOST_AUTH_METHOD: trust`（拋棄式容器、只綁 runner
   內部 ✓）＋ 連線 URL 改 `postgres://${PGUSER}@…` ✓＋移除 `PGPASSWORD`／密碼字面值 ✓（實測檔案內
   `PGPASSWORD` 與 `postgres:postgres` 皆 **0 次** ✓）＋ 新增 `.gitguardian.yaml` 忽略該 CI 測試 URL ✓。
   **殘留**：分支歷史的舊 commit 仍含該字面值 ⇒ GitGuardian incident 需在後台**一次性**標為
   false positive／已知測試憑證 ✓（不需提供任何 token 給我 ✓；我不會未經同意改寫歷史 ✓）。
4. **PG 整合 job 的 3 個 live 測試失敗 ✗**：
   - 私有 schema 缺表（`relation "settings" does not exist`）✗ ⇒ 可選表改用 **`to_regclass` 事前檢查** ✓
     並把降級記入 `context.degraded`／`queryDetails.contextDegraded` ✓（**不可「送出再吞 42P01」** ✗：
     在 `BEGIN READ ONLY` 內會讓交易變成 `current transaction is aborted` ✗✗，CI 實測踩過 ✓）。
   - 「種子查詢讀的是 PostgreSQL」**本質需要匯入正式站資料的影子站** ✗ ⇒ 依 §3.4 以專屬
     `PG_SHADOW_URL` 明確 gate ✓（skip 訊息寫明理由；不屬 PR-B 必要 gate ✓）。

### 待辦（astra §6 剩餘）
③ warm A/B（ORDER BY 成本、階段目標）＋ 每請求查詢數進門檻（現 17／21，目標 ≤12／≤16）
④ 受控副本 `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)` → 等價改寫或索引（兩個候選熱點見 §11）
⑤ 同 fixture 雙向 parity → 分層 perf gate → PR 本文更新


## 十六、EXPLAIN (ANALYZE) 結果與兩個操作教訓（2026-09-25）

### 實測（真實鏡像；`ANALYZE=1`、`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)`）
| 能力 | PG execMs | planningMs | rows |
|---|---|---|---|
| baseline（西屯區） | **117** | 5.4 | 6694 |
| q=電梯 | **376** | 11.2 | 983 |
| kind=whole | **316** | 10.5 | 6694 |
| sources=591 | **143** | 5.6 | 6694 |
| areaMax=30 | **162** | 8.1 | 6694 |
| wholeFloorOnly=1 | **164** | 9.3 | 6694 |
| **full-table（`districts: []`）** | **57014（逾時）** ✗ | — | — |

⇒ **有行政區時 PG 實際執行只要 117–376 ms** ✓（先前 stage `sql_ms=634` 含 pg 驅動／Node 傳輸 ✓）
⇒ 請求級成本主要落在 **Node 階段**（`prepare_ms` 900–1500／`relations_ms` 1400–2600 ✓，見 §12）
⇒ **全區候選仍是唯一會逾時的查詢** ✗（§11 的 `Seq Scan` ＋ `Nested Loop Anti Join`＋`Join Filter` ✓）

### 教訓 1（探針）：`TIMING OFF` 會讓逐節點時間消失 ✗
`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)` 的輸出**沒有** `Actual Total Time` ✗
⇒ 本次 `analyzeHot`（用 loops × time 排序）全為 0 ✗。逐節點歸因必須改用可得的欄位：
`Actual Rows`／`Actual Loops`／`Shared Hit/Read Blocks`（astra §4.2 的 rows／loops／buffers ✓）；
若一定要時間，就得開 timing（並接受量測開銷 ✓）。**修探針的下一步** ✓。

### 教訓 2（流程）：不可把同步輸出丟進 `/dev/null` ✗
本次 `run-in-container.sh … > /dev/null 2>&1` 同步**失敗但無聲** ✗ ⇒ 容器內跑的是舊版探針（`grep -c analyzeHot` = 0 ✗）
⇒ 白費一輪 ✓。規則：**同步後一定要用 marker grep 驗證** ✓（`grep -c analyzeHot` = 1 ✓ 才繼續），
而且不要吞掉同步輸出 ✓。

### 逐節點歸因（`ANALYZE=1`，baseline 西屯區，以 buffers／loops 排序）
| 節點 | relation | rows | loops | buffers |
|---|---|---|---|---|
| Merge Join | — | 6694 | 1 | 33,518 |
| Index Scan | **listings** | 6694 | 1 | **33,516** ✗ |
| Index Scan | **user_listing_flags** | 0 | **6,907** ✗ | 13,814 ✗ |
| Seq Scan | **listing_prep** | 0 | **1** | **13** ✓ |

⇒ **候選欄位寬度是最大成本** ✓（`listings` index scan 33,516 buffers ≈ 262 MB block 存取 ✗；對應 astra §4.2
「若成本主要是傳輸／Node，優先縮減候選欄位」✓）—— 現行 `LIST_CANDIDATE_COLUMNS` 有 43 個欄位、寬 739 bytes ✓。
⇒ **flags 反連接逐列執行 6,907 loops** ✗（每候選列一次 index scan ✓）⇒ 等價改寫（讓 PG 選 hash anti join ✓／
或等效條件重寫 ✓）或統計修正 ✓，這才是「flags 逐列 subquery」的真實量測 ✓。
⇒ **`listing_prep` 只碰 13 buffers、1 loop** ✓ ⇒ **先前標為候選熱點的猜測被推翻** ✗✓
（**不需要**為它加索引 ✓；這正是 astra 要求「先量再決定」的價值 ✓）。
⇒ 探針修正：`FORMAT JSON` 的根在 **`Plan`** 底下 ✗（直接走 root 會得到空節點、buffers 全 0 ✗），已修 ✓。

### 統計新鮮度（唯讀 `pg_stat_user_tables`，`v3/scripts/pg-stats-check.mjs`）
| 表 | n_live_tup | n_mod_since_analyze | last_autoanalyze |
|---|---|---|---|
| **listings** | **122,925** ✗ | 5,429 | 2026-09-25 09:30 ✓ |
| **user_listing_flags** | **0** ✗ | 0 | **null** ✗✗ |
| listing_prep | 379 ✓ | 74 | 2026-09-24 ✓ |
| settings | 28 ✓ | 45 | 2026-09-25 09:17 ✓ |
| crawl_covers | 38 ✓ | 0 | 2026-09-25 09:31 ✓ |
| listing_group_members | 0 ✓ | 0 | null ✓ |

⇒ **①`listings` 實際 122,925 列** ✗（先前估「~36k」**是錯的** ✓）⇒ 全區候選的逾時完全說得通 ✓，
且正好對應 astra §4.3 的「CI fixture 約 12 萬列」✓。
⇒ **②`user_listing_flags` 完全沒有統計** ✗（0 列、`last_autoanalyze = null` ✓）⇒ 這是計畫
「估計 577 vs 實際 6,647」✗ 與 **Nested Loop ＋ Join Filter** ✗ 的**直接解釋** ✓
（planner 用預設選擇率 ⇒ 選了 nested loop ✓；實測 6,907 loops × 每次索引探測 ≈ 13,814 buffers ✓）。
⇒ **修法**：跑 `ANALYZE user_listing_flags`（**既有發布權限** ✓；astra：索引／設定套用沿用發布權限 ✓），
**不是**新增無關索引 ✗ —— 改完再取一次 ANALYZE 對照 ✓。
⇒ 全區（無行政區）要能達標，除統計外仍需**縮減候選欄位**（33,516 buffers ✗）與**限制候選集合**的
等價手段 ✓；三者都要在不改變 totalMatched／排序／角色的前提下做 ✓。

### ANALYZE 前後對照（唯讀探針重跑 ✓，已授權的維護性寫入 ✓）
| 量測 | ANALYZE 前 | ANALYZE 後 |
|---|---|---|
| flags 節點 loops | 6,907 | **6,912** ✓（幾乎不變 ✗） |
| flags 節點 buffers | 13,814 | 13,824 ✓（不變 ✗） |
| 計畫形狀 | `Nested Loop` ＋ `Join Filter` ✗ | **`Nested Loop` ＋ `Join Filter`** ✗（**沒翻** ✗） |
| `listings` index scan buffers | 33,516 | 33,541 ✓（不變 ✓） |

⇒ **ANALYZE 沒有改變計畫** ✗ ⇒ flags 的逐列索引探測**不是統計假象** ✓，而是**正確的存取法** ✓
（13,824 ÷ 6,912 ≈ **每次探測 2 buffers** ✓＝正常 B-tree 下降 ✓；反連接本來就逐列探測 ✓、實際匹配 0 列 ✓）。
⇒ **第二個猜測依實測退休** ✗✓：astra「flags 逐列 subquery 等價改寫」**不成立** ✓
（改寫只冒語意風險、換不到效能 ✗）——**但 `ANALYZE` 仍保留其價值** ✓：它當場修正了一個錯誤事實 ✓，
且統計健全是計畫穩定的前提 ✓。
⇒ **唯一站得住的成本中心仍是候選欄位寬度** ✓（33,541 buffers ✗ ≈ 268 MB、約 **每列 5 buffers** ✗
⇒ 對上 `exec 121 ms` 的主要部分 ✓）；而 **6,694 列 × 43 欄的 JS 物件** ＋ **全區 122,925 列** ✗
才是 30s 的真正來源 ✓ ⇒ 對策是**縮減候選欄位** ＋**減少查詢數** ✓，不需動 flags 的連接方式 ✓。
⇒ 另一事實修正 ✓：`user_listing_flags` **不是空表** ✓（`n_live_tup = 705` ✓）；先前讀到 0 ✗
是因為**完全沒有統計**時的佔位值 ✓ —— 沒有統計時 `n_live_tup` 不可信 ✓。

### 候選欄位審計（① 的第一步）
- `LIST_CANDIDATE_COLUMNS` **只在 `v3/src/db.js`** ✓（單一來源 ✓）；投影輔助在 `v3/src/listingSearchProjection.js` ✓。
- 以 `grep -o 'row\.[a-z_]*'` 掃候選階段檔案（`listingSearchAsync.js`／`listingSearchSql.js`／
  `listDistrictSql.js`／`listPriceSql.js`／`listKeep.js`／`listingSearchProjection.js`／
  `repository/listingFields.js`／`listingSearchNodePg.js`）只得到 **10 個欄位** ✓：
  `post_id`(7)／`updated_at`(3)／`name`(3)／`key`(3)／`total_monthly_cost`／`rent`／`match_post_id`／`lat`／`lng`／`group_key` ✓。
- ✗ **但這不完整**：管線大量使用**解構**與其他變數名（`r.`／`candidate.`／`item.`／`{ district }` ✗）⇒
  `grep` 審計會**低估**使用面 ✗ ⇒ 依此直接刪欄位**不安全** ✗。
- ⇒ **改採嚴謹可證法**：新增**Proxy 讀取審計測試** ✓ —— 把候選列包成 `Proxy` ✓、記錄實際被讀取的鍵 ✓，
  跑一次真正的搜尋管線（既有 fixture ✓）⇒ 得到**有證據的最小欄位集** ✓；再據此縮減投影 ✓，
  並以既有 parity／contract 測試（totalMatched／排序／角色不變 ✓）守住等價性 ✓。
- ⇒ 這條路**零生產風險** ✓（不先改 `db.js` ✗）、可重跑 ✓、且結果可寫進 PR 當證據 ✓。

### 讀取審計結果（已落地成測試 ✓ `v3/test/listing-search-projection-read-audit.test.js` ✓）
`ComputeListingProjection`（與 Node filter/sort **同一批函式** ✓）對候選列**實際讀取**：
- `AUDIT-READ-PRESENT`（19 欄 ✓）：`post_id`／`source`／`source_key`／`price`／`price_num`／`extra_fee`／
  `extra_fees`／`title`／`address`／`area_name`／`floor_name`／`kind_name`／`tags`／`lat`／`lng`／
  `location_class`／`match_post_id`／`offline`／`refresh_time` ✓
- `AUDIT-READ-ABSENT`（14 欄 ✓，由 hydration／正規化階段提供 ✓）：`commute_km`／`route_km`／
  `source_updated_at`／`source_published_at`／`building_type`／`buildingType`／`caseTypeName`／
  `listing_kind`／`region_id`／`regionid`／`section_id`／`sectionid`／`shape`／`shape_name` ✓
- **`AUDIT-SPREAD no`** ✓✓：`computeListingProjection` **沒有展開整列** ✗ ⇒ **縮減候選欄位在這一層確實有效** ✓
  （若它 `{ ...row }` 就會複製全列、縮欄位白做 ✗）。
- 護欄價值**當場驗證** ✓：初版只登錄 4 個裝飾欄位 ⇒ **測試正確地紅了** ✗（`# fail 1` ✓）、
  逼出另外 10 個**隱性依賴**（來源別名／舊 schema 變體 ✓）⇒ 登錄後轉綠 ✓。
- ⇒ 可縮範圍：**43 → 19（＋裝飾／別名 14 於後續階段）** ✓ ⇒ 直接對應實測最大成本
  （`Index Scan listings` 33,541 buffers ✗）✓；落地時以既有 parity／contract 測試守住
  `totalMatched`／排序／角色不變 ✓。

### ✗ 對上一節的更正：19 欄是**必要但不充分**
真正的候選階段是 **`buildListListingsRows`**（`db.js:6540` ✓，已 export ✓）＋
**`pageListListingsRows`**（`db.js:6758` ✓，已 export ✓），而前者：
- **就地改寫**候選列（`overlayRowsPersonal(raw, flags, { inPlace: true })` ✓）；
- 讀 `row.district`（**由 `address` 推導** ✓，`district` 不在 43 欄內 ✓）；
- 走 `applyListingFilter`（`db.js:6322` ✓）／`passesDisplayFilters`／`listingMatchesListFilter`／
  `keepSelfListingForViewer`／`matchesHousingKind`／`matchesListingSources` ✓；
- `sort === "fit_desc"` 時讀 `route_km` 並**寫入** `row.fit_score` ✓；
- 需要注入 `provider`／`flagMap` ✓（否則落到同步 SQLite ✗：`loadFlagMap`／`attachSameHouseRoles` ✓）。

⇒ 因此 `computeListingProjection` 的 19 欄**只覆蓋推導欄位** ✗ ✓；
⇒ **完整最小欄位集必須由「管線級 Proxy 審計」決定** ✓ —— 在既有 parity／contract 測試的 fixture 上，
把候選列包 `Proxy` ✓、注入 fake `flagMap`（`new Map()` ✓）與 `provider` ✓，依序跑
`buildListListingsRows` ✓、再包一次 Proxy 跑 `pageListListingsRows` ✓，即得「篩選／排序／分頁」的
真實讀取集合 ✓。
⇒ **在此之前不動 `db.js` 的候選 SELECT** ✗ —— 以**不足**的欄位集去改，會改壞管線且可能不會被現有測試抓到 ✗
（這正是本專案「先量、再改」的紅線 ✓）。

### 管線級審計的注入契約（已封閉 ✓，可直接照做）
讀 `db.js` 後確定，要讓管線在**無 SQLite**下可測 ✓（否則落在同步讀取 ✗）：
- `attachSameHouseRoles(rows, voteUserId, provider)`（`db.js:3373` ✓）：
  `const source = provider || sqliteDecorationProvider(voteUserId)` ✗ ⇒ **必須注入 provider** ✓；
  所需介面＝`personalIndex()`（回傳含 `peers(post_id)` ✓）＋ `extras(ids)`（可迭代 `[id, item]` ✓）✓。
- `applyListingFilter(rows, settings = getSettings(), provider = null)`（`db.js:6322` ✓）：
  `warmRouteCache()` 與 `applyCachedCoords(…, provider)` **只在 `settings.commuteKm > 0 且 hasWorkPoint(settings)`** 時才走 ✓
  ⇒ **審計的 settings 不含 `commuteKm`** ✓ 即可完全避開 provider 與路線快取 ✓。
- ⇒ 因此審計配方 ✓：`filter:"all"` ✓、`kind:""` ✓、`sources:null` ✓、**`sort` 不用 `fit_desc`** ✓
  （否則讀 `route_km` 並寫 `fit_score` ✗）、`uid:0` ✓、`voteUid:0` ✓、`districtSet:new Set()` ✓、
  `flagMap:new Map()` ✓、`provider:{ personalIndex:()=>({peers:()=>[]}), extras:()=>[] }` ✓、`markStage:()=>{}` ✓；
  再對回傳列**重新包一次 Proxy** 跑 `pageListListingsRows` ✓ ⇒ 同時涵蓋「分頁階段」的讀取 ✓。
- 附帶確認 ✓：`listingDistrictName(row) = row?.district || districtNameFromListing(row)`（`db.js:6336` ✓）
  ⇒ `district` 確實被讀、且 `district` **不在** 43 欄內 ✓（靠 `address` 推導 ✓）。

### 管線級審計結果 ✓ **43 → 22 欄**（已落地成測試 ✓ `v3/test/listing-search-pipeline-read-audit.test.js` ✓）
手法：真實管線 ＋ `spyProvider`（照 `listing-score.test.js` ✓）＋ 對候選列包 `Proxy`（`get`／`has`／`ownKeys`／`set` ✓）。
- **`PIPE-SPREAD no`** ✓✓ ⇒ 管線**沒有整列展開** ✗ ⇒ **縮減候選欄位在 SELECT 這層確實有效** ✓（關鍵前提成立 ✓）。
- **`PIPE-READ-IN-CANDIDATE` ＝ 22 欄** ✓：
  `post_id`／`source`／`price`／`price_num`／`title`／`address`／`area_name`／`floor_name`／`kind_name`／
  `tags`／`lat`／`lng`／`geo_source`／`location_class`／`match_post_id`／`match_verdict`／`offline`／
  `offline_confirmed`／`hidden`／`hidden_at`／`refresh_time`／`contact_uid` ✓
  ⇒ **可移 21 欄** ✓（含 `source_id`／`source_key`／`extra_fee*`／`price_contain_text`／`address_norm`／
  `layout`／`role_name`／`contact_name`／`contact_role`／`agency`／`match_level`／`match_rejected`／
  `last_event`／`first_seen_at`／`last_seen_at`／`listed_by_user_id`／`self_status` 等 ✓）✓
  —— 注意 `extra_fee*` 不在管線直讀清單 ✓（月總成本由投影表／`computeListingProjection` 提供 ✓）。
- `PIPE-READ-UNREGISTERED` 初值 6 ✓ ⇒ 全為非 SELECT 來源 ✓、登錄後轉綠 ✓：
  `fixture_namespace`（fixture 隔離 ✓）／`same_house_split`（同戶裝飾 ✓）／
  `viewed`／`viewed_at`／`watched`／`watched_at`（`overlayRowsPersonal(flags)` 疊加的個人狀態 ✓）✓
- **已知限制 ✓（下一步，不可略過 ✗）**：本次只量 `filter:"all"` ＋ 非 `fit_desc` 排序 ✓
  ⇒ `watched`／`offline`／`suspected`／`fit_desc`／關鍵字等模式需**各跑一次** ✓（同一支測試可參數化 ✓）。
- 附帶訊息 ✓：測試日誌顯示 `listing_search_projection 已與 listings 對齊，訪客搜尋使用 SQL-first` ✓
  ⇒ 投影表**已在對齊**、guest 路徑已走 SQL-first ✓ ⇒ 縮欄位可望直接接到既有機制 ✓。

### 模式矩陣結果 ✓ —— 最終欄位集（`READS`＝被讀欄位數／`SPREAD`＝是否整列展開）
| 模式 | READS | SPREAD |
|---|---|---|
| `filter:"all"` / `price_asc` | 32 | 0 ✓ |
| `filter:"watched"` | **12** ✓ | 0 ✓ |
| `filter:"offline"` | 14 ✓ | 0 ✓ |
| `filter:"suspected"` | 15 ✓ | 0 ✓ |
| `filter:"all"` / `refresh_desc` ＋kind＋sources | 30 ✓ | 0 ✓ |
| **`filter:"all"` / `fit_desc`** | **54** ✗ | **1** ✗ |

- ⇒ **非 `fit_desc` 模式：候選欄位 43 → 23** ✓（22 ＋ `match_level` ✓——`suspected` 唯一額外讀取 ✓）
  ⇒ **可移 20 欄** ✓ ⇒ 這是縮減 SELECT 的**最終依據** ✓。
- ⇒ **`fit_desc` 是唯一例外** ✗：`applyCachedCoords` **複製整列** ✗（`db.js:6322` 上方註解自述
  "cloning wide rows" ✓）⇒ 該模式讀滿 43 欄 ✗ ⇒ **縮 SELECT 對它收益有限** ✗
  ⇒ 需另外把 clone 改成就地／延後（後續工作 ✓，**不可略過** ✗）。
- ⇒ 護欄已就位 ✓：`PIPE-SPREAD-MODES` 斷言「整列展開只允許發生在 `fit_desc`」✓
  ⇒ 若哪天擴散到別的排序，測試會紅 ✗（避免縮欄位後才發現白做 ✓）。
- ⇒ `watched`(12)／`offline`(14)／`suspected`(15) 讀得**更少** ✓ ⇒ 這些分支走更短路徑
  （跳過 `applyListingFilter`／display filters ✓）⇒ 佐證「分層成本」模型 ✓。
- 測試狀態：`exit=0`／`pass 1`／`fail 0` ✓。

### 改 SELECT 前的兩項決定性檢查（本批新增 ✓）
1. **投影計算不會污染候選欄位集** ✓✓：`computeListingProjection` 只被**寫入路徑**呼叫
   （`repository/writePath.js:361` ✓）與 `syncListingProjection`（投影維護 ✓）⇒
   **讀取路徑不會拿候選列去算投影** ✓ ⇒ 我先前擔心「23 欄漏掉投影所需的
   `extra_fee*`／`first_seen_at`／`last_seen_at`／`source_updated_at`／`source_published_at`」**不成立** ✓
   （該擔心已解除 ✓；但若未來把投影計算搬進讀取路徑，這裡會立刻變成必須補的 5 欄 ✗ ⇒ 已記錄 ✓）。
2. ✗ **真正的新風險（改動範圍）**：`candidateColumns` 有**兩個消費者** ✗ ——
   - 列表路徑 ✓：`listingSearchNodePg.js:216`（`SELECT ${candidateColumns} FROM listings … ORDER BY post_id` ✓）
     ＋ `db.js:6813`（SQLite 路徑 ✓）
   - **統計路徑** ✗：`repository/listingStats.js:133`（`SELECT ${context.candidateColumns} …` ✓）
   ⇒ 縮欄位**只能針對列表路徑的 context** ✓（`db.js:6838` 與 `6859` 是兩個 context 建構點 ✓），
   **統計必須留在寬欄位** ✓（它有獨立的 `listing-stats-parity.test.js` ✓）。
3. ✗ **驗證能力限制（實測）**：本地 `node --test` 跑既有套件（`list-query-regression`／
   `search-contract-regression`／`listing-search-projection`／`listing-score`／`list-display-filter` ✓）
   **會卡住** ✗（240 s 只輸出 `TAP version 13` 一行 ✓；且本地無 `node_modules` ✗）
   ⇒ **不得盲改熱路徑** ✗ ⇒ 縮欄位的改動**必須由 CI 驗證** ✓；
   在能本地重現套件之前，此改動不進主線 ✗（astara 紅線：先量、再改、且可驗證 ✓）。

### ✗✓ 更正第三點：驗證牆已解 —— **本地可驗證**（真相：慢，不是卡 ✓）
逐檔實測（單檔 ＋ `timeout` ✓）：
| 檔案 | 結果 | 耗時 |
|---|---|---|
| `list-query-regression` | **15/15 ✓** `exit=0` | **124.7 s** ✗（慢 ✓） |
| `search-contract-regression` | 1/1 ✓ | 快 ✓ |
| `listing-score` | 6/6 ✓ | 快 ✓ |
| `listing-search-projection` | 3/3 ✓ | 快 ✓ |
| `list-display-filter` | 1/1 ✓ | 快 ✓ |
| `list-sql-first-wiring` | 3/3 ✓ | 快 ✓ |

⇒ 先前「跑既有套件會卡住」✗ 是**誤判** ✓：真相是**基準契約檔很慢** ✓（124.7 s ✓，
超過我原先給的 45–240 s 批次預算 ✗ 而被我讀成 hang ✗）⇒ **本地驗證完全可行** ✓✓。
⇒ 可用驗證指令（單檔逐一、給足時間 ✓）：
`for f in list-query-regression search-contract-regression listing-score listing-search-projection list-display-filter list-sql-first-wiring; do timeout 260 node --test v3/test/$f.test.js; done` ✓
⇒ **上一批的紅線解除** ✗✓：縮欄位改動**現在可以做、且有本地回歸網** ✓（僅 `node_modules` 相關工具如 eslint 仍需 CI ✓）。

### ① 縮欄位已落地 ✓（`22e3c27`）
- `db.js` ✓：新增 `export const LIST_CANDIDATE_COLUMNS_NARROW`（**23 欄** ✓，含 `match_level` ✓），
  附量測依據與「使用範圍刻意最小」說明 ✓。
- `listingSearchAsync.js` ✓：PG 列表路徑在「**自己建 deps**」時覆寫 `candidateColumns` 為窄版 ✓；
  **呼叫端注入 deps 時一律尊重** ✓（測試／診斷不受影響 ✓）。
- **未動** ✓：統計（`listingStatsBuildContext` ✓）、明細（`listingDetailAsync` ✓）、
  爬蟲（`crawlerReads` ✓、`db.js:3618` 超集 ✓）、SQLite `listListings` ✓。
- 本地驗證 ✓：7 檔共 **31 個測試全綠** ✓（含 `list-query-regression` 15/15 ✓、142.5 s ✓）。

### ② 追查「整列複製」：兩處，且**都不該盲改** ✗✓（改為「已由 ① 緩解」✓）
- `applyCachedCoords`（`db.js:5773` ✓）：**只在**「`commuteKm>0` ＋ 有工作點 ＋ trusted geo ＋
  查得到路線」時 `return { ...row, route_* }` ✓ ⇒ 複製是**有條件**的 ✓；其餘**原樣回傳** ✓。
- 管線端 `needFit` 分支 ✓：`listingFitFields({ ...located, commute_km: km }, settings)` ✓
  ⇒ **這才是 `fit_desc` 整列展開的來源** ✓。
- ⇒ 兩處展開**可能都是刻意的** ✓：provider 的列來自**共用快取** ✗ ⇒ 就地改寫會**污染快取** ✗
  （比複製更糟 ✗）⇒ **不盲改** ✗。
- ⇒ 而且 **① 已把成本降下來** ✓：被複製的物件由 **43 欄 → 23 欄** ✓ ⇒ `fit_desc` 的複製成本
  **同步下降** ✓ ⇒ ② 由「改程式」改為「已由 ① 緩解」✓ ✓。
- ⇒ 保留觸發條件 ✓：**若日後量到 fit 路徑仍是熱點**，再處理複製（且有本地測試可驗 ✓）。

### ✗✓ 鏡像量測限制（已用證據確認，非假設 ✓）
- 新增 `v3/scripts/pg-columns-ab.mjs` ✓：同一條 WHERE、**43 欄 vs 23 欄**的 SQL 級 A/B ✓
  （欄位清單字面寫死 ✓，兩側唯一差異就是清單本身 ✓；用 `.Plan` 根節點走樹 ✓、輸出總 buffers 與前三大熱點 ✓）。
- ✗ **實測結果**：容器內的部署版 `/app/src/db.js` **沒有匯出** `buildListListingsClauses` /
  `buildListRequestContextFromPg` ✗（`grep -c` = 0 ✓）⇒ 執行即
  `SyntaxError: does not provide an export named 'buildListListingsClauses'` ✗
  ⇒ **部署映像比本分支舊** ✗ ⇒ **鏡像無法驗證本分支的改動** ✗（上一批的推論 ✓，現有證據 ✓）。
- ⇒ **正確的驗證路徑** ✓：CI 的 live PG 整合測試 ✓（它跑本分支程式碼 ＋ 真 PG ✓）；
  本腳本等**本分支被部署**（或 CI 的真 PG 服務 ✓）之後再跑 ✓，即可量化 43 → 23 的 buffer 降幅 ✓。
- ⇒ 教訓 ✓：**「在鏡像上量測」只對已部署的程式碼有效** ✗ —— 量測前必須先確認鏡像版本 ✓
  （本次以 `grep` 匯出清單確認 ✓，而非靠假設 ✓）。

### ✅ CI 驗證：縮欄位通過 ✓（含 live PG 整合 ✓）
- `22e3c27`（縮欄位）→ Tests **`failure`** ✗，但**唯一失敗**是
  `not ok 25 - live：PostgreSQL 佇列可以排入、搶到、完成、失敗與回收`
  （`AssertionError: '剛排進去的要搶到'` ✓）⇒ **與候選欄位完全無關** ✗（是佇列 claim 的競態斷言 ✗）。
- **其後代 `cae323f`（純文件、含同一份程式碼 ✓）→ Tests `success`** ✓✓
  ⇒ 同一份程式碼下次就通過 ✓ ⇒ **`22e3c27` 的失敗是偶發（flaky）** ✓✓
  ⇒ **43 → 23 的縮欄位因此獲得 CI 驗證** ✓（且含 **live PG 整合測試** ✓，即在真 PG 上跑窄 SELECT ✓）。
- ⇒ 另記一個**既有 flake** ✗（非本分支造成 ✓）：`pg-live-integration` 的佇列 claim 斷言
  （`剛排進去的要搶到` ✓）會偶爾紅 ⇒ **若之後持續紅就要處理** ✓。
- CI 現況 ✓：`0969884` Code review (advisory) `success` ✓、Tests `in_progress` ✓；
  `cae323f`／`c2d779a` 兩項皆 `success` ✓。
















## 十七、查詢數超標的組成與**等價**削減計畫（先前定位，尚未實作完）

### 機制（已讀程式碼確認）
`createDecorationDataLoader` 的 memo 是 **以整個 id 集合為 key** ✗：
```js
const keyOf = (ids) => [...new Set(ids.map(normalizeId).filter(Boolean))].sort((a,b) => a-b).join(",");
memo(cache.prep, keyOf(ids), () => loadListingPrepMap(exec, ids, driver));   // 同一個 loader、不同集合 ⇒ 再查一次
```
⇒ 「候選集合」與「頁面集合」的 key 不同 ✗ ⇒ `prep`／`extras`／`groupIds` 各查 **2 次** ✗
（＝本輪 preload 分層新增的成本 ✓：省下 peer 展開，但多吃 3 筆查詢 ✓）。
`groupMemberRows(groupId)` 則是**每個 group 一筆** ✗（頁面 ≤50 列 ⇒ 最多 50 筆 ✗）。

### 實測組成（baseline ≈ 19 筆）✓
context 6（crawlSources／settings／user_settings／users／crawl_covers／distinct search_key ✗）
＋ closure 2 ＋ 候選 1 ＋ flags 1 ＋ personalIndex 1 ＋ splitPairs 1 ＋ peers(兩跳) 2
＋ groupIds 2 ＋ groupMembers n ＋ prep 2 ＋ extras 2 ＋ routeCache 1 ＋ mrtCache 1 ＋ routeJobs 1
＋ 頁面列 1 ⇒ 約 19 ✓（`q=電梯` 29 ⇒ 多出 10 筆，待查 ✗）。

### 等價削減（**不改變任何語意** ✓，astra §4.3「查詢數：一般 ≤12、通勤 ≤16」）
1. **memo 改成以 id 為單位** ✓（保留 per-id row map，只對「缺少的 id」發查詢 ✓）⇒
   `prep`／`extras`／`groupIds` 由 2 次降為 1 次 ✓，且集合重疊時天然不重查 ✓。
2. **`groupMemberRows` 批次化** ✓：一次 `= ANY(?)` 查多個 group ✓（同一套陣列綁定 ✓）。
3. **context 合併** ✗（6 → 2～3）：可把 `settings`／`crawlSources` 併為一次、`users`／`user_settings` 併為一次 ✓；
   若要更進一步需評估快取（跨請求）⇒ 需 astra 同意 ✗，因為那會影響「設定變更的可見延遲」。
4. `q=電梯` 多出的 10 筆需定位（疑似 `searchWhere` 的 `expandSearchKeys`／chunked 或額外的 prep 集合 ✗）。

三項完成後才可能達到 ≤12 ✓；在此之前 **不宣稱**效能 gate 通過 ✓。

2. 受控副本上的 `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)`（見 §11 的兩個候選熱點）。
3. 補四個 loader 的大清單測試（>32,767、>65,535）＋ 同 fixture 雙向 parity。
4. `prepare`／`relations` 的等價優化（不縮小候選集合、不改變角色／總數／排序語意）＋ 查詢數降到門檻內。
5. 分層效能 gate（單行政區 C1 ≤1s／C4 ≤2s；全區 C1 ≤2s／C4 ≤4s；查詢數；event-loop lag p99 ≤50ms）
   ＋ warm p95（暖機 ≥5、量測 50 請求；冷啟另列）＋ PR 本文更新。
   ※ 註：`run-in-container.sh -d` 目前只帶 `PG_STATEMENT_TIMEOUT_MS`，`RUNS` 不會傳進容器
   ⇒ 暖機量測需用 `ssh … docker exec -e RUNS=…`（或之後把 ENV 支援補進腳本 ✓）。




### ③ 查詢數清點（唯讀 ✓）—— 查詢數**不是固定的 12** ✗
- `listingSearchNodePg.js` ✓（列表路徑）**5 個基座查詢** ✓：
  `seeds`（:49 ✓）／`linked`（`match_post_id`，:57 ✓）／same-house members（:64 ✓）／
  **candidate SELECT**（:216 ✓）／page hydration（`SELECT * … IN (…)`，:242 ✓）。
- `repository/decorationData.js` ✓：**14+ 個查詢點** ✗✗ —— `user_listing_flags`（:64 ✓）、
  :72／:93／:135／:159／:172／:197／`listing_prep`(:218 ✓)／:228／:245／:263／:278／:293 ✓。
- ⇒ **結論** ✓：總查詢數**不是常數** ✗，而是由「管線實際叫到哪些裝飾方法」決定 ✓
  （`flags`／`personalIndex`／`splitPairs`／`prep`／`peerRows`／`extras` ✓）。
  ⇒ 所以 ③ 的順序必須是：**先量**每次搜尋實際發出幾個查詢 ✓（用假 `pgDriver` 包計數器 ✓，
  可離線跑 ✓）⇒ **再**把 `flags`／`personalIndex`／`splitPairs` 三筆併成一筆 ✓。
- ⇒ 尚未做（下一批 ✓）：量測查詢數 ＋ 合併；本批只完成清點與方法 ✓。

### ✗✓ 更正：`to_regclass` **不是**重複浪費（我判錯 ✓），`ab06f0e` 非效能收益 ✗
- 我原先主張「同一探測重複 5 次 ⇒ 快取即省 26%」✗ —— **錯** ✓。實測改動後
  `QC-TOTAL` **仍是 19** ✗：那 5 個探測是**5 張不同的表**
  （`settings`／`user_settings`／`users`／`search_profiles`／`listings`(search_key) ✓），
  **每表一次是正確行為** ✓ ⇒ 快取本來就正確 ✓。
- ⇒ `ab06f0e` 的性質更正 ✓：**不是效能收益** ✗（19 → 19 ✓），而是無害的重構 ✓
  （per-instance → 共享快取 ✓，＋ 只快取正結果的語意收緊 ✓）。
- ⇒ 這是我第 **3** 個被實測推翻的猜測 ✓（前兩個：`listing_prep` 熱點 ✗、flags 統計問題 ✗）
  —— 再次證明「先量再改」有效 ✓：若照原計畫去改 flags/splitPairs 合併 ✗，也同樣不會動到這個數字 ✓。
- ⇒ **真正剩下的目標**（依實測清單 ✓）：
  ① `SELECT DISTINCT search_key FROM listings` ✓ —— **全表** ✗（最可疑 ✓）；
  ② `listings` 被查 **5 次** ✗（candidate SELECT ＋ DISTINCT search_key ＋ hydration ＋ 另兩筆 ✓）；
  ③ 裝飾各自一筆 ✓（`flags`／`same_house`／`votes`／`prep`／`group_members` ✓）⇒ 才是合併候選 ✓。

### ④ `SELECT DISTINCT search_key FROM listings`（全表 ✗）—— 用途已釐清，修法已定 ✓
- 位置 ✓：**`buildSearchKeysFromPg`**（`db.js:4165` ✓），由 `buildListRequestContextFromPg` 呼叫 ✓。
- 用途（原始碼自述 ✓）：它是 **PG 版 `currentSearchKeys()`** ✓ —— 把「使用者 searchUrls ＋ 全域 searchUrls ＋
  `crawl_covers` 的 searchUrl」對照 **`listings` 實際存在的 search_key** 展開 ✓
  （`expandSearchKeysAgainst(stored, keys)` ✓、**零語意漂移** ✓、且**不掃 SQLite** ✓、也不用對不存在的鍵發查詢 ✓）。
- ⇒ 這個查詢**語意上必要** ✓（不能直接刪 ✗），但現行寫法對 **122,925 列**做 `DISTINCT` ✗
  ⇒ 無 `search_key` 索引時就是**全表掃描 ＋ 去重** ✗。
- ⇒ **較好的修法（等價、免索引）** ✓：改成 `WHERE search_key = ANY($1)` ✓（只針對手上的鍵 ✓）
  ⇒ 語意等價 ✓（見下「待確認」✓）、掃描量從 12 萬列降到數列 ✓。
- ⇒ 備援修法 ✓：為 `search_key` 建索引（走**既有發布權限** ✓，astra：索引套用沿用發布流程 ✓）
  ⇒ 變成 index-only scan ✓；但**先做免索引的那個** ✓（改動更小、可本地驗證 ✓）。
- ⇒ **待確認（下一批第一步 ✓）**：`expandSearchKeysAgainst(stored, keys)` 是否**只做成員判定** ✓
  —— 若是 ✓，`= ANY(keys)` 完全等價 ✓；若它還需要「stored 的其他性質」✗，就不能這樣改 ✗
  （**先讀再改** ✓，不猜 ✓）。


