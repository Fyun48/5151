# 5151 Shadow HA — PostgreSQL Primary/Standby + HAProxy

Shadow 環境（Phase 19）。與正式 v3 / 5151-ops 完全隔離：獨立 container name、
獨立 port、獨立 volume、獨立 database。**不切換、不停任何正式 container。**

> **⚠️ 現況（2026-10-09）——「Shadow」是歷史命名，內容已是正式站業務庫**：
> - 庫名仍叫 `5151_shadow`，但它是**正式站的業務庫**。2026-10-09 起 primary = CasaOS
>   `5151-postgres-A`（NVMe `/mnt/Storage1`，`rotational=0`），Synology `5151-postgres-B`
>   重建成 hot standby（HDD 卷），不是與正式站隔離的影子站。
> - 兩台各有自己的 HAProxy：CasaOS `5151-haproxy`、Synology `5151-haproxy-B`
>   （下方「實際佈署只有 CasaOS 一台」那句已過時；拓撲見 `web/README.md`）。
> - 容器 `5151-crawler` 已 Exited；實際在跑的爬蟲是 `591-tracker-v3`。

## 網路拓撲（兩台 NAS 同一內網）

```
CasaOS  192.168.0.140 (CASAOS_HOST)
└─ 5151-postgres-A   **Primary（預設，2026-10-09 起）** host 0.0.0.0:15432 -> 5432
└─ 5151-web-A        APP_ROLE=web host 0.0.0.0:15153 -> 5153（HAProxy 的 web backend）

Synology 192.168.0.220 (SYNOLOGY_HOST)
└─ 5151-postgres-B   Hot Standby  host 0.0.0.0:15432 -> 5432（只讀；不可寫）
└─ 5151-web-B        APP_ROLE=web host 0.0.0.0:15153 -> 5153

5151-haproxy（CasaOS）
└─ host 0.0.0.0:25433 (postgres-rw) / 0.0.0.0:25434 (postgres-ro)
└─ host 0.0.0.0:25153 -> container 15153 (web)
```

- **預設 primary 在 CasaOS**（`5151-postgres-A`，NVMe）；Synology（`5151-postgres-B`）是 hot standby。
  （2026-09-20 由 A→B 定案；**2026-10-09 又走了一次 B→A**。程序見
  `docs/runbooks/postgres-manual-failover.md`；實測記錄見 `evidence/runtime-modernization/HA-CUTOVER-20261009.md`。）
- 角色是**狀態**不是設定：promote 之後兩個節點的資料目錄各自記住自己的角色，
  `docker restart` 不會改變角色；要換回來得再走一次 failover。
- **2026-10-09 換方向的動機是「磁碟」，不是容錯**：Synology 的資料卷是 HDD，且當晚正在跑
  `btrfs scrub`（已跑 5.8 小時），`1k + fsync` 實測 327–670ms、`32MB + fsync` 0.87–1.42s，
  app 端出現 `slow commit 20485ms / 17527ms`、`pg_stat_activity` 抓到 `wait_event=WALSync`；
  CasaOS 是 NVMe，對照 `1k + fsync = 15ms`、`32MB = 169ms`。換完後新 primary 每筆 insert+commit
  （含 docker exec 開銷）**171–181ms**、tracker 重啟後 6 分鐘 `slow commit` 筆數 **0**、備份 53s→**41s**。
- 實際佈署只有 **CasaOS 一台** `5151-haproxy`（Synology 沒有第二份）。**（過時：2026-10-08 起兩台各有 HAProxy，Synology 是 `5151-haproxy-B`，見開頭「現況」與 `web/README.md`。）**
- web 對外埠是 **25153**（container 15153）：同一台的 Web-A 已經佔用主機 `15153`，
  HAProxy 若也綁 15153 會 `address already in use`。

- Primary 的 `15432` 需對 Standby 開放，供 streaming replication（現況：primary = CasaOS
  `CASAOS_HOST`、standby = Synology `SYNOLOGY_HOST`，所以 CasaOS 的 15432 要對 Synology 開）。
- 所有密碼一律走 env（`PG_SUPER_PASSWORD` / `PG_REPLICATION_PASSWORD`），不 commit 明文。
- 2026-09-21 起：`standby-basebackup` helper 的 `PG_REPLICATION_PASSWORD` 改由**同目錄 `.env`**
  （compose `env_file`）提供，compose 檔本身不再出現 password 形狀的字串（secret scanner 誤報來源）；
  inline 環境變數仍可覆寫；`.env` 不在版控內，缺檔時 compose 會直接失敗（fail-closed）。
- 兩節點**不啟用 automatic failover**（無 Witness）。promotion 一律手動（見
  `docs/runbooks/postgres-manual-failover.md`）。

