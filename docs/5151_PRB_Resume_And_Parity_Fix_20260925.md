# PR-B 接續裁決：終端恢復、fixture 修正與完整驗收

適用：Fyun48/5151，PR #497，分支 `fix/pr-b-persist-listing-transaction`。查核日期：2026-09-25。

**給 DeepSeek 的執行指令：讀完本文件後，承接同一 PR，依序完成修正、驗收及 PR 本文。日常程式修改、隔離測試、commit／push 與 CI 修復不需再逐項詢問 Owner。遇到可自行排除的問題直接處理，完成一批就接著下一批；僅在所有必要工作完成，或工具／權限限制確實使工作無法繼續時交棒。沿用未 merge、未部署正式環境的範圍。**

## 1. 已查核的狀態與本次決定

查核的遠端 HEAD 為 `dfdcff4f86bf2f362d90599f4c2e516befd32133`；PR 仍開啟、未合併。`79da249` 是先前檢查點，不是本次 PR 的 merge base；GitHub 回報 base SHA 為 `9c6b7b04f9801717cb6696e8e095fde4c309473f`。

| 同 HEAD 的 CI | 結果 |
|---|---|
| 一般 Tests | 2,612 tests；2,585 pass；0 fail；27 skip |
| PostgreSQL integration | 116 tests；114 pass；1 fail；1 skip |
| PG 唯一失敗 | `listing-search-parity.test.js`：`PG fixture 必須在位（實際 0）`，預期 3 |
| PG 的 1 skip | 需要正式資料影子庫的 `PG_SHADOW_URL` 測試；不屬於此 CI 必要 gate |

目前狀態是 **NOT_READY_FOR_REVIEW**。終端阻塞若屬實，可以暫停執行；但 parity 仍有已定位的程式錯誤，B4、fail-closed 與其餘驗收也尚未完成。

已推送的測試沒有 `PARITY-PG-TARGET` 診斷。遠端無法證明它是否存在編輯器緩衝區或工作樹，不能保證「無資料遺失」。先保存／查核，不要盲目提交這個診斷。

## 2. 直接修正：source_key 綁錯參數

現行 INSERT 每列使用 6 個參數，卻將 `source_key`、`search_key` 都指向同一個參數：

```text
欄位：post_id  source  source_key  search_key  title  url  first_seen_at  last_seen_at  offline
首列：$1       '591'   $2          $2          $3     $4   $5             $6            0
$2 的實際值：r.search_key（591 搜尋網址）
```

SQLite 寫入的是 `source_key = parity|0/1/2`；PG 寫入的卻是搜尋網址。隨後查 `WHERE source_key LIKE 'parity|%'` 得到 0，是這個錯誤的直接結果，**不能據此判定 INSERT 沒有落地、寫錯 database 或 ON CONFLICT 跳過資料**。

本次已擷取已提交 INSERT 的實際 SQL／參數生成邏輯，在本地驗證三列都綁錯，修正後三列九個欄位全部對應正確。這是參數生成驗證，尚非修正後的真 PG 整合測試。

最小修法：每列改為 7 個參數，欄位順序如下；保留必要的 upsert 更新。

```js
const values = seeds.map((_, i) => {
  const n = i * 7;
  return `($${n + 1}, '591', $${n + 2}, $${n + 3}, $${n + 4}, $${n + 5}, $${n + 6}, $${n + 7}, 0)`;
}).join(",");
const params = seeds.flatMap((r) => [
  r.post_id, r.source_key, r.search_key, r.title, r.url,
  r.first_seen_at, r.last_seen_at,
]);
// INSERT 欄位順序維持：
// post_id, source, source_key, search_key, title, url, first_seen_at, last_seen_at, offline
// 將原 VALUES 與參數陣列換為 values／params；ON CONFLICT 不可留下不同的 fixture 欄位。
```

不要把計數改成 0、不增加 skip，也不要只修改 LIKE 的條件來掩蓋兩邊不同的資料。

**先按本次 seed 的確切 post_id 讀回兩邊資料，逐欄比對 canonical fixture。** PG 可使用 `post_id = ANY($1::bigint[])`，傳入 `[seeds.map(r => r.post_id)]`。既驗證三筆都在，也驗證 `source_key` 與 `search_key` 各自正確；全表 prefix count 不能取代這個檢查。

