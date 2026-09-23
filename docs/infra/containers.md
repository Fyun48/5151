# 基礎設施與容器清單（專案內摘要）

> **完整版（跨專案共用）**：`/home/cline/INFRA-INVENTORY.md`（NAS：`…/cline-server/home/INFRA-INVENTORY.md`）。
> 本檔只放與 5151 直接相關、專案內的人需要知道的內容。
> **任何容器、compose、連接埠、掛載的變更，兩份都要同步更新。**
> 資料來源：`docker inspect`（每個容器「由哪個 compose 建立」是實查，不是推測）。

## 主機

| 代稱 | 機器 | 區網 IP | sshd 埠 | 登入者 | 用途 |
|---|---|---|---|---|---|
| casa-nas | CasaOS NAS | 192.168.0.140 | 54722 | root | 正式站容器、正式站 PostgreSQL、Cloudflare connectors、多數專案 |
| syn-nas | Synology NAS | 192.168.0.220 | 58722 | tori | 影子站 PostgreSQL（primary／standby）、Gitea（暫停）、code-server 與 cline-dev、備份 |

代理人可用金鑰免密碼登入：`ssh syn-nas`、`ssh casa-nas`。

## 容器（正式站與 A 組）

| 容器 | 由哪個 compose 建立 | 角色 | DB 模式 |
|---|---|---|---|
| `591-tracker-v3` | `/mnt/Storage1/apps/5151/docker-compose.yml` ＋ override | **正式站**（對外 `127.0.0.1:5153`） | **postgres** |
| `5151-ops` | 同上 | OPS Console（埠 5154） | 自己的 `/data`（無 PG 設定） |
| `591-tracker-tunnel` | 同上（profile `tunnel`） | Cloudflare Tunnel（host network） | — |
| `5151-postgres-A` | `/root/5151-shadow-ha/shadow-ha/postgres-primary/docker-compose.yml` | 正式站 PostgreSQL | — |
| `5151-haproxy` | `/opt/5151-shadow/haproxy/docker-compose.yml` | **A 組**入口（25153 網站／25433 PG） | — |
| `5151-web-A` | `/opt/5151-shadow/web-a/docker-compose.yml` | **A 組**網站 | **sqlite** |
| `5151-crawler` | **手動 `docker run`（沒有 compose）** | **A 組**爬蟲（與 web-a 共用 `/data`） | **sqlite** |

## 三個必須記住的事實

1. **正式站實際執行的程式碼來自掛載的原始碼。** compose 把 `./v3/src`、`./v3/public` 唯讀掛進容器，
   啟動指令是 `node --watch-path=src --watch-path=public src/server.js`，所以主機上的檔案一改、容器就跑新程式。
   映像 digest（由 `deploy-v3.yml` 產生的 override 鎖定）只決定「基底映像」，**擋不住掛載的原始碼**。
2. **OPS Console 與正式站共用同一張映像**，差別只在啟動指令與資料目錄；它的資料是容器自己的 `/data`，
   **與 v3 的 PostgreSQL 不是同一個庫**。
3. **A 組目前是 sqlite 模式**，且 `5151-crawler` 沒有 compose（手動建立）。
   因此**切換到 A 組之前必須先把還在用 SQLite 的路徑清完**，否則網站會改讀本機檔案。

## HA 與資料庫的權威文件（不要重寫）

| 問題 | 來源 |
|---|---|
| HA 演練與影子站整體說明 | `deploy/shadow-ha/README.md` |
| 演練流程（可重跑） | `deploy/shadow-ha/drill.sh` |
| 正式切換步驟（detect／verify／fence／inspect／promote／re-point／verify／rejoin） | `docs/runbooks/postgres-manual-failover.md` |
| 切換當天清單 | `docs/runbooks/postgres-cutover-day-checklist.md` |
| 備份與還原 | `docs/runbooks/postgres-backup-restore.md` |
| 首次建置與匯入 | `docs/runbooks/postgres-cutover-bootstrap.md` |

演練實測細節：`promote` 必須用 `-u postgres`（`docker exec` 預設是 root，`pg_ctl` 會拒絕以 root 執行）。

## 回復方式（雙軌）

1. **資料庫層**：照 `postgres-manual-failover.md` 切回原 primary，或把 standby 升為主並更新 HAProxy 後端。
2. **應用層**：把 NAS `/mnt/Storage1/apps/5151/.env` 的 `DB_DRIVER` 改回 `sqlite`，重建容器；
   驗證公開站首頁 200、`/api/health` 200、後台可登入；若程式也改過，記得把主機的 `v3/src` 退回對應版本。

## 共用副本

compose 與 HA 相關檔案的副本在 `/home/cline/infra-compose/`（目錄 700／檔案 600，共 16 個檔案）。
**正本一律在原處**（repo 或主機）；副本只用來查閱，改動要改正本再重抓。

