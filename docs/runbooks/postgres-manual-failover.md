# PostgreSQL Manual Failover Runbook（Shadow）

適用兩節點（CasaOS Primary + Synology Hot Standby）、**無 Witness** 的環境。
依 section 14，**禁止自動 promotion**。任何 failover 都走人工流程，且必須先防 split-brain。

## 原則

- 只有「確認舊 primary 真的無法存取」後才 promote standby。
- 網路 partition ≠ primary 故障；兩邊都活著時**絕不**兩邊都變 writable。
- 每一步都先驗證，再進入下一步。

## 名詞

- 本 cluster 自 2026-10-09 起**預設 primary = CasaOS**（`5151-postgres-A`，`CASAOS_HOST:15432`），
  預設 standby = Synology（`5151-postgres-B`，`SYNOLOGY_HOST:15432`）。流程本身對稱。
  （2026-09-20 曾把預設 primary 改到 Synology；2026-10-09 因磁碟效能把 primary 交回 CasaOS 的 NVMe、
  Synology 重建成 hot standby，見 `evidence/runtime-modernization/HA-CUTOVER-20261009.md`。）
- `P` = 當下的 primary（預設 CasaOS）
- `S` = 當下的 standby（預設 Synology）
- 連線一律用 `docker exec`（shadow container），不碰正式 DB。

> ⚠️ 下面 §1–§8 的**範例指令是照「CasaOS（primary）→ Synology（standby）」方向寫的**，也就是
> 2026-10-09 交回 CasaOS 之後的**預設方向**（2026-09-20 drill 與 2026-10-09 cutover 都逐步實測過）。
> 要按反方向（Synology → CasaOS）操作時，把範例中的
> `5151-postgres-A` ↔ `5151-postgres-B`、`CASAOS_HOST` ↔ `SYNOLOGY_HOST` 對調即可；
> 兩個方向都跑過（見 `evidence/runtime-modernization/A4-HA-DRILL-20260920.md` 與
> `evidence/runtime-modernization/HA-CUTOVER-20261009.md`）。

> 演練可改用 `deploy/shadow-ha/drill.sh`（`preflight` / `failover`；`failover` 需 `CONFIRM_FAILOVER=yes`，
> 且它只做本機步驟、跨主機一律人工）。**下列步驟仍是唯一權威來源**，腳本只是把已實測過的步驟自動化。

## 流程

### 1. detect — 確認 P 狀態

```bash
# 從 S（或任一可達主機）ping P 的 15432
docker exec 5151-postgres-B psql -U postgres -h "$CASAOS_HOST" -p 15432 \
  -c "SELECT 1"   # 預期：連不上 / timeout
```

### 2. verify — 確認 P 真的不可用（不是只有這台斷線）

```bash
# 從第三點（例如 CasaOS 本機 loopback）再測一次，排除「只有 S 網路斷」
docker exec 5151-postgres-A psql -U postgres -c "SELECT pg_is_in_recovery();"
```

若 P 仍可寫入（`pg_is_in_recovery()` = `f`），**停止**，這是 split-brain 前兆。

### 3. fence — 隔離舊 primary

```bash
# 確保 P 不再接受寫入。最安全是停掉 container（人工確認後）：
docker stop 5151-postgres-A
```

### 4. inspect — 檢查 replication lag

```bash
# 在 S 上檢查是否已追到 P 的最後 WAL
docker exec 5151-postgres-B psql -U postgres \
  -c "SELECT pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn(), pg_is_in_recovery();"
```

若 lag 很大，評估是否等待或接受資料遺失（RPO）。

### 5. promote — 手動升格 standby

```bash
# 一定要 -u postgres：docker exec 預設是 root，pg_ctl 會直接拒絕
# （2026-09-20 drill 實測：`pg_ctl: cannot be run as root`）。
docker exec -u postgres 5151-postgres-B pg_ctl promote -D /var/lib/postgresql/data/pgdata
# 或直接跑（psql 走容器內 local socket trust，不受 root 影響）：
docker exec 5151-postgres-B psql -U postgres -c "SELECT pg_promote();"
```