## 目錄 / 節點 / 角色對照（角色會變，路徑不會）

| 角色 | 主機 | 節點（container / volume） | 目錄 |
|---|---|---|---|
| **Primary（預設，2026-10-09 起）** | CasaOS | `5151-postgres-A` / `5151-shadow-pg-a` | `postgres-primary/` |
| Hot Standby | Synology | `5151-postgres-B` / `5151-shadow-pg-b` | `postgres-standby/` |
| primary 端工具 | 在「當下的 primary」跑 | — | `postgres-primary/`（`setup-replication.sh`、`fix-pg-hba.sh`）|
| standby 端工具 | 在「當下的 standby」跑 | — | `postgres-standby/`（`setup-standby.sh`、`standby-basebackup`）|
| 備份 / 還原 / verify | 在「當下的 primary」跑 | `PG_CONTAINER` 預設 `5151-postgres-A`（primary 端；`verify-standby.sh` 預設 `5151-postgres-B`） | `backup/`、`verify-*.sh` |

> 目錄名沿用第一次 bootstrap 時的角色，之後**只有角色變、路徑不變**：兩份 compose 各自綁定
> 自己的節點與 volume（A = CasaOS、B = Synology），誰是 primary 由 promote / 重拉 base backup 決定。
> 2026-10-09 交回 CasaOS 後，目錄名與角色**恰好一致**（casa `postgres-primary/` = primary、
> syn `postgres-standby/` = standby），但 **volume 名仍帶歷史字樣**（「primary／standby」這些字是
> bootstrap 時的角色，不一定是現況）——判斷節點身分**依容器名／volume 名（`…-A`／`…-B`）**，不要看
> 目錄名；判斷「誰是 primary」最準的是直接查 `pg_is_in_recovery()`。
> 腳本（`setup-replication.sh`、`fix-pg-hba.sh`、`verify-*.sh`、`drill.sh`、`backup/*.sh`、
> `pg-indexes.sh`）的預設容器名已改成現行角色：primary 端（CasaOS）預設 `5151-postgres-A`、
> standby 端（Synology）預設 `5151-postgres-B`。仍可用 `CONTAINER` / `PG_CONTAINER` 覆寫。

> **Synology 的 PATH 陷阱**：`docker` / `docker-compose` 都在 `/usr/local/bin`，非登入 shell 不在 PATH，
> 直接打 `docker …` 會 `command not found`。用絕對路徑（`/usr/local/bin/docker compose …`）
> 或先 `export PATH=/usr/local/bin:$PATH`；repo 的腳本會自動解析（`DOCKER` 變數）。

## 套用（依序；預設目標：CasaOS = primary，2026-10-09 起）

### 1. CasaOS — 啟動 Primary（預設）

```bash
cd deploy/shadow-ha/postgres-primary          # 這個目錄 = CasaOS 節點（A）
SYNOLOGY_HOST=192.168.0.220 CASAOS_HOST=192.168.0.140 \
PG_SUPER_PASSWORD='<super>' \
"${DOCKER:-docker}" compose up -d
# primary 端工具在 postgres-primary/（工具與「角色」有關，與節點無關）
CONTAINER=5151-postgres-A PG_REPLICATION_PASSWORD='<repl>' bash setup-replication.sh
CONTAINER=5151-postgres-A bash fix-pg-hba.sh    # pg_hba：LAN + docker 網段（idempotent）+ reload
```

### 2. Synology — 建立 Hot Standby（從 CasaOS 拉）

```bash
cd deploy/shadow-ha/postgres-standby          # 這個目錄 = Synology 節點（B）
# 密碼由同目錄 .env 提供（PG_REPLICATION_PASSWORD=…）；要用 inline 覆寫也可以：
CASAOS_HOST=192.168.0.140 \
PG_REPLICATION_PASSWORD='<repl>' \
docker compose --profile setup run --rm standby-basebackup
docker compose up -d                          # 以 standby 模式啟動（standby.signal）
```

> 反向（把 primary 交回 Synology）只是角色對調，程序見
> `docs/runbooks/postgres-manual-failover.md` §8；`setup-standby.sh` 的 `PRIMARY_HOST` / `SLOT_NAME`
> 可覆寫來源與 slot 名稱（重建 B 時 `SLOT_NAME=standby_b`、`PRIMARY_HOST` 預設即 `192.168.0.140`）。
> 2026-10-09 走的方向是「CasaOS = primary」——動機是磁碟效能（HDD＋scrub）不是容錯，見本檔「網路拓撲」
> 與 `evidence/runtime-modernization/HA-CUTOVER-20261009.md`。

### 3. HAProxy（CasaOS；實際佈署只跑這一台）

