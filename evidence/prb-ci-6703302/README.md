# PR-B 6703302 CI 證據（不是 NAS 驗收）

程式 SHA：`6703302cf57deeaa8cc5b8866f08fb4f8d6e23c5`。
**CODE_CI_PASS / CI_SMOKE_PASS / NAS_NOT_RUN / NOT_READY_FOR_REVIEW / NOT_READY_FOR_MERGE**。
本輪 CI 延遲比上一輪差，尚未證實 NAS 延遲或 GC 改善；完整保留此結果，不挑樣本。

## 來源

- [精確 SHA Tests 36240011855](https://github.com/Fyun48/5151/actions/runs/36240011855) completed／success。
  一般 2658 tests／2618 pass／0 fail／40 skip；真 PG 149 tests／148 pass／0 fail／1 optional skip。
  同 SHA GitGuardian 與 model review checks 也全綠。
- [原始 artifact 10904524394](https://github.com/Fyun48/5151/actions/runs/36240011855/artifacts/10904524394)。
  JSON 原樣取出；ZIP SHA256 已核對 GitHub digest：
  `2d8c45191fd0a9f0697dd2759e73b645343621f502eae98c7426e2f12e914a4f`。
- JSON sourceSha 為上方程式 SHA，checkoutSha 為 Actions merge ref `48ab619ee3cc7050da660b832b30010f010187b4`。
  14 個 module hashes 全部與程式 SHA 相符，source／checkout 原樣保留。
- CI Intel Xeon Platinum 8573C／4 vCPU／16,765,378,560 bytes RAM，Node v22.23.2、PG 16.14。
  硬體型號與 ae88ce6 CI 相同，但為不同 workflow 執行，並非同一受控 A/B；兩者都不是 CasaOS N3450。
- 固定 120k stored／36k active、完整 42 欄、1024 節點關係鏈、兩行政區、暖機 5 輪、四案各 50 次。
  完整 page／stats／JSON，獨立結果斷言。200 次 errors／timeouts=0，SQLite attempts=0。
- 四案結果 hash 與 ae88ce6 NAS 完全相同。單區 `d75a57c20695b67ee348505aa3c074ff1a05b769e5263b483f51a0285800423f`；
  全區 `b1a872a9e9aa4c7494129d315fcb89bc043d72db39d5bfa8506b93c35169cbf7`。

## 四案 CI 結果與前輪對照

| 案例 | p50／p95 ms | 前輪 CI p95 ms | p95 變化 | lag p99／max ms | RSS MiB | heap MiB | GC max ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| 單區 C1 | 253.56／294.22 | 233.24 | +26.1% | 17.24／18.25 | 426.2 | 324.9 | 6.024 |
| 單區 C4 | 641.05／767.91 | 675.10 | +13.7% | 19.97／28.82 | 603.8 | 506.6 | 20.667 |
| 全區 C1 | 265.83／301.05 | 243.43 | +23.7% | 17.55／21.84 | 593.5 | 343.1 | 6.930 |
| 全區 C4 | 731.52／778.20 | 627.09 | +24.1% | 21.53／31.67 | 705.0 | 596.7 | 16.575 |

四案 lag 仍達標；NAS acceptance 是 NOT_RUN，不能以 CI 的成功解除 NAS gate。
RSS／heap 改善並不一致，GC 暫停也沒有呈現全面改善。改成逐批處理降低中間資料的保留範圍，
不等於已量得整個請求配置量或 GC 成本下降；下輪必須用同一 NAS 驗證。

## 改動與量測界線

- 版本窄列以 array values 逐批消費，省去整個中間 selection 陣列；完整候選仍全部建立。
  stats 每 256 筆完成 profile 與計數，不保留完整 private profile 陣列。全域計數只加一次。
- 窄列批次仍 1024、寬列仍 512；query count 仍單區 88／全區 96，交易控制 4。
  本批沒有宣稱已解決往返次數；先保留前輪成功的 lag 切片界線。
- 新 stats profile_sync_ms／count_sync_ms 是同步累積值，不是前輪的分段 wall time；
  reduce_ms 才包含排程等待。不能拿不同定義的欄位直接算改善百分比。
- 同一時鐘的 workTimeline 保存每類最多 32 個最長、≥20 ms 的 GC／tickGap／FETCH／yieldWait spans。
  GC 使用實際 entry.startTime；其他 spans 使用操作起點。timeOrigin 與量測窗保存在 measurementClock。
  **舊資料的不同最大值不能相加解釋 162 ms lag，也不能據短 generator step 排除未插樁的同步段。**
- 空閒 PG SELECT 1 往返 p50 約 0.11～0.15 ms，只是未負載基準；不能從負載 FETCH wall 直接減出 server CPU。
  processCpu 是 Node process 的 user／system 累積值，含其執行緒，與 PG 容器的 CPU 分開看。
- 新 COUNT cold EXPLAIN：前三案約 46～47 ms／8001 shared hits，最後全區 C4 約 25 ms／465 shared hits。
  固定候選不變，查詢計畫／可見性與資料庫背景狀態仍可能影響耗時；不可把所有差異都歸為程式或 GC。
- NAS runner 新增對自身拋棄式 PG 容器的 docker stats 串流；記錄 start UTC、JSONL 及 stderr，
  EXIT 時停止 sampler 並 wait。尚未在 NAS 驗證此新增收集流程；CI 僅跑 benchmark 與真 PG，沒有執行 NAS runner。

## 接續

請 DeepSeek 使用原 CasaOS N3450、既有 SSH、setsid nohup，指定
`6703302cf57deeaa8cc5b8866f08fb4f8d6e23c5`，依 [交接文件](../../docs/handoffs/PRB_EXECUTION_STATE.md) 執行。
保存完整四案、raw logs、PG resource 檔、時間線、module hashes、主機／映像、runner exit、清理紀錄與 SHA256SUMS。
後續文件提交恢復 runner executable bit（程式內容不變）；指定 SHA 的 runner 明確使用 bash 呼叫。
最新完成 NAS 仍為 ae88ce6 FAIL。未合併、未部署；不動正式庫、不放寬門檻、不減候選、不換硬體。
