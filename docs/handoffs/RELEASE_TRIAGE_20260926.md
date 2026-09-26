# 2026-09-26 上線裁決：停止搜尋效能微調，先補資料正確性與可復原性

Owner 於 2026-09-26 21:00（Asia/Taipei）指示：若 PostgreSQL、爬蟲與雙備援已完成，
資料正確且速度可接受，就優先上線，後續再優化與改功能。
本次裁決依此改變排序；不是沿用先前「任何 NAS 效能門檻未過都不得前進」的要求。

## 裁決

- **SEARCH_PERFORMANCE_ACCEPTED_WITH_EXCEPTION**：接受下列已測搜尋延遲作為此版上線規劃的效能取捨，
  停止 GC、parser、round trips 等純效能迭代，不再為 lag max 差 0.07／1.65 ms 延後功能工作。
- **原始 NAS_ACCEPTANCE_FAIL 保留**：不改測試閾值、不刪失敗樣本、不把舊 SHA 成績改寫為新 SHA PASS。
- **RELEASE_BLOCKED_ON_CORRECTNESS_AND_RECOVERY**：目前不能宣告「PostgreSQL＋爬蟲＋雙備援全部好了」。
  下列缺口不只是速度，部分可由目前程式直接重現。Owner 的條件尚未成立，因此未合併、未部署。
- PR-B 搜尋效能工作可停止並交付審查；整體架構遷移不能因此結案。不要求為這次上線先完成所有非核心功能。

## 已接受的效能與證據範圍

受測 SHA：`6703302cf57deeaa8cc5b8866f08fb4f8d6e23c5`，CasaOS N3450，暖機 5 次、四案各 50 次。
證據：[NAS README](../../evidence/prb-nas-6703302/README.md)。本次逐項核對 SHA256SUMS，12 檔全部相符。

| 案例 | p95 ms | lag p99／max ms | 裁決 |
|---|---:|---:|---|
| 單區 C1 | 1337.70 | 22.72／54.56 | 接受此版效能取捨 |
| 單區 C4 | 3029.58 | 32.19／100.07 | 接受此版效能取捨 |
| 全區 C1 | 1326.39 | 26.56／46.99 | 原延遲與 lag 門檻通過 |
| 全區 C4 | 3529.45 | 41.29／101.65 | 接受此版 lag 取捨 |

真 PG 149 tests／148 pass／0 fail／1 optional skip；200 次 errors／timeouts=0、SQLite attempts=0，
結果 hash 未變。這是固定 fixture 的完整搜尋請求，並非正式使用者 HTTP 全流程或爬蟲來源精準度驗收；
也沒有與目前正式站做受控 A/B，不能稱「與現行上線版一樣快」。

## runner 修正已交付

程式 SHA：`eb564736ee14d268e0a5358d5be7787c0d9a3f78`。
只改 runner 與新增其回歸測試；`v3/src`、搜尋 benchmark 與 6703302 完全相同。

- `docker stats --no-stream` 每次輸出一筆，再間隔 2 秒；避免 streaming 的 ANSI 畫面刷新碼。
- sampler 放在獨立 session／process group。EXIT 時只 SIGKILL 該診斷取樣群組，再 wait，
  接著清理本輪 app／PG／network／volumes／worktree；不等待不理 SIGTERM 的 docker client。
- 新增三個真實 Bash／process-group 回歸，以 fake Docker 重現不接受 SIGTERM 的子程序：
  正常退出 0、benchmark 失敗退出 1、runner SIGTERM 退出 143，全部清理完成、JSON 可解析。
  Node 22.23.3 本機 3／3 pass；沒有接 Docker daemon 或正式庫。
