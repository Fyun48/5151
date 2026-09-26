# PR-B 可接續狀態

更新：2026-09-26。**BLOCKED：ChatGPT 執行環境離線，NAS 實測無法接續。**
PR [#497](https://github.com/Fyun48/5151/pull/497) 保持 open、非草稿、未合併、未部署。不是缺 NAS 憑證；既有通道本輪已成功實跑，現在是執行器斷線。

## 已提交與驗證

- 分支：`fix/pr-b-persist-listing-transaction`；base `9c6b7b04f9801717cb6696e8e095fde4c309473f`。最新 HEAD 與 CI 結果讀 PR。
- `749165e`：完整 42 欄 array 解碼、同一請求的統計／清單候選重用、行政區關係縮減與統計單迴圈。一般 CI 的 4 個來源文字解析測試於下一提交修復，沒有刪掉欄位或排序斷言。
- `7a1f4eec8f946ee9a9c1c378ff1560880b67ae6b`：[Tests 36229928048](https://github.com/Fyun48/5151/actions/runs/36229928048)，一般 2644／2608 pass／0 fail／36 skip；PG 132／131 pass／0 fail／1 optional skip。
- `9d415e4c2b4453ed7d0dfa68bec760c4c67cec75`：[Tests 36230822383](https://github.com/Fyun48/5151/actions/runs/36230822383)，一般 2646／2609 pass／0 fail／37 skip；PG 142／141 pass／0 fail／1 optional skip。CI_SMOKE_PASS。
- 9d415e4 完整 CI 四案 p95：單區 C1 426.06／C4 1001.46 ms；全區 C1 451.59／C4 1307.31 ms。200 次 errors/timeouts 皆 0、SQLite guard 通過。全區 C4 lag p99 56.75 ms 高於 50 ms，不能把 CI smoke 成功寫成全部效能 gate 通過。
- [CI 原始 artifact](https://github.com/Fyun48/5151/actions/runs/36230822383/artifacts/10902641044)。
- 版本重用設計與界線：[PRB_CONTENT_REUSE_20260926.md](PRB_CONTENT_REUSE_20260926.md)。每次在當前 PG 快照核對 WHERE、列版本、relation/storage/schema/role/epoch 與完整欄位權限，沒有 search-key TTL 或 query-result memo。

本檔所在提交另加入三處可回復修正：完整讀取 cursor 的交易內 planner 設定、可用既有 source 索引的等價 predicate、無地理條件時省略無作用計算。新增真 PG 測試檢查設定在成功／例外後恢復。這三處尚無 NAS 成績；精確同 SHA CI 結果以 PR 最新區段為準。

## NAS 已實測的界線

- 硬體 CasaOS／Intel Celeron N3450 @1.10GHz／8 GB；Node 22.23.3、PG 16.14。
- baseline 848aa7e 的四案 50 次正式驗收已跑完且 FAIL；原始證據在 `evidence/prb-nas-20260926/`（201b5bb 證據提交）。
- 本輪開發短測固定 120k stored／36k active。單區 C1 從無 profiler 約 2.86 秒，經版本重用約 2.48 秒，再經窄欄位批次與關係索引約 1.93 秒；三次量測，結果 hash 一致。**不是 50 次正式驗收，且仍高於 1 秒目標。**
- 最後一個名為 `diagnostic-cursor.json` 的約 2.19 秒結果，實際未套入三處新修正（patch 的 EOF context 失敗），不可用來評價新 planner 設定。
- 尚未完成新 SHA 的 NAS 四案驗收、C4 lag 收斂與清理本輪隔離開發資源。整體遷移 C～F、production auth／雙節點 HTTP E2E、HA promotion／failover、PITR／RPO／RTO 未完成。

## 中斷時的可接續環境

ChatGPT 的 `exec_command` 與 `node_repl` 先回報 transport disconnected，重試均為 `409 Conflict, environment_offline: Environment is not connected`。沒有宣稱工作仍會在背景自動接續。

- 既有瀏覽器 IDE：`https://cocodeco.reversalplay.me/?folder=/workspace`。原 `/workspace/5151` 未覆蓋。
- code-server 的隔離 clone：`/tmp/prb-transfer.it64ho8o/5151`，遠端 `github` 指向權威 GitHub，最後 HEAD 9d415e4。有一份未提交的 `v3/test/pg-candidate-array.test.js` 新測試；已納入本檔所在 GitHub 提交，接續時先比對 diff 再同步。
- NAS 隔離開發根目錄：`/tmp/prb-opt.JoUcLPr0`。其 Git HEAD 仍是舊 baseline／evidence，但應用檔案已逐批套修正；**不可當作同 SHA 正式驗收 checkout**。
- NAS 原始開發 log／JSON／CPU profiles：上述目錄的 `artifacts/dev/`。包含 diagnostic-baseline、optimized（撤回 JSON transport）、array、reuse、context、content、batches、cursor；complete-cursor patch 未套入，額外設定測試已寫入，但最後測試的完成結果未能讀回。
- 最後確認已完成的完整 NAS PG 回歸：`content-full-pg.log`，142 tests／141 pass／0 fail／1 optional skip。後續窄欄位／版本／closure 19 項針對性測試全過。
- Docker 資源前綴 `prb-opt-jouclpr0`：`-pg` 容器、`-net` internal network、`-deps` 與 `-pgdata` volumes；`-app` 僅在單次測試時存在，採 --rm。未發布 host port，DB 僅 `tracker_prb_test`。
- dev runner 使用 nohup + timeout 5／6 分鐘，沒有無限背景迴圈。執行器斷線後的實際資源狀態尚待確認。
- 既有 SSH 設定／金鑰／known_hosts 依共享 infra runbook 使用，StrictHostKeyChecking 保持啟用。不要新開 tunnel、不要把機密寫入 repo。正式 `5151_shadow` 不可用於測試 setup／migration／ANALYZE。

## 恢復後接續

1. 先確認上述 dev runner 已結束、取回完整 logs 與 JSON，核對待提交測試及 GitHub HEAD；保留失敗證據。
2. 以最新精確 SHA 的新獨立 checkout 執行 `bash v3/scripts/prb-nas-verify.sh <完整 SHA>`；不要對有 patch 的 dev clone 冒稱同 SHA。
3. 保持暖機至少 5 輪、四案各 50 次、完整 page/stats/JSON、獨立預期與零 SQLite guard；針對未過延遲／lag 繼續修正。
4. 保存本輪 raw evidence 後，只清除 `prb-opt-jouclpr0-app`、`prb-opt-jouclpr0-pg`、`prb-opt-jouclpr0-net`、`prb-opt-jouclpr0-deps`、`prb-opt-jouclpr0-pgdata`。不要 prune 或碰正式容器。
5. NAS gate 通過前維持 NOT_READY_FOR_REVIEW／NOT_READY_FOR_MERGE。完整 PR-B 驗收後再接續 C～F，正式變更仍 manual-only。