驗證 S 已變成 primary：

```bash
docker exec 5151-postgres-B psql -U postgres -c "SELECT pg_is_in_recovery();"  # 預期 f
```

### 6. re-point — 更新 router

> **2026-10-12 起：正常 failover 不需要改 `haproxy.cfg`。** `backend pg_primary` 是
> `balance first` ＋ 兩條 `server pg-* … agent-check agent-port 25436 agent-inter 2s`，
> 角色由每個節點上的 pg-agent 判定（`25436`＝up-if-primary、`25437`＝up-if-standby），
> **不靠 server 先後順序**，`pg-b` 也**刻意不帶 `backup`**（見下方注意事項 2）。
> 設定已逐字同步在 `deploy/shadow-ha/haproxy/haproxy.cfg`（repo 檔＝兩台現行檔，差異 0）。

- **舊 primary 停機**（fence 後尚未回來）：`pg_primary/pg-a` 會 DOWN，但 promote 之前**沒有**任何節點
  自稱 primary ⇒ `balance first` 沒有可用後端，`pg-rw`（25433）**連線直接失敗**（fail-closed，
  不會把寫入送到待命庫，這是設計）。
- **在新 primary 完成 promote 後**：agent 會自己回 `up` ⇒ `pg-rw` 自動恢復，**不必改設定、不必 reload**。
  驗證＝經 `25433` 查 `pg_is_in_recovery()` 應回 `f`；stats 頁（宿主 `127.0.0.1:25154`）的
  `pg_primary` 應是 promote 那台 `UP`、另一台 `DOWN (agent)`。

**只有 agent 本身故障才需要人工介入**（例如兩台 agent 都回 down、`pg-rw` 全滅）。介入一律走
`docs/runbooks/haproxy-web-weight.md` 的流程：**在 NAS 宿主就地改寫**（單檔 bind mount 綁 inode）
→ 容器內 `haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg` → `kill -s USR2 1`：

```bash
docker exec 5151-haproxy haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg && \
docker exec 5151-haproxy kill -s USR2 1
```

**不准把 `backup` 加回 `pg-b`**（那會讓待命庫在沒有任何 primary 時接到寫入）；改完務必把變更
逐字同步回 repo 檔，否則 repo 鏡像會與正式機漂移。

應用程式 DB router 亦依 `pg_is_in_recovery()` 自動辨識新 primary（read-after-write 打 primary）。

