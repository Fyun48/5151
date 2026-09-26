# PR-B 可接續狀態

## 本批提交：整輪 PostgreSQL ownership

新增 crawlOwnership.js 與 crawl-ownership.test.js；整輪使用專用 PG 連線與 session advisory lock，爬蟲 driver 交易沿同一連線序列執行。取消／斷線後拒絕新操作、等待現有交易回滾才解鎖；晚到 SQLite callback 也受 owner scope 保護。
獨立座標補算在 owner scope 外啟動，避免繼承已結束的鎖；巢狀 driver 交易明確拒絕，須使用現有 client，避免死鎖。
本機相關測試 28／25 pass／0 fail／3 PG-only skip；本批真 PG CI 與 NAS 尚待執行，不沿用父 SHA 綠燈。
這是同一 PG database 的單輪排他，不代表雙 primary fencing／完整 HA；raw pool 繞過 driver 的路徑與已送出的外部副作用不在此保證。其餘 legacy SQLite、跨節點業務與備份復原仍待驗證。

## 最新已測版本：1e0813e NAS 完成

[Run 36250785406](https://github.com/Fyun48/5151/actions/runs/36250785406)，[原始證據](../../evidence/prb-nas-1e0813e/README.md)。
受測 SHA `1e0813e14f3934fe6218065c054ac4f9cfd63261`；真 PG 156 pass／0 fail；四案 p95 1915.93／4812.84／2048.02／6267.02 ms。
200 次 errors／timeouts=0、結果 hash 相同；原始 NAS_ACCEPTANCE_FAIL。清理三項 0，144 行 JSONL 有效。fixture 計畫比對見附件，未證實退步根因。
未合併、未部署應用程式，NOT_READY_FOR_REVIEW／NOT_READY_FOR_MERGE。

## 後續程式批次：持久輪替與成功完成範圍

- 新 `crawlScheduleAsync` 從目前 driver 的 settings/users/user_settings 建立計畫；PG 不再以節點 SQLite 的會員條件或來源開關決定本輪內容。
- 預約在短交易內鎖住 settings 的 crawlScheduleV1；每個 cover 保存最後嘗試順序，優先選最久未嘗試的 6 組。失敗仍會重試，不受時間窗跳號或重啟影響。
- watcher 依各啟用來源實際回傳的成功 searchUrl 交集記錄成功；沒有回傳／失敗來源不算完成。只更新成功 cover 的 last_run_at，不刪除未執行 covers。
- 成功範圍可跨輪累積；會員所有所需範圍都在其 dueAt 之後成功、且設定未被修改時，才以 CAS 更新該會員下一次到期時間。進度不再冒充 lastCoveringAt 或更新所有 cover。
- 本機測試涵蓋 19 組／不規則時間、資料庫重新開啟、部分失敗、跨輪完成及設定變更；PG 的並行預約／零 SQLite I/O 交由精確 SHA CI 實測。
- 此批是短交易預約鎖，**不是整輪分散式 worker lease／fencing**；兩個 worker 的完整生命週期排他仍待補。watcher 其餘 legacy helper 不因此宣稱全站零 SQLite。
- 下一步：精確 SHA CI → 同 SHA NAS；再補 worker ownership、跨節點啟用功能與備份復原，未合併、未部署。


## 22:32 最新 NAS 結果：92e8210 四案已完成

[原始證據與表格](../../evidence/prb-nas-92e8210/README.md)，[run 36248207780](https://github.com/Fyun48/5151/actions/runs/36248207780)。
受測精確 SHA `92e8210adbe362e98c79ba869d8bd65c99ddbfd2`，不是後續文件 HEAD。
真 PG 154 pass／0 fail；四案 p95 2402.70／6040.11／3096.85／6080.45 ms，四案 errors／timeouts=0、結果 hash 與先前相同。
原始結論 NAS_ACCEPTANCE_FAIL，四案 latency／lag 皆未過；較 6703302 慢 1.72～2.33 倍，根因未證實，不將先前效能例外自動擴大。
fixture 分批與 runner 收尾修復已實機通過；清理三項 0、JSONL 174 行有效。
不再要求重跑舊 SHA、不重啟純效能微調；下一步仍為持久輪替、成功完成範圍及跨節點／復原。
NOT_READY_FOR_REVIEW／NOT_READY_FOR_MERGE；應用程式未合併、未部署。以下舊節為歷史紀錄，以本節為最新狀態。


更新：2026-09-26，第三批程式 SHA `6703302cf57deeaa8cc5b8866f08fb4f8d6e23c5` 已推送，精確 SHA CI checks 全部成功。
**最近完成的 NAS 驗收：受測 SHA `6703302cf57deeaa8cc5b8866f08fb4f8d6e23c5`，結果 `NAS_ACCEPTANCE_FAIL`；
全區 C4 延遲首次達標、lag 兩案達標，另兩案只差 0.07 與 1.65 ms。**
PR [#497](https://github.com/Fyun48/5151/pull/497) 保持 open、非草稿、未合併、未部署。

## 2026-09-26 21:00 Owner 上線優先：目前有效裁決

**SEARCH_PERFORMANCE_ACCEPTED_WITH_EXCEPTION / RELEASE_BLOCKED_ON_CORRECTNESS_AND_RECOVERY**。
依 Owner 最新指示，接受 6703302 已測搜尋延遲作為此版效能取捨，停止純效能優化；
舊 NAS_ACCEPTANCE_FAIL 保留、不改測試門檻，但不再以它單獨阻擋進度。
PR-B 搜尋工作交付審查；整體 PostgreSQL／爬蟲／雙備援尚不可結案，故維持 NOT_READY_FOR_MERGE。
目前爬蟲取消／輪替／完成範圍有可重現缺口，跨節點與資料復原證據未齊，與速度問題分開處理。
完整裁決、三項最短上線必辦與接續順序見 [RELEASE_TRIAGE_20260926.md](RELEASE_TRIAGE_20260926.md)。

runner 修正 SHA：`eb564736ee14d268e0a5358d5be7787c0d9a3f78`；採獨立 process group、
EXIT SIGKILL 該診斷群組後 wait，並用 docker stats --no-stream 避免 ANSI。
Node 22.23.3 的正常／失敗／SIGTERM 三案回歸全部通過；[精確 SHA CI](https://github.com/Fyun48/5151/actions/runs/36243932369) 與 GitGuardian／model review 全綠。
`v3/src` 與搜尋 benchmark 與 6703302 完全相同；新 runner NAS 尚未實跑，不能填 PASS。
下一輪固定測最新程式 SHA `4ee81e7495f63873e302a6451b1bdc51a46cca16`（包含 eb56473 runner 修復），勿改測後續文件 HEAD；保存四案，不再追逐微小效能差距。
以下為歷次原始成果與當時交接，若其優先順序與本節不同，以本節為準。

## 22:13 NAS 4ee81e7：fixture setup timeout，四案未執行

[Run 36247562272](https://github.com/Fyun48/5151/actions/runs/36247562272) 已完成，證據見 [README](../../evidence/prb-nas-4ee81e7/README.md)。
精確受測 SHA `4ee81e7495f63873e302a6451b1bdc51a46cca16`；兩個 SHA 欄位、14 個 module hash 與 manifest 全相符。
真 PG 155／154 pass／0 fail／1 skip；benchmark 建立 120,000 筆 fixture 的單一 INSERT 超過 15 秒（57014），`cases=[]`。
狀態 **FIXTURE_SETUP_TIMEOUT / NAS_FOUR_CASES_NOT_RUN**，不是已有四案的效能 FAIL。runner exit=1、標籤三項 0、JSONL 39 行可解析，收尾修復已實機驗證。
本批只修 fixture 分批 10,000 筆 INSERT，最後核對完整總筆數；不改正式程式、候選、timeout 或門檻。新 SHA CI 全綠後再執行同 SHA NAS。
持久輪替／成功完成範圍及跨節點／復原仍待完成，維持 NOT_READY_FOR_REVIEW／NOT_READY_FOR_MERGE；應用程式未合併、未部署。

## 爬蟲第一批修正：取消邊界（4ee81e7）

程式 SHA：`4ee81e7495f63873e302a6451b1bdc51a46cca16`。
[精確 SHA CI](https://github.com/Fyun48/5151/actions/runs/36246228432) 已全綠：一般測試 2667／2626 pass／0 fail／41 skip；真 PG 155／154 pass／0 fail／1 skip，包含取消後回滾實測。

- withBudget 以 AbortController 與 AsyncLocalStorage 傳播該輪 deadline／取消；tick abandon 或新 generation 會取消舊 generation。
- 591、各外站、地理／路線／MRT 與 provider 的既有請求 timeout signal 合併該輪取消訊號；搜尋 HTTP 請求不在此 scope。
- SQLite handle／statement／iterator 檢查該輪 deadline，禁止取消後的新操作；ROLLBACK 與關閉仍可執行。
- PG driver 的 crawler-scoped 獨立語句用短交易保護；既有 withTransaction 在語句返回及 COMMIT 前檢查取消，失敗會回滾並釋放連線。
  非 crawler 請求維持原 query 路徑；raw pool 的搜尋唯讀 snapshot 沒有宣稱被此 guard 包裝。
  crawler 獨立語句增加 BEGIN／COMMIT 往返成本，尚未量測正式抓取吞吐，不能拿搜尋 benchmark 代替。
- Node 22.23.3 本機相關回歸 13 tests／12 pass／0 fail／1 PG-only skip；真 PG 另在 CI 執行。
- 這不是強制終止任意 JavaScript：未合作的 callback 可能仍運算，但被保護的資料庫邊界拒絕後續操作。
  已送出的 COMMIT、已對外送出的通知不能撤回；持久化 ownership／fencing 與 outbox 冪等仍是後續項目。
- **持久輪替、僅成功 cover／會員記完成、跨節點業務與 restore／failover 尚未完成。**
  新 SHA NAS 未跑；既有 6703302 NAS 數字不改寫到本 SHA。未合併、未部署。

## 2026-09-26 21:32 雙 NAS 唯讀採證已取得

[Run 36245519847](https://github.com/Fyun48/5151/actions/runs/36245519847) 兩台成功，workflow SHA 08706e30。
原始產物、ZIP digest 與解讀已保存 [evidence/nas-readiness-36245519847](../../evidence/nas-readiness-36245519847/README.md)。
三個 running 應用 DB_DRIVER=postgres，六個關鍵 source hashes 一致且對應舊 master 9c6b7b0，#497 尚未部署。
Synology PG primary、CasaOS standby，16.14，async streaming；primary 觀測 replay lag 4.818 ms。
主庫 archive_mode=off；standby=on，但兩者成功封存數都是 0。未執行備份清單／還原，因此不宣稱沒有任何備份。
本次已確認通道與角色，仍未驗證跨節點業務／來源爬蟲正確性／restore／failover，不能標 HA PASS。
ChatGPT 能讀取 artifacts；既有 workflow 是固定唯讀腳本，沒有因此取得通用互動 SSH 或 workflow_dispatch。

## 第三批修正的 NAS 實測（受測 SHA 6703302）

由 DeepSeek Harness 依交接通知在 CasaOS N3450 執行，**未改測文件 HEAD `b22c13c`**。
暖機 5 輪、四案各 50 次；真 PG 149 tests／148 pass／0 fail／1 skip；`sqliteAttempts = 0`；runner exit = 1。
`sourceSha`／`checkoutSha` 皆為該 SHA，14 個 module hash 全部相符。

| 案例 | p95 ms | 目標 ms | 延遲結果 | lag p99／max ms | lag 門檻 | peak RSS／heap MiB | errors／timeouts |
|---|---:|---:|---|---|---:|---:|---|
| 單區 C1 | 1337.70 | 1000 | FAIL | 22.72／54.56 | **PASS** | 419.6／325.3 | 0／0 |
| 單區 C4 | 3029.58 | 2000 | FAIL | 32.19／**100.07** | FAIL | 663.5／562.5 | 0／0 |
| 全區 C1 | 1326.39 | 2000 | PASS | 26.56／46.99 | **PASS** | 662.1／376.0 | 0／0 |
| 全區 C4 | 3529.45 | 4000 | **PASS** | 41.29／**101.65** | FAIL | 781.6／614.7 | 0／0 |

- **全區 C4 首次進入 4000 ms 門檻**（餘裕 11.8%）。p95 對 `ae88ce6` 再降 6.5%／8.8%／8.4%／12.5%，
  對最初 `848aa7e` 已降 71.1%／78.1%／71.8%／75.1%。
- 單區 C4 lag max 超出 **0.07 ms**、全區 C4 超出 **1.65 ms**；四案 p99 全部在 50 ms 內。
- **workTimeline 重疊分析**：單區 C4 的 100.0 ms gap 中 `gc.pause` 覆蓋 60.6 ms（61%）、
  全區 C4 的 101.5 ms 中覆蓋 47.5 ms（47%）；單區 C1 與全區 C1 的最大 gap **沒有任何已插樁 span 重疊**。
  沒有 `pg.fetch.wall`／`yieldWait` 與該視窗重疊，所以其餘 39%～53% 仍未被解釋，
  PG parser／JSON 序列化／其他 I/O callback 不在插樁範圍內。不把不同事件最大值相加當因果。
- **processCpu**：C4 兩案 CPU／wall 僅 1.08～1.09，平均只用約 1 顆核心，4 核未吃滿 → 併發瓶頸偏等待與排程。
- **idleRoundTripMs**（空閒 SELECT 1，10 次）：p50 1.484／1.561／1.501／1.200 ms，CI 為 0.146 ms → NAS 的
  PG 往返慢約一個數量級，是固定成本基準。
- **PG 資源取樣**（12:36–12:54Z，含卡住時段；1442 筆可用）：`CPUPerc` p50 52.5%、p95 128%、max 162%；
  `MemUsage` 22.1→166.5 MiB。粗粒度，無每筆 server execution time，不能單憑它判定 FETCH 慢的原因。
- 證據：`evidence/prb-nas-6703302/`。

### ⚠️ runner 瑕疵：EXIT cleanup 卡死本輪（新發現，必須修）

量測 12:42Z 完成後，PG 容器到 12:53Z 仍存活、取樣檔持續成長、`runner-exit.txt` 未產生。原因：
`cleanup()` 的 `kill "$metrics_pid"; wait "$metrics_pid"` 中，背景 `docker stats` **不接受 SIGTERM**。
實測 runner `wchan=do_wait`、唯一子程序是 `docker stats`（存活 17 分鐘），補送 SIGTERM 後 8 秒仍存活。
先寫下 `runner-cleanup-hang.txt` 診斷，再以 SIGKILL 解除；之後 cleanup 正常完成
（exit=1、三項標籤查詢 0 筆、worktree 移除、正式容器未動）。**這是 runner 缺陷，不是量測失敗。**

附帶瑕疵：`postgres-resource-stats.jsonl` 每次刷新帶 ANSI `\x1b[H`，不是可直接解析的 JSON Lines。
建議下一版改用 `docker stats --no-stream` 迴圈，或在 cleanup 以 `kill -9`／`timeout` 包住取樣器。

## 第三批：降低中間配置與可對時的診斷（6703302）

程式 SHA：`6703302cf57deeaa8cc5b8866f08fb4f8d6e23c5`，基於 GitHub `d98cab24b4c4285ce185e702eb979ae6968e543a`。
[精確 SHA Tests 36240011855](https://github.com/Fyun48/5151/actions/runs/36240011855)：精確 SHA CI checks 全部成功。
一般 2658／2618 pass／0 fail／40 skip；真 PG 149／148 pass／0 fail／1 optional skip。
CI p95：294.22／767.91／301.05／778.20 ms；lag p99：17.24／19.97／17.55／21.53 ms，max：18.25／28.82／21.84／31.67 ms。
四案 CI smoke／lag 通過，但延遲比 ae88ce6 CI 高約 14～26%，尚未證實 NAS 效能改善。
原始 artifact、hash 與完整取捨記錄於 `evidence/prb-ci-6703302/`；不把 CI 成功代替 NAS。

- PG 版本列逐批以 array values 消費，不再同時保留整個版本查詢結果與完整候選陣列。
  每筆都查當前快照的版本；完整 42 欄、權限、schema／role／MVCC／storage／epoch 保護不變。
- canonical stats 每 256 筆完成個人旗標 overlay、profile 過濾與計數，隨即釋放中間物件。
  保留所有候選與精確總數；全域 watched／offline／dbTotal 只計入一次。自訂 projection 保留原路徑。
- 新 `stats_profile_sync_ms`／`stats_count_sync_ms` 是同步工作累積值；`stats_reduce_ms` 包含排程等待。
  不可把它們和舊 `stats_profile_ms`／`stats_count_ms` 的 wall time 直接比較。
- PG 窄列上限仍為 1,024、寬列 512，沒有用放大批次交換 lag。每請求查詢數並未因此減少。
- benchmark 加入同一 monotonic clock 上的 GC／tickGap／FETCH／yieldWait spans（每類最多 32 個最長且 ≥20 ms 的事件）、
  Node process CPU、量測窗與 timeOrigin。空閒 SELECT 1 的 10 次往返基準在正式量測窗外；所有 gate 與 50 次樣本保留。
  cold EXPLAIN 另納入精確 COUNT 查詢，以區分 server plan 成本與應用端等待。
- NAS runner 只對它建立的拋棄式 PG 容器取樣 Docker CPU／memory／I/O，保存
  `postgres-resource-stats.jsonl`／`.err`／`-start.txt`，EXIT cleanup 先停止並 wait 該 sampler，再清除資源。
  此為粗粒度觀測，沒有每筆 query 的 server execution time，不能單憑它證明某次 FETCH 慢的原因。
- 本機 Node 22.23.3：40 tests／33 pass／0 fail／7 PG-only skip；真 PG CI 另含 8,705 筆冷／暖版本串流相容性。
- 不改 fixture、候選、欄位、硬體、暖機／樣本數與門檻；不動正式 5151_shadow、不合併、不部署。

### 對上一輪 lag 歸因的更正

已有數據證明插樁 generator 的 step／slice 很短，並觀測到 GC pause 與排程等待。
**但各指標最大值沒有時間關聯，不能把 96.113 ms yieldWait 與 59.069 ms GC 相加，宣稱已證明 162 ms 原因。**
PG parser、其他 I/O callback、JSON serialization 等不全在 generator 的插樁範圍；不能排除未量到的長同步段。
新增時間線用於確認是否重疊，仍不把重疊直接等同因果；舊 NAS raw JSON／logs／README 保留不改。

### DeepSeek 下一輪指定 NAS — 已執行

**已於 2026-09-26 由 DeepSeek Harness 執行完畢，結果見本檔第一節。**
受測 SHA 就是指定的 `6703302cf57deeaa8cc5b8866f08fb4f8d6e23c5`，未改測文件 HEAD `b22c13c`；
證據目錄 `evidence/prb-nas-6703302/`。以下保留原始指令備查。

精確 SHA CI 已全綠，請原 CasaOS N3450 透過既有 SSH 執行 **6703302cf57deeaa8cc5b8866f08fb4f8d6e23c5**。
不要自動改測後續文件 HEAD。指定 SHA 的 runner 用 `bash` 呼叫；後續文件提交會恢復 runner 的 executable bit，內容不變。

```bash
ssh casa-nas
cd /mnt/Storage1/prb-acceptance/5151 || exit 1
test -z "$(git status --porcelain)" || exit 1
git fetch origin || exit 1
git checkout --detach 6703302cf57deeaa8cc5b8866f08fb4f8d6e23c5 || exit 1
test "$(git rev-parse HEAD)" = 6703302cf57deeaa8cc5b8866f08fb4f8d6e23c5 || exit 1
mkdir -p /mnt/Storage1/prb-acceptance/evidence
mkdir /mnt/Storage1/prb-acceptance/evidence/prb-nas-6703302 || exit 1
setsid nohup bash -c '
  bash v3/scripts/prb-nas-verify.sh \
    6703302cf57deeaa8cc5b8866f08fb4f8d6e23c5 \
    /mnt/Storage1/prb-acceptance/evidence/prb-nas-6703302 \
    > /mnt/Storage1/prb-acceptance/evidence/prb-nas-6703302/runner.log 2>&1
  prb_run_exit=$?
  echo "$prb_run_exit" > /mnt/Storage1/prb-acceptance/evidence/prb-nas-6703302/runner-exit.txt
  exit "$prb_run_exit"
' >/dev/null 2>&1 &
```

保留完整真 PG 與四案各 50 次、raw JSON／logs、上述 PG resource 檔、映像／主機、runner exit、SHA256SUMS。
核對實際 sourceSha／checkoutSha 與 module hashes；以 `prb-nas-verify=1` 查容器／network／volume，三項皆應為 0，保存清理紀錄。
請回傳 heap／RSS／GC、workTimeline 最大 tickGap 附近是否有 GC／FETCH span，以及 idleRoundTripMs／processCpu／PG resource 觀測。
沒有證據就保留未定論，不把 wall time 全歸為 server CPU，也不以別的 SHA 成績代替。
新 NAS 證據提交 `evidence/prb-nas-6703302/`，回填 PR 與本文件；任何 FAIL 一律保留。

## 第二批修正的 NAS 實測（受測 SHA ae88ce6）

由 DeepSeek Harness 依交接指令在 CasaOS N3450 執行，**未改測文件 HEAD `be2da17`**。
暖機 5 輪、四案各 50 次；真 PG 148 tests／147 pass／0 fail／1 skip；`sqliteAttempts = 0`；runner exit = 1。

| 案例 | p95 ms | 目標 ms | 延遲結果 | lag p99／max ms | lag 門檻 | peak RSS MiB | errors／timeouts |
|---|---:|---:|---|---|---:|---:|---|
| 單區 C1 | 1429.96 | 1000 | FAIL | 23.25／44.83 | **PASS** | 436.2 | 0／0 |
| 單區 C4 | 3321.86 | 2000 | FAIL | 36.08／67.31 | **PASS** | 679.3 | 0／0 |
| 全區 C1 | 1448.70 | 2000 | PASS | 26.64／73.86 | **PASS** | 666.6 | 0／0 |
| 全區 C4 | 4032.71 | 4000 | FAIL | 41.84／162.14 | FAIL | 745.2 | 0／0 |

- **本批用一點延遲換到大幅 lag**：p95 與 `6381f0f` 幾乎相同（單區 +3.0%／+3.1%，全區 −0.1%／+0.4%），
  但 lag p99 降到原來約 29～50%、max 降到約 30～66%。全區 C4 的 **p99 41.84 ms 已在門檻內**，
  只剩 **max 162.14 ms** 超標；全區 C4 延遲只超目標 32.71 ms（0.82%）。
- **lag 定位（不看 p95）**：同步切片已被壓住 —— 四案最大 `step` 6.919／8.149／7.479／7.119 ms、
  最大 `slice` 7.731／9.382／8.918／7.909 ms，都遠低於 50 ms。lag max 等於最大 `tickGap`
  （44.805／67.228／73.837／162.051 ms）。全區 C4 同時觀測到以下最大值（未證明它們在同一時段）：
  `pg.fetch.wall` 最大 303.586 ms、`pg.fetch.yieldWait` 最大 96.113 ms、`gc.pause` 最大 59.069 ms
  （3 次 >50 ms）。需要可對時的事件與更多插樁，才能檢驗 GC／I/O 對 lag 的貢獻。
- **下一批具體目標**：①降低 fetch／append 期間的配置以壓 GC pause（四案最大 35.7～71.5 ms，>50 ms 共 5 次）；
  ②查 PG fetch wall／yieldWait（round trips 已由 49／44 增至 88／96）；③`stats_ms` 仍是最大階段
  （785.05／1634.92／728.30／1865.29 ms，占 46.3～54.9%），且比上一輪高，切片開銷要一併計入；
  ④單區 C4 的 `prepare_ms` 92→223、`display_ms` 157→172、`sort_ms` 149→163。
- 三項標籤清理查詢皆 0 筆；正式容器未動；證據在 `evidence/prb-nas-ae88ce6/`（含 `runner.log`）。

## 第二批輸入／SQL／關係與排程修正（ae88ce6）

程式 SHA：`ae88ce66df0a2271dcc0e14f5525db6b2cf93bc0`，基於 GitHub `a6378854bf5365595f77752e8dcd2215956442f1`。
[精確 SHA Tests 36237613877](https://github.com/Fyun48/5151/actions/runs/36237613877) completed／success。
一般 2656 tests／2616 pass／0 fail／40 skip；真 PG 148 tests／147 pass／0 fail／1 optional skip。
同 SHA GitGuardian 與 model review checks 皆 completed／success。
原始 artifact JSON 已原樣保存於 `evidence/prb-ci-ae88ce6/`，ZIP digest、14 個 module hashes 與四案結果 hash 均核對相符。

| CI 案例 | p95 ms | lag p99／max ms | peak RSS MiB | errors／timeouts |
|---|---:|---:|---:|---:|
| 單區 C1 | 233.24 | 15.56／18.78 | 443.4 | 0／0 |
| 單區 C4 | 675.10 | 19.64／24.40 | 565.1 | 0／0 |
| 全區 C1 | 243.43 | 17.27／19.46 | 571.8 | 0／0 |
| 全區 C4 | 627.09 | 22.66／30.39 | 788.8 | 0／0 |

該次 CI smoke 與四案 lag 均通過、SQLite attempts 0；後續 ae88ce6 NAS 已跑且 FAIL，見前節。
本輪 CI 是 Xeon Platinum 8573C，上輪是 EPYC 7763，不能據此推算 NAS 改善幅度。
插樁同步 step 最大 3.000／7.200／4.274／7.101 ms；slice 最大 4.268／8.035／6.233／8.615 ms；
yieldWait 最大 6.201／17.168／6.621／17.999 ms。GC pause 與所有工作量見原始 JSON。
PG list ID 查詢 shared hits 為 2,438；候選仍為單區 18,512／全區 36,000。

- PG 的 all／unseen／viewed 個人旗標改用 EXISTS／NOT EXISTS，讓 planner 可使用 semi／anti join，
  避免每個候選都執行 scalar subquery。保留缺值、NULL、0、1、非二元值，以及 viewer uid 與 voteUid 分離的語意。
- 候選 prep 僅載入已知 houseprice 列與來源未知的外部 peers；一般 provider／頁面裝飾契約不變。
  不減少候選、欄位、extras 或關係；preload 的候選記憶體迴圈加上合作式排程。
- 同戶角色只掃描一次所有候選建立索引與個人群組；配對階段只處理有關係的列，保留原順序、
  主副卡／split／個人群組覆寫規則。內層 peer 及 primary 選擇加入 checkpoints。
- stats 數字欄位改用固定 property 讀取；保留自訂 projection、文字數字與 own-field 轉換契約。
- PG 窄列每批最多 1,024 列（原 4,096），完整 42 欄仍為每批 512 列；完整讀完，不截斷。
  代價是窄列 FETCH 次數增加，須由同 SHA CI／NAS 同時檢查端到端延遲與 lag。
- 版本內容複製改為 2 ms 合作式排程；generator 最後一次 next() 超過預算也必須讓出。
  WHERE、MVCC 列版本、欄位權限、schema／role／storage／epoch 與快照保護皆不變。
- benchmark 新增每案 `workDiagnostics`：`.step`／`.slice` 的同步時間、checkpoint 工作量、
  `.yieldWait` 排程等待、PG submit／append 同步段及 query wall time、GC pause／timer gap。
  **yieldWait 與 PG wall time 包含其他請求／I/O，不能當作本次同步 CPU 時間**；
  step／slice 為已插樁區段，並非完整 JS／PG parser profiler。GC pause 另列。
  診斷只在 benchmark 量測區段透過 AsyncLocalStorage 啟用，使用彙總資料、不保留無界樣本。
- 本機 Node 22.23.3 回歸：127 tests／121 pass／0 fail／6 真 PG 測試於本機跳過，現已在 CI 實際執行。
  本機 CPU-only 診斷沒有 PG／NAS，不能替代驗收。
- fixture、42 欄、120k stored／36k active、暖機 5 輪、每案 50 次及所有硬 gate 不變。

## 交給 DeepSeek 的下一輪 NAS（指定程式 SHA ae88ce6）— 已執行

**已於 2026-09-26 由 DeepSeek Harness 執行完畢，結果見本檔第一節。**
受測 SHA 就是指定的 `ae88ce66df0a2271dcc0e14f5525db6b2cf93bc0`，沒有改測文件 HEAD `be2da17`；
證據目錄 `evidence/prb-nas-ae88ce6/`，`sourceSha` 與 `checkoutSha` 皆為該 SHA。
本節以下保留原始指令備查。

本輪由 DeepSeek Harness 透過既有 SSH 執行。沒有瀏覽器登入／OTP 待辦。
**指定 SHA CI 已全綠，可以執行；指定測 `ae88ce66df0a2271dcc0e14f5525db6b2cf93bc0`，不要自動換成後續文件 HEAD。**
未量測的新版本不得沿用 6381f0f 或 CI 的成績。若實際改測別的 SHA，須先核對它自己的 CI、
以真正受測 SHA 命名目錄並回填版本差異。

```bash
ssh casa-nas
cd /mnt/Storage1/prb-acceptance/5151 || exit 1
test -z "$(git status --porcelain)" || exit 1
git fetch origin || exit 1
git checkout --detach ae88ce66df0a2271dcc0e14f5525db6b2cf93bc0 || exit 1
test "$(git rev-parse HEAD)" = ae88ce66df0a2271dcc0e14f5525db6b2cf93bc0 || exit 1
mkdir -p /mnt/Storage1/prb-acceptance/evidence
mkdir /mnt/Storage1/prb-acceptance/evidence/prb-nas-ae88ce6 || exit 1
setsid nohup bash -c '
  bash v3/scripts/prb-nas-verify.sh \
    ae88ce66df0a2271dcc0e14f5525db6b2cf93bc0 \
    /mnt/Storage1/prb-acceptance/evidence/prb-nas-ae88ce6 \
    > /mnt/Storage1/prb-acceptance/evidence/prb-nas-ae88ce6/runner.log 2>&1
  prb_run_exit=$?
  echo "$prb_run_exit" > /mnt/Storage1/prb-acceptance/evidence/prb-nas-ae88ce6/runner-exit.txt
  exit "$prb_run_exit"
' >/dev/null 2>&1 &
```

原 CasaOS N3450，完整真 PG 與四案各 50 次。請一併回傳 `workDiagnostics` 的最大同步 step／slice、
工作量、讓出等待、PG reply 列數與 GC pause；若仍超過 lag gate，先依量測定位，勿只看 p95 改善。
核對 JSON `sourceSha`／`checkoutSha`、module hashes、結果 hash、主機與映像、SQLite attempts、
errors／timeouts、runner exit。完成後保存三項標籤清理查詢（容器／network／volume 應為 0）：

```bash
docker ps -a --filter label=prb-nas-verify=1 --format '{{.ID}} {{.Names}}'
docker network ls --filter label=prb-nas-verify=1 --format '{{.ID}} {{.Name}}'
docker volume ls --filter label=prb-nas-verify=1 --format '{{.Name}}'
```

保存全部失敗樣本、raw logs、cleanup 紀錄與 SHA256SUMS，提交到 `evidence/prb-nas-ae88ce6/`。
回填 PR 與本文件時一律用實際受測 SHA；NAS 未過仍 NOT_READY_FOR_REVIEW／NOT_READY_FOR_MERGE。
正式 `5151_shadow` 不可 setup／migration／ANALYZE；不改硬體、不放寬 gate、不合併、不部署。

## 第一批 CPU 修正的 NAS 實測（受測 SHA 6381f0f）

由 DeepSeek Harness 以 GitHub 權威 checkout 在 CasaOS N3450 執行四案（暖機 5 輪、每案 50 次）。

| 案例 | p95 ms | 目標 ms | 延遲結果 | lag p99／max ms | peak RSS MiB | errors／timeouts |
|---|---:|---:|---|---|---:|---|
| 單區 C1 | 1388.20 | 1000 | FAIL | 59.47／89.52 | 427.4 | 0／0 |
| 單區 C4 | 3221.51 | 2000 | FAIL | 72.02／223.08 | 765.6 | 0／0 |
| 全區 C1 | 1449.60 | 2000 | PASS | 91.68／145.62 | 732.5 | 0／0 |
| 全區 C4 | 4016.80 | 4000 | FAIL | 126.22／247.46 | 834.9 | 0／0 |

- 全區 C4 只超出目標 16.80 ms（0.42%）；真 PG 143 tests／142 pass／0 fail／1 skip；
  `sqliteAttempts = 0`；runner exit = 1；結果 hash 與前幾輪相同。
- 與 `ef9e21a` 相比 p95 降 21.8%／31.2%／26.0%／31.0%；與 `848aa7e` baseline 相比降 69～77%。
  修正命中的階段：`profile_ms` 119→50、`sort_ms` 90→42、`display_ms` 61→35（單區 C1）。
- **lag 沒有跟著改善**：p99 四案仍全部超標，全區 C1／C4 與單區 C4 的 max 反而上升。
  總延遲下降但 event-loop lag 未降，推測與單次不讓出的同步區段變長有關，尚未以 profiler 證實；
  下一批修正應同時量測讓出間隔，不能只看總時間。
- 瓶頸：`stats_ms` 仍是四案最大單一階段（697.76／1532.16／603.87／1490.97 ms，占 37.1～50.3%），
  其內部以 `stats_inputs_ms` 最大（591／1121／455／1100）；C4 時 `sql_ms`（867／1407）與
  `relations_ms`（307／884）是第二、第三大成本。
- 同 SHA CI 對照：NAS 約為 CI 的 3.70～3.90 倍（上一輪為 5.49～6.00 倍），
  代表本批修正對慢速 CPU 的幫助大於對 CI runner 的幫助。`143f1a6` 的 CI 全區 C4 lag p99 為 54.20 ms，
  CI 也不是全部效能 gate 通過。
- 證據：`evidence/prb-nas-6381f0f/`；同 SHA CI
  [36235625644](https://github.com/Fyun48/5151/actions/runs/36235625644)。

## 第一批 CPU 修正（143f1a6，歷史）

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

ChatGPT 負責改碼、推送與精確 SHA CI；NAS 由 DeepSeek Harness 以既有 SSH 接續。
`143f1a6`／`6381f0f` 的 NAS 四案已於本輪由 DeepSeek Harness 跑完，結果見上方。

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

- 第一批程式 SHA `143f1a636a21a85cad1019dd5037a476123fd5a3`（歷史）：
  [Tests 36235146987](https://github.com/Fyun48/5151/actions/runs/36235146987) completed／success。
  一般 2650 tests／2612 pass／0 fail／38 skip；真 PG 143 tests／142 pass／0 fail／1 optional skip。
  GitGuardian 與 model review checks 也成功。
- 同 SHA CI 四案 p95：單區 C1 361.76／C4 871.02 ms；全區 C1 371.66／C4 1071.29 ms。
  每案 50 次，errors／timeouts／SQLite attempts 皆 0；`CI_SMOKE_PASS`。
  **全區 C4 lag p99 54.20 ms 超過 50 ms**（max 87.88 ms）；不可寫成所有效能 gates 已過。
  完整 artifact 原樣保存於 `evidence/prb-ci-143f1a6/`，含版本、硬體、module hashes 與 SHA256SUMS。
- 上一輪 NAS 受測 SHA `ef9e21aa0f293e97a7269e4726f499e4561f21fe`（歷史）：
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
- ef9e21a 與 6381f0f 的 NAS 四案已完成（皆 FAIL，見上）；143f1a6 程式效果由實測 6381f0f 記錄。
  新程式 ae88ce6 尚未在 NAS 量測，不預先宣稱 `stats_ms`、C4 或 lag gate 達標。
  整體遷移 C～F、production auth／雙節點 HTTP E2E、HA promotion／failover、PITR／RPO／RTO 未完成。

## 可接續環境（DeepSeek 2026-09-26 完成後）

- NAS 受測 checkout：`/mnt/Storage1/prb-acceptance/5151`（最近受測 detached `6381f0f`，取自 GitHub 權威來源）。
  新一輪 runner 建立的資源都帶 `prb-nas-verify=1` 標籤，可依標籤查回來源。
- 最新 NAS 持久證據：`/mnt/Storage1/prb-acceptance/evidence/prb-nas-6381f0f/`（含 SHA256SUMS）；
  已提交到 repo 的 `evidence/prb-nas-6381f0f/`，更早 ef9e21a 證據亦保留。
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

## 第一批 NAS 後提出的目標（本批已實作，效果待新 SHA NAS）

1. `143f1a6`／`6381f0f` 的精確 SHA CI 與 NAS 四案都已完成（NAS 為 FAIL，見上方第一節）。
   下一批修正的目標：`stats_inputs_ms`（591／1121／455／1100 ms）與 C4 的 `sql_ms`（867／1407）、
   `relations_ms`（307／884）。
2. **lag 是本輪沒有進展的部分**：總延遲降了 22～31%，但 p99 四案仍全部超標（59.47／72.02／91.68／126.22），
   單區 C4、全區 C1、全區 C4 的 max 反而上升到 223.08／145.62／247.46 ms。下一批必須同時觀測
   event-loop 讓出間隔與單次同步工作量，不能只用總延遲當改善證據；也不得用放寬門檻收斂。
3. 不使用較強硬體、不放寬門檻、不減少候選來讓數字過關；失敗樣本一律保留。
4. NAS gate 通過前維持 NOT_READY_FOR_REVIEW／NOT_READY_FOR_MERGE。完整 PR-B 驗收後再接續 C～F；
   正式變更仍 manual-only，且需 Owner 明確核准。

## 143f1a6 的 NAS 接續指令（已執行，見上方第一節）

本節原為待執行指令，現已由 DeepSeek Harness 執行完畢，保留備查。

**執行時的版本選擇（與本節原指令的差異，需明示）**：實際受測 SHA 為 PR head
`6381f0f8a5afad0a6f4e9ca8cc67cf42e7e9349b`，不是 `143f1a6`。原因是 `6381f0f` 才是會被合併的 head，
而兩者的 `v3/src`、`v3/test`、`v3/scripts` 完全相同（差異只有本文件與 `evidence/prb-ci-143f1a6/`），
所以量到的程式等於 `143f1a6`。證據目錄因此命名為 `evidence/prb-nas-6381f0f/`（依受測 SHA），
沒有產生 `prb-nas-143f1a6` 目錄。除此之外其餘要求（獨立 checkout、不覆寫既有樣本、四案各 50 次、
完整 PG tests、標籤清理查詢、SHA256SUMS、保留 FAIL 樣本）都照本節執行。

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
