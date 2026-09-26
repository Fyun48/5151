# 雙 NAS 唯讀實測：36245519847

採證時間：2026-09-26 21:32:51–52 Asia/Taipei。
[Actions run](https://github.com/Fyun48/5151/actions/runs/36245519847) 的兩個 inventory jobs 成功。
Workflow SHA：`08706e30aa6bf5eb88968aac897a089f27790ab1`。兩份 raw artifact 原樣保存。

ZIP digest 與 GitHub metadata 核對相符：
- Casa artifact 10907695620：`5dcbd8cfd06097d3bef63da1b1df907a5ffcd7f371ea32610568abcc871de8d0`
- Syn artifact 10906144901：`59bce58a6c6fe1ab8529f241cfb0227c6a38dc8869018d0543f23e29a04e9dc2`

## 已確認

| 項目 | 實測 |
|---|---|
| CasaOS | ubuntucasaos、Docker 28.0.1 |
| Synology | TORI_NAS01、Docker 24.0.2 |
| 三個應用 | 591-tracker-v3、5151-web-A、5151-web-B 都 running，DB_DRIVER=postgres |
| 應用版本 | 映像 ID 都是 a47285c6…；六個受查程式 hash 全部一致且等於 GitHub 9c6b7b0。不能延伸為所有檔案／掛載／資料均一致 |
| PG primary | Synology 5151-postgres-B，16.14、recovery=false |
| PG standby | CasaOS 5151-postgres-A，16.14、recovery=true，receiver streaming |
| 複寫 | primary 所見 streaming／async；write 0.944 ms、flush 4.525 ms、replay 4.818 ms（單次觀測，不是 RPO 上限） |
| WAL 封存 | primary archive_mode=off；standby archive_mode=on，但兩者 archived_count=0、last_archived_time=null |
| 舊 crawler | CasaOS 5151-crawler exited，因此其 app_observation=NOT_RUN 是預期，不能說所有採證子項 PASS |

六檔為 server.js、watcher.js、crawlWatchdog.js、crawlPolicy.js、db.js、coveringBookkeepingAsync.js。
#497 候選版的 server.js／db.js hash 與正式機不同；這再次確認 PR-B 搜尋修正尚未部署。

## 上線判斷

通道、主備角色與串流複寫已用本次實機證據確認，不再列成「無 NAS 證據」。
但這不是完整 HA、備份還原或爬蟲正確性驗收：

- DB_DRIVER=postgres 不能證明所有業務入口零 SQLite。
- 三節點六檔一致不能證明跨節點登入／寫後讀／媒體一致。
- asynchronous streaming 不能保證已確認寫入零遺失；synchronous_commit=on 且 synchronous_standby_names 空白不能稱同步備援。
- standby archive_mode=on 且成功封存數為 0，不能當作主庫已啟用 WAL 歷史封存。
- 本次未盤點既有備份檔，所以不能斷言「沒有任何備份」；只能說未取得可還原備份／PITR 的驗證。
- 工作流程未執行 failover、promotion、備份還原、跨節點 CRUD 或正式來源爬蟲抽驗。

搜尋效能仍依 Owner 最新裁決接受取捨；上線仍需爬蟲正確性、啟用功能跨節點一致與可復原性。
不新開 tunnel、不部署、不修改正式資料。ChatGPT 可讀取此次產物，不等於取得互動 SSH 或 workflow_dispatch 能力。
