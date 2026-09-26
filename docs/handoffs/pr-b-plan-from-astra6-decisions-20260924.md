# PR-B 實作計畫（依 astra6 決策文件 `docs/runbooks/5151_PRB_Decisions_20260924.md`）

審閱基準：PR #497 @ `9e621b9`。以下把該決策文件轉成**可追蹤的工作項**，順序照文件要求排定。

## A. 已接受的更正（我原文件的事實錯誤）

| 我原本的說法 | 更正後（astra6 §1.1-1.5）| 處置 |
|---|---|---|
| 「生產 PG 第一頁有 30% 重複」 | **量測其實在生產 SQLite 快照（`/data/v3.db`）上**，是「同一 DB、兩條管線」的比較 ⇒ 是有效的**語意反例**，但不是 PG 的直接測量 | 已在 `pr-b-sql-node-divergence-measured-20260924.md` 加更正；PG 事實另量（見 B1）|
| `primary_listing_id` 當成「已選出的 primary」 | 其來源是 `Number(row.match_post_id) || 0` ⇒ **只是 peer 指標** | 文件與後續命名改為 peer 語意 |
| 配對只受 per-user split 影響 | `attachSameHouseRoles` 後半段**還會依使用者自己的同屋源群組重算並覆寫角色** | 不得用「全站共用角色＋split 例外」近似 |
| 角色是一次性事實 | `listingRefreshAt(row, now)` 以**查詢當下**解讀相對時間 ⇒ 角色會隨時間改變 | 不得回填一次絕對時間（會改變現行為）|
| 結果只取決於單列投影 | 候選**順序**也影響（鏈狀配對 A→B→C 的實測反例）| 需固定 `asOf` 與明訂候選順序，且**獨立**留 fixture／變更說明 |

## B. 工作項（依序）

### B1. PG 端事實量測（已完成）
`西屯區`：候選 **6,226**、帶 peer 指標 **2,581（41.5%）**、peer 落在同一候選集合內 **2,526（40.6%）**
⇒ 40.6% 是「可能被 Node 排除」的**上界**（實際排除需 Node 角色推導）。腳本：`/tmp/pg-affiliate-facts.mjs`（將入 repo）。

### B2.（緊急）停止未經完整管線 parity 的 SQL-first 入口
- 觸發條件**已成立**（已有反例），不必等更多客訴或比例門檻。
- 實作：`listingSearchAsync.js` 的 unsupported-query 分支（`if (!page) …`）**不得**再走 `searchListingsSqlite`；
  catch 的 `options.sqliteFallback` **不得**成為正式入口可達的逃生門。
- **與 PG＋Node 實作及效能檢查一起交付**，不是只翻舊 fallback 開關。

### B3. 新能力 `searchListingsNodePg`（PG-fed Node）
- 候選列、peer、personal groups、split votes、個人旗標、`listing_prep`、來源啟用設定**全部取自 PG**，
  **同一個一致快照**；provider 缺資料時**不得暗中讀 SQLite**。
- 使用共用純 Node 業務函式，依參考管線順序完成配對、個人覆寫、篩選、排序、計數**之後**才取頁面；
  **不得**先 `LIMIT 300` 再過濾，也不得用任意候選上限截斷 total。
- 降級開關只允許 `sql_pg` / `node_pg`（**不得**切換資料來源）；PG 失敗一律 503 與既有穩定錯誤碼。
- 效能：量 p95／RSS／event-loop lag／PG 查詢數；用必要欄位與批量 preload；分批也要保留完整配對上下文與一致快照。

### B4. 確定性化（獨立變更）
- 共用 Node 參考管線固定一次 `asOf`；配對階段使用明訂候選順序（例如數值 `post_id ASC`）。
- 留 fixture 與變更說明；**不得**把 SQLite 偶然列順序當業務規格。
- **不做**匹配邊的傳遞合併（A-B、B-C ≠ 三筆同群）。

### B5. 驗收（強化版，原生標準不足）
1. 固定 fixture／一致快照、同一使用者與設定、同一 `asOf` 下，**完整結果的雙向差集皆為空**（非只比第一頁）。
2. 排序後完整 ID 序列、頁邊界、重複 ID、`totalMatched`、`hasMore`、分頁續接；含最後一頁／空頁／不同 limit/offset。
3. 卡片角色、primary ID、primary offline、split／personal 標記與展開同屋源資料一致。
4. 覆蓋：單向／反向配對、鏈／環、orphan、peer 在候選或頁面外、主卡 offline、prep 未就緒、來源關閉、
   split、兩使用者不同合併/拆分、租金缺失、含額外月費、完全平手、Unicode tie key、相對時間跨絕對時間。
