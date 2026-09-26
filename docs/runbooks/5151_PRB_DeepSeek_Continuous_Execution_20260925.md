# 5151 PR-B：持續執行至驗收的指令與技術裁決

日期：2026-09-25（台北時間）  
對象：DeepSeek  
範圍：Fyun48/5151，PR #497／PR-B  
本次核對 HEAD：`79da24939e40f3079fa05e0979284540f7312bc6`

請把 PR-B 視為一個持續任務，完成程式修正、測試、效能驗證及審查材料後，一次交給 ChatGPT 做最終審查。進度通知不代表交棒，不要再因一個 commit、一批測試或一個可回復的技術實驗，要求 Owner 回覆「請繼續」。

本文取代上一份裁決中「查詢數 ≤12 必須作為硬性通關數字」的解讀；正確性、PG 單一快照、禁止 SQLite 回退、效能與 Production manual-only 的要求仍有效。本文不是合併 PR 或部署正式站的批准。

## 1. 已決定，不必再問 Owner

| 事項 | 決定 |
|---|---|
| 13 筆是否一定要降到 12 | **不必。≤12 改列優化目標，不是獨立的發布阻擋條件。** 13 筆，或修正一致性後增加的必要查詢，都可接受；必須量出真實成本、消除逐列／逐群組 N+1，並通過正確性與端到端效能 gate。 |
| 是否合併裝飾查詢 | **可自行做可回復的分支實驗，但不是本批必做項目。** 先修已確認的正確性問題；若合併沒有可重現收益或造成結果膨脹，就撤回實驗，不必請 Owner 選擇。 |
| 23 欄窄投影 | **先撤回正式入口的窄欄位覆寫，恢復既有寬候選欄位作為修復基準。** 保留有用的審計工具；待完整 parity 證明後，再保留真正可刪的欄位，不追求固定的「23」。 |
| PG search_key 的跨請求 8 秒 memo | **本批撤回，改成請求／交易內重用。** 先保住單一快照，不以快取舊資料換取少一筆 SQL。版本化跨請求快取另案設計，這次不新增為前置依賴。 |
| 共享表存在快取 | **移除只有 table name 的模組全域快取。** 本批先使用請求內狀態。必要 schema 在啟動／測試 setup 驗證；不得把缺少必要表當成空資料而放寬來源／搜尋範圍。 |
| 鏡像程式舊，是否需先部署 | **不需先部署。** 用精確 SHA 的獨立 checkout／測試映像連到拋棄式或受控測試資料；修正 loader 路徑，使量測載入新分支。 |
| 本地缺 node_modules／eslint | 自行在隔離工作目錄使用 repo 鎖定的 Node／lockfile 安裝依賴，或使用既有 CI 環境。只回報實際執行的 lint／test；沒有跑 lint 就標 NOT_RUN，不把 Tests 綠燈稱為 lint 通過。 |
| 任務終點 | PR-B 所有必要修正、同 SHA CI、parity、效能與 PR 本文完成，狀態為 READY_FOR_REVIEW。保持未合併、未部署，交 ChatGPT 審查。 |

本次 ChatGPT 核對了 GitHub 程式與 Actions，並以該 SHA 抽出的函式做隔離重現；沒有登入 NAS 或重跑生產效能。以下反例是程式層的實際重現，不是推測生產已發生多少次。

## 2. 先處理已確認的回歸

### 2.1 縮欄位已改變「最新排序」

`listingEffectiveUpdatedAt()` 在 refresh_time 是相對時間或缺少可解析絕對時間時，會讀取 `first_seen_at`。目前窄清單刪掉了它。

同一支 HEAD 原始排序函式，固定 now，以下兩列可重現：

```js
[
  { post_id: 1, source: "591", refresh_time: "1小時前",
    first_seen_at: "2026-09-01T00:00:00Z" },
  { post_id: 2, source: "591", refresh_time: "1小時前",
    first_seen_at: "2026-09-20T00:00:00Z" }
]
```

