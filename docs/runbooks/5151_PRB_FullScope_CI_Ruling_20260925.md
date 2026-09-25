# PR-B 全區查詢、CI 與正確性裁決
日期：2026-09-25  
對象：DeepSeek／5151 維護者  
核對版本：PR #497，HEAD `7944ab63ba827007f55fafa7015146a1d07f22a5`

這次選 **(a)：先取真實執行計畫，再依瓶頸選索引或等價的查詢改寫**。不恢復未通過語意驗收的 SQL-first，也不截斷候選集合。可直接依下列順序繼續，不必再等待架構選路。

本次已讀取精確 HEAD 的程式、handoff、GitHub Actions 記錄，並以抽出的原始函式做三個隔離探針；**沒有登入 NAS 或重跑生產效能**。本文的毫秒門檻是工程目標，不是已達成的成績。

## 1. 三項決策

| 題目 | 決定 |
|---|---|
| 索引／查詢形態 | 選 (a)。`kind_tokens + GIN` 延後；目前這句候選 SQL 沒有 kind 述詞，該索引無法直接解決它。允許依計畫改寫查詢，但必須保持候選集合、角色判定、總數與排序語意。 |
| p95 目標 | 單行政區：完整搜尋 warm p95，C1 ≤ 1 秒、C4 ≤ 2 秒。全區：新增第一階段目標，C1 ≤ 2 秒、C4 ≤ 4 秒；獨立列報，不用行政區小案例代替。量測規格見 §4。 |
| sql_pg | 保留實驗實作及對照測試；移出正式入口的引擎分支。由獨立測試 helper／診斷腳本直接呼叫，不能透過正式 handler、環境變數或 options.engine 切入。 |

`districts: []` 不一定等於全區：目前 `resolveListDistrictNames()` 還會使用 settings 的會員行政區。因此必須分開測「空請求名單但會員有設定行政區」與「最終解析出的行政區確實為空」。後者不加行政區子句可以是正確語意，不能把它本身當成程式缺陷。

