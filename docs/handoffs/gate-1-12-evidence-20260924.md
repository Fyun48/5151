# GATE-1～12 證據表（2026-09-26 更新，PR-B 接手）

狀態只使用 PASS / FAIL / PARTIAL / NOT_RUN / BLOCKED。此表區分分支測試與正式環境。
未合併、未部署；2026-09-24 的正式環境觀測保留在 Git 歷史，不能冒充本次重新查驗。
目前 scope 是 PR #497。整體 SQLite 退出、跨節點業務與 HA 並未完成。

| GATE | 判定 | 已有證據 | 尚缺驗證或工作 |
|---|---|---|---|
| **1 版本／拓樸** | PARTIAL | 已核對 GitHub PR、base、checkout；CI artifact 有 source SHA、checkout SHA、模組 hash、Node／PG／硬體。既有 infra 文件記錄 web-A、web-B、crawler 共用 primary，PG 16.14／async standby。 | 本工作階段沒有 NAS 執行通道；正式節點 image digest、source mount、runtime hashes 未重新核對。 |
| **2 PG 無 SQLite 啟動** | BLOCKED | 搜尋核心使用 PG，且 live fixture 攔截 SQLite I/O 嘗試。 | db.js 啟動仍初始化 SQLite；auth／設定寫入／排程等需 C～F。不能宣稱刪除 v3.db 後整站正常。 |
| **3 禁止錯誤回退** | PARTIAL | 會員、訪客、stats／page 正式 PG 入口失敗回 503／SEARCH_UNAVAILABLE；缺表與缺 provider 失敗；存在但為空的表可正常回空結果。真 PG 測試有 PG-only sentinel 及 SQLite 嘗試記錄；前端保留既有內容／分頁。 | PASS 僅限已驗證搜尋核心。整個 HTTP 請求的 auth、events 等仍有 SQLite；正式雙節點 HTTP E2E 尚未跑。 |
| **4 搜尋／投影** | PARTIAL | 寬候選欄位、同一 asOf、primary／bundle／排序、個人旗標／投票者分離、通勤、訪客、兩頁與 total 在固定 fixture 通過 parity。正式 PG dispatcher 固定 node_pg；SQL PG 診斷獨立。SQLite dispatcher 使用完整 projection fixture。 | 120k CI smoke 與 NAS 驗收分開；目前正式資料全量／NAS 效能尚未驗收。舊 SQL-only same-house 不等價不再作正式入口，但未宣稱診斷 SQL 已完全等價。 |
| **5 跨節點業務** | NOT_RUN | 無本次實機證據。 | A 建／B 讀／B 改／A 讀回，涵蓋設定、刊登、許願、人工配對、回饋、附件、auth；依賴 C～F 及既有遠端通道。 |
| **6 交易／冪等** | PARTIAL | 原 persistListing／SAVEPOINT／change-log／bookkeeping 整合保留於真 PG CI；完整 page 用一個 Repeatable Read 唯讀快照；並行外部更新只在下一請求可見。queue 注入時鐘及隔離 claim／owner／retry 測試修正。 | 群組轉移、audit／outbox 中途故障、commit 後 client timeout 重試的全部業務情境未宣稱完成。 |
| **7 抓取公平／取消** | NOT_RUN | 無本次完成證據。 | PR-C：AbortSignal、排程／擁有權。 |
| **8 多 worker** | PARTIAL | 本批 queue fixture 驗證基本 lease、claim ownership、reclaim／retry，移除共用資料污染。 | PR-C 的多 worker 預算 reservation、取消與完整整合未完成。 |
| **9 補遷** | NOT_RUN | 無本次完成證據。 | PR-D／E 資料、媒體核對與衝突處理。 |
| **10 完整執行覆蓋** | NOT_RUN | CI fixture 是功能與效能測試，不是正式抓取週期觀測。 | 連續兩個完整覆蓋週期、至少 30 分鐘，取較長者。 |
| **11 HA／回版** | PARTIAL | 既有 infra 文件記錄 primary＋async standby、archive_mode=off；有 PITR runbook。 | 未執行封存、還原、promotion／failover、RPO／RTO 實測、舊版讀新 schema。本次沒有改正式環境。 |
| **12 CI 可信度** | PASS（本批程式） | `316995b` 的 [Tests run 36222517400](https://github.com/Fyun48/5151/actions/runs/36222517400)：一般 2,598 pass／0 fail／34 skip；真 PG 129 pass／0 fail／1 optional shadow skip；C1 smoke PASS。 | 最終文件提交的 HEAD CI 另在 PR 本文核對；CI 並未替代 NAS／完整 HTTP E2E／lint（NOT_RUN）。 |

原始效能 JSON：`evidence/prb-codex-20260926/`。
可接續狀態：`docs/handoffs/PRB_EXECUTION_STATE.md`。
NAS 拋棄式驗收入口：`v3/scripts/prb-nas-verify.sh`；尚無本次 NAS 成績。
