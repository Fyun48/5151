# 093bb4a 上線缺口核對（2026-09-26）

此表是既有「跨節點同源、可復原」兩項要求的具體化，不新增搜尋效能門檻。
受查程式 SHA：093bb4ae76339b0f6a5f4ea57ca4266872de4a30。
NAS 四案結果另見對應 evidence；不能用搜尋 sqliteAttempts=0 推論整站零 SQLite。

## 已完成與保留範圍

- 取消後受保護的寫入停止、持久輪替、成功 cover／會員 CAS 完成已加入回歸。
- 整輪 PG session advisory lock 與同連線交易序列化已加入；精確 CI 真 PG 162 tests／161 pass／0 fail／1 skip。
- 同一資料庫兩個 worker 排他不等於雙 primary fencing。
- NAS 通道及主備角色已驗證，無需重新登入或重建通道。

## 可定位的本機業務路徑

| 路徑 | 原始碼事實 | 收尾要求 |
|---|---|---|
| watcher 房源配對 | watcher.js 呼叫 db.js 的 setListingMatch／reconcileListingById；函式直接讀寫 db.prepare | 配對讀寫與群組副作用接至目前 driver；用兩個獨立 app context 驗證相同結果 |
| 爬蟲基線／樂屋游標 | watcher.js 的 saveSettings({hasBaseline:true})、get/saveRakuyaPageCursors 走 db.js 的 SQLite settings | 使用共用 PG settings；不要將全份舊 settings 覆寫到新設定 |
| tick 帳號維護 | server.js execute 仍呼叫 expireStaleVerifyTokens／pauseIdleMembers，同步 helper 使用本機 db | 核對正式啟用功能，移轉時保留過期及閒置規則，不自行停用 |
| 上班地址補座標 | server.js ensureWorkCoords 使用同步 getSettings／saveSettings | 避免會員透過 PG 儲存後，被本機舊設定讀取或寫入 |

以上是 source call-path 證據，不是本次已觀測到的正式資料損壞；尚未窮盡全部功能。
修正應按既有啟用入口成批驗證，不再以一個字串接線測試代表端到端一致性。

## PostgreSQL 備份／回版

- `.github/scripts/production-predeploy-remote.sh` 與其 workflow 的備份及 integrity_check 仍針對 SQLite；未找到該流程執行 pg_dump／PG restore 的步驟。
- `deploy/shadow-ha/backup/backup.sh` 有 pg_dump custom format 及 manifest SHA256；這不代表目前已有排程或可用備份。
- `evidence/runtime-modernization/A4-HA-DRILL-20260920.md` 的還原只有 repl_test 1 列，failover marker 已預先複寫。保留此歷史成功證據，但不將當時 RPO=0 或 5–17 秒 RTO 推廣成今日保證。
- 今日角色／async streaming 已由 36245519847 驗證；不重做會中斷正式服務的 promotion。
- `deploy/shadow-ha/backup/restore.sh` 雖註解 never 5151_shadow，實際只有名稱字元白名單，隨後 DROP DATABASE IF EXISTS，沒有拒絕正式名稱。不得直接帶可自訂名稱在現役 PG 上執行它。

最短補證：找出最近 PG dump 與 manifest、時間／雜湊／來源資料庫及異機副本；在全新、具標籤且無正式 volume 掛載的 PG 容器還原，核對 schema、主要表、約束／序列及業務樣本，清理只有該輪資源。備份資料留 NAS，不上傳含會員資料的 dump 作為 Actions artifact；artifact 只留去識別驗證摘要。若無適用備份，將 PG 備份接入既有 predeploy 流程；不是新增第四條部署路徑。指定保留既有 PG schema 相容性的 rollback image，不自動把舊 SQLite-only image 當成可回版。

## 搜尋效能的可比性

6703302→92e8210：fixture 全域 i 公式、120k 筆數、完成後 ANALYZE、Node/PG image ID 相同；18 筆已保存的計畫根摘要一致，部分估計成本小幅變動。並未保存完整 plan tree，不能排除細節差異。
三輪查詢往返仍為單區 88／全區 96，transactionStatements=4；不能將 crawler 的交易包裝直接等同搜尋增加交易。
另一個未隔離變因是 runner 資源取樣從長連線串流改為每次 docker stats --no-stream 後 sleep 2；可能有額外診斷負擔，尚未做因果驗證。
因此保留原始成績與 FAIL，不將退步歸因於 fixture、程式或主機負載任何單一因素；也不反覆加入純效能優化。
