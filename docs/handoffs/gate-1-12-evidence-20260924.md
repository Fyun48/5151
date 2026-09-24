# GATE-1～12 證據表（2026-09-24，PR-B 階段）

判定用詞依指令文件：PASS / FAIL / PARTIAL / NOT_RUN / BLOCKED。
**本表禁止填推測 PASS**：沒有量測到的就寫 NOT_RUN 或 PARTIAL，並列出缺口。

| GATE | 判定 | 證據（可重現的位置） | 缺口（要 PASS 還缺什麼） |
|---|---|---|---|
| **GATE-1** 版本與拓樸 | **PARTIAL** | **已實測**：<br>• casa：`5151-web-A`、`591-tracker-v3`（crawler）、`5151-haproxy`、**`5151-postgres-A`**（皆 ghcr.io/fyun48/5151 或官方映像）<br>• syn-nas：`5151-web-B`、`5151-haproxy-B`、`5151-postgres-B`（postgres:16-alpine）、`5151-ops`<br>• **三個應用實例（web-A／web-B／crawler）皆 `DB_DRIVER=postgres`、`DATA_DIR=/data`，且 `PG_URL` 指向同一個 DB**：`192.168.0.140:25433` / **database `5151_shadow`** / schema `public` / user `postgres`（以 `inet_server_addr()`／`current_database()` 交叉驗證）<br>• PG 16.14、`wal_level=replica`、`archive_mode=off`、複寫槽 `standby_a`（physical, active, **非同步**）<br>• master 區域已合併 #492/#493/#494；本階段 PR：#496（PR-A）、#497（PR-B）、#498（唯讀監控）| ①各節點的 **runtime source hashes** 與 **image digest**（本表只記了 image 名稱）；②各節點的 **source mounts 清單**；③web-A 與 crawler 同在主機 casa，需確認兩者資料目錄是否共用（影響「單一權威來源」判定）；④~~`5151-postgres-A` 與 `-B` 的主／備角色需以 `pg_is_in_recovery()` 逐一確認~~ **已確認**：應用連到的伺服器 `pg_is_in_recovery()=false` ⇒ **就是 primary**，且有**恰好一個** standby 在 `streaming`／`sync_state=async`（`pg_stat_wal_receiver` 為空，一致）|
| **GATE-2** PG 無 SQLite 啟動 | **BLOCKED** | 尚未執行 | 依賴 PR-C～F（排程／擁有權、`listing_match_evaluations`、網域／媒體／認證、PG 模式下無業務 SQLite）。目前 SQL 外框外仍會回退 SQLite ⇒ 現階段不可能達成「無 v3.db 仍完整運作」 |
| **GATE-3** 禁止錯誤回退 | **PARTIAL** | PG 失效 → **503 ＋ 穩定錯誤碼 `SEARCH_UNAVAILABLE`**，且**不再回退 SQLite**：程式 `listingSearchAsync.js`（class＋`SEARCH_UNAVAILABLE_CODE`）、`server.js`（503 對應）、測試 `test/listing-search-unavailable.test.js`（4 個）→ commit `3db004a` | ①「外框外」回退仍在（需 F3 補齊後移除，`listingSearchAsync.js` 的 `!page` 分支）；②指令要求的**強版本**：注入不同 **SQLite sentinel** 並斷言回應永不出現 sentinel — 尚未實作 |
| **GATE-4** 搜尋與投影 | **FAIL**（2026-09-24 實測更新）| 投影完整性**已歸零**：`missing=0 missing_visible=0 orphan=0 dup=0 nulls=0 listings=119876 projection=119876 ok=1`（唯讀檢查，另一個程式路徑）；回填 `done=86522 failed=0 missingAfter=0`；監控 timer 每 15 分鐘持續 `ok=1`。F3 已下推 5 項並附等價性證據（`sources`／`areaMax`／`kind` 四層／`wholeFloorOnly`／`q` 三層）。**但「完整 ID 集合／total／下一頁一致」不成立** ✗：同一組 args（`filter=all`、`districts=[西屯區]`、`limit=300`）實測 **Node `totalMatched=4,259` vs SQL `6,023`（+41%）**，第一頁 300 列中有 **91 列只有 SQL 回傳**且 `match_post_id` 全部非空 ⇒ SQL 多回傳 same-house 同源配對列 | 依 `docs/handoffs/report-for-astra6-20260924.md` §4 擇一（(A) 精確 SQL 化／(B) 保守回退／(C) 投影層預算），驗收標準＝`sqlOnlyCount=0` 且 `totalMatched` 相等；另「公共與會員**所有**既有查詢能力使用 PG」未達成（`q`／`filter≠all`／`fit_desc`／多項 settings 仍回退）；②完整 ID 集合／排序／total／下一頁一致性尚未做全量比對；③`kind_keys` 回填尚未 100%（見下） |
| **GATE-5** 跨節點業務 | **NOT_RUN** | — | A 建／B 讀／B 改／A 讀回，涵蓋設定、刊登、許願、人工配對、回饋、附件、auth |
| **GATE-6** 交易與冪等 | **PARTIAL** | PR-B 已把 `persistListing` PG 路徑收斂為單一交易＋SAVEPOINT（失敗語句會毒化交易 ⇒ 沒有 SAVEPOINT 時 COMMIT 變 ROLLBACK＝靜默資料遺失）；測試 `persist-listing-transaction`／`change-log-identity`／`covering-bookkeeping` | 群組轉移、audit／outbox 中途失敗、以及「commit 成功但 client timeout 後重試」不重複副作用的情境尚未測 |
| **GATE-7** 抓取公平與取消 | **NOT_RUN** | — | 依賴 PR-C（`AbortSignal`／排程／擁有權） |
| **GATE-8** 多 worker | **NOT_RUN** | — | 依賴 PR-C（lease／owner token／預算 reservation） |
| **GATE-9** 補遷 | **NOT_RUN** | — | 依賴 PR-D／E（資料、媒體核對、衝突處理） |
| **GATE-10** 完整執行覆蓋 | **NOT_RUN** | — | 需連續兩次完整覆蓋週期、觀測 ≥30 分鐘（取較長） |
| **GATE-11** HA 與回版 | **PARTIAL** | **已實測**：應用連到的伺服器 `pg_is_in_recovery()=false` ⇒ primary；`pg_stat_replication` 有**恰好一個** standby，`state=streaming`、`sync_state=**async**`；`pg_stat_wal_receiver` 為空（一致）。WAL 80 MB／DB 549 MB；**`archive_mode=off`（無 PITR）**；已寫好 WAL 封存／PITR runbook（含還原演練）| runbook **尚未執行**（需 Owner 提供封存路徑）；**RPO 未量測——且因為是非同步複寫，RPO > 0 是已知的資料遺失窗口**（failover 時已提交但未串流的交易會遺失），需以實測量化；RTO 未量測；舊版本讀新 schema 未驗證；promotion／failover 演練未做 |
| **GATE-12** CI 可信度 | **FAIL** | 實跑證據：完整套件 `# tests 1648 / # pass 1626 / # fail 2 / # skipped 20`；其中 **20 個 skip 來自缺 PG 連線的 PG 依賴測試**（framework 會優雅跳過，例如 `listing-stats-parity.test.js`：`pass 1 / skipped 1`）⇒ 正是指令禁止的「因缺 PG_URL 被 skip 卻標綠」 | 需在 CI 起一個**真實獨立的 PG service／隔離資料庫**，讓這些測試真的跑 |

## 補充：本階段已完成的獨立可驗證項

1. **投影完整性歸零**（GATE-4 的核心）：三條獨立證據（回填摘要／唯讀複查／監控 timer 歷史），見 `docs/handoffs/pr-b-backfill-completion-20260924.md`。
2. **kind 下推的三重等價性**：述詞探針（14 查詢×2000 列 `mismatch=0`）、單元測試、生產資料抽樣（`kind_keys` vs `listingKindKeys` 重算 **5000/5000 相同**）。
3. **測試套件可完成**：修掉 `commute-route-live.test.js` 的 `spawnSync` 缺 timeout（原本整套停在 253 個測試後零進度，是確定性阻塞）→ 253 → 1648。
4. **`q` 暫緩下推的實測依據**：SQLite `'ABC' LIKE 'abc'` = 1、PG = false（大小寫語意不同）⇒ 直接下推會造成 driver 間行為差異；解法與驗證方式已寫入 PR 說明。
