# PR-B 可接續狀態

更新：2026-09-26 台灣時間 17:45。**NAS 同 SHA 驗收已實跑：受測 SHA `ef9e21a`，結果 `NAS_ACCEPTANCE_FAIL`。**
PR [#497](https://github.com/Fyun48/5151/pull/497) 保持 open、非草稿、未合併、未部署。維持 NOT_READY_FOR_REVIEW／NOT_READY_FOR_MERGE。

登入阻礙已解除，而且原本就不需要瀏覽器登入：Cloudflare 組織只有一個，
`name=toriace.cloudflareaccess.com` 與 `auth_domain=jibbyteam.cloudflareaccess.com` 是同一個組織物件的兩個欄位，
兩者都屬於 Owner 唯一的 Cloudflare 帳號。NAS 通道走既有 SSH 金鑰即可；該組織唯一的登入方式是 One-time PIN，
驗證碼只寄到 Owner 信箱，代理人本來就無法代收。

## 本輪已完成的五個步驟（DeepSeek Harness，2026-09-26）

1. **保全**：`/tmp/prb-opt.JoUcLPr0` 已封存到 `/mnt/Storage1/prb-archive/prb-opt-jouclpr0-20260926/`
   （tar 含 `.git`、原 HEAD `201b5bb`、status、binary diff、逐檔 SHA256），解開後 HEAD 與 73 筆變更狀態一致；
   `/tmp/prb-nas-src.5oVQAQv1` 同樣封存。
2. **比對**：code-server `/tmp/prb-transfer.it64ho8o/5151` 唯一變更的 `v3/test/pg-candidate-array.test.js`，
   內容雜湊 `5bbad427…` 等於 `1d09dee`／`63c1f5a`，沒有未納入的修改。
3. **清理**：`prb-opt-jouclpr0-app` 事前已不存在（`--rm`）；`-pg`／`-net`／`-deps`／`-pgdata` 四項依精確名稱移除。
   清理後以標籤與名稱前綴查詢皆 0 筆，`/tmp/prb-nas.*` 無殘留，正式容器與 `5151_shadow` 未受影響。
4. **runner 修正**：`v3/scripts/prb-nas-verify.sh` 建立 container／network／volume 時未加標籤，已最小修正為
   `prb-nas-verify=1`、`prb-nas-verify.sha`、`prb-nas-verify.script` 三個標籤並提交為 `ef9e21a`。
   該提交只動 runner（+10／−6）；`v3/src`、`v3/test`、benchmark 腳本與 `63c1f5a` 完全相同。
   同 SHA CI [36233027423](https://github.com/Fyun48/5151/actions/runs/36233027423) completed／success。
5. **驗收**：以 GitHub 唯一權威來源的獨立 checkout 在 CasaOS N3450 執行
   `bash v3/scripts/prb-nas-verify.sh ef9e21aa0f293e97a7269e4726f499e4561f21fe <證據目錄>`。

| 案例 | p95 ms | 目標 ms | 延遲結果 | lag p99／max ms | peak RSS MiB | errors／timeouts |
|---|---:|---:|---|---|---:|---|
| 單區 C1 | 1775.12 | 1000 | FAIL | 55.97／98.63 | 431.0 | 0／0 |
| 單區 C4 | 4680.62 | 2000 | FAIL | 72.88／209.85 | 674.9 | 0／0 |
| 全區 C1 | 1959.80 | 2000 | PASS | 79.04／134.74 | 694.4 | 0／0 |
| 全區 C4 | 5821.09 | 4000 | FAIL | 121.83／226.62 | 839.7 | 0／0 |

真 PG 143 tests／142 pass／0 fail／1 optional skip；`sqliteAttempts = 0`；runner exit = `1`。
與 `848aa7e` baseline 相比 p95 下降 58～66%，只有全區 C1 進入門檻（餘裕 2.0%）。
`stats_ms` 是四案最大單一階段（占 35.9～50.1%），C4 時 CPU 密集階段同步放大，lag max 升到 226.62 ms。
完整證據在 `evidence/prb-nas-ef9e21a/`。

## 已提交與驗證

- 最新應用程式 SHA `1d09deee8a4f91acad6774077f704a39edc6e026`：[Tests 36231527187](https://github.com/Fyun48/5151/actions/runs/36231527187) completed/success。一般 2647 tests／2609 pass／0 fail／38 skip；真 PG 143 tests／142 pass／0 fail／1 optional skip。
- 同 SHA 完整 CI 四案 warm p95：單區 C1 460.94／C4 1136.73 ms；全區 C1 463.03／C4 1525.48 ms。各案 50 次，errors/timeouts 皆 0，SQLite guard PASS，四案 lag gate 本次皆通過。這些不是 NAS 成績。
- [最新 CI 原始 artifact](https://github.com/Fyun48/5151/actions/runs/36231527187/artifacts/10901884154)。本次狀態更新僅改文件，應用程式仍是上述受測內容；精確 HEAD 與最新 CI 讀 PR。

- 分支：`fix/pr-b-persist-listing-transaction`；base `9c6b7b04f9801717cb6696e8e095fde4c309473f`。最新 HEAD 與 CI 結果讀 PR。
- `749165e`：完整 42 欄 array 解碼、同一請求的統計／清單候選重用、行政區關係縮減與統計單迴圈。一般 CI 的 4 個來源文字解析測試於下一提交修復，沒有刪掉欄位或排序斷言。
- `7a1f4eec8f946ee9a9c1c378ff1560880b67ae6b`：[Tests 36229928048](https://github.com/Fyun48/5151/actions/runs/36229928048)，一般 2644／2608 pass／0 fail／36 skip；PG 132／131 pass／0 fail／1 optional skip。
- `9d415e4c2b4453ed7d0dfa68bec760c4c67cec75`：[Tests 36230822383](https://github.com/Fyun48/5151/actions/runs/36230822383)，一般 2646／2609 pass／0 fail／37 skip；PG 142／141 pass／0 fail／1 optional skip。CI_SMOKE_PASS。
- 9d415e4 完整 CI 四案 p95：單區 C1 426.06／C4 1001.46 ms；全區 C1 451.59／C4 1307.31 ms。200 次 errors/timeouts 皆 0、SQLite guard 通過。全區 C4 lag p99 56.75 ms 高於 50 ms，不能把 CI smoke 成功寫成全部效能 gate 通過。
- [CI 原始 artifact](https://github.com/Fyun48/5151/actions/runs/36230822383/artifacts/10902641044)。
- 版本重用設計與界線：[PRB_CONTENT_REUSE_20260926.md](PRB_CONTENT_REUSE_20260926.md)。每次在當前 PG 快照核對 WHERE、列版本、relation/storage/schema/role/epoch 與完整欄位權限，沒有 search-key TTL 或 query-result memo。

1d09dee 另加入三處可回復修正：完整讀取 cursor 的交易內 planner 設定、可用既有 source 索引的等價 predicate、無地理條件時省略無作用計算。新增真 PG 測試檢查設定在成功／例外後恢復。這三處尚無 NAS 成績；精確同 SHA CI 結果以 PR 最新區段為準。

## NAS 已實測的界線

- 硬體 CasaOS／Intel Celeron N3450 @1.10GHz／8 GB；Node 22.23.3、PG 16.14。
- baseline 848aa7e 的四案 50 次正式驗收已跑完且 FAIL；原始證據在 `evidence/prb-nas-20260926/`（201b5bb 證據提交）。
- 本輪開發短測固定 120k stored／36k active。單區 C1 從無 profiler 約 2.86 秒，經版本重用約 2.48 秒，再經窄欄位批次與關係索引約 1.93 秒；三次量測，結果 hash 一致。**不是 50 次正式驗收，且仍高於 1 秒目標。**
- 最後一個名為 `diagnostic-cursor.json` 的約 2.19 秒結果，實際未套入三處新修正（patch 的 EOF context 失敗），不可用來評價新 planner 設定。
- 新 SHA 的 NAS 四案驗收已於本輪完成（FAIL，見上）；C4 lag 收斂與 `stats_ms` 成本尚未處理。
  整體遷移 C～F、production auth／雙節點 HTTP E2E、HA promotion／failover、PITR／RPO／RTO 未完成。

## 可接續環境（本輪結束時）

- NAS 受測 checkout：`/mnt/Storage1/prb-acceptance/5151`（detached `ef9e21a`，取自 GitHub 權威來源）。
  新一輪 runner 建立的資源都帶 `prb-nas-verify=1` 標籤，可依標籤查回來源。
- NAS 持久證據：`/mnt/Storage1/prb-acceptance/evidence/prb-nas-ef9e21a/`（含 SHA256SUMS）；
  同一份已提交到 repo 的 `evidence/prb-nas-ef9e21a/`。
- 封存：`/mnt/Storage1/prb-archive/prb-opt-jouclpr0-20260926/` 與
  `/mnt/Storage1/prb-archive/prb-nas-src-5oVQAQv1-20260926/`。舊 `/tmp/prb-opt.JoUcLPr0`、
  `/tmp/prb-nas-src.5oVQAQv1` 依指示先保留，重開機即失效，內容以封存為準。
- `prb-opt-jouclpr0-*` 五項資源已清除；新一輪 runner 資源由 EXIT trap 清除，兩者查詢皆 0 筆。
- code-server 的 `/tmp/prb-transfer.it64ho8o/5151` 已確認沒有未納入的修改。
- 既有 SSH 設定／金鑰／known_hosts 依共享 infra runbook 使用，StrictHostKeyChecking 保持啟用。
  長時間驗收以 `setsid nohup` 脫離 SSH 連線，避免斷線觸發 runner 的 EXIT cleanup。
  不要新開 tunnel、不要把機密寫入 repo。正式 `5151_shadow` 不可用於測試 setup／migration／ANALYZE。
- 舊 dev 註記仍有效但已封存：NAS 開發短測曾到單區 C1 約 1.93 秒（3 次量測、非 50 次正式驗收）；
  `diagnostic-cursor.json` 的約 2.19 秒未套入三處 planner 修正，不可用來評價新設定。

## 後續

1. 針對 `stats_ms`（四案最大單一階段）與 C4 併發下的 CPU 成本（profile／sort／relations／display）修正；
   每次新程式都要有精確 SHA CI 與 NAS 四案驗收。
2. lag gate 尚未有任何一案同時滿足 p99 ≤50 ms、max ≤100 ms；C4 的 lag max 已到 226.62 ms，需一併收斂。
3. 不使用較強硬體、不放寬門檻、不減少候選來讓數字過關；失敗樣本一律保留。
4. NAS gate 通過前維持 NOT_READY_FOR_REVIEW／NOT_READY_FOR_MERGE。完整 PR-B 驗收後再接續 C～F；
   正式變更仍 manual-only，且需 Owner 明確核准。