> ⚠️ **2026-09-23 演練 + 2026-10-09 cutover 實測的必讀事項**
>
> 1. **`haproxy.cfg` 只能用「就地改寫」**：compose 是把 `./haproxy.cfg` 以**單檔 bind mount** 掛進容器
>    （`:ro`，所以也**不能**從容器內改檔），而 bind mount 綁的是 inode。若用
>    `awk … > f.new && mv f.new f`／`sed -i`（或任何會換 inode 的編輯器）改設定，
>    **容器仍看到舊檔**，reload 也只會重載舊設定；連容器內 `haproxy -c -f …` 驗證到的都是舊內容
>    （症狀：改了順序卻完全沒生效，pg-rw 繼續打到舊 primary）。請用會**改同一個 inode** 的方式
>    （例如宿主上 python `open(path,'w')` 覆寫），或重建容器
>    （`docker compose -f /opt/5151-shadow/haproxy/docker-compose.yml up -d --force-recreate`）。
>    2026-10-12 已實查：兩台都**沒有** `.cfg.tmpl`／`render-and-run.sh`／`/tmp/haproxy.cfg`，
>    `-f` 指的就是這個被掛進去的 `haproxy.cfg`。
> 2. **角色判定看 agent-check，不看順序**：`option pgsql-check` 只確認「這個 PG 接受連線」，
>    分不出 primary／standby；分得出的是每個節點的 pg-agent（`agent-check agent-port 25436`）。
>    所以 promote 後**不必**改設定、也不必把 server 行對調。若 agent 故障（回報與實際角色不符），
>    才可能把寫入導到唯讀節點（症狀 `cannot execute … in a read-only transaction`），
>    這時照上面的「人工介入」流程處理，**不要**用「加回 `backup`」或「手動排序」當解法。
>
> 3. **應用端寫入是 fail-closed（2026-09-23 起）**：PG 模式的寫入失敗**不會再悄悄落回本機 SQLite**，
>    而是直接把錯誤往上丟（使用者看到 5xx／「儲存失敗」）。演練時這代表「promote 沒做完＝寫入全滅」，
>    但不會產生無聲的資料分歧；讀取仍維持 fail-open（回舊資料）。真的需要「先讓站活著」時才設
>    `PG_SQLITE_FALLBACK=open`（寫入也回退），用完立刻關掉。
>
> 4. **`haproxy.cfg` 有兩個 backend 都列 `pg-a`／`pg-b`，別用整檔字串比對判斷「是否已對調」**：
>    `backend pg_primary`（pg-rw 用）與 `backend pg_standby_first`（pg-ro 用）
>    都列出兩台。2026-10-09 cutover 第一次核對時，就因為在 `pg_standby_first`
>    命中「pg-a 在前」而誤以為已對調、跳過。**改動／核對要限定在你要改的那個 block 內**。
>    現在的狀態（2026-10-12 起兩個池都不再靠排序）：
>    * `pg_primary`：`balance first` ＋ 兩條 `agent-check agent-port 25436`、`pg-b` **不帶 `backup`**
>      ⇒ 角色由 responder 判定（**這個 block 是寫入路由核心，一個字都不准亂動**）。
>    * `pg_standby_first`：**2026-10-12 起也吃 agent-check，埠是 25437（up-if-standby）**，
>      兩條都**不帶 `backup`** ⇒ 只有自報待機的那台 UP，promote 後讀取自動跟隨；
>      兩池的 agent 埠**不可相同**（25436 給寫入、25437 給讀取）。看到讀取池兩台都 UP
>      ＝ 有人把 25436 抄過來、或把 agent-check 拿掉了，要當異常。
>      就地改寫／reload／驗收程序見 `docs/runbooks/haproxy-web-weight.md` §2.4。
>
> 另外（2026-10-09 對調後）：**compose 目錄名稱與角色已一致**——
> primary 的 compose 在 casa-nas `/root/5151-shadow-ha/shadow-ha/postgres-primary/`（容器 `5151-postgres-A`）、
> standby 的在 syn-nas `~/5151-shadow-ha/shadow-ha/postgres-standby/`（容器 `5151-postgres-B`）。
> 但 **volume 名稱仍帶歷史字樣**（「primary／standby」這些字是第一次 bootstrap 時的角色，不一定是現況），
> 目錄名也可能再隨下次 failover 變得不一致。重建節點時依 **容器名稱（`…-A`／`…-B`）與 volume 名稱**判斷
> 節點身分，不要看目錄名；要確認「誰是 primary」最準的是直接查 `pg_is_in_recovery()`。

### 7. verify — 驗證新 primary 可寫

```bash
docker exec 5151-postgres-B psql -U postgres -d 5151_shadow -c "CREATE TABLE failover_check(id int); DROP TABLE failover_check;"
```

### 8. rejoin — 舊 primary 回來後重建為 standby

舊 P 重新可達後，**不要直接啟動**（否則兩個 primary 併存）。以下兩個方向都實測可行
（方向一 = 2026-09-20 drill；方向二 = 2026-10-09 cutover 實走）。

**方向一：promote B（Synology）、重建 A（CasaOS）**