```bash
cd deploy/shadow-ha/haproxy
CASAOS_HOST=192.168.0.140 SYNOLOGY_HOST=192.168.0.220 docker compose up -d
```

- `haproxy.cfg` 是 **template**：`${CASAOS_HOST}` / `${SYNOLOGY_HOST}` 由容器的
  `render-and-run.sh` 在啟動時用 sed 展開。docker compose 只會替換 compose YAML 內的
  `${...}`，**不會**替換掛載檔案的內容 —— 直接把 template 掛進去會讓 HAProxy 把
  `${CASAOS_HOST}` 當主機名解析而失敗。
- web backend 連的是各主機**已發佈**的 `15153`（容器內的 5153 只有本機可見）。

## 與實際佈署的校正（2026-09-20）

| 原本（repo） | 實際可用（live） | 症狀 |
|---|---|---|
| `httpchk GET /api/public/health` | `GET /api/health` | 端點不存在 → 404 → 兩個 web 節點全 DOWN |
| web backend `:5153` | `:15153` | 跨主機連不到 → connection refused → 節點 DOWN |
| haproxy web 埠 `15153:15153` | `25153:15153` | 與同機 Web-A 的主機 15153 衝突 → `compose up` 失敗 |
| web node `127.0.0.1:15153` | `0.0.0.0:15153` | 另一台的 HAProxy 連不到 loopback → 節點 DOWN |
| `${CASAOS_HOST}` 直接掛載 | `render-and-run.sh` 展開 | HAProxy 解析不到 `${...}` 主機名 |

驗證（throwaway 容器，不動 live）：修正後經 HAProxy 打 `/api/health` = `200`（`Loading success.`），
舊設定 = `000`。詳見 `evidence/runtime-modernization/STATUS.md`。

## 季度演練：`drill.sh`

把 2026-09-20 的 A4 演練固化成可重跑腳本（產出報告到 `drill-reports/`，報告內容可直接貼進 evidence）。

```bash
PG_CONTAINER=5151-postgres-B bash drill.sh preflight --expect-role primary          # 唯讀
PG_CONTAINER=5151-postgres-B PG_SUPER_PASSWORD='<super>' bash drill.sh preflight    # 加測 HAProxy pg-rw
PG_CONTAINER=5151-postgres-B bash drill.sh backup                                   # 唯讀備份 + 隔離還原
CONFIRM_FAILOVER=yes FENCED=yes PG_CONTAINER=5151-postgres-A bash drill.sh failover # 在「要 promote 的那台」跑
```

- `preflight`：角色（`pg_is_in_recovery()`）、replication 狀態、standby 的 WAL receive/replay 是否相等，
  以及可選的「經 HAProxy pg-rw 的角色」探測。**判斷落後只看 LSN 是否相等** ——
  `pg_last_xact_replay_timestamp()` 的差值在 primary 閒置時會很大（2026-09-20 實測 10213s）卻不代表落後。
- HAProxy 探測走 TCP，pg_hba 要求密碼（只有容器內 local socket 是 trust）→ 需要 `PG_SUPER_PASSWORD`；
  沒給會標 `probe skipped`（不是故障）。
- `backup`：`backup.sh`（pg_dump -Fc + sha256 manifest）→ `restore.sh`（隔離 DB `5151_restore_test`，先驗 sha256）。
- `failover`：**只做本機步驟**且需 `CONFIRM_FAILOVER=yes`；尚未 fence 舊 primary 時只印出 fence 指令就停住。
  promote 後印出 runbook §8 的 rejoin 指令（跨主機步驟一律人工；本腳本不做遠端 SSH、不自動 promotion）。
- 2026-09-20 實測（兩台主機）：Synology（primary B）`pg_is_in_recovery=f`、replication
  `172.21.0.1|streaming|async`；CasaOS（standby A）`t` 且 receive/replay 皆 `0/C02B900`（無落後）。


## 驗證

```bash
# Primary 端
docker exec 5151-postgres-A psql -U postgres -c "SELECT * FROM pg_stat_replication;"
# Standby 端（只讀）
docker exec 5151-postgres-B psql -U postgres -c "SELECT pg_is_in_recovery();"
```

- `pg_is_in_recovery()` = `t` 表示 Standby 正常追隨 Primary。
- 兩台同時寫入測試時，Standby 的寫入必須被拒絕（split-brain prevention）。

## 尚未做到（EXTERNAL_SETUP_REQUIRED / 後續）

- 實際在兩台 NAS 上 `docker compose up`（需 Owner 授權後執行，避免動到資源）。
- Cloudflare HA、Web active/active、crawler/worker shadow 另列於 STATUS.md。
