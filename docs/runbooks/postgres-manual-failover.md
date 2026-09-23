# PostgreSQL Manual Failover Runbook（Shadow）

適用兩節點（CasaOS Primary + Synology Hot Standby）、**無 Witness** 的環境。
依 section 14，**禁止自動 promotion**。任何 failover 都走人工流程，且必須先防 split-brain。

## 原則

- 只有「確認舊 primary 真的無法存取」後才 promote standby。
- 網路 partition ≠ primary 故障；兩邊都活著時**絕不**兩邊都變 writable。
- 每一步都先驗證，再進入下一步。

## 名詞

- 本 cluster 自 2026-09-20 起**預設 primary = Synology**（`5151-postgres-B`，`SYNOLOGY_HOST:15432`），
  預設 standby = CasaOS（`5151-postgres-A`，`CASAOS_HOST:15432`）。流程本身對稱。
- `P` = 當下的 primary（預設 Synology）
- `S` = 當下的 standby（預設 CasaOS）
- 連線一律用 `docker exec`（shadow container），不碰正式 DB。

> ⚠️ 下面 §1–§8 的**範例指令是照「CasaOS → Synology」方向寫的**（2026-09-20 drill 逐步實測過，
> 那次 CasaOS 是 primary）。要按預設方向（Synology → CasaOS）操作時，把範例中的
> `5151-postgres-A` ↔ `5151-postgres-B`、`CASAOS_HOST` ↔ `SYNOLOGY_HOST` 對調即可；
> 兩個方向 drill 都跑過（見 `evidence/runtime-modernization/A4-HA-DRILL-20260920.md`）。

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

實測結論（2026-09-20 drill）分兩種情況，**不能只記一種**：

- **舊 primary 還停機**（fence 後尚未回來）：**不需要**動設定。HAProxy 會在 `fall 3 × inter 3s`
  後自動把 pg-rw 轉到標成 `backup` 的那台（drill 實測：經 `25433` 查 `pg_is_in_recovery()` = `f`）。
- **舊 primary 已回來變成 standby**：**必須**把 `pg_primary` 的順序對調並 reload，否則 pg-rw 會照舊順序
  打到「已降級成唯讀」的節點（2026-09-20 實測踩到：`pg_is_in_recovery()` 回 `t`、寫入會失敗）。

本 cluster 預設 primary = Synology，`haproxy.cfg` 已按此排列（`pg-b` 在前）；若把 primary 交回 CasaOS，
要把 `pg-a` 排回前面。重新載入：

```bash
docker exec 5151-haproxy haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg && \
docker exec 5151-haproxy kill -s HUP 1
```

應用程式 DB router 亦依 `pg_is_in_recovery()` 自動辨識新 primary（read-after-write 打 primary）。

> ⚠️ **2026-09-23 演練實測的兩個必讀事項**
>
> 1. **`haproxy.cfg` 只能用「就地改寫」**：compose 是把 `./haproxy.cfg` 以**單檔 bind mount** 掛進容器，
>    而 bind mount 綁的是 inode。若用 `awk … > f.new && mv f.new f`（或任何會換 inode 的編輯器）改設定，
>    **容器仍看到舊檔**，`kill -HUP` 也只會重載舊設定；連容器內 `haproxy -c -f …` 驗證到的都是舊內容
>    （症狀：改了順序卻完全沒生效，pg-rw 繼續打到舊 primary）。請用會**改同一個 inode**的方式
>    （例如 python `open(path,'w')` 覆寫、`printf … > file` 也同 inode），或重建容器
>    （`docker compose -f /opt/5151-shadow/haproxy/docker-compose.yml up -d --force-recreate`）。
> 2. **`option pgsql-check` 不會分辨 primary／standby**：它只確認「這個 PG 接受連線」，
>    所以 promote 之後若沒同步這裡的順序，pg-rw 會照舊順序打到已降級成唯讀的節點，
>    應用端會出現 `cannot execute … in a read-only transaction`（寫入全數失敗）。順序＝正確性，不是最佳化。
>
> 另外：**兩個 compose 目錄名稱與實際角色是相反的**——
> primary 的 compose 在 `~/5151-shadow-ha/shadow-ha/postgres-standby/`（syn-nas，容器 `5151-postgres-B`）、
> standby 的在 `/root/5151-shadow-ha/shadow-ha/postgres-primary/`（casa-nas，容器 `5151-postgres-A`）；
> volume 名稱同理（`…pg-primary_…pg-a` 目前裝的是 standby）。重建節點時依 **容器名稱與 volume 名稱**判斷，
> 不要看目錄名。

### 7. verify — 驗證新 primary 可寫

```bash
docker exec 5151-postgres-B psql -U postgres -d 5151_shadow -c "CREATE TABLE failover_check(id int); DROP TABLE failover_check;"
```

### 8. rejoin — 舊 primary 回來後重建為 standby

舊 P 重新可達後，**不要直接啟動**（否則兩個 primary 併存）。以下步驟為 2026-09-20 drill 實測可行版本：

```bash
# 1) 在「新 primary」上為被重建的節點建 slot（名字要與下面 SLOT_NAME 一致）
docker exec -u postgres 5151-postgres-B psql -U postgres \
  -c "SELECT pg_create_physical_replication_slot('standby_a');"   # 舊 primary = A

# 2) fence 舊節點（避免邊跑邊被覆蓋）
docker stop 5151-postgres-A

# 3) 用「被重建節點自己的 volume」重拉 base backup
#    （standby compose 掛的是 5151-shadow-pg-b；重建 A 必須換成 A 的 volume）
docker run --rm -u postgres \
  -v 5151-shadow-pg-primary_5151-shadow-pg-a:/var/lib/postgresql/data \
  -e PRIMARY_HOST=192.168.0.220 -e SLOT_NAME=standby_a \
  -e PG_REPLICATION_PASSWORD='<repl>' -e PGDATA=/var/lib/postgresql/data/pgdata \
  -v "$PWD/setup-standby.sh:/setup-standby.sh:ro" \
  --entrypoint /bin/sh postgres:16-alpine -c '. /setup-standby.sh'

# 4) 啟動（standby.signal + primary_conninfo 已寫好）
docker start 5151-postgres-A
```

- 第 3 步若出現 `no pg_hba.conf entry for replication connection from host "172.21.0.1"`，
  表示 pg_hba 少了 docker 私有網段（peer 主機上的容器經 docker-proxy，來源會變 bridge gateway）。
  用 `deploy/shadow-ha/postgres-primary/fix-pg-hba.sh` 補（`CONTAINER=<new primary>`），兩段都仍要密碼。
- 反向（B 接回 A）只是把 `PRIMARY_HOST` / `SLOT_NAME` / volume 對調；drill 兩個方向都實測過，
  **RPO = 0、RTO ≈ 5–17s**（詳見 `evidence/runtime-modernization/A4-HA-DRILL-20260920.md`）。
- 腳本已加 `DOCKER`（Synology 的 docker 在 `/usr/local/bin`）與 `PG_CONTAINER` 覆寫，
  failover 後不論在哪一台主機都能執行。

## Split-brain prevention 重點

- 舊 primary 被 fence 前，**不** promote standby。
- 若兩邊都曾寫入，以「新 primary（被 promote 的那台）」為準，舊 primary 一律重拉。
- 全程不依賴自動化；不啟用 `repmgr` / `Patroni` 自動升格（未來有第三 Witness 才評估）。