```bash
# 1) 在「新 primary」B 上為被重建的 A 建 slot（名字要與下面 SLOT_NAME 一致）
docker exec -u postgres 5151-postgres-B psql -U postgres \
  -c "SELECT pg_create_physical_replication_slot('standby_a');"   # 舊 primary = A

# 2) fence 舊節點（避免邊跑邊被覆蓋）
docker stop 5151-postgres-A

# 3) 用 A 自己的 volume 重拉 base backup（PRIMARY_HOST = 新 primary B）
docker run --rm -u postgres \
  -v 5151-shadow-pg-primary_5151-shadow-pg-a:/var/lib/postgresql/data \
  -e PRIMARY_HOST=192.168.0.220 -e SLOT_NAME=standby_a \
  -e PG_REPLICATION_PASSWORD='<repl>' -e PGDATA=/var/lib/postgresql/data/pgdata \
  -v "$PWD/setup-standby.sh:/setup-standby.sh:ro" \
  --entrypoint /bin/sh postgres:16-alpine -c '. /setup-standby.sh'

# 4) 啟動 A（standby.signal + primary_conninfo 已寫好）
docker start 5151-postgres-A
```

**方向二：promote A（CasaOS）、重建 B（Synology）——2026-10-09 cutover 實走**

```bash
# 1) 在「新 primary」A 上為被重建的 B 建 slot
docker exec -u postgres 5151-postgres-A psql -U postgres \
  -c "SELECT pg_create_physical_replication_slot('standby_b');"   # 舊 primary = B

# 2) fence 舊節點
docker stop 5151-postgres-B

# 3) 用 B 自己的 volume 重拉 base backup（PRIMARY_HOST = 新 primary A；
#    postgres-standby/ 的 compose 與 setup-standby.sh 預設就是 CasaOS 192.168.0.140）
docker run --rm -u postgres \
  -v 5151-shadow-pg-standby_5151-shadow-pg-b:/var/lib/postgresql/data \
  -e PRIMARY_HOST=192.168.0.140 -e SLOT_NAME=standby_b \
  -e PG_REPLICATION_PASSWORD='<repl>' -e PGDATA=/var/lib/postgresql/data/pgdata \
  -v "$PWD/setup-standby.sh:/setup-standby.sh:ro" \
  --entrypoint /bin/sh postgres:16-alpine -c '. /setup-standby.sh'

# 4) 啟動 B（standby.signal + primary_conninfo 已寫好）
docker start 5151-postgres-B
```

- 第 3 步若出現 `no pg_hba.conf entry for replication connection from host "172.21.0.1"`，
  表示 pg_hba 少了 docker 私有網段（peer 主機上的容器經 docker-proxy，來源會變 bridge gateway）。
  用 `deploy/shadow-ha/postgres-primary/fix-pg-hba.sh` 補（`CONTAINER=<new primary>`），兩段都仍要密碼。
- 兩個方向（promote B 重建 A、promote A 重建 B）都實測過；drill 的 **RPO = 0、RTO ≈ 5–17s**
  （見 `evidence/runtime-modernization/A4-HA-DRILL-20260920.md`）；2026-10-09 的正式切換是
  「停寫入端 → 站體回 200 約 9 分鐘、公網中斷約 2 分鐘」
  （見 `evidence/runtime-modernization/HA-CUTOVER-20261009.md`）。
- 腳本已加 `DOCKER`（Synology 的 docker 在 `/usr/local/bin`）與 `PG_CONTAINER` 覆寫，
  failover 後不論在哪一台主機都能執行。

## Split-brain prevention 重點

- 舊 primary 被 fence 前，**不** promote standby。
- 若兩邊都曾寫入，以「新 primary（被 promote 的那台）」為準，舊 primary 一律重拉。
- 全程不依賴自動化；不啟用 `repmgr` / `Patroni` 自動升格（未來有第三 Witness 才評估）。

## PG 記憶體參數變更與 `shm_size`（2026-10-11 實測）

### 現行值（兩台刻意不同，不要調成一樣）

| 節點 | 主機 | 角色 | RAM | 可用 | `shm_size` | `shared_buffers` | `work_mem` |
|---|---|---|---|---|---|---|---|
| `5151-postgres-A` | casa-nas | primary | 7.6 GB | ~4.5 GB | `2147483648`（2 GiB） | `1GB` | `8MB` |
| `5151-postgres-B` | syn-nas | hot standby | 32 GB | ~19 GB | `3221225472`（3 GiB） | `2GB` | `16MB` |