- 寬欄位 `sort=newest`：**[2, 1]**
- 依 `LIST_CANDIDATE_COLUMNS_NARROW` 投影後：**[1, 2]**

這是分頁前的排序差異，頁面 hydration 不能補救已選錯的頁面。

目前 Proxy 審計的候選 refresh_time 都是有效絕對時間，沒有覆蓋上述分支；也沒有涵蓋所有附加費、自有房源、配對 tie-break 與設定組合。動態讀取紀錄只證明走過的分支，不能據此刪掉其他分支的必要輸入。

此外：
- `preferPrimaryListing()` 仍讀 `last_seen_at`，tie-break 會用 `source_id`／`url`。
- 個人自有房源、含附加費價格與 fit／通勤各有條件分支，需依實際消費者補 fixture。
- 現有審計護欄比對的是舊 `LIST_CANDIDATE_COLUMNS`，不是正式使用的窄清單。

**執行：** 先恢復寬欄位；把反例加入行為測試。之後如再縮欄位，以「寬版與優化版的總數、順序、角色、卡片狀態完全相同」驗收。審計清單只能輔助，不能代替 parity。

### 2.2 「CI 真 PG 通過」尚未驗到正式窄投影入口

窄欄位覆寫在 `searchListingsAsync()`，且只有未注入 deps 時啟用。

目前 `pg-provider-canaries.test.js` 直接呼叫 `searchListingsNodePg()`，帶入 `listingSearchBuildContext()` 的寬欄位。因此這個 canary 通過，不能證明正式入口的 23 欄正確。

**執行：** 補真正從 `searchListingsAsync()` 進入的 live PG fixture 測試；讓它使用正式預設依賴，檢查實際 SELECT 與回傳內容。不要在測試裡注入另一套候選欄位，繞過被驗證的行為。

### 2.3 跨請求 search-key memo 破壞快照來源一致性

`pgSearchKeyMemo` 是模組全域，沒有 database／schema／交易版本範圍。第一個請求取得的 keys，可以被後面另一個 executor／交易直接使用。

本次對原始函式的隔離重現：
- 第一個 executor 回 `["old-key"]`。
- 第二個 executor 本來會回 `["new-key"]`。
- 第二次實際仍得到 `["old-key"]`，第二個 executor **呼叫 0 次**。

即使只連同一生產 DB，快取也可能來自另一個資料快照；新交易可讀到新 listings／settings，卻拿舊 keys 展開搜尋範圍。SQLite 也有 8 秒 TTL，不能證明它符合本案的 PG 單一快照契約。

**執行：** 撤回跨請求 TTL。必要重用留在同一 request／同一 PG transaction。加入「前一請求後新增正規化等價 search_key，下一個請求看得到」及兩個隔離 executor／schema 不互相污染的測試。保留 `sameSearch()` 展開語意。

