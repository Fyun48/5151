# PostgreSQL Manual Failover Runbook（Shadow）

適用兩節點（CasaOS Primary + Synology Hot Standby）、**無 Witness** 的環境。
依 section 14，**禁止自動 promotion**。任何 failover 都走人工流程，且必須先防 split-brain。

## 原則

- 只有「確認舊 primary 真的無法存取」後才 promote standby。
- 網路 partition ≠ primary 故障；兩邊都活著時**絕不**兩邊都變 writable。
- 每一步都先驗證，再進入下一步。

## 名詞

- `P` = 舊 primary（CasaOS，`CASAOS_HOST:15432`）
- `S` = standby（Synology，`SYNOLOGY_HOST:15432`）
- 連線一律用 `docker exec`（shadow container），不碰正式 DB。

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
docker exec 5151-postgres-B pg_ctl promote -D /var/lib/postgresql/data/pgdata
# 或直接跑：
docker exec 5151-postgres-B psql -U postgres -c "SELECT pg_promote();"
```

驗證 S 已變成 primary：

```bash
docker exec 5151-postgres-B psql -U postgres -c "SELECT pg_is_in_recovery();"  # 預期 f
```

### 6. re-point — 更新 router

更新 HAProxy `haproxy.cfg` 的 `pg_primary` backend，把 `pg-b`（Synology）改成 primary、
`pg-a`（CasaOS）改成 backup；`pg_standby_first` 反向調整。重新載入：

```bash
docker exec 5151-haproxy haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg && \
docker exec 5151-haproxy kill -s HUP 1
```

應用程式 DB router 亦依 `pg_is_in_recovery()` 自動辨識新 primary（read-after-write 打 primary）。

### 7. verify — 驗證新 primary 可寫

```bash
docker exec 5151-postgres-B psql -U postgres -d 5151_shadow -c "CREATE TABLE failover_check(id int); DROP TABLE failover_check;"
```

### 8. rejoin — 舊 primary 回來後重建為 standby

舊 P 重新可達後，**不要直接啟動**（否則兩 primary 併存）。用 `pg_rewind` 或重拉 base backup：

```bash
# 偏好：直接重拉 base backup（資料已分歧時最安全）
cd deploy/shadow-ha/postgres-standby   # 在舊 P（CasaOS）上，把它當新 standby
docker stop 5151-postgres-A || true
docker compose run --rm standby-basebackup   # 從新 primary（Synology）重拉
docker compose up -d
```

## Split-brain prevention 重點

- 舊 primary 被 fence 前，**不** promote standby。
- 若兩邊都曾寫入，以「新 primary（被 promote 的那台）」為準，舊 primary 一律重拉。
- 全程不依賴自動化；不啟用 `repmgr` / `Patroni` 自動升格（未來有第三 Witness 才評估）。