- 值按各自實體 RAM 給（7.6GB vs 32GB），**不是打錯**。
- 兩台都啟用 `shared_preload_libraries=pg_stat_statements`、`pg_stat_statements.track=top`；
  `5151-postgres-B` 原本沒有 `command:` 段，2026-10-11 才整段補上（含 `hot_standby=on`）。
- `pg_stat_statements` 在 standby 是**跟著 WAL 複製過來的**，**不要**在 standby 再 `CREATE EXTENSION`。

### 坑：Docker 預設 `/dev/shm` 只有 64MB —— 症狀不是「PG 起不來」

`shm_size` 沒放大時 **PG 還是起得來**：2026-10-11 用 throwaway 容器實測
`--shm-size=64m` ＋ `shared_buffers=512MB` 照樣 `database system is ready to accept connections`
（PG 的主共享記憶體走 anonymous mmap，**不經過** `/dev/shm`），所以 startup 不會失敗、log 沒有異狀。
會炸的是 **dynamic shared memory**：PG 16 預設 `dynamic_shared_memory_type=posix`，用的就是
`/dev/shm`；並行查詢（parallel hash join 等）會直接失敗：

```text
ERROR:  could not resize shared memory segment "/PostgreSQL.1594758946" to 16777216 bytes: No space left on device
```

這個症狀平時不出現（要有並行查詢才踩到），事後很難查，所以**調大 `shared_buffers` / `work_mem`
時就一起把 `shm_size` 調大**。

> 兩份 compose 裡那句註解「Docker 預設 shm_size=64MB 會卡住 shared_buffers=1GB（PG 起不來）」
> 是**照 NAS 原文逐字同步過來的**（2026-10-11 機上手改的內容，不改一字）。
> 症狀請以上面實測的為準：**起得來**，炸的是並行查詢的 dynamic shared memory。

重跑（throwaway 容器；不掛 volume、不開 port、不碰 live 資料）：

```bash
docker run --rm --shm-size=64m --network none -e POSTGRES_HOST_AUTH_METHOD=trust \
  postgres:16-alpine sh -c 'df -h /dev/shm | tail -1'
# => shm  64.0M  0  64.0M  0% /dev/shm        ← Docker 預設值
```

### 調參＝要重建容器：用 `docker compose up -d`，並比對 image id

- 改 `command:` / `shm_size` 都要**重建容器**：在各自的 compose 目錄跑 `docker compose up -d`。
  **不要**用 `docker restart` —— 它不會重新讀 compose，改了等於沒改。
- 重建前後**必須比對 image id**，確認只是重啟、沒有換版：
  ```bash
  docker inspect -f '{{.Image}}' 5151-postgres-A    # primary（casa-nas）
  /usr/local/bin/docker inspect -f '{{.Image}}' 5151-postgres-B   # standby（syn-nas，docker 在 /usr/local/bin）
  ```
  2026-10-11 重建前後兩台都是 `sha256:de3a4eab8fdfa507ea92aac488b916b08089e515db49b055fe71dfa271ba3a28`
  （＝ `sha256:de3a4eab8fdf…`，同一個版本，沒有換版）。
- `postgres:16-alpine` **尚未釘 digest**：這是**刻意保留的待辦，不是遺漏**。
  要釘之前得先確認重建立會換版、並走一次 standby 重建流程；**不要在別的 PR 順手釘**。

### 2026-10-11 重建後實測

- primary `5151-postgres-A` 約 5 秒就緒、standby `5151-postgres-B` 約 10 秒就緒。
- replication slot `standby_b`、`wal_archive` 皆 `active=true`、`replay_lag=0.07s`。
- 逐表列數兩側一致：`listings=186,359`、`listing_search_projection=186,359`、
  `listing_group_members=92,713`、`users=28`。
- 機上回滾檔：兩台各自 compose 目錄下的 `docker-compose.yml.bak-20261011`。
- 註：這兩個 compose 目錄**不是 git checkout（是純目錄）**，機上改了 repo 不會知道；
  2026-10-11 已把機上手改內容逐字同步回 repo，之後**以 repo 版為權威**。