- [精確 SHA CI](https://github.com/Fyun48/5151/actions/runs/36243932369) 與 GitGuardian／model review checks 已全部成功。
  **新 runner 的 NAS 實跑尚未完成**，本機替身測試不冒充 NAS 驗收。

## 最短上線必辦：只處理會影響正確資料、跨節點一致及回復的缺口

| 項目 | 已確認的缺口 | 完成條件 |
|---|---|---|
| 爬蟲取消／覆蓋 | `crawlWatchdog.js` 的 withBudget 仍是 Promise.race，逾時不取消工作；`crawlPolicy.js` 用時間窗選組。`server.js` 只傳部分 jobs 卻仍傳整份 includedUserIds；`coveringBookkeepingAsync.js` 完成時 UPDATE 全部 crawl_covers。 | 持久化完成游標、有效 owner／取消與提交防護；只對本批實際成功的 cover／會員記完成。測 19+ 組、多輪、重啟、部分失敗、逾時舊工作與雙 worker 競爭；不能讓未抓組看起來已成功。 |
| 已啟用功能跨節點同源 | `db.js` 模組載入仍無條件開 v3.db；整站零 SQLite 不能由搜尋核心 sqliteAttempts=0 推得。現有矩陣的 auth／媒體／背景工作與雙節點 HTTP 尚未驗完。 | 核對正式已啟用入口，完成 A 寫 B 讀、B 改 A 讀、權限與媒體可見性；有活躍本機業務寫入就修正或提出明確範圍，不能假稱全站遷移完成，也不能自行關既有功能。 |
| 資料復原／雙備援 | 2026-09-24 文件記錄 async standby、archive_mode=off；是歷史觀測，沒有本輪即時核對。舊 tunnel 32/32 HTTP 200 演練不是資料與 PG failover 驗收。 | 既有 SSH 核對兩節點版本／掛載／PG角色／複寫與 lag；確認可用備份並在隔離副本還原、指定可回版的 PG 相容應用版本。人工 promotion 可以是明確策略，不要求先建自動選主，但必須有舊 primary 隔離、實測資料點與 RPO／RTO，不能把 standby 稱為備份。 |

以上依目前 authoritative checkout 判斷；GitHub master 核對仍為 `9c6b7b04f9801717cb6696e8e095fde4c309473f`。
目前 open PR 為 #496（盤點）、#497（本 PR）、#498（唯讀監控），未找到已另行交付 C～F 的 PR 證據。
若 NAS 已有後續正式證據，直接補上 exact SHA／觀測時間／原始結果，不要求重做已完成工作。

### 本次最小重現（不接外站／正式庫）

在 `5c8a26efdd8518f355475731eefed764dbd98b73` 的純函式上執行：19 組、每次 6 組、
15 分鐘時間窗，在 0／30／60／90 分鐘選取，未涵蓋 7、8、9、10、11、12、19；
withBudget 5 ms 包住 60 ms 工作，拋 TIMEOUT 後該工作仍完成。
這證明可重現的程式缺口，**不宣稱正式站當下就是該間隔或已發生那些漏抓**。

## DeepSeek 接續順序

1. runner 精確 SHA CI 全綠後，用既有 SSH／原 CasaOS 跑 `eb564736ee14d268e0a5358d5be7787c0d9a3f78`。
   不改測文件 HEAD；保存 `evidence/prb-nas-eb56473/`、exit、完整樣本與清理查詢。
   這輪重點為 JSONL 逐行可解析、取樣器與子程序消失、三項標籤歸零且 EXIT 不再卡住。
   原門檻仍可回 FAIL；不要再因此啟動純效能優化迴圈。
2. 集中補上表三項實際缺口／缺少的正式證據。先讀現有證據；只做必要修正，不重構已通過搜尋路徑。
   爬蟲抽查需包含來源 ID／租金／行政區／刊登與下架狀態及實際 cover 完成映射，不只比 COUNT。
3. 交付候選 exact SHA＋CI、已啟用功能跨節點驗證、資料／媒體補遷差異、備份還原與回版證據。
   條件成立後沿既有 GitHub manual-only build → predeploy → deploy 路徑上線；Owner 本次已表達條件式上線意圖，
   不再為同一意圖索取重複批准。對尚未具體化的資料改寫／故障演練，不以本文件當成無範圍授權。

## 診斷解讀修正

- Node process CPU／wall 約 1.08 不排除單一 JS 主執行緒 CPU 飽和；不能據此斷言瓶頸一定是等待。
- timeline 每類只保留最長 32 個且 ≥20 ms 的 span。沒有保留的 FETCH overlap 不等於完整排除 FETCH／callback，
  GC 的已記錄重疊可保留，但未覆蓋時間不能直接全算成同步工作。
- 上述診斷留待上線後必要時處理，不作為這輪新增效能工項。

## 21:32 最新採證補充

雙 NAS 的角色與版本已有當次實測：[run 36245519847](../../evidence/nas-readiness-36245519847/README.md)。
Synology primary／CasaOS standby，async streaming，單次 replay lag 4.818 ms；三應用受查六檔均為 9c6b7b0。
主庫 archive_mode=off、兩台 archived_count=0；備份檔本次未盤點，restore／failover 仍未做。
因此不用再重查通道／基本角色；下一步聚焦已列的爬蟲缺陷、跨節點業務與復原驗證。