5. 所有 filter × source × district × kind × q × price 組合以**完整正式管線**驗證。
6. 兩層測試：同 fixture 在 SQLite/PG 的**資料契約** parity；同一 PG fixture 在 Node/SQL 的**查詢管線** parity。
   **不得**把會變動、時間不同的 SQLite 快照或正式 PG 當等價 oracle。
7. 注意例外：`hidden`／`watched` 在 `listingIsMainMainAffiliate` 有例外；online affiliate 在主卡 offline 時也有例外
   ⇒ 不可一律 `WHERE role <> 'affiliate'`；`watched` 保留獨立管理清單行為。

### B6. 修正版 C（後續；投影只存共用比較輸入）
- 不新增「永久最終角色」；角色在**查詢時**決定。
- 欄位集合（最小）：peer（`peer_post_id`／`match_verdict`；既有 `primary_listing_id` 標為 peer 語意、建反向索引）、
  共用 `comparableRent`（不得只用 `rent`；保留「未知不贏有效月費」）、
  `refresh_basis`＋`refresh_value_ms`（查詢固定 `asOf` 才計算；不可回填絕對時間）、
  tie-break 原語意輸入（`last_seen_at`／tie key；Node `localeCompare` 與 PG collation 未證明等價前留 PG＋Node）、
  peer 顯示依賴（`offline`／`source`／prep 狀態）、`projection_version` 與 input revision。
- 順序：抽共用純函式與 fixtures（先可重現）→ 相容新增欄位並維護 revision → 分批可續跑回填
  （防舊快照覆寫、確定性失敗列有限重試）→ 同資料完整雙向差分 → 逐能力開放。

### B7. CI（GATE-12）
- GitHub-hosted runner ＋ PostgreSQL **service container**（16.14、固定 digest、驗證實際版本），
  用 repository 讀的 **`PG_TEST_URL`**；DB 命名 `5151_ci`；**禁止**在 CI 範例出現 `5151_shadow`。
- 新增必跑 PG 模式：缺 `PG_TEST_URL`／PG 不可連／migration 失敗／具名 PG 測試被 skip ⇒ **CI 失敗**。
- 需要 standby 行為時另建隔離 primary＋standby job；單一 service container 不能證明 HA。

### B8. PITR（pgBackRest，規劃基準）
- 每日 full＋連續 WAL、**14 天可還原窗口**（time-based retention）；repo 與 PGDATA 分離、優先不同 NAS；
  兩節點都要能在自己成為 primary 時封存；測該台故障情境與告警。
- 修掉現有 runbook 的缺陷：`test ! -f && cp` 的成功語意錯誤、未驗證承諾（成本可忽略／秒級重啟／60 秒 RPO）、
  演練改用**目標時間前後的交易標記**並記錄 target／timeline／實測還原時間、target 必須落在可還原範圍、
  tar-format 備份的完整性、回退不得「人工清除 WAL」。
- 先備 30 分鐘低流量窗口（實際停機以演練為準）；先處理 standby 並確認追上，再處理 primary；不可同時重啟兩台。

## D. B3 實作規格（已讀過程式接縫，2026-09-24）

### D1. 為什麼不能用「複製一份後處理鏈」

`listListings`（`db.js`）目前是「SQLite 取候選 → 一串 Node 後處理 → 排序／分頁／計數」的單一長函式，
後處理鏈（`db.js:6460` 起）依賴大量閉包變數：`uid`／`voteUid`／`filter`／`kind`／`sources`／`settings`／
`districtSet`／`sort`／`listingInMemberScope`／`queryDetails`／`markStage`。
若在新路徑複製一份，之後任何修正都會分岔 ⇒ **必須先抽成共用函式**。

### D2. 要抽出的三段（行為保持不變，先用完整套件驗證）

