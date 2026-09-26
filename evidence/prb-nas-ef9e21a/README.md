# PR-B NAS 同 SHA 驗收（2026-09-26，受測 SHA ef9e21a）

結論：**NAS_ACCEPTANCE_FAIL / NOT_READY_FOR_MERGE**。未合併、未部署。
四案完整跑完，200 次量測 errors／timeouts 皆 0，零 SQLite guard 通過；延遲與 lag 硬 gate 未過。

## 本輪版本關係（重要）

- 受測 SHA：`ef9e21aa0f293e97a7269e4726f499e4561f21fe`（runner 加資源標籤的提交）。
- 與 `63c1f5a` 的差異**只有** `v3/scripts/prb-nas-verify.sh`（+10／−6）；
  `v3/src`、`v3/test`、`v3/scripts/prb-search-benchmark.mjs` 內容完全相同。
- 因此本輪量到的應用程式等同 `63c1f5a`／`1d09dee`，但**受測版本一律記為 `ef9e21a`**，
  不把結果回寫成 `63c1f5a`。
- 同 SHA CI：[Tests 36233027423](https://github.com/Fyun48/5151/actions/runs/36233027423)
  completed／success；GitGuardian 與 model review 亦 pass。
- runner 修正內容：對本腳本建立的每個 container／network／volume 加上
  `prb-nas-verify=1`、`prb-nas-verify.sha`、`prb-nas-verify.script` 三個標籤。
  未改測試行為、fixture、門檻或斷言。舊版 runner 被中斷時會留下無法歸屬的資源
  （本次清理的 `prb-opt-*` 即為此例）。

## 執行環境

- 主機：CasaOS `ubuntucasaos`，Intel Celeron N3450 @ 1.10GHz，4 CPU，8,162,942,976 bytes RAM。
- Docker 28.0.1；Node `v22.23.3`；PostgreSQL `16.14`。
- Node image `sha256:b37a4d56eedb5e42bca59c8d4782fa550e741fba5dbce943c53767d3ceee57e6`；
  PG image `sha256:de3a4eab8fdfa507ea92aac488b916b08089e515db49b055fe71dfa271ba3a28`。
- 固定 fixture `prb-fixed-v1`，asOf `2026-09-26T00:00:00.000Z`：120,000 stored／36,000 active、
  兩個行政區、1,024 節點關係鏈、跨區 peer。
- 每案暖機 5 輪後量測 50 次完整 page／stats／JSON；獨立斷言 matched／total／dbTotal／前 50 筆 ID，
  並保存結果 hash（單區 `d75a57c2…`、全區 `b1a872a9…`）。
- 以 GitHub 唯一權威來源取得 `ef9e21a` 的獨立 checkout。PG 在新 volume、internal network，
  未發布 host port，未對正式 `5151_shadow` 做 setup／migration／ANALYZE。
- 執行指令：`bash v3/scripts/prb-nas-verify.sh ef9e21aa0f293e97a7269e4726f499e4561f21fe <證據目錄>`。

## 硬 gate 結果

| 案例 | p50 ms | p95 ms | 目標 ms | 延遲結果 | lag p99／max ms | lag 門檻 | peak RSS MiB | errors／timeouts |
|---|---:|---:|---:|---|---|---:|---:|---|
| 單區 C1 | 1606.01 | 1775.12 | 1000 | FAIL | 55.97／98.63 | FAIL | 431.0 | 0／0 |
| 單區 C4 | 4383.11 | 4680.62 | 2000 | FAIL | 72.88／209.85 | FAIL | 674.9 | 0／0 |
| 全區 C1 | 1822.11 | 1959.80 | 2000 | PASS | 79.04／134.74 | FAIL | 694.4 | 0／0 |
| 全區 C4 | 5569.90 | 5821.09 | 4000 | FAIL | 121.83／226.62 | FAIL | 839.7 | 0／0 |

- lag 門檻為 p99 ≤50 ms、max ≤100 ms；四案皆未同時滿足。
- 真 PostgreSQL：143 tests／142 pass／0 fail／1 optional skip（與同 SHA CI 相同）。
- SQL／交易控制：單區 49／4、全區 44／4（含 cursor FETCH；BEGIN／SET LOCAL／ROLLBACK 另列）。
- `sqliteAttempts = 0`（零 SQLite guard 通過）。runner exit = `1`。

## 與 848aa7e baseline 的比較（同一台 N3450）

| 案例 | baseline p95 ms | 本輪 p95 ms | 變化 |
|---|---:|---:|---:|
| 單區 C1 | 4628.58 | 1775.12 | −61.6% |
| 單區 C4 | 13857.82 | 4680.62 | −66.2% |
| 全區 C1 | 4700.29 | 1959.80 | −58.3% |
| 全區 C4 | 14200.41 | 5821.09 | −59.0% |

baseline 證據在 `evidence/prb-nas-20260926/`（受測 SHA `848aa7e`）。
改善明顯，但只有全區 C1 進入門檻（餘裕 2.0%），其餘三案仍超標。

## 同 SHA 的 CI 對照（不是 NAS 成績）

| 案例 | CI p95 ms | NAS p95 ms | NAS／CI 倍數 |
|---|---:|---:|---:|
| 單區 C1 | 296.65 | 1775.12 | 5.98× |
| 單區 C4 | 823.37 | 4680.62 | 5.69× |
| 全區 C1 | 326.52 | 1959.80 | 6.00× |
| 全區 C4 | 1060.48 | 5821.09 | 5.49× |

同 SHA CI 為 `CI_SMOKE_PASS`，四案 errors／timeouts 0／0。CI 執行在 GitHub runner，
與 NAS 門檻不同，不可互相替代。

## 瓶頸定位

單區 C1 各階段 p95：

| 階段 | p95 ms |
|---|---:|
| stats_ms | 890.23 |
| sql_ms | 340 |
| preload_ms | 180 |
| profile_ms | 119 |
| sort_ms | 90 |
| relations_ms | 83 |
| display_ms | 61 |

- `stats_ms` 在四案都是最大單一階段：單區 C1 占 50.1%、單區 C4 46.5%、全區 C1 42.1%、全區 C4 35.9%
  （絕對值 890.23／2176.16／825.20／2090.33 ms）。
- stats 內部（單區 C1）：inputs 605、candidates 382、auxiliary 218、profile 214、count 120 ms。
- C4 時 CPU 密集階段（profile／sort／relations／display）同步放大，lag max 升到 209.85／226.62 ms，
  與 4 核 Celeron 的 CPU 飽和一致。
- 後續修正焦點是 stats 路徑與 C4 併發下的 CPU 成本；不放寬門檻。

## 檔案來源與資源清理

- 本目錄是 NAS 上 `/mnt/Storage1/prb-acceptance/evidence/prb-nas-ef9e21a/` 的原樣副本，
  加上本 README 後重新產生 `SHA256SUMS`。
- 受測 checkout：NAS `/mnt/Storage1/prb-acceptance/5151`（detached `ef9e21a`，取自 GitHub）。
  測試用 worktree、container、network、volume 都由 runner 的 EXIT trap 清除。
- 本輪之前的未提交開發工作封存在同一台機器的
  `/mnt/Storage1/prb-archive/prb-opt-jouclpr0-20260926/`：tar（含 `.git`）、原 HEAD、status、
  binary diff、逐檔 SHA256；另有 `prb-nas-src-5oVQAQv1-20260926/`。
  封存已解開驗證：HEAD 與 73 筆變更狀態一致、抽驗檔案雜湊相符。
- 舊開發資源清理（只依精確名稱，未用 wildcard／prune）：
  `prb-opt-jouclpr0-app` 清理前已不存在（`--rm`），`-pg`／`-net`／`-deps`／`-pgdata` 四項移除成功；
  清理後以標籤與名稱前綴查詢皆為 0 筆，`/tmp/prb-nas.*` 無殘留，正式容器未受影響。
- code-server 的 `/tmp/prb-transfer.it64ho8o/5151` 只有一個變更
  `v3/test/pg-candidate-array.test.js`，其內容雜湊 `5bbad427…` 與 `1d09dee`／`63c1f5a` 完全相同，
  因此沒有未納入的修改。

## 界線

- 本輪只驗證 PR-B 的搜尋／統計路徑。整體 SQLite 退場（C～F）、production auth／雙節點 HTTP E2E、
  HA promotion／failover、PITR／RPO／RTO 均未驗收。
- NAS gate 未過之前維持 NOT_READY_FOR_REVIEW／NOT_READY_FOR_MERGE；未合併、未部署。
- 本次未放寬門檻、未減少候選、未改用較強硬體；失敗樣本完整保留。
