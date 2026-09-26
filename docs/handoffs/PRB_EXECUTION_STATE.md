# PR-B 可接續狀態

更新：2026-09-26，CPU 修正提交 `143f1a636a21a85cad1019dd5037a476123fd5a3` 已推送，精確 SHA 的 CI checks 全部成功。
**最近完成的 NAS 驗收：受測 SHA `ef9e21aa0f293e97a7269e4726f499e4561f21fe`，結果 `NAS_ACCEPTANCE_FAIL`。**
PR [#497](https://github.com/Fyun48/5151/pull/497) 保持 open、非草稿、未合併、未部署。維持 NOT_READY_FOR_REVIEW／NOT_READY_FOR_MERGE。

## 本輪 CPU 修正（143f1a6）

- 從 GitHub 的 `2a90c1d` 乾淨 checkout 開始，沒有取用 NAS 舊 `/tmp` 工作樹。
- 完整 42 欄 PG 候選的個人旗標 overlay 改為固定欄位建構，避免逐列枚舉寬物件。
  保留型別、重複刊登隱藏優先順序與原始列不變性；自訂 projection 保留通用 overlay。
- 排除關鍵字／仲介條件每批正規化一次；未啟用 kind／source 篩選時省略空操作。
- 非同步穩定排序預先計算純量 key，省掉每次 comparison 的 Map 查找；日期解析快取
  限定單次呼叫、最多 128 個字串。保留全候選與所有排序、時間與 tie-break 規則。
- 有效數字租金已決定結果時省略文字解析；數字／萬元／文字優先順序不變。
- 本機 Node 22.23.3：相關回歸 57 tests／57 pass／0 fail／0 skip；包含 1,031 筆跨批排序、
  所有排序模式、穩定相等項、42 欄、旗標／設定隔離與篩選契約。
- 本機 CPU-only 診斷第一輪 C4 p95：單區 454.72→249.31 ms、全區 649.73→293.75 ms。
  同批 36,000 候選、暖機 3 次、每案 12 次；沒有 PG、沒有 NAS，僅用於確認 CPU 熱點。
  最後數字租金 fast path 未另外計入這份診斷；正式效能以同 SHA CI 與 NAS 為準。
- runner、benchmark、fixture、gate、42 欄契約、快照與完整候選數皆未修改。

本執行器可改碼、推送與檢查 CI，但沒有 DeepSeek Harness 的既有 NAS SSH 設定／金鑰。
`143f1a6` 的 NAS 尚未啟動，必須由具既有 SSH 存取的執行器接續；不建立新通道。

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

- 最新程式 SHA `143f1a636a21a85cad1019dd5037a476123fd5a3`：
  [Tests 36235146987](https://github.com/Fyun48/5151/actions/runs/36235146987) completed／success。
  一般 2650 tests／2612 pass／0 fail／38 skip；真 PG 143 tests／142 pass／0 fail／1 optional skip。
  GitGuardian 與 model review checks 也成功。
- 同 SHA CI 四案 p95：單區 C1 361.76／C4 871.02 ms；全區 C1 371.66／C4 1071.29 ms。
  每案 50 次，errors／timeouts／SQLite attempts 皆 0；`CI_SMOKE_PASS`。
  **全區 C4 lag p99 54.20 ms 超過 50 ms**（max 87.88 ms）；不可寫成所有效能 gates 已過。
  完整 artifact 原樣保存於 `evidence/prb-ci-143f1a6/`，含版本、硬體、module hashes 與 SHA256SUMS。
- 最近 NAS 受測 SHA `ef9e21aa0f293e97a7269e4726f499e4561f21fe`：
  [同 SHA Tests 36233027423](https://github.com/Fyun48/5151/actions/runs/36233027423) success，NAS FAIL。
- 以下 `749165e`～`1d09dee` 為歷史程式／CI 記錄；其 NAS 效果已由 `ef9e21a` 的完整實跑涵蓋，
  結果仍只歸屬實際受測 SHA `ef9e21a`。

- 分支：`fix/pr-b-persist-listing-transaction`；base `9c6b7b04f9801717cb6696e8e095fde4c309473f`。最新 HEAD 與 CI 結果讀 PR。
- `749165e`：完整 42 欄 array 解碼、同一請求的統計／清單候選重用、行政區關係縮減與統計單迴圈。一般 CI 的 4 個來源文字解析測試於下一提交修復，沒有刪掉欄位或排序斷言。
- `7a1f4eec8f946ee9a9c1c378ff1560880b67ae6b`：[Tests 36229928048](https://github.com/Fyun48/5151/actions/runs/36229928048)，一般 2644／2608 pass／0 fail／36 skip；PG 132／131 pass／0 fail／1 optional skip。
- `9d415e4c2b4453ed7d0dfa68bec760c4c67cec75`：[Tests 36230822383](https://github.com/Fyun48/5151/actions/runs/36230822383)，一般 2646／2609 pass／0 fail／37 skip；PG 142／141 pass／0 fail／1 optional skip。CI_SMOKE_PASS。
- 9d415e4 完整 CI 四案 p95：單區 C1 426.06／C4 1001.46 ms；全區 C1 451.59／C4 1307.31 ms。200 次 errors/timeouts 皆 0、SQLite guard 通過。全區 C4 lag p99 56.75 ms 高於 50 ms，不能把 CI smoke 成功寫成全部效能 gate 通過。
- [CI 原始 artifact](https://github.com/Fyun48/5151/actions/runs/36230822383/artifacts/10902641044)。
- 版本重用設計與界線：[PRB_CONTENT_REUSE_20260926.md](PRB_CONTENT_REUSE_20260926.md)。每次在當前 PG 快照核對 WHERE、列版本、relation/storage/schema/role/epoch 與完整欄位權限，沒有 search-key TTL 或 query-result memo。

1d09dee 加入完整讀取 cursor 的交易內 planner 設定、可用既有 source 索引的等價 predicate、無地理條件時省略無作用計算，並以真 PG 測試設定在成功／例外後恢復；完整 NAS 結果見 ef9e21a。

## NAS 已實測的界線

- 硬體 CasaOS／Intel Celeron N3450 @1.10GHz／8 GB；Node 22.23.3、PG 16.14。
- baseline 848aa7e 的四案 50 次正式驗收已跑完且 FAIL；原始證據在 `evidence/prb-nas-20260926/`（201b5bb 證據提交）。
- 歷史 NAS 開發短測固定 120k stored／36k active。單區 C1 從無 profiler 約 2.86 秒，經版本重用約 2.48 秒，再經窄欄位批次與關係索引約 1.93 秒；三次量測，結果 hash 一致。**不是 50 次正式驗收，且仍高於 1 秒目標。**
- 最後一個名為 `diagnostic-cursor.json` 的約 2.19 秒結果，實際未套入三處新修正（patch 的 EOF context 失敗），不可用來評價新 planner 設定。
- ef9e21a 的 NAS 四案驗收已完成（FAIL，見上）。143f1a6 的 CPU 修正尚無 NAS 四案結果；
  不預先宣稱 `stats_ms`、C4 或 lag gate 已達標。
  整體遷移 C～F、production auth／雙節點 HTTP E2E、HA promotion／failover、PITR／RPO／RTO 未完成。

## 可接續環境（DeepSeek 2026-09-26 完成後）

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

1. `143f1a636a21a85cad1019dd5037a476123fd5a3` 的全部 CI checks 已成功；下一步跑這個精確 SHA 的 NAS 四案。
   不用文件提交 HEAD 或前一個綠燈 SHA 代替；將 CI 成績、NAS 成績與受測版本分開記錄。
2. lag gate 尚未有任何一案同時滿足 p99 ≤50 ms、max ≤100 ms；C4 的 lag max 已到 226.62 ms，需一併收斂。
3. 不使用較強硬體、不放寬門檻、不減少候選來讓數字過關；失敗樣本一律保留。
4. NAS gate 通過前維持 NOT_READY_FOR_REVIEW／NOT_READY_FOR_MERGE。完整 PR-B 驗收後再接續 C～F；
   正式變更仍 manual-only，且需 Owner 明確核准。

## 143f1a6 的 NAS 接續指令

前置條件已滿足：上方精確 SHA 的全部 CI checks 成功。以下在具既有 SSH 設定的執行器使用，
目前只準備好指令，**未啟動此輪 NAS 工作**。本節不能當作已完成證據。

```bash
ssh casa-nas
cd /mnt/Storage1/prb-acceptance/5151 || exit 1
test -z "$(git status --porcelain)" || exit 1
git fetch origin || exit 1
git checkout --detach 143f1a636a21a85cad1019dd5037a476123fd5a3 || exit 1
test "$(git rev-parse HEAD)" = 143f1a636a21a85cad1019dd5037a476123fd5a3 || exit 1
mkdir -p /mnt/Storage1/prb-acceptance/evidence
# 目錄已存在時停止，不覆寫任何先前樣本。
mkdir /mnt/Storage1/prb-acceptance/evidence/prb-nas-143f1a6 || exit 1
setsid nohup bash -c '
  bash v3/scripts/prb-nas-verify.sh \
    143f1a636a21a85cad1019dd5037a476123fd5a3 \
    /mnt/Storage1/prb-acceptance/evidence/prb-nas-143f1a6 \
    > /mnt/Storage1/prb-acceptance/evidence/prb-nas-143f1a6/runner.log 2>&1
  prb_run_exit=$?
  echo "$prb_run_exit" > /mnt/Storage1/prb-acceptance/evidence/prb-nas-143f1a6/runner-exit.txt
  exit "$prb_run_exit"
' >/dev/null 2>&1 &
```

完成後核對 runner exit 與 JSON 的 `sourceSha`／`checkoutSha`，保留 FAIL 樣本。
確認完整 PG tests、四案各 50 次、errors／timeouts、SQLite attempts、主機與映像識別，
記錄 p50／p95、lag p99／max、RSS／heap、各階段及結果 hash。查詢並保存清理結果：

```bash
docker ps -a --filter label=prb-nas-verify=1 --format '{{.ID}} {{.Names}}'
docker network ls --filter label=prb-nas-verify=1 --format '{{.ID}} {{.Name}}'
docker volume ls --filter label=prb-nas-verify=1 --format '{{.Name}}'
```

三類查詢應為 0 筆；若有殘留，先核對來源，不能廣泛 prune。
寫 README、保存 cleanup 紀錄後產生 `SHA256SUMS`，把完整證據提交到
`evidence/prb-nas-143f1a6/`，回填本文件與 PR。只有全部 NAS gates 通過才能變更 readiness；
合併與部署仍需 Owner 明確核准。
