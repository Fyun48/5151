# PR-B NAS 同 SHA 驗收（2026-09-26，受測 SHA 6381f0f）

結論：**NAS_ACCEPTANCE_FAIL / NOT_READY_FOR_MERGE**。未合併、未部署。
四案完整跑完，200 次量測 errors／timeouts 皆 0，零 SQLite guard 通過；延遲與 lag 硬 gate 未過。
本輪是第一批 CPU 修正（`143f1a6`）的 NAS 實測，延遲大幅改善，但 **lag 反而略微變差**。

## 本輪版本關係（重要）

- 受測 SHA：`6381f0f8a5afad0a6f4e9ca8cc67cf42e7e9349b`（PR head）。
- 程式提交為 `143f1a636a21a85cad1019dd5037a476123fd5a3`；兩者差異只有
  `docs/handoffs/PRB_EXECUTION_STATE.md` 與 `evidence/prb-ci-143f1a6/`，
  **`v3/src`、`v3/test`、`v3/scripts` 完全相同**，所以本輪量到的程式等於 `143f1a6`。
- 受測版本一律記為 `6381f0f`，不把結果回寫成 `143f1a6`。
- 同 SHA（`6381f0f`）CI [36235625644](https://github.com/Fyun48/5151/actions/runs/36235625644)
  completed／success；`143f1a6` 的 CI 為
  [36235146987](https://github.com/Fyun48/5151/actions/runs/36235146987)，兩者 checks 皆全綠。
- 本輪 runner 與上一輪相同（blob `ef92607a…`），資源標籤 `prb-nas-verify=1` 已在實跑中再次驗證生效。

## 執行環境

- 主機：CasaOS `ubuntucasaos`，Intel Celeron N3450 @ 1.10GHz，4 CPU，8,162,942,976 bytes RAM。
- Docker 28.0.1；Node `v22.23.3`；PostgreSQL `16.14`。
- Node image `sha256:b37a4d56eedb5e42bca59c8d4782fa550e741fba5dbce943c53767d3ceee57e6`；
  PG image `sha256:de3a4eab8fdfa507ea92aac488b916b08089e515db49b055fe71dfa271ba3a28`。
- 固定 fixture `prb-fixed-v1`，asOf `2026-09-26T00:00:00.000Z`：120,000 stored／36,000 active、
  兩個行政區、1,024 節點關係鏈、跨區 peer。
- 每案暖機 5 輪後量測 50 次完整 page／stats／JSON；獨立斷言 matched／total／dbTotal／前 50 筆 ID。
- 結果 hash 與前幾輪完全相同（單區 `d75a57c20695…`、全區 `b1a872a9e9aa…`）→ 最佳化沒有改變結果。
- 以 GitHub 唯一權威來源取得 `6381f0f` 的獨立 checkout。PG 在新 volume、internal network，
  未發布 host port，未對正式 `5151_shadow` 做 setup／migration／ANALYZE。

## 硬 gate 結果

| 案例 | p50 ms | p95 ms | 目標 ms | 延遲結果 | lag p99／max ms | lag 門檻 | peak RSS MiB | errors／timeouts |
|---|---:|---:|---:|---|---|---:|---:|---|
| 單區 C1 | 1292.54 | 1388.20 | 1000 | FAIL | 59.47／89.52 | FAIL | 427.4 | 0／0 |
| 單區 C4 | 2903.95 | 3221.51 | 2000 | FAIL | 72.02／223.08 | FAIL | 765.6 | 0／0 |
| 全區 C1 | 1337.44 | 1449.60 | 2000 | PASS | 91.68／145.62 | FAIL | 732.5 | 0／0 |
| 全區 C4 | 3926.53 | 4016.80 | 4000 | FAIL | 126.22／247.46 | FAIL | 834.9 | 0／0 |

- 全區 C4 只超出目標 **16.80 ms（0.42%）**；單區 C1 為目標的 1.39 倍、單區 C4 為 1.61 倍。
- lag 門檻為 p99 ≤50 ms、max ≤100 ms；四案皆未同時滿足。
- 真 PostgreSQL：143 tests／142 pass／0 fail／1 optional skip（與同 SHA CI 相同）。
- SQL／交易控制：單區 49／4、全區 44／4（含 cursor FETCH；BEGIN／SET LOCAL／ROLLBACK 另列）。
- `sqliteAttempts = 0`。runner exit = `1`。

## 進步幅度

與上一輪 `ef9e21a`（同一台 N3450、同一個 runner）相比：

| 案例 | ef9e21a p95 | 本輪 p95 | 變化 |
|---|---:|---:|---:|
| 單區 C1 | 1775.12 | 1388.20 | −21.8% |
| 單區 C4 | 4680.62 | 3221.51 | −31.2% |
| 全區 C1 | 1959.80 | 1449.60 | −26.0% |
| 全區 C4 | 5821.09 | 4016.80 | −31.0% |

與最初 baseline `848aa7e` 相比：−70.0%／−76.8%／−69.2%／−71.7%。

修正命中的階段（單區 C1，`ef9e21a` → 本輪）：`profile_ms` 119→50、`sort_ms` 90→42、
`display_ms` 61→35、stats 內部的 `stats_profile_ms` 214→67、`stats_count_ms` 120→55。
本批 CPU 修正確實打中目標。

## lag 沒有跟著改善（需要看的事實）

| 案例 | ef9e21a lag p99／max | 本輪 lag p99／max | 變化 |
|---|---|---|---|
| 單區 C1 | 55.97／98.63 | 59.47／89.52 | p99 變差、max 變好 |
| 單區 C4 | 72.88／209.85 | 72.02／223.08 | p99 略好、max 變差 |
| 全區 C1 | 79.04／134.74 | 91.68／145.62 | 兩項都變差 |
| 全區 C4 | 121.83／226.62 | 126.22／247.46 | 兩項都變差 |

也就是說：**總延遲降了 22～31%，但 event-loop lag 幾乎沒降、部分反而上升**。
可能與「同樣的工作被壓進更長的不讓出同步區段」有關（單次同步工作量放大 → 單一 tick 變長），
但這是假設，尚未用 profiler 證實；下一個修正批次應同時量測單次讓出間隔，而不是只看總時間。

## 同 SHA 的 CI 對照（不是 NAS 成績）

CI 使用 `143f1a6`（應用程式碼與本輪相同）：單區 C1 361.76／C4 871.02、全區 C1 371.66／C4 1071.29 ms。

| 案例 | CI p95 ms | NAS p95 ms | NAS／CI 倍數 |
|---|---:|---:|---:|
| 單區 C1 | 361.76 | 1388.20 | 3.84× |
| 單區 C4 | 871.02 | 3221.51 | 3.70× |
| 全區 C1 | 371.66 | 1449.60 | 3.90× |
| 全區 C4 | 1071.29 | 4016.80 | 3.75× |

上一輪這個倍數是 5.49～6.00×，本輪縮到 3.70～3.90× → 本批修正對慢速 CPU 的幫助大於對 CI runner 的幫助，
與「修的是 CPU 成本」一致。CI 為 `CI_SMOKE_PASS`，但 `143f1a6` 的 CI 全區 C4 lag p99 為 54.20 ms
（>50），CI 也不是全部效能 gate 通過；兩者門檻不同，不可互相替代。

## 瓶頸定位（本輪各階段 p95，ms）

| 階段 | 單區 C1 | 單區 C4 | 全區 C1 | 全區 C4 |
|---|---:|---:|---:|---:|
| stats_ms | 697.76 | 1532.16 | 603.87 | 1490.97 |
| sql_ms | 313 | 867 | 351 | 1407 |
| preload_ms | 155 | 331 | 263 | 599 |
| relations_ms | 75 | 307 | 123 | 884 |
| profile_ms | 50 | 261 | 44 | 684 |
| sort_ms | 42 | 149 | 67 | 271 |
| display_ms | 35 | 157 | 28 | 126 |
| 合計 p95 | 1388.20 | 3221.51 | 1449.60 | 4016.80 |

`stats_ms` 仍是四案最大單一階段（占 50.3%／47.6%／41.7%／37.1%），其內部以 `stats_inputs_ms` 最大
（591／1121／455／1100），其次 `stats_candidates_ms`（331／784／320／823）。
C4 時 `sql_ms`（867／1407）與 `relations_ms`（307／884）同步放大，是併發下第二與第三大成本。

## 檔案來源與資源清理

- 本目錄是 NAS `/mnt/Storage1/prb-acceptance/evidence/prb-nas-6381f0f/` 的原樣副本，
  加上本 README 後重新產生 `SHA256SUMS`。
- 受測 checkout：NAS `/mnt/Storage1/prb-acceptance/5151`（detached `6381f0f`，取自 GitHub）。
- 清理核對：依 `prb-nas-verify=1` 標籤查詢為 0 容器／0 network／0 volume；名稱前綴 `prb-verify-` 為 0；
  `/tmp/prb-nas.*` 無殘留；五個正式容器（`5151-web-A`、`591-tracker-v3`、`5151-postgres-A`、
  `5151-ops`、`5151-haproxy`）皆在。未使用 wildcard／prune。

## 界線

- 本輪只驗證 PR-B 的搜尋／統計路徑。整體 SQLite 退場（C～F）、production auth／雙節點 HTTP E2E、
  HA promotion／failover、PITR／RPO／RTO 均未驗收。
- NAS gate 未過之前維持 NOT_READY_FOR_REVIEW／NOT_READY_FOR_MERGE；未合併、未部署。
- 未放寬門檻、未減少候選、未改用較強硬體；失敗樣本完整保留。
