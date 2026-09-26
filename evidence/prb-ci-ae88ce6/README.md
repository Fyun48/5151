# PR-B ae88ce6 CI 證據（不是 NAS 驗收）

程式 SHA：`ae88ce66df0a2271dcc0e14f5525db6b2cf93bc0`。
**CI_SMOKE_PASS / NAS_NOT_RUN / NOT_READY_FOR_REVIEW / NOT_READY_FOR_MERGE**。
精確 SHA 的一般測試、真 PG、GitGuardian 與 model review checks 全部成功，可交給 DeepSeek 跑 NAS。

## 來源與驗證

- [Tests run 36237613877](https://github.com/Fyun48/5151/actions/runs/36237613877)。
- 一般測試：2656 tests／2616 pass／0 fail／40 skip。
- 真 PG：148 tests／147 pass／0 fail／1 optional skip。
- 同 SHA GitGuardian 與 model review checks 皆 completed／success。
- 本機 Node 22.23.3 相關回歸：127 tests／121 pass／0 fail／6 PG-only skips；這 6 案由真 PG CI 執行。
- [原始 artifact 10904622002](https://github.com/Fyun48/5151/actions/runs/36237613877/artifacts/10904622002)。
  JSON 由 ZIP 原樣取出，未重算、未刪除樣本。ZIP SHA256 已核對 GitHub digest：
  `b4ecc3a4bda21b5e5093636a2b55f9045494e59814ca336185d473fdc16ef2c2`。
- JSON `sourceSha` 為上述程式 SHA，`checkoutSha` 為 Actions PR merge ref
  `600e03370c5b16b8f8a6da11e55798e9e1c95dfa`，兩者原樣保留；14 個 module hashes 全部與程式 SHA 相符。
- CI 硬體 **Intel Xeon Platinum 8573C／4 vCPU／16,765,378,560 bytes RAM**，Node v22.23.2、PG 16.14。
  前一輪 143f1a6 CI 是 AMD EPYC 7763；不能把不同 runner 的改善幅度推算成 NAS 成效。
- fixture 不變：120,000 stored／36,000 active、完整 42 欄、兩行政區、1,024 節點關係鏈；
  暖機 5 輪、四案各 50 次、完整 page／stats／JSON，獨立斷言 IDs 與 totals。

## 四案結果

| CI 案例 | cold ms | warm p50／p95 ms | lag p99／max ms | peak RSS MiB | errors／timeouts |
|---|---:|---:|---:|---:|---:|
| 單區 C1 | 662.30 | 207.19／233.24 | 15.56／18.78 | 443.4 | 0／0 |
| 單區 C4 | 464.77 | 521.28／675.10 | 19.64／24.40 | 565.1 | 0／0 |
| 全區 C1 | 530.20 | 220.82／243.43 | 17.27／19.46 | 571.8 | 0／0 |
| 全區 C4 | 507.71 | 586.13／627.09 | 22.66／30.39 | 788.8 | 0／0 |

四案 CI smoke 與 lag（p99 ≤50／max ≤100 ms）皆通過；200 次 errors／timeouts 皆 0、`sqliteAttempts = 0`。
`nasLatencyPassed` 皆為 null，`nasAcceptance` 為 NOT_RUN。**不把 CI lag 達標當作 NAS gate 已過。**
結果 hash 與 NAS 6381f0f 完全相同：

- 單區：`d75a57c20695b67ee348505aa3c074ff1a05b769e5263b483f51a0285800423f`
- 全區：`b1a872a9e9aa4c7494129d315fcb89bc043d72db39d5bfa8506b93c35169cbf7`

## 同步工作與讓出診斷

| 案例 | 最大 step ms | 最大 slice ms | 最大 yieldWait ms | 最大 GC pause ms |
|---|---:|---:|---:|---:|
| 單區 C1 | 3.000 | 4.268 | 6.201 | 6.088 |
| 單區 C4 | 7.200 | 8.035 | 17.168 | 18.853 |
| 全區 C1 | 4.274 | 6.233 | 6.621 | 6.501 |
| 全區 C4 | 7.101 | 8.615 | 17.999 | 13.405 |

- step 是單次 generator next() 的同步段；checkpoint 報告的最大工作量為 256（列、peer 或排序搬移項目），
  不是候選上限。slice 是同一 generator 兩次明確讓出間的時間，可包含多個 checkpoints。
  budget 2 ms 只在 checkpoint／最後 return 時檢查，並非能中斷 GC 或單次同步工作。
- yieldWait 是 `await setImmediate` 的等待，包含其他請求與 I/O；PG `.wall` 也包含 server／transport／parser，
  兩者都不是單次同步 CPU。`.submitSync` 與 `.appendRows.sync` 只量指定段落。
  所列是插樁範圍的最大值，不能聲稱整個 process 從未有更長同步段。timer gap 包含原訂 10 ms 間隔。
- 本輪量測中 PG appendRows 每批最多 1,024 列；snapshot 測試也驗證 8,705 列跨批完整讀回，
  42 欄寬列讀取與欄位權限／MVCC／角色隔離測試仍通過。
- 原始 JSON 保存各指標 calls／totalMs／maxMs／totalUnits／maxUnits 及 >2／>10／>50 ms 次數。
  `totalUnits` 為 checkpoint 回報數；沒有宣稱涵蓋所有未插樁尾段或所有 PG parser 工作。

## 查詢與剩餘成本

- 固定 fixture 的 list ID 查詢 cold EXPLAIN root shared hits 為 **2,438**（單區／全區皆同）；
  上輪 6381f0f NAS 為 39,460／74,436。候選數仍為 18,512／36,000。
  這是查詢工作量的直接證據；不同硬體的 execution ms 不拿來估算 NAS 改善。
- 窄列批次縮小使 SQL／cursor query count 由單區 49→88、全區 44→96；交易控制仍各 4。
  沒有把多出的 FETCH 隱藏或當作查詢數下降。NAS 須同時檢查往返成本與 lag。
- stats inputs p95：107／356／109／358 ms；其中 candidates 68／287／64／338 ms、
  normalize 2／7／2／3 ms。整體 stats p95：135.53／382.52／127.43／378.79 ms。
- C4 的 sql p95 為 210／231 ms、relations 為 14／33 ms。各階段 p95 不可相加。
- `COUNT(*)` query wall max 為 36.05／102.12／43.72／54.35 ms；它是資料庫與排程的合計等待，
  不可據此宣稱 Node 有 102 ms 的同步卡頓。

## 下一步

DeepSeek Harness 依 [PRB_EXECUTION_STATE.md](../../docs/handoffs/PRB_EXECUTION_STATE.md)
的指定 SHA 指令，在原 CasaOS N3450 跑 `ae88ce66df0a2271dcc0e14f5525db6b2cf93bc0`。
保存四案、原始 JSON／logs、同步工作診斷、映像／主機、實際受測 SHA、runner exit、清理紀錄與 SHA256SUMS。
最新已完成 NAS 仍為 **6381f0f FAIL**；不改門檻、不減候選、不改硬體、不動正式庫，不合併、不部署。