| 抽出物 | 內容 | 驗證 |
|---|---|---|
| `buildListClauses(args, deps)` | 現有 clauses 建構（`searchWhere`／可見性／行政區／價格上限／filter 分支／q 等）| 與改動前 SQL 文字一致（可加臨時斷言比對）|
| `listPostProcess(raw, ctx)` | `loadFlagMap`／`overlayRowsPersonal` → filter 分支（`watched`／`offline`／`suspected`／其餘 `applyListingFilter`）→ `attachSameHouseRoles` → `listingMatchesListFilter` → `keepSelfListingForViewer` → 顯示篩選（含 `skipWholeFloor`）→ 行政區集合 → `matchesHousingKind` → `matchesListingSources` → fit 分數 | 既有測試全綠（特別是同屋源、個人旗標、顯示篩選相關）|
| `listSortPaginate(rows, ctx)` | 排序（`newest`／價格／`fit_desc`）＋ keyset/offset 分頁＋`totalMatched`／`hasMore`／`nextCursor` | 既有分頁測試（含 cursor 走訪）|

`listListings(args)` 改為：`buildListClauses` → SQLite 取候選 → `listPostProcess` → `listSortPaginate`。
**不得改變任何既有行為**；這一階段只有結構改變。

### D3. `searchListingsNodePg`（新能力）

```js
// v3/src/listingSearchNodePg.js（新增）
export async function searchListingsNodePg(args, { pgDriver, deps }) {
  const clauses = buildListClauses(args, deps);            // 與 Node 路徑同一份
  const raw = await pgQueryCandidates(pgDriver, clauses);  // 同一組條件，取「全部」候選（不得先 LIMIT）
  const exec = (sql, params) => pgDriver.query(toPostgresSql(sql), params).then(r => r.rows);
  const provider = await preloadDecorationProviderAsync({   // PG 版的裝飾資料來源（已存在）
    exec, rows: raw, settings: args.settings, userId: args.userId,
    matchVoteUserId: args.matchVoteUserId, sameHouse: args.sameHouse,
  });
  const flagMap = /* PG 版個人旗標（loader.personalFlagMap(voteUid)） */;
  const rows = listPostProcess(raw, { ...ctx, flagMap, provider });   // 與 SQLite 版共用
  return listSortPaginate(rows, ctx);
}
```

要點（依 astra6 決策）：
1. **同一份**業務函式；候選、peer、personal groups、split votes、個人旗標、`listing_prep`、來源啟用**全部從 PG**。
2. provider 缺資料時 **不得** fallback 到 SQLite（寧可 503）。
3. **不得**先 `LIMIT` 再過濾；不得用候選上限截斷 `totalMatched`。
4. 降級開關只允許 `sql_pg` / `node_pg`（不得切換資料來源）；PG 失敗 → 503 ＋ 既有穩定錯誤碼。
5. 效能要量：p95、RSS、event-loop lag、PG 查詢數（必要欄位＋批量 preload）。

### D4. 接線（B2 與 B3 一起交付）

`listingSearchAsync.js` 目前兩處仍指向 SQLite，必須同時改掉：

```js
if (!page) return searchListingsSqlite(args);                       // ← 改為 searchListingsNodePg(args, …)
...
if (options.sqliteFallback === true) return searchListingsSqlite(args);  // ← 僅測試用；確保正式入口不可達
```

`options.sqliteFallback` 不得有任何環境變數或正式路徑能開啟；測試專用選項要在型別／註解上寫明。

### D5. 這一階段不做的事

- 不動投影欄位（那是 B6）。
- 不動 SQL builder 的能力範圍（`sql_pg` 仍只服務已證明等價者）。
- 不做配對邊的傳遞合併。
- 不引入角色快取（astra6：第一版不值得）。

### D6. 風險與檢查點

| 風險 | 檢查點 |
|---|---|
| 抽出後處理鏈造成行為改變 | 抽完先跑完整套件（預期與 `1da20f5` 相同：僅 1 個已證明環境性失敗）|
| PG 候選查詢效能 | 量 p95 與 PG 查詢數；必要欄位與批量 preload；必要時分批但保留完整配對上下文 |
| 新路徑與舊路徑分岔 | 兩者共用同一份 `listPostProcess`／`listSortPaginate`；不允許複製 |
| 誤把測試用 SQLite 選項當逃生門 | grep 全 repo 確認 `sqliteFallback` 只出現在測試與註解 |


- 已完成：B1（PG 事實）；B2/B3 尚未開始（本計畫的第一步實作目標）。
- 先前已完成且不受影響：投影完整性歸零、`kind`／`q`／`sources`／`areaMax`／`wholeFloorOnly` 下推（各自等價性證據）、
  F2 的 503 與穩定錯誤碼、基礎建設知識庫與漂移自動記載。
- GATE-4 維持 **FAIL**（直到 B5 的完整雙向 parity 通過）。
