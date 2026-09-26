# PR-B NAS 同 SHA 驗收（2026-09-26，受測 SHA ae88ce6）

結論：**NAS_ACCEPTANCE_FAIL / NOT_READY_FOR_MERGE**。未合併、未部署。
四案完整跑完，200 次量測 errors／timeouts 皆 0，零 SQLite guard 通過。
**lag 大幅改善：四案有三案達標**（單區 C1、單區 C4、全區 C1）；延遲幾乎沒動（單區略退 3%）。
剩下兩件事：單區延遲仍超標，以及全區 C4 的延遲（超 32.71 ms）與 lag max（162.05 ms）。

## 受測版本

- 受測 SHA：`ae88ce66df0a2271dcc0e14f5525db6b2cf93bc0`，依 PR #497 與 `PRB_EXECUTION_STATE.md`
  的交接指令指定，**未改測後續文件 HEAD `be2da17`**。
- 同 SHA CI [36237613877](https://github.com/Fyun48/5151/actions/runs/36237613877) completed／success；
  一般 2656／2616 pass／0 fail／40 skip，真 PG 148／147 pass／0 fail／1 skip。
- 本輪 runner 與前兩輪相同（blob `ef92607a…`），資源標籤 `prb-nas-verify=1` 再次在實跑中驗證生效。
- 結果 hash 與前幾輪相同：單區 `d75a57c20695b67ee348505aa3c074ff1a05b769e5263b483f51a0285800423f`、
  全區 `b1a872a9e9aa4c7494129d315fcb89bc043d72db39d5bfa8506b93c35169cbf7`。

## 執行環境

- 主機：CasaOS `ubuntucasaos`，Intel Celeron N3450 @ 1.10GHz，4 CPU，8,162,942,976 bytes RAM。
- Docker 28.0.1；Node `v22.23.3`；PostgreSQL `16.14`。
- Node image `sha256:b37a4d56eedb5e42bca59c8d4782fa550e741fba5dbce943c53767d3ceee57e6`；
  PG image `sha256:de3a4eab8fdfa507ea92aac488b916b08089e515db49b055fe71dfa271ba3a28`。
- 固定 fixture `prb-fixed-v1`，asOf `2026-09-26T00:00:00.000Z`：120,000 stored／36,000 active、
  兩個行政區、1,024 節點關係鏈、跨區 peer。暖機 5 輪、四案各 50 次完整 page／stats／JSON。
- 以 GitHub 唯一權威來源取得 `ae88ce6` 的獨立 checkout。PG 在新 volume、internal network，
  未發布 host port，未對正式 `5151_shadow` 做 setup／migration／ANALYZE。

## 硬 gate 結果

| 案例 | cold ms | p50 ms | p95 ms | 目標 ms | 延遲結果 | lag p99／max ms | lag 門檻 | peak RSS MiB | errors／timeouts |
|---|---:|---:|---:|---:|---|---|---:|---:|---|
| 單區 C1 | 3719.4 | 1209.40 | 1429.96 | 1000 | FAIL | **23.25**／**44.83** | **PASS** | 436.2 | 0／0 |
| 單區 C4 | 2764.9 | 2918.40 | 3321.86 | 2000 | FAIL | **36.08**／**67.31** | **PASS** | 679.3 | 0／0 |
| 全區 C1 | 2775.9 | 1270.18 | 1448.70 | 2000 | **PASS** | **26.64**／**73.86** | **PASS** | 666.6 | 0／0 |
| 全區 C4 | 2735.2 | 3519.64 | 4032.71 | 4000 | FAIL | 41.84／162.14 | FAIL | 745.2 | 0／0 |

- lag 門檻 p99 ≤50 ms、max ≤100 ms。全區 C4 的 **p99 41.84 ms 已在門檻內**，只有 **max 162.14 ms 超標**。
- 全區 C4 延遲只超目標 **32.71 ms（0.82%）**；單區 C1 為目標 1.43 倍、單區 C4 為 1.66 倍。
- 真 PostgreSQL：148 tests／147 pass／0 fail／1 optional skip（與同 SHA CI 相同）。
- SQL／交易控制：單區 88／4、全區 96／4（窄列批次使 round trips 由 49／44 增加；交易控制仍為 4）。
- `sqliteAttempts = 0`。runner exit = `1`。

## 本批的實際效果：拿一點延遲換到大幅 lag

| 案例 | 6381f0f p95 | 本輪 p95 | 延遲變化 | 6381f0f lag p99／max | 本輪 lag p99／max |
|---|---:|---:|---:|---|---|
| 單區 C1 | 1388.20 | 1429.96 | +3.0% | 59.47／89.52 | **23.25／44.83** |
| 單區 C4 | 3221.51 | 3321.86 | +3.1% | 72.02／223.08 | **36.08／67.31** |
| 全區 C1 | 1449.60 | 1448.70 | −0.1% | 91.68／145.62 | **26.64／73.86** |
| 全區 C4 | 4016.80 | 4032.71 | +0.4% | 126.22／247.46 | **41.84／162.14** |

延遲與前一批幾乎相同（單區小退 3%，全區持平），但 lag p99 降到原來的 33～39%，max 降到 50～66%。
**這一批的目的（縮小同步工作切片、把讓出間隔壓住）確實達成了。**

各輪延遲（NAS p95，ms）：

| 案例 | 848aa7e | ef9e21a | 6381f0f | 本輪 ae88ce6 |
|---|---:|---:|---:|---:|
| 單區 C1 | 4628.58 | 1775.12 | 1388.20 | 1429.96 |
| 單區 C4 | 13857.82 | 4680.62 | 3221.51 | 3321.86 |
| 全區 C1 | 4700.29 | 1959.80 | 1449.60 | 1448.70 |
| 全區 C4 | 14200.41 | 5821.09 | 4016.80 | 4032.71 |

## workDiagnostics（本輪新增的診斷）

| 案例 | 最大 step ms | step 工作量 units | 最大 slice ms | 最大 yieldWait ms | 最大 tickGap ms | 最大 GC pause ms | GC over50 ms | 最大 PG fetch wall ms | PG reply 列數 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 單區 C1 | 6.919 | 256／1,876,800 | 7.731 | 23.863 | 44.805 | 35.683 | 0 | 150.126 | 2,802,350 |
| 單區 C4 | 8.149 | 256／1,876,800 | 9.382 | 45.258 | 67.228 | 53.316 | 1 | 279.889 | 2,802,350 |
| 全區 C1 | 7.479 | 256／3,600,000 | 8.918 | 23.011 | 73.837 | 71.479 | 1 | 139.649 | 3,600,000 |
| 全區 C4 | 7.119 | 256／3,600,000 | 7.909 | 64.949 | 162.051 | 59.069 | 3 | 303.586 | 3,600,000 |

單位定義取自 JSON 內 `workDiagnosticsDefinitions`：`step` 為同步 `next()` 時間（`maxUnits` 是檢查點
回報的工作量，不是候選上限）；`slice` 是兩次讓出之間的總時間；`yieldWait` 是 `await setImmediate`
的等待（含其他請求與 I/O，不是同步 CPU）；`gcPause` 是量測窗內觀測到的 GC 時間。

## lag 超標的定位（不看 p95，只看讓出）

- **同步切片本身已經被壓住**：四案最大 `step` 只有 6.9～8.1 ms、最大 `slice` 7.9～9.4 ms，
  沒有任何一次接近 50 ms。所以全區 C4 的 162 ms **不是**單一長時間同步迴圈造成的。
- **lag max 就是最大 tick gap**：四案的 `tickGap` 最大值（44.805／67.228／73.837／162.051）
  與回報的 lag max（44.83／67.31／73.86／162.14）一致。tick 的標稱間隔是 10 ms。
- **全區 C4 的 162 ms 由「等待」與 GC 疊出來**：`pg.fetch.wall` 最大 303.586 ms、
  `pg.fetch.yieldWait` 最大 96.113 ms、`gc.pause` 最大 59.069 ms（3 次超過 50 ms）。
  在 4 路併發下，I/O 回呼與 GC 連續佔用事件迴圈，讓 10 ms 計時器拿不到執行機會。
  這是排程與配置壓力，不是未受控的同步 CPU。
- 全區 C1 的 GC max 也有 71.479 ms（1 次 >50 ms），但併發低時 tickGap 仍只有 73.837 ms，
  與 lag max 相符；可見 C4 是放大器。

## 下一批的具體目標（依本輪量測）

1. **GC pause**：四案最大 35.7～71.5 ms、超過 50 ms 共 5 次。窄列批次每批 1,024 列、
   四案共讀 2.8M／3.6M 列，短命物件量可觀；降低 fetch／append 期間的配置或改用重用緩衝，
   是壓下 tickGap 最直接的方向。
2. **PG fetch wall**（最大 139.6～303.6 ms）與 **fetch yieldWait**（13.2～96.1 ms）：
   併發下等待佔比明顯；需確認是 N3450 上的 PG 容器資源、round trips（88／96 次）或兩者疊加。
3. **stats_ms 仍是最大階段**：785.05／1634.92／728.30／1865.29 ms，占 54.9%／49.2%／50.3%／46.3%，
   內部以 `stats_inputs_ms`（655／1298／591／1331）與 `stats_candidates_ms`（416／1125／429／1152）最大。
   注意本輪 `stats_ms` 比上一輪（697.76／1532.16／603.87／1490.97）高，與切片開銷增加一致；
   降低同步切片不能只看 lag，也要看它加回來的成本。
4. 單區 C4 的 `prepare_ms` 由 92 升到 223、`display_ms` 157→172、`sort_ms` 149→163，
   值得一併檢查。
5. 不得放寬門檻、減少候選、改用較強硬體；`5151_shadow` 不可做 setup／migration／ANALYZE。

## 檔案來源與資源清理

- 本目錄是 NAS `/mnt/Storage1/prb-acceptance/evidence/prb-nas-ae88ce6/` 的原樣副本，
  加上本 README 後重新產生 `SHA256SUMS`；`runner.log` 為 runner 完整輸出。
- 受測 checkout：NAS `/mnt/Storage1/prb-acceptance/5151`（detached `ae88ce6`，取自 GitHub）。
- 三項標籤清理查詢（容器／network／volume）皆為 0 筆；名稱前綴 `prb-verify-` 為 0；`/tmp/prb-nas.*` 無殘留；
  五個正式容器（`5151-web-A`、`591-tracker-v3`、`5151-postgres-A`、`5151-ops`、`5151-haproxy`）皆在。
  未使用 wildcard／prune。

## 界線

- 本輪只驗證 PR-B 的搜尋／統計路徑。整體 SQLite 退場（C～F）、production auth／雙節點 HTTP E2E、
  HA promotion／failover、PITR／RPO／RTO 均未驗收。
- NAS gate 未過之前維持 NOT_READY_FOR_REVIEW／NOT_READY_FOR_MERGE；未合併、未部署。
- 失敗樣本完整保留，未重算、未刪除。