## 3. 同一批完成測試前提，避免逐個診斷 commit

| 項目 | 執行要求 |
|---|---|
| 測試連線 | 明確用 `createPostgresDriver({ connectionString: process.env.PG_TEST_URL })`。現行 `PG_TEST_URL` 僅控制 skip，driver 卻讀一般環境，存在兩個 URL 不同時連錯目標的風險。只用拋棄式測試庫，不輸出完整 URL／密碼。 |
| schema 順序 | 先準備所有必要 schema，再 seed settings／listings。目前先 INSERT settings、後 ensure settings 的順序要修正。 |
| fixture 隔離 | 兩 driver 使用相同的資料、使用者與 settings；避免其他測試殘留的 users／settings／covers 改變 searchKeys。準備與斷言都納入 try/finally，失敗也釋放連線、清理自己建立的資料。不得清空共享或正式資料。 |
| 行政區／顯示條件 | `districts: []` 會由 settings 推導會員行政區，不保證代表全庫。依已知 URL 的區域建立有效的 district／地址及顯示所需欄位；直接斷言預期可見 ID，不用反覆猜 URL。 |
| 時間 | 使用固定 fixture 時間與同一 asOf，不能以每次 new Date() 充當決定性驗證。 |
| 結果契約 | 明確斷言 `listings` 是陣列、`totalMatched` 是有效整數；移除「任何回傳形狀都容忍、缺值就 []」的輔助函式。 |
| 有效案例 | 三列、limit=20 的第二頁必為空，不能證明分頁正確。最小案例可改 limit=2，明確預期第二頁有資料，再加入配對 winner、個人 flags、uid≠voteUid 等既定必要案例。 |

`PARITY-PG-TARGET` 可保留必要且不洩密的目標資訊，但它不是下一步前置條件。先修已知綁定錯誤，再執行完整的 fixture 準備與搜尋；同批處理實際出現的後續失敗。

## 4. 語意參考與正式入口分開驗證

現行 SQLite 呼叫 `searchListingsAsync(..., {driver: "sqlite"})`，可能先走 `listListingsSqlFirst()`；PG 正式入口則固定 `node_pg`。SQLite SQL-first 的 builder 從 `listing_search_projection` 讀取，本測試卻只直接 INSERT `listings`。**僅把 listing seed 寫對，還不能保證這個測試前提完整。**

裁決如下，這是釐清原本 parity 驗收的參考管線，不是放寬 PG 正確性：

1. 核心語意 parity：SQLite 的 Node 參考函式 `listListings(args)` 對照 PG 正式 `searchListingsAsync(args, {driver: "postgres", pgDriver})`。PG 端不覆寫 deps／candidateColumns／decorator，不繞過正式 context 與單一快照。
2. 各個重要案例先有人工確定的預期 ID、順序、角色與 flags，再檢查雙向一致；兩邊相同不代表兩邊都正確。
3. 正式 SQLite dispatcher 另作入口相容性驗證：若實際走 SQL-first，必須建立所需投影與關聯，標示引擎。既有 SQL-first 的已知配對語意差異不能變成修改 PG 正確結果的依據；該差異需要記錄及正確的回歸案例，不能以 skip 或改名當已解決。
4. 分頁以對外契約驗證每頁內容、順序、hasMore 及遍歷後無遺漏／重複。nextCursor 若只屬某引擎的能力，先確認 API 契約；不要求不同機制的 token 字串相等，也不能無說明地刪掉應有的契約測試。

修完參數後仍可能有上述資料與管線問題；目前沒有證據承諾「改這一行，所有 parity 就會綠」。

## 5. 終端恢復：保護未提交內容，再繼續

先使用編輯器可用的存檔／匯出功能保留未提交內容，尤其尚未確認落盤的 diagnostic diff；無法讀回時標示未確認。不要 reset／clean、重建容器或刪除工作目錄。

若工具允許，在同一工作環境建立新的終端／PTY，做一次有超時限制的非互動探針：

```bash
/bin/bash --noprofile --norc -c 'printf "SHELL_ALIVE\n"'
```

只回顯指令而無 stdout／exit code，能證明該執行通道沒有提供正常結果；不足以判定整台 NAS 或所有 shell 都失效。新的執行通道仍不可用時，停止重複探針；若平台要求 Owner 開新任務，只需一次，並沿用原工作目錄與本文件。不要聲稱平台限制已自行解除。