同理，**Sequential Scan 並不自動代表缺索引**。讀取大量資料時它可能合理；要看實際 rows、loops、buffers、等待與傳輸成本，才能決定修改方向。[PG 16 EXPLAIN 文件](https://www.postgresql.org/docs/16/using-explain.html)

## 2. 先修正兩個仍存在的正確性缺口

### 2.1 watched 仍會呼叫 SQLite

HEAD 的 `v3/src/db.js`：
- `buildListListingsClauses()` 在 watched 分支仍呼叫 `applyBrowseIsolation(clauses, params, sqliteDb, "listings")`。
- `stage1FixtureIsolation.js` 內接著呼叫 `db.prepare("PRAGMA table_info(listings)")`。
- 即使 request context 已帶 `isolation`，這個分支也沒有使用它。

本次隔離執行該 HEAD 的 builder，提供 PG context，仍記錄到 **1 次 `PRAGMA table_info(listings)`**。因此「搜尋熱路徑零 SQLite」尚未完成。

**修法：** watched 使用 request context 的 isolation；PG 缺必要 context 時明確失敗。保留 watched 不受行政區、價格、一般顯示篩選限制的既有契約。測試必須計數 SQLite 存取嘗試且斷言為零；只讓 stub 拋錯不夠，因為 `tableColumns()` 會吞掉例外並可能退成 `1=1`。

### 2.2 flags 身分只測到 SQL builder，PG 後處理仍用錯身分

`listingSearchNodePg.js` 的 `searchListingsNodePgInner()` 仍執行：

```js
loader.personalFlagMap(voteUid)
```

然後把這個 map 傳入 `buildListListingsRows()`。但是 SQLite 參考管線在同一位置用 `loadFlagMap(db, uid)`，新增的身分契約註解也明訂清單狀態屬於觀看者 uid。

本次對原始 inner 函式的隔離探針：`uid=101`、`voteUid=202`，實際 flags loader 收到 **202**。現有 `listing-search-flags-identity.test.js` 三項只檢查 builder 的 SQL／params，抓不到這個消費端錯誤。

**修法：** 清單 overlay 的 flagMap 改依 uid 載入；配對投票／split／關係所需的 voteUid 保持原契約，不要全域取代。另逐一核對頁面裝飾的 flags 消費者。加入真正走完搜尋管線、兩人 flags 相反的 fixture，至少涵蓋 hidden／viewed／watched 與回傳卡片狀態。

兩項修正完成前，§0.2 與身分契約都不能標記全數驗收通過。

## 3. CI 現在的紅燈不只是效能問題

已核對 [Tests run 36102593979](https://github.com/Fyun48/5151/actions/runs/36102593979)，對應上述 HEAD：

| Job | Pass | Fail | Skip | 重要證據 |
|---|---:|---:|---:|---|
| Run Tests | 2541 | 3 | 23 | 兩個原始碼文字檢查失敗；通知 parity 的 SQLite 模擬 executor 不懂新增的 PG array cast。 |
| Run Tests (PostgreSQL) | 2530 | 17 | 20 | 搜尋 canary 是 `42P01: relation "settings" does not exist`，不是 57014；20 個 live PG 測試仍因未設 PG_TEST_URL 被跳過。 |

此外，workflow 明確設定 **`PG_STATEMENT_TIMEOUT_MS: "300000"`（5 分鐘）**，不是 driver 預設 15 秒。不要再以「CI 沒設 env，所以必踩 15 秒」解釋本次 CI。

修正順序：

1. 保留原有一般測試 job 的 driver 隔離；不要用 job 全域 `DB_DRIVER=postgres` 強制所有 SQLite／預設 driver 測試改走 PG。建立明確的 PG 整合測試入口，納入原有 live PG 測試，避免藉拆 job 漏測。
2. PG service 固定 image 版本或 digest；就緒後套正式 schema／migration，載入可重現 fixture。避免並行測試共用可互相清空的資料；必要時使用各自的測試 database 或一致設定 search_path 的隔離 schema。
3. 統一測試連線契約。若現有測試使用 PG_TEST_URL、應用 driver 使用 PG_URL，兩者都指向本次 CI 的拋棄式 PG。這是 CI 本地測試密碼，**不需要生產 NAS 的 PG_URL，也不要把生產連線交給 Actions**。
4. required PG job 遇到連不上、缺 schema、必要測試 skip 必須失敗。移除 canary 對 `42P01` 的 catch-and-return；不要讓 `PG_SKIP_CANARIES=1` 繞過必要 gate。
5. 修正 canary 計數位置：實際 snapshot 使用 `pool.connect()` 後的 **client.query**；目前只包 `drv.query`，因此即使搜尋完成，`queries` 仍可能為 0。本次原始 snapshot 探針得到：取連線 1 次、client.query 3 次、wrapper.query 0 次。應包住回傳 client 的 query，保留 release，並把交易控制 SQL 與資料查詢分開計數。
6. 修正一般 job 的三個失敗。原始碼位置／字串斷言改成有意義的行為驗證；通知 parity 更新 executor 的 PG array 表達支援，或改用真 PG fixture。不能為了舊模擬器而撤回正式陣列綁定。

**修索引不會自動解決以上 CI 缺陷。** 修正前維持紅燈是正確的，但紅燈不能被算成已通過的回歸保證。

## 4. 效能量測與 EXPLAIN 的具體做法

### 4.1 先修探針，讓它真的測到所標示的能力

目前兩支探針都把 `areaMax`、`wholeFloorOnly` 放在 args 最上層，卻同時傳入 `settings: {}`；真正的顯示篩選讀的是 settings，且 wholeFloorOnly 要 boolean。改成：

```js
{ settings: { areaMax: 30 } }
{ settings: { wholeFloorOnly: true } }
```

為每個能力放入一筆必定被排除的 fixture，斷言它確實生效。這不表示應把這些條件搬到角色判定之前；目前候選 SQL 不縮小集合可以是刻意保留語意的設計。

另外：
- `pg-stage-forensics.mjs` 尚未把每次回傳的 `queryDetails` 各階段數值輸出，也沒實作所註解的 PG 查詢計數；補齊後才可定位 preload 或 Node 耗時。
- `pg-explain-forensics.mjs` 例外時的 `failedAfterMs` 目前可能回報 EXPLAIN 耗時，應從失敗階段開始時計時。
- 普通 EXPLAIN 仍可能受 statement_timeout 影響；不要保留「只規劃所以不受 timeout 影響」的註解。
- 57014 表示查詢取消；保留伺服器訊息與實際 timeout 設定，才能區分 statement timeout 與其他取消來源。

### 4.2 取證

固定 SHA、fixture／資料版本、uid、voteUid、settings、searchKeys、解析後行政區與 asOf。擷取正式 builder 的 SQL，不手寫一個近似版本。

同一條待測查詢收集：
- 參數數量／型別、候選數、實際 `statement_timeout`、backend pid。
- `EXPLAIN (VERBOSE, FORMAT JSON)`。
- 可在既定閘門完成時，再取 `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)`。
- 查詢 wall time、連線池等待、rows、各 Node 階段、完整回應時間。

ANALYZE 會真的執行 SQL。若 3 秒就被取消，不會得到完整實際計畫；在受控資料副本分析長查詢，生產端維持既定取證限制。不要關閉 timeout，也不要強迫禁用 seq scan 來做出漂亮計畫。

優先核對 flags 相關重複 subplan、`hpDisplayReadySql`／listing_prep、來源與隔離述詞、統計估計偏差，以及實際有無必要索引。**這些是待驗證的方向，不是已確診熱點。**

若 flags 的逐列 scalar subquery 是熱點，且已確認 `(user_id, post_id)` 唯一，可評估一次 LEFT JOIN 或等價 EXISTS 改寫；缺列與 NULL 語意都需一致。若成本主要是傳輸／Node，優先縮減候選欄位與重複 preload；不新增無關索引。

### 4.3 量測門檻

C1＝單一並行請求；C4＝四個並行請求。完整搜尋時間涵蓋 pool 等待、PG、Node 後處理及回應序列化，不含使用者外網傳輸。暖機與量測分開，至少暖機 5 次、量測 50 個完整請求；冷啟另列，不能用 1 次或 5 次宣稱穩定 p95。

| 指標 | 固定規模／同級 NAS 的工程目標 |
|---|---|
| 單行政區，完整搜尋 warm p95 | C1 ≤ 1 秒；C4 ≤ 2 秒 |
| 全區，完整搜尋 warm p95 | C1 ≤ 2 秒；C4 ≤ 4 秒 |
| 候選 SQL 的 client wall p95 | C1 ≤ 1 秒；診斷單句 timeout 3 秒 |
| 每請求資料查詢數 | 一般 ≤ 12；通勤 ≤ 16；交易控制語句另列 |
| Node event-loop lag | 目標 p99 ≤ 50 ms、max ≤ 100 ms；同時記錄量測視窗與並行度 |

全區目標是本次新增的初始門檻；尚未證明現行架構能達到。若 EXPLAIN 與全管線結果顯示需要進一步設計，回報瓶頸及下一個精確方案，不以截斷、放寬 timeout 或改標籤通關。全區 RSS／heap 峰值另列，在沒有測得部署記憶體餘裕前，不把單行政區的 +64 MiB 成績套用過去。

GitHub-hosted CI 跑固定、具代表性的資料集：總量約 12 萬列，包含全區大候選、約四成有配對、跨區 peer、多使用者相反 flags、長關係鏈及時間邊界。CI 單行政區 C1 p95 ≤ 2 秒、全區 C1 p95 ≤ 4 秒作 smoke 門檻；受控 NAS 的 C1／C4 成績是另一份必要驗收，兩種硬體數字不混比。效能 job 與其他重型測試分開跑。

最小案例：單區 baseline、單區 q、全區 baseline、全區 q、四個能力確實生效的案例，以及 watched／hidden／uid≠voteUid 的正確性案例。查詢逾時、PG 錯誤、結果漂移均 fail。每句 timeout 與整個請求的期限分開計算。

## 5. 必須更正的根因敘述與驗收方式

1. **PG 16 的 query parameter 上限是 65,535，不是 32,767。** 單憑 36,306 個 placeholder 不能證明超過 PG 協定上限。請記錄真正的 `params.length`、最大 placeholder 編號與原始錯誤；錯誤訊息中的 format count 不必然等於應用原本傳入的清單長度。[官方 limits](https://www.postgresql.org/docs/16/limits.html)
2. **保留 ANY(bigint[]) 的修正方向。** 增加真正跑到四個 loader 的大清單測試，包含超過 32,767 與超過 65,535 個 ID，驗證回讀集合完整。若新一輪在候選 SELECT 就以 57014 結束，它根本尚未執行後面的 loader，不能用「錯誤碼變了」單獨證明陣列修復已通過。
3. 舊 `sql_pg count` 的 30 秒斷線、新 `node_pg` preload 的 08P01、新全區候選的 57014 是**不同 SQL／階段的三組事件**。目前已定位全區候選的超時案例；尚未足以將歷史 30 秒斷線一律歸為相同原因，更不能直接宣稱 4.5～10 倍優化。
4. `onlySqlite=0`、`onlyPg=22` 且兩側使用者資料不同，只能說明不具可比性與一個合理差異來源，不能稱為「零語意漂移」驗收。需同一 fixture／快照、雙向集合差為零、totalMatched 相等，再檢查順序與回傳狀態。
5. B4 的固定 asOf 與決定性排序應在最終效能／parity 封存前完成。REPEATABLE READ 固定資料快照，並不自動固定 JavaScript 現在時間；單純新增 ORDER BY 也需確認不改變依輸入順序處理的配對結果。
6. 正式 `listingSearchAsync.js` 目前仍接受 `options.engine === "sql_pg"`。移除 env 已有進展，但「正式模組沒有選擇入口」尚未完成。把 SQL 實驗 dispatcher 搬到 test helper／診斷腳本；不以 `NODE_ENV=test` 或隱藏 HTTP 參數充當隔離。SQL 實驗不支援某案例時回報 unsupported，避免偷偷改跑 Node 後把成績標成 SQL。

## 6. 可直接執行的工作順序

1. 修 watched 的 SQLite 存取、uid／voteUid 消費端，補全管線行為測試。
2. 修 CI schema／fixture／driver 隔離／PG_TEST_URL／必要測試不得 skip，以及 client.query 計數。
3. 修量測參數與階段記錄；完成 B4，取得全區真實計畫與暖機基線。
4. 只針對已定位瓶頸實作等價改寫或索引，在鏡像／CI 驗證。
5. 移出正式 sql_pg 分支；以同資料雙向 parity、零 SQLite 嘗試、單一 client／快照、查詢數與分級效能 gate 封存證據，再更新 PR 本文。

可以並行收集 EXPLAIN 與修 CI；正確性及測試基礎必須先通過，才可宣告 PR-B 完成。程式與測試可繼續做；正式 NAS 的設定、索引套用及部署沿用現有發布權限，本文不增加生產變更授權。

## 7. 證據索引

- [PR #497](https://github.com/Fyun48/5151/pull/497)
- [PG job：17 fail、20 skip](https://github.com/Fyun48/5151/actions/runs/36102593979/job/107968112403)
- [一般 job：3 fail](https://github.com/Fyun48/5151/actions/runs/36102593979/job/107968112564)
- [精確 HEAD 的 workflow](https://github.com/Fyun48/5151/blob/7944ab63ba827007f55fafa7015146a1d07f22a5/.github/workflows/test.yml)
- [PG canary](https://github.com/Fyun48/5151/blob/7944ab63ba827007f55fafa7015146a1d07f22a5/v3/test/pg-provider-canaries.test.js)
- [PG Node 管線](https://github.com/Fyun48/5151/blob/7944ab63ba827007f55fafa7015146a1d07f22a5/v3/src/listingSearchNodePg.js)
- [共用 builder／後處理](https://github.com/Fyun48/5151/blob/7944ab63ba827007f55fafa7015146a1d07f22a5/v3/src/db.js)
- [隔離政策的 SQLite schema 探測](https://github.com/Fyun48/5151/blob/7944ab63ba827007f55fafa7015146a1d07f22a5/v3/src/stage1FixtureIsolation.js)
- [DeepSeek 的本輪 handoff](https://github.com/Fyun48/5151/blob/7944ab63ba827007f55fafa7015146a1d07f22a5/docs/handoffs/pr-b-30s-forensics-and-preload-layering-20260925.md)

隔離探針結果（讀取上述 SHA 的函式，以 stub 觀測呼叫；不是 live PG 測試）：

```json
{
  "watchedSqliteCalls": ["PRAGMA table_info(listings)"],
  "canaryCounter": {"wrapperQueries": 0, "clientQueries": 3, "connects": 1},
  "flags": {"viewerUid": 101, "voteUid": 202, "actualFlagLoaderUid": 202}
}
```