PG 的 Repeatable Read 保證交易內 SQL 的一致視圖，不能替應用程式從外部快取拿進來的舊值建立相同快照。[官方說明](https://www.postgresql.org/docs/16/transaction-iso.html)

### 2.4 表存在快取也缺少作用範圍

`SAFE_TABLE_EXISTS` 只以 table name 為 key。原始函式隔離探針顯示：executor A 確認 settings 存在後，executor B 不再探測，直接執行查詢；若 B 的 schema 沒有該表，便得到 42P01。

「只快取正結果」不能排除跨 database／search_path／schema 的污染。空探測結果也不能被當成已證明存在而寫入共享狀態。

**執行：** 本批採請求內快取；如果必要表已由啟動檢查保證，可以移除熱路徑上對該表的反覆可選探測。settings、users、user_settings 等影響來源與搜尋範圍的依賴，不得因缺表而改用更寬鬆預設。資料庫有表但沒有資料，與根本缺表，分別處理。

## 3. 精確 HEAD 的 CI 狀態與修復

本次核對 [Tests run 36130119290](https://github.com/Fyun48/5151/actions/runs/36130119290)，已經完成，不再是 in_progress：

| Job | Pass | Fail | Skip | 結論 |
|---|---:|---:|---:|---|
| 一般 Tests | 2581 | 1 | 24 | FAIL：request-context 測試預期執行 DISTINCT search_key，但全域 memo 使它未執行。 |
| PostgreSQL integration | 112 | 0 | 1 | SUCCESS：一項需要正式鏡像資料的 seed probe 被跳過。 |

本次失敗不是報告中提到的 queue claim flake，也不是取消的舊 run。先修快取作用範圍，再驗證 fixture 輸出；不能只移除「有查詢」斷言而留下資料污染。

必要 PG 功能測試不得 skip。需要正式鏡像資料的規模探針可以另列，但同功能的「seed 讀 PG」契約仍要有 CI fixture 覆蓋。一般 job 沒配置 PG 時的 skip 與專用 PG job 的必要覆蓋要對照列明，不混成「全部 0 skip」。

既有 queue claim 偶發失敗應檢查 schema／資料隔離、清理時序與並行；不准把「重跑後綠」作為長期修法，也不因判定是既有問題就要求 Owner 選擇是否處理。

`listing-search-query-count.test.js` 目前還有以下缺口，請一起修正：
- 吃掉兩次搜尋例外，最後只斷言總 queries > 0；搜尋失敗也可能通過。
- 第二次結果、查詢數沒有有效 gate。
- 傳的是 uid／voteUid，實際入口參數是 userId／matchVoteUserId。
- 只有一列假資料，未涵蓋配對、分頁、通勤及真正的 snapshot client。

把它保留為小型診斷時應清楚標示；正式驗收改用真 PG、正確 API args、確實成功的結果與 client.query 計數。交易控制 SQL 另列，並涵蓋第一個請求、暖機後、資料變更後。

## 4. 新分支可以先驗證，不需先部署

目前 `run-in-container.sh` 將腳本放在 `${REMOTE_DIR}/pg-columns-ab.mjs`。當 REMOTE_DIR 是 `/app/tmpkk`，腳本內的：

```js
import ... from "../src/db.js";
```

實際解析為 **`/app/src/db.js`**，不是已同步的 `/app/tmpkk/src/db.js`。這能解釋為何讀到舊 exports；不是新分支無法在部署前驗證的證據。

**執行方案：**

1. 使用精確 SHA 的獨立 checkout／worktree 或測試映像，保留 repo 的 `v3/scripts/`、`v3/src/` 相對結構。統一腳本布局；不要混用只適合另一種部署布局的相對路徑。
2. 使用對應 Node、lockfile 及依賴。輸出 SHA、實際 module URL／檔案 checksum，確認跑的是新程式。
3. 在拋棄式 PG 建 schema 與 fixture；需要真實分布時使用受控資料副本。舊應用映像與資料副本是兩件事。
4. `db.js` import 會依 DATA_DIR 初始化 SQLite。診斷程序須明確使用獨立暫存 DATA_DIR；不得繼承正式 /data，避免只是 import 就碰正式 v3.db。
5. 正式 PG 僅沿用已允許的受控唯讀探針；不要把 CI setup／importStore／migration／ANALYZE TABLE 對準正式 PG。完整整合測試使用拋棄式資料庫。
6. 不啟動新正式服務、不換正式 image、不動既有應用／爬蟲設定。若已有受控唯讀量測可完成，其結果獨立標示為實機成績；純 CI 數字不冒充 NAS 成績。

## 5. 效能量測修正與保留條件

### A/B 腳本先變成可信量測

`pg-columns-ab.mjs` 還需要：

- 所有含 `?` 的 builder SQL 先經 `toPostgresSql()`；目前直接交給 drv.query，不是正式路徑的轉換方式。
- 使用正式 PG district closure、相同 args／settings／searchKeys／asOf 與 ORDER BY。不要讓 builder 掉到另一條行政區查詢實作。
- 使用同一 client、明確唯讀快照與受控 timeout；拋棄式固定 fixture 也可用於可比 A/B。
- **不能把整棵 plan 每個節點的 buffers 加總。** 父節點包含子節點，現在 summarize() 會重複計算。整體值取根節點相應欄位，子節點用於定位；hit／read／temp 分開。
- buffers × block size 是存取量的解讀，不等於「實際從磁碟讀了多少不同資料」。縮欄位可能減少傳輸、反序列化、配置或 TOAST 成本，但不保證 heap buffers 必降。
- 同時執行真正返回 rows 的 SELECT，量 client wall time、回傳 bytes／rows、Node CPU／記憶體與完整回應。EXPLAIN 不能代替端到端量測。
- A/B 都暖機，交替執行，避免第一組替第二組暖快取；結果附正確性核對。

[PG EXPLAIN：父節點 buffers 包含子節點](https://www.postgresql.org/docs/16/sql-explain.html)；[成本與結果傳輸的區別](https://www.postgresql.org/docs/16/using-explain.html)。

### 驗收數字

RUNS≥5 可用來暖機；**至少暖機 5 次，再量測 50 個完整請求**，冷啟另列。快取驗證同時涵蓋冷啟、暖機、更新／失效及並行，不能只測第二次命中。

| 條件 | 延續的工程目標 |
|---|---|
| 同級 NAS，單行政區 warm p95 | C1 ≤1 秒、C4 ≤2 秒 |
| 同級 NAS，全區 warm p95 | C1 ≤2 秒、C4 ≤4 秒 |
| 固定 fixture 的 GitHub-hosted CI smoke | C1：單行政區 ≤2 秒、全區 ≤4 秒 |
| event-loop lag | p99 ≤50 ms、max ≤100 ms，附視窗／並行度 |
| 查詢數 | ≤12／通勤 ≤16 為優化目標；允許有依據的必要查詢，不得用犧牲一致性或單列假 driver 數字通關 |

C1 是單並行請求，C4 是四個並行請求。完整時間含 pool 等待、PG、Node 篩選／配對／排序／裝飾及回應序列化，不含使用者外網傳輸。另記錄 RSS／heap 峰值、timeout／error 數與資料規模。

最小驗收涵蓋：單區／全區 baseline、q、kind、sources、areaMax、wholeFloorOnly、watched、hidden、uid≠voteUid、含附加費價格、最新排序、配對 tie-break、fit／通勤。fixture 包含約 12 萬列規模、大候選集合、跨區 peer、長關係鏈及相對時間。

B4 必須把同一 asOf 真正傳到相對時間、primary 比較與排序；目前 context 有 asOf，不能單憑這個欄位就宣稱所有 Date.now() 已固定。

## 6. 持續執行順序

1. 恢復正確候選欄位、撤回跨請求 data memo，修表存在快取作用範圍與必要 schema 契約。
2. 補本文件的反例、正式入口的真 PG 測試及正確計數；修同 SHA CI 的全部失敗。
3. 修診斷布局、SQL dialect、closure、快照及 buffers 統計；使用新 SHA 的隔離環境，完成可重跑 A/B。
4. 完成同 fixture 的雙向 parity：集合、totalMatched、順序、same-house 角色、個人狀態與分頁皆一致。PG 熱路徑 SQLite 存取嘗試為零；缺 provider／必要 PG 資料時 fail-closed。
5. 依實測選擇保留有收益的優化；無收益或改變結果的實驗撤回。優先請求內去重與批次 preload，合併查詢不列必做。
6. 跑完 C1／C4 與必要案例，再更新 PR 本文、gate 表及 handoff。PR 主軸寫實際問題、保留變更、最終行為及證據，不以 commit 數或猜測清單當作完工程度。

前一份要求的 sql_pg 實驗 dispatcher 仍應移到獨立診斷模組，保持正式入口不可選到；清掉過時的 SQLite fallback／SQL-first 註解。這是同一 PR 已列工作，接續完成即可。

## 7. 工作與回報規則

### 已授權的日常實作範圍

在本 PR／隔離測試環境內，自行完成必要程式、測試、依賴安裝、可回復的 A/B、commit／push、CI 修復與 PR 本文更新。不要把這些動作逐一交給 Owner 決定。尊重 repo 規範與現有工具權限，不繞過環境的存取控制。

查詢合併風險透過 fixture、parity、效能 A/B 及可回復 commit 管理；Owner 是否坐在電腦前，不影響進行這類開發驗證。

### 何時繼續、何時才交棒

- 完成一小批後更新任務清單，**接著做下一項**。
- 等待 CI 時可以寫文件、補 fixture 或分析既有記錄；最終提交後等該 SHA 的 CI 完成再判定。
- 遇到可回復方案失敗，修正或撤回，接著做其他未受阻工作。
- 只有需要未授權的正式變更／付費／不可逆操作，或缺少憑證且合理的測試替代方案都不可用，才彙整一次必要問題。先完成所有不受阻部分，附具體待批准項目與證據。
- 最終只有 READY_FOR_REVIEW，或有上述真實外部限制的 BLOCKED。不要把「等你說合併裝飾查詢」列為 blocker。

在 `docs/handoffs/PRB_EXECUTION_STATE.md` 維護可接續狀態：SHA、已驗證項目、目前動作、未完成項目、可重跑命令、CI run／結果、下一步。不得記錄連線密碼。工具允許時自行接續上下文；若平台真的強制終止，保存此檔並明確標為未完成，不假裝已完工或仍在背景執行。

這套規則要求持續工作，但不能替執行器解除上下文、連線、配額或權限限制。

### 最後一次回報格式

1. exact HEAD／base、工作樹狀態、同 SHA 必要 CI 連結與完整 pass/fail/skip。
2. 最終保留及撤回哪些改動，各自原因。
3. parity、零 SQLite、快照、B4 與上述反例的證據。
4. 冷啟／warm、C1／C4、全區／單區的延遲、查詢數、lag、RSS、錯誤數；注明硬體與 fixture／資料版本。
5. PR 本文與 gate 表已更新；如還有外部 blocker，列已完成部分與唯一需要 Owner 的具體決定。
6. 明確說明未 merge、未 Production deploy，請 ChatGPT 做最終審查。

## 8. 本次查核證據

- [精確 HEAD](https://github.com/Fyun48/5151/commit/79da24939e40f3079fa05e0979284540f7312bc6)
- [一般 Tests：1 fail](https://github.com/Fyun48/5151/actions/runs/36130119290/job/108055286550)
- [PG integration：112 pass／0 fail／1 skip](https://github.com/Fyun48/5151/actions/runs/36130119290/job/108055286456)
- [候選欄位、快取、排序](https://github.com/Fyun48/5151/blob/79da24939e40f3079fa05e0979284540f7312bc6/v3/src/db.js)
- [正式入口的窄欄位覆寫](https://github.com/Fyun48/5151/blob/79da24939e40f3079fa05e0979284540f7312bc6/v3/src/listingSearchAsync.js)
- [PG canary 實際入口](https://github.com/Fyun48/5151/blob/79da24939e40f3079fa05e0979284540f7312bc6/v3/test/pg-provider-canaries.test.js)
- [columns A/B 腳本](https://github.com/Fyun48/5151/blob/79da24939e40f3079fa05e0979284540f7312bc6/v3/scripts/pg-columns-ab.mjs)
- [容器腳本布局](https://github.com/Fyun48/5151/blob/79da24939e40f3079fa05e0979284540f7312bc6/v3/scripts/run-in-container.sh)

隔離重現結果（精確 HEAD 原始函式；不是 live PG 成績）：

```json
{
  "newestSort": { "wide": [2, 1], "narrow": [1, 2] },
  "searchKeyCache": {
    "firstResult": ["old-key"],
    "secondResult": ["old-key"],
    "secondExecutorCalls": 0
  },
  "tableCache": { "secondExecutorProbes": 0, "outcome": "42P01" }
}
```

