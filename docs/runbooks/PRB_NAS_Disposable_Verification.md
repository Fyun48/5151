# PR-B 同 SHA 的 NAS 拋棄式驗收

此流程在既有 NAS 開發主機執行，不部署 5151。腳本建立獨立 checkout、Node 22 與 PG 16.14 測試容器。
PostgreSQL 不發布 host port；測試容器使用新建的 internal Docker network，沒有通往正式庫的路由。
PG 使用新建的 Docker volume（隨驗收清除），沒有改用 RAM disk 美化儲存效能。
不讀共享憑證庫、不接受 PG_URL；不把名稱帶 shadow 的資料庫當成測試庫。

前置：既有 repo、Git、Docker，且 Docker 可拉取官方映像。約需數分鐘及數 GB 暫存記憶體。
首次 npm ci 需要 registry 網路；實際測試時只有封閉測試網路。

```bash
git fetch origin fix/pr-b-persist-listing-transaction
sha=$(git rev-parse origin/fix/pr-b-persist-listing-transaction)
# 先檢視該 SHA 的腳本；若目前 checkout 較舊，將腳本由該 SHA 匯出至暫存檔執行。
git show "$sha:v3/scripts/prb-nas-verify.sh" > /tmp/prb-nas-verify.sh
bash /tmp/prb-nas-verify.sh "$sha"
```

腳本保留 `artifacts/prb-nas-<SHA>/` 的 PG test log、完整 benchmark JSON／log、Node 與 PG image ID。
退出時只移除自己建立的 container／network／dependency volume／worktree；不清理既有服務。
benchmark 記錄 source SHA、checkout SHA、模組 hash、硬體、PG／Node、固定 fixture、暖機與量測次數。

固定 120,000 列、36,000 查詢範圍；單區／全區各 C1／C4，至少 5 輪暖機及 50 次完整請求。
NAS 判定使用：單區 C1 p95 ≤1s／C4 ≤2s；全區 C1 ≤2s／C4 ≤4s；lag p99 ≤50ms／max ≤100ms；零錯誤。
完整請求包含同快照 PG、Node 篩選／配對／排序／裝飾、stats、JSON 序列化，不含使用者外網傳輸。
每個 SQL 包括 cursor FETCH 都計數；BEGIN／ROLLBACK 另列。查詢數目標不是單獨硬性 gate。

此腳本的外殼已通過 bash 語法檢查；本次工作環境沒有 Docker／NAS 執行通道，因此未執行這個 NAS 容器流程。
其所呼叫的真 PG fixture 與 benchmark 由 GitHub Actions 分別實跑；CI 成績不能替代 NAS 成績。
若需要真實資料分布驗收，另使用已核准的受控資料副本；本流程不會複製正式資料。