終端恢復後，在 `/workspace/repos/5151` 分別執行：

```bash
git status --short --branch
git log -3 --oneline
git diff -- v3/test/listing-search-parity.test.js
git diff --cached -- v3/test/listing-search-parity.test.js
```

先對照本地與遠端最新狀態、確認編輯器內容已保存，再整合修正與必要診斷。不要直接照舊交接執行 `git add && git commit`；可能尚未存檔、已提交，或已被新修改取代。

能用既有 GitHub 工具查 CI／檔案時可以繼續做唯讀工作，不必等 shell 才確認遠端狀態。尊重既有存取控制，不以恢復終端為由繞過權限。

## 6. 接續順序與完成條件

1. 保存／核對工作樹，完成第 2～4 節的修正與非空、雙向 parity。
2. 完成 B4：同一 asOf 真正傳入相對時間、primary 比較與排序；候選順序確定。context 多一個欄位不算完成。
3. 完成 fail-closed：缺必要 provider／PG context／schema 時報出明確失敗，正式 HTTP 層驗證 503 與穩定錯誤碼；合法的空資料仍是正常空結果。不可回退 SQLite。PG 熱路徑 SQLite 存取嘗試為零。
4. 完成原 §6.5 取捨：保留有證據且不改結果的優化；不追逐假 driver 的 ≤12 次查詢，也不強制合併裝飾查詢。已撤回的窄欄位、跨請求 memo、全域存在性快取維持撤回，除非另有完整證據支持安全的新設計。
5. 完成原 §6.6：新版程式、固定 fixture／資料快照、暖機至少 5 次，再量測至少 50 個完整請求；C1／C4、單區／全區、lag、RSS、query count、timeout／error 均有證據。不得以舊部署版代替本分支。
6. 清掉過期的 fallback／SQL-first 註解；完成既定診斷模組隔離。改寫 PR 本文、gate 表與接續檔為最終實際狀態。
7. 成組提交／推送；等待最終同 SHA 的必要 CI 完成，修正所有必要失敗。不要每加一行診斷就 push、取消前一個 run；失敗不可用 skip、放寬斷言或反覆重跑掩蓋。

沿用既定效能目標：同級 NAS warm p95，單行政區 C1≤1s／C4≤2s，全區 C1≤2s／C4≤4s；event-loop lag p99≤50ms、max≤100ms。GitHub 固定 fixture 的 C1 smoke 為單區≤2s、全區≤4s。硬體與資料規模分開記錄，不能互當證據；查詢數 ≤12／通勤≤16 仍是優化目標，不凌駕正確性。

需要正式環境權限才能完成的量測，先用隔離環境完成所有可做工作，再一次列出未取得的證據。不得把未跑、紅燈或不具代表性的量測改寫成 PASS。

**最後交付只有兩種：**

- **READY_FOR_REVIEW**：必要修正與驗收齊備，同 SHA CI 完成，附證據；保持未 merge、未部署，交 ChatGPT 最終審查。
- **BLOCKED**：平台／工具／權限等真實外部限制仍在，附已保存狀態、已完成項目、未完成項目，以及 Owner 一次即可處理的具體動作。不要把「等 Owner 說請繼續」列為阻塞。

以上安排無法保證跨 session 的背景執行；若平台強制停止，保存接續狀態並如實交代，不假裝仍在工作。

## 查核來源

- [PR #497](https://github.com/Fyun48/5151/pull/497)
- [已查核 HEAD 的 parity 測試](https://github.com/Fyun48/5151/blob/dfdcff4f86bf2f362d90599f4c2e516befd32133/v3/test/listing-search-parity.test.js)
- [同 HEAD 的 CI run](https://github.com/Fyun48/5151/actions/runs/36143500377)，PG job `108098792570`、一般 job `108098792298`。
- 同 HEAD：`v3/src/dbDriverPostgres.js`、`listingSearchAsync.js`、`listingSearchNodePg.js`、`listingSearchSql.js`、`db.js`。
- 延續 `docs/runbooks/5151_PRB_DeepSeek_Continuous_Execution_20260925.md`；本文件補正 fixture 診斷與語意參考的選擇，其餘已定事項延續。
