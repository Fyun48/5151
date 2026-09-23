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
| `591-tracker-v3` | `/mnt/Storage1/apps/5151/docker-compose.yml` ＋ override | 正式站容器（web `127.0.0.1:5153`／`5155`；爬蟲＋worker，`APP_ROLE` 未設＝all） | **postgres** |
| `5151-ops` | 同上 | OPS Console（埠 5154） | 自己的 `/data`（無 PG 設定） |
| `591-tracker-tunnel` | 同上（profile `tunnel`） | Cloudflare Tunnel（host network）。**公開站 ingress → `127.0.0.1:25153`（HAProxy）**、OPS → `127.0.0.1:5154` | — |
| `5151-postgres-B`（syn-nas） | `/root/5151-shadow-ha/shadow-ha/postgres-primary/docker-compose.yml` | **目前的 primary**（`pg_is_in_recovery=f`） | — |
| `5151-postgres-A`（casa-nas） | 同上的 standby compose | **目前的 hot standby**（`caught_up=t`） | — |
| `5151-haproxy` | `/opt/5151-shadow/haproxy/docker-compose.yml` | **A 組**入口（25153 網站／25433 PG `pg-rw`／25434 `pg_ro`） | — |
| `5151-web-A` | `/opt/5151-shadow/web-a/docker-compose.yml` | **A 組**網站（2026-09-23 起讀同一套 PG，且**已接手公開站流量**） | **postgres** |
| `5151-crawler` | **手動 `docker run`（沒有 compose）** | **A 組**爬蟲（與 web-a 共用 `/data`，仍寫本機 SQLite） | **sqlite** |

> **2026-09-23 HA 切換（A 組）**：`5151-web-A` 的 image 改成與正式站同一顆 digest
> （`ghcr.io/fyun48/5151@sha256:43bd376c…`，內建 `src` 與正式站主機掛載的 `src` 逐檔相同），
> 加上 `DB_DRIVER=postgres`、`PG_URL=…@192.168.0.140:25433/5151_shadow`（HAProxy `pg-rw`），
> 並把 `SESSION_SECRET` 對齊正式站、複製一份正式站的 `/data/auth.env`（SMTP／OAuth／管理員帳號）
> 到 A 組的 `/data/auth.env`，讓兩個節點行為一致。
> 最後在 Cloudflare 後台把公開站的 ingress 由 `http://127.0.0.1:5155` 改成 `http://127.0.0.1:25153`。
> compose 備份：同一目錄的 `docker-compose.yml.bak-20260923T*`、`…bak-seq-…`；
> tunnel 設定的備份在 `/home/cline/infra-compose/cloudflare/`。
> `5151-crawler` 刻意留在 SQLite（它是 A 組 SQLite 的保鮮來源＝回復路徑），**不要一起切**。
> A 組的 `APP_ROLE=web`（只跑 HTTP），爬蟲與 worker 仍在正式站容器（`APP_ROLE` 未設＝all）。
>
> **發版路徑（P0，2026-09-23）**：A 組的 image 由 `/opt/5151-shadow/web-a/.env` 的 `V3_IMAGE` 注入
> （compose 寫 `image: ${V3_IMAGE:-<目前 digest>}`），而 `deploy-v3.yml` 在重建正式站之後**會用同一顆
> digest 重建 web-A**（新步驟 `Recreate A-group web node with the same digest`，成功訊息 `DEPLOY_A_GROUP_OK`）。
> 所以公開站（在 web-A）會跟著發版更新。
> ⚠️ **web-B 在 syn-nas，發版流程的 SSH 通道只到 casa-nas**（Cloudflare Access bridge，沒有 syn-nas 的
> secret）→ web-B 的更新目前是**手動**：把同一顆 digest 寫進它的 `.env` 後重建（見 P1 章節的指令）。

## 三個必須記住的事實

1. **正式站實際執行的程式碼來自掛載的原始碼。** compose 把 `./v3/src`、`./v3/public` 唯讀掛進容器，
   啟動指令是 `node --watch-path=src --watch-path=public src/server.js`，所以主機上的檔案一改、容器就跑新程式。
   映像 digest（由 `deploy-v3.yml` 產生的 override 鎖定）只決定「基底映像」，**擋不住掛載的原始碼**。
2. **OPS Console 與正式站共用同一張映像**，差別只在啟動指令與資料目錄；它的資料是容器自己的 `/data`，
   **與 v3 的 PostgreSQL 不是同一個庫**。
3. **公開站自 2026-09-23 起由 A 組（`5151-web-A`）服務**（tunnel → HAProxy `25153` → web-A → PG）。
   A 組**不掛主機原始碼**：程式來自 image，所以「A 組的程式版本」由 compose 的 image digest 決定，
   與正式站（掛載主機原始碼）是兩條更新路徑——要換 A 組程式就得改 digest 並重建。
   `5151-crawler` 沒有 compose（手動建立）且仍是 SQLite。

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

