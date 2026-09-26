# PR-B 接手結果（2026-09-26）

**BLOCKED：需要既有 NAS 執行通道，才能完成實機驗收。** 未合併、未部署；本報告不是正式上線批准。

## 版本與驗證界線

- PR [#497](https://github.com/Fyun48/5151/pull/497)，`fix/pr-b-persist-listing-transaction`。
- 接手起點 `ad5310e6a70de3b694869b2fefedefabc688a292`；base `9c6b7b04f9801717cb6696e8e095fde4c309473f`。
- 本報告實測程式 SHA：`316995b768415e7b69f03e658c4027cdb5bab6cd`；[同 SHA Tests](https://github.com/Fyun48/5151/actions/runs/36222517400)。
- 一般：2,632 tests／2,598 pass／0 fail／34 skip。真 PG：130 tests／129 pass／0 fail／1 skip。
  PG skip 是需要正式 shadow 副本的選用 probe；必要功能 fixture 實際執行。lint NOT_RUN。
- 文件／證據提交之後的 PR HEAD 與 CI，以 PR 本文的最終核對為準；不把較早 SHA 綠燈套用到新程式。

## 修正後的行為

1. 會員、訪客、stats／page 的正式 PG 搜尋均由 PG 供料；sql_pg 實驗入口獨立，正式 dispatcher 固定 node_pg。
2. 候選、設定、來源、裝飾及統計共用單一 Repeatable Read 唯讀快照；可見性、primary、排序及 bundle 共用 asOf。
3. 必要 schema／provider 缺失直接 503／SEARCH_UNAVAILABLE；表存在但為空仍可正常回空結果。前端失敗保留既有清單／統計／篩選／分頁。
4. 移除跨請求 search-key TTL／全域 table-exists 快取；PG 訪客不使用不可靠 revision 的跨請求 cache。
5. 寬候選欄位完整保留；重用同快照 extras，只保留實際關係 partner；統計只 preload 實際消費的資料。
6. PG cursor 分批傳輸全部候選與 district seeds；Node 分段處理但保留全域關係與穩定排序，不先 LIMIT 截斷候選。
7. `SET LOCAL jit = off` 只套用搜尋交易；消除每請求約 0.8 秒 JIT 編譯成本，ROLLBACK 後恢復。完整物件建立避免 flags 造成寬 row 的 dictionary 膨脹。
8. 通勤／MRT／job key 改綁 text array；真 PG 驗證 70,001 個 key。queue availableAt 共用注入時鐘，fixture／claim／owner／retry 隔離。
9. 保留原 PR 的 persistListing 交易／SAVEPOINT／projection／revision 工作；正式投影回填屬接手前歷史證據，本次未重新對正式庫執行。

## 可重現的效能

硬體：AMD EPYC 7763 64-Core Processor，4 CPU，Linux x64，Node v22.23.2／PG 16.14。
固定 fixture `prb-fixed-v1`：120,000 stored／36,000 active、跨區 peer 與 1,024 節點關係鏈；asOf `2026-09-26T00:00:00.000Z`。
每案至少 5 輪暖機、50 個完整請求；包括 pool、PG、Node、統計及 JSON 序列化，不含使用者外網。

| 案例 | cold ms | warm p50 ms | warm p95 ms | lag p99 / max ms | RSS MiB | SQL / 交易控制 | error |
|---|---:|---:|---:|---:|---:|---:|---:|
| 單區 C1 | 1324.15 | 1072.58 | 1302.87 | 26.43 / 37.09 | 374.5 | 256–256 / 3 | 0 |
| 單區 C4 | 1012.85 | 2979.82 | 3021.05 | 34.44 / 67.90 | 890.9 | 256–256 / 3 | 0 |
| 全區 C1 | 1048.49 | 1036.83 | 1070.45 | 37.26 / 48.40 | 857.5 | 165–165 / 3 | 0 |
| 全區 C4 | 1012.89 | 3407.92 | 3454.62 | 48.37 / 84.41 | 1052.3 | 165–165 / 3 | 0 |

CI C1 smoke：PASS。此批全部 lag 門檻：PASS。SQLite I/O 嘗試：0；timeout：0。
每個 FETCH 如實計入 SQL，BEGIN／SET LOCAL／ROLLBACK 另列；固定批次傳輸增加 round trips，換取主執行緒反應時間。
查詢數高於 ≤12／16 的優化目標；依既有裁決，該目標不是獨立硬 gate。沒有逐列或逐群組 N+1。

基準 `dfe78ee` 的單區／全區 C1 p95 為 2,414.79／2,703.46ms，C4 為 6,961.32／8,293.12ms，最高 RSS 2,150,023,168 bytes。
完整歷程 JSON 保存在 `evidence/prb-codex-20260926/`；包含失敗量測，沒有只留綠燈。
本批 benchmark 同時核對獨立推導的固定 ID／matched／total／dbTotal，並記錄 result hash；不能少取資料通關。

## 正確性證據與限制

- `listing-search-parity.test.js`：正式 PG dispatcher、SQLite Node 參考與完整 projection dispatcher；兩頁／total／順序、viewer≠voter、flags、q、kind、sources、area、whole-floor、extras、fit／commute、相對時間與 primary、被 profile 排除的 partner。
- 同檔 live PG 測試：缺表與空表區分、單回應快照期間外部更新、下次請求可見、訪客 PG-only sentinel、cursor 多批／參數／錯誤後可再用。
- I/O guard 記錄 prepare／exec 及事先準備的 StatementSync 呼叫，吞例外也會留下違規嘗試；測試驗證 guard 本身。
- `listing-search-http.test.js` 使用正式 page loader／錯誤 helper；`listing-search-client-error.test.js` 執行實際前端函式。它們不是完整 production auth／雙節點 HTTP E2E。
- SQLite／同步參考及 PG／非同步管線共用規則；cooperative 測試涵蓋穩定排序、NaN ties、跨 chunk 關係／統計。

## 剩餘工作與唯一需要 Owner 的資料

本工作環境沒有 infra 文件指定的 NAS SSH key／共享憑證目錄；既有 VS Code 遠端入口顯示未登入、沒有可用 host。
需要將**既有 NAS 遠端開發執行通道**提供給本工作階段。取得通道後以同 SHA 執行拋棄式驗收；不需先部署正式站。

已備好 `v3/scripts/prb-nas-verify.sh` 與 `docs/runbooks/PRB_NAS_Disposable_Verification.md`：
新建 Node／PG 容器、Docker volume、封閉網路，無正式 PG URL／host port；只清除自己建立的資源。
外殼已做 bash 語法檢查；本次沒有 Docker／NAS，所以容器流程仍 NOT_RUN，不能宣稱完成 NAS gate。

NAS 門檻仍是單區 C1 ≤1s／C4 ≤2s、全區 C1 ≤2s／C4 ≤4s；lag p99 ≤50ms／max ≤100ms。
CI 數字不可替代 NAS 成績。正式庫 `5151_shadow` 是 production，名稱不代表可灌 fixture。

整體架構的 C（排程／擁有權）、D（match／eval）、E（media／auth 等 domain）、F（全業務 SQLite 退出／PITR）仍未完成。
HTTP 的 auth／events 等與 db.js 啟動仍可能使用 SQLite，不能把搜尋核心零 SQLite 說成整個應用已退出 SQLite。
跨節點 E2E、完整抓取週期、HA promotion／failover、RPO／RTO／還原演練均未宣稱通過。
