# PR-B NAS 同 SHA 驗收（2026-09-26，受測 SHA 6703302）

結論：**NAS_ACCEPTANCE_FAIL / NOT_READY_FOR_MERGE**。未合併、未部署。
四案完整跑完，200 次量測 errors／timeouts 皆 0，零 SQLite guard 通過。但本輪有兩項重要進展與一項瑕疵。

- **全區 C4 延遲首次達標**（3529.45 ms ≤ 4000），四案延遲有兩案通過。
- **lag 兩案達標**（單區 C1、全區 C1）；另兩案只差 **0.07 ms**（單區 C4）與 **1.65 ms**（全區 C4）就過 max 門檻。
- **runner 的 EXIT cleanup 卡死**：新的 PG 資源取樣器 `docker stats` 不接受 SIGTERM，`wait` 永遠不返回。
  資源與 `runner-exit.txt` 一度無法收尾，已記錄診斷後以 SIGKILL 解除。詳見下方專節。

## 受測版本

- 受測 SHA：`6703302cf57deeaa8cc5b8866f08fb4f8d6e23c5`，依 PR 交接通知指定，**未改測文件 HEAD `b22c13c`**。
- `sourceSha` 與 `checkoutSha` 皆為該 SHA（NAS 端獨立 checkout，非 merge ref）；14 個 module hash 全部相符。
- 同 SHA CI [36240011855](https://github.com/Fyun48/5151/actions/runs/36240011855) completed／success；
  一般 2658／2618 pass／0 fail／40 skip，真 PG 149／148 pass／0 fail／1 skip。
- runner blob `1b2aa56b…`，檔案模式 644（`b22c13c` 才恢復執行位；本輪以 `bash` 呼叫，不受影響）。
- 結果 hash 與前幾輪相同：單區 `d75a57c20695b67ee348505aa3c074ff1a05b769e5263b483f51a0285800423f`、
  全區 `b1a872a9e9aa4c7494129d315fcb89bc043d72db39d5bfa8506b93c35169cbf7`。

## 執行環境

- 主機：CasaOS `ubuntucasaos`，Intel Celeron N3450 @ 1.10GHz，4 CPU，8,162,942,976 bytes RAM。
- Docker 28.0.1；Node `v22.23.3`；PostgreSQL `16.14`。
- Node image `sha256:b37a4d56eedb5e42bca59c8d4782fa550e741fba5dbce943c53767d3ceee57e6`；
  PG image `sha256:de3a4eab8fdfa507ea92aac488b916b08089e515db49b055fe71dfa271ba3a28`。
- 固定 fixture `prb-fixed-v1`，asOf `2026-09-26T00:00:00.000Z`：120,000 stored／36,000 active、
  兩個行政區、1,024 節點關係鏈。暖機 5 輪、四案各 50 次完整 page／stats／JSON。
- PG 在新 volume、internal network；未發布 host port；未對正式 `5151_shadow` 做 setup／migration／ANALYZE。

## 硬 gate 結果

| 案例 | cold ms | p50 ms | p95 ms | 目標 ms | 延遲結果 | lag p99／max ms | lag 門檻 | peak RSS／heap MiB | errors／timeouts |
|---|---:|---:|---:|---:|---|---|---:|---:|---|
| 單區 C1 | 3782.2 | 1175.92 | 1337.70 | 1000 | FAIL | 22.72／54.56 | **PASS** | 419.6／325.3 | 0／0 |
| 單區 C4 | 2625.1 | 2723.55 | 3029.58 | 2000 | FAIL | 32.19／**100.07** | FAIL | 663.5／562.5 | 0／0 |
| 全區 C1 | 2811.1 | 1195.28 | 1326.39 | 2000 | **PASS** | 26.56／46.99 | **PASS** | 662.1／376.0 | 0／0 |
| 全區 C4 | 2744.9 | 3265.14 | 3529.45 | 4000 | **PASS** | 41.29／**101.65** | FAIL | 781.6／614.7 | 0／0 |

- 單區 C4 的 lag max 100.07 ms 超出 0.07 ms；全區 C4 的 101.65 ms 超出 1.65 ms。四案 p99 全部在 50 ms 內。
- 真 PostgreSQL：149 tests／148 pass／0 fail／1 optional skip（與同 SHA CI 相同）。
- SQL／交易控制：單區 88／4、全區 96／4。`sqliteAttempts = 0`。runner exit = `1`。

## 進步幅度

| 案例 | 848aa7e | ef9e21a | 6381f0f | ae88ce6 | 本輪 6703302 | 對 ae88ce6 |
|---|---:|---:|---:|---:|---:|---:|
| 單區 C1 | 4628.58 | 1775.12 | 1388.20 | 1429.96 | **1337.70** | −6.5% |
| 單區 C4 | 13857.82 | 4680.62 | 3221.51 | 3321.86 | **3029.58** | −8.8% |
| 全區 C1 | 4700.29 | 1959.80 | 1449.60 | 1448.70 | **1326.39** | −8.4% |
| 全區 C4 | 14200.41 | 5821.09 | 4016.80 | 4032.71 | **3529.45** | −12.5% |

對最初 baseline 已降 71.1%／78.1%／71.8%／75.1%。**全區 C4 是本專案第一次進入 4000 ms 門檻**（餘裕 11.8%）。

## workDiagnostics（最大值，ms）

| 案例 | step | slice | yieldWait | tickGap | GC pause | PG fetch wall |
|---|---:|---:|---:|---:|---:|---:|
| 單區 C1 | 4.761 | 6.535 | 13.832 | 54.407 | 36.252 | 141.817 |
| 單區 C4 | 8.252 | 9.275 | 37.123 | 100.032 | 60.570 | 295.492 |
| 全區 C1 | 5.648 | 6.746 | 23.845 | 46.877 | 35.636 | 108.144 |
| 全區 C4 | 8.579 | 9.290 | 68.583 | 101.511 | 60.950 | 226.230 |

- 同步切片仍被壓住：最大 step 4.8～8.6 ms、最大 slice 6.5～9.3 ms。checkpoint 工作量固定 256 units，
  總量 1,876,800（單區）／3,600,000（全區）。
- GC 總量 2125／2511／2664／2984 ms；超過 50 ms 的次數 0／1／0／2。
- tickGap 取樣數 5405／2357／5392／2723，其中 >10 ms 為 4232／2178／4184／2481。

## workTimeline：最大 tickGap 附近有什麼

| 案例 | 最大 tickGap ms | 重疊的已插樁 span | 覆蓋時間 | 佔比 |
|---|---:|---|---:|---:|
| 單區 C1 | 54.4 | 無 | 0 | 0% |
| 單區 C4 | 100.0 | `gc.pause` ×1 | 60.6 ms | 61% |
| 全區 C1 | 46.9 | 無 | 0 | 0% |
| 全區 C4 | 101.5 | `gc.pause` ×1 | 47.5 ms | 47% |

- 兩案 lag 未過的 gap 中，**GC 有時間重疊，是已證實的貢獻者**：單區 C4 佔 61%、全區 C4 佔 47%。
- 但**沒有任何 `pg.fetch.wall` 或 `pg.fetch.yieldWait` span 與該視窗重疊**，其餘 39%／53% 沒有被任何
  已插樁 span 覆蓋。依交接文件的提醒，PG parser、其他 I/O callback、JSON 序列化不在 generator 插樁範圍內，
  所以**不能宣稱已完整解釋**這兩個 gap；只能說 GC 是其中一部分。
- 各指標最大值之間沒有時間關聯，本報告不把不同事件的最大值相加當作因果。

## processCpu 與 idle PG round trip

| 案例 | user ms | system ms | wall ms | CPU／wall |
|---|---:|---:|---:|---:|
| 單區 C1 | 38368.5 | 4016.6 | 59894.0 | 0.71 |
| 單區 C4 | 34315.2 | 3200.3 | 34694.0 | 1.08 |
| 全區 C1 | 43215.1 | 4953.1 | 60869.7 | 0.79 |
| 全區 C4 | 40577.1 | 3987.5 | 41051.2 | 1.09 |

- C4 兩案的 CPU／wall 約 1.08～1.09，代表**平均只用到約 1 顆核心**，4 核並沒有被吃滿；
  併發下的瓶頸偏向等待與排程，而不是核心數不足。
- 空閒 `SELECT 1` 往返（`idleRoundTripMs`，量測窗外、10 次）：p50
  1.484／1.561／1.501／1.200 ms，max 1.980／1.915／4.597／1.837 ms。
  同 SHA CI 的 p50 是 0.146 ms、max 0.401 ms，**NAS 的 PG 往返約慢一個數量級**，
  這是 N3450 上 PG 的固定成本基準。

## PG 資源觀測（粗粒度）

- 取樣期間 12:36Z–12:54Z（**含量測結束後卡住的 12 分鐘**），`postgres-resource-stats.err` 為 0 bytes。
- 可用樣本 1442 筆：`CPUPerc` p50 **52.5%**、p95 128.0%、max **162.0%**；
  `MemUsage` 22.1 → 166.5 MiB（p50 140.7 MiB）。
- 這是整段取樣窗的粗粒度數字，**沒有每筆 query 的 server execution time，不能單憑它判定某次 FETCH 慢的原因**；
  且窗內包含非量測時段，不可當成負載期間的平均值。

## runner 瑕疵：EXIT cleanup 卡死（本輪新發現）

**症狀**：量測在 12:42Z 完成並印出 `PRB-PERF-RESULT NAS_ACCEPTANCE_FAIL`，但 PG 容器在 12:53Z 仍存活、
取樣檔持續成長，`runner-exit.txt` 未產生、資源未清除、worktree `/tmp/prb-nas.Ehgn1lEF/checkout` 仍在。

**原因**：`cleanup()` 執行 `kill "$metrics_pid"; wait "$metrics_pid"`，而背景取樣器
`docker stats --format '{{json .}}'` **不會因 SIGTERM 結束**。實測：

- runner pid 1571328 狀態 `S`、`wchan = do_wait`，唯一子程序是 pid 1572053 的 `docker stats`（存活 17 分鐘）。
- 取樣器 `/proc/<pid>/status`：`SigIgn = 0x1`（僅 SIGHUP）、`SigCgt` 含 SIGTERM（bit 14），
  即 SIGTERM 有 handler 但不會離開。
- 直接對它補送一次 SIGTERM，8 秒後仍存活 → 確認 SIGTERM 無效，不是「kill 沒送到」。

**處置**：先將完整診斷寫入 `runner-cleanup-hang.txt`（含 ps 快照與 `/proc` 訊號設定），
再以 SIGKILL 終止取樣器讓 `wait` 返回。之後 cleanup 正常完成：`runner-exit.txt = 1`、
三項標籤查詢（容器／network／volume）皆 0 筆、worktree 已移除、正式容器未受影響。
**這是 runner 的缺陷，不是量測失敗；本輪量測資料在卡住前已完整寫出。**

**附帶瑕疵**：`postgres-resource-stats.jsonl` 每次刷新都帶 ANSI 控制序列（`\x1b[H`），
不是可直接解析的 JSON Lines；解析前必須先去除 ANSI。建議下一版改用
`docker stats --no-stream` 迴圈，或在 cleanup 以 `kill -9` / `timeout` 包住取樣器。

## 建議的下一批重點

1. **GC 是已證實的 lag 貢獻者**（單區 C4 佔 gap 61%、全區 C4 佔 47%）：降低版本批次與 stats 分塊期間的
   短命配置。四案 GC 最大 35.6～61.0 ms。
2. **另外 39%～53% 的 gap 尚未被解釋**：需要把插樁範圍延伸到 PG parser、JSON 序列化與其他 I/O callback，
   或改用 CPU profile，才能定位剩下來的同步段。
3. **單區延遲仍是最大缺口**（1337.70 對 1000、3029.58 對 2000）；C4 的 CPU／wall 僅約 1.08，
   代表還有等待可壓，不是算力不足。
4. **PG 端固定成本**：空閒往返 p50 已 1.2～1.6 ms（CI 0.146 ms），PG CPU 尖峰到 162%；
   值得確認 PG 容器在 N3450 上的資源配置與 autovacuum／shared_buffers。
5. 不放寬門檻、不減少候選、不換硬體、不動 `5151_shadow`；未合併、未部署。

## 檔案與清理

- 本目錄為 NAS `/mnt/Storage1/prb-acceptance/evidence/prb-nas-6703302/` 的原樣副本，加上本 README 後
  重新產生 `SHA256SUMS`。含 `runner.log`、`postgres-resource-stats.{jsonl,err,start.txt}`、
  `runner-cleanup-hang.txt`（本輪新增的瑕疵診斷）。
- 受測 checkout：NAS `/mnt/Storage1/prb-acceptance/5151`（detached `6703302`）。
- 清理核對（SIGKILL 解除卡住之後）：`docker ps -a`／`network ls`／`volume ls` 以
  `prb-nas-verify=1` 查詢皆 0 筆；名稱前綴 `prb-verify-` 為 0；`/tmp/prb-nas.*` 無殘留；
  五個正式容器（`5151-web-A`、`591-tracker-v3`、`5151-postgres-A`、`5151-ops`、`5151-haproxy`）皆在。

## 界線

- 本輪只驗證 PR-B 的搜尋／統計路徑。整體 SQLite 退場（C～F）、production auth／雙節點 HTTP E2E、
  HA promotion／failover、PITR／RPO／RTO 均未驗收。
- NAS gate 未過之前維持 NOT_READY_FOR_REVIEW／NOT_READY_FOR_MERGE。
- 失敗樣本完整保留，未重算、未刪除。
