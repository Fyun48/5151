# PR-B 143f1a6 CI 證據（不是 NAS 驗收）

程式 SHA：`143f1a636a21a85cad1019dd5037a476123fd5a3`。
結論：**CI_SMOKE_PASS / NAS_NOT_RUN / NOT_READY_FOR_REVIEW / NOT_READY_FOR_MERGE**。
全區 C4 的 lag p99 超過 50 ms；CI checks 成功不代表所有效能 gates 成功。

## 來源與驗證

- [Tests run 36235146987](https://github.com/Fyun48/5151/actions/runs/36235146987)：completed／success。
- 一般測試：2650 tests／2612 pass／0 fail／38 skip。
- 真 PG 測試：143 tests／142 pass／0 fail／1 optional skip。必要 PG fixture 實際執行。
- 同 SHA GitGuardian 與 model review checks 皆 success。
- [原始 artifact 10904126085](https://github.com/Fyun48/5151/actions/runs/36235146987/artifacts/10904126085)。
  本目錄 `prb-search-benchmark.json` 由 artifact ZIP 原樣取出，未重算或刪除樣本。
  ZIP SHA256：`f1101cb78fb1dafbd4dd3e3e6dd1209f794f085d7296cddcadad30aaee45d195`，
  下載後已核對 GitHub 回報的 digest。
- JSON 的 `sourceSha` 為上方程式 SHA；`checkoutSha` 為 Actions 的 PR merge ref
  `f7952e4b29bb243f1fab2a36d6cb2470dffac9ef`，兩者都原樣保留。
  JSON 的全部 13 個 module hashes 已與 143f1a6 checkout 核對一致。
- CI 硬體 AMD EPYC 7763／4 vCPU／16,766,406,656 bytes RAM；Node v22.23.2。
  這不是 CasaOS N3450 的成績，也不把本機 Node 22.23.3 診斷當作這輪 CI。
- 固定 fixture：120,000 stored／36,000 active，完整 42 欄、兩行政區、1,024 節點關係鏈。
  每案暖機 5 輪、量測 50 次，完整 page／stats／JSON 與獨立結果斷言。

## 四案結果

| CI 案例 | cold ms | warm p50／p95 ms | lag p99／max ms | peak RSS MiB | errors／timeouts |
|---|---:|---:|---:|---:|---:|
| 單區 C1 | 939.65 | 315.18／361.76 | 23.30／27.28 | 437.1 | 0／0 |
| 單區 C4 | 673.47 | 824.43／871.02 | 33.62／36.47 | 725.5 | 0／0 |
| 全區 C1 | 753.87 | 344.38／371.66 | 37.13／50.23 | 703.1 | 0／0 |
| 全區 C4 | 682.80 | 985.48／1071.29 | **54.20**／87.88 | 908.9 | 0／0 |

- 200 次請求 errors／timeouts 皆 0；`sqliteAttempts = 0`。
- SQL／交易控制：單區 49／4、全區 44／4；完整欄位與候選數未減少。
- `nasLatencyPassed` 在四案皆為 null；`nasAcceptance` 明確為 NOT_RUN。
- 全區 C4 `lagTargetMet=false`；其他三案 true。保留超標結果，不以 CI success 覆蓋。
- 結果 hash：單區 `d75a57c20695b67ee348505aa3c074ff1a05b769e5263b483f51a0285800423f`；
  全區 `b1a872a9e9aa4c7494129d315fcb89bc043d72db39d5bfa8506b93c35169cbf7`，
  與上一輪 ef9e21a 的 NAS 結果相符。

## 瓶頸與下一步

本次 CI 的 stats_ms p95（單區 C1／C4、全區 C1／C4）：192.37／424.33／170.85／386.56 ms。
單區 C1 的 stats inputs／candidates／auxiliary／profile／count p95 分別為 165／91／65／21／24 ms。
各階段 p95 不能直接相加，也不能拿不同 GitHub runner 的數字推定 NAS 改善百分比。

本輪已降低寬列個人旗標、重複條件正規化與排序 key 存取的 CPU 成本；
完整端到端與 C4 lag 的 NAS 效果仍須實測。請依
[PRB_EXECUTION_STATE.md](../../docs/handoffs/PRB_EXECUTION_STATE.md) 的精確 SHA 指令，
在原 CasaOS N3450 跑四案，保存結果與清理紀錄。最近完成的 NAS 仍是 ef9e21a FAIL。
未合併、未部署。
