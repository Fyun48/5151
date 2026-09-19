# 5151 Shadow HA — PostgreSQL Primary/Standby + HAProxy

Shadow 環境（Phase 19）。與正式 v3 / 5151-ops 完全隔離：獨立 container name、
獨立 port、獨立 volume、獨立 database。**不切換、不停任何正式 container。**

## 網路拓撲（兩台 NAS 同一內網）

```
CasaOS  192.168.0.140 (CASAOS_HOST)
└─ 5151-postgres-A   Primary     host 0.0.0.0:15432 -> 5432
└─ 5151-haproxy-A    HAProxy     host 0.0.0.0:25432 (postgres-rw/ro) / 0.0.0.0:15153 (web)

Synology 192.168.0.220 (SYNOLOGY_HOST)
└─ 5151-postgres-B   Hot Standby host 0.0.0.0:15432 -> 5432（只讀；不可寫）
└─ 5151-haproxy-B    HAProxy     同上
```

- Primary 的 `15432` 需對 Standby（`SYNOLOGY_HOST`）開放，供 streaming replication。
- 所有密碼一律走 env（`PG_SUPER_PASSWORD` / `PG_REPLICATION_PASSWORD`），不 commit 明文。
- 兩節點**不啟用 automatic failover**（無 Witness）。promotion 一律手動（見
  `docs/runbooks/postgres-manual-failover.md`）。

## 套用（依序）

### 1. CasaOS — 啟動 Primary

```bash
cd deploy/shadow-ha/postgres-primary
CASAOS_HOST=192.168.0.140 \
PG_SUPER_PASSWORD='<super>' \
PG_REPLICATION_PASSWORD='<repl>' \
docker compose up -d
./setup-replication.sh   # 建 replication user + slot
```

### 2. Synology — 啟動 Standby

```bash
cd deploy/shadow-ha/postgres-standby
SYNOLOGY_HOST=192.168.0.220 \
CASAOS_HOST=192.168.0.140 \
PG_REPLICATION_PASSWORD='<repl>' \
docker compose run --rm standby-basebackup   # pg_basebackup 拉一份 primary
docker compose up -d                          # 以 standby 模式啟動
```

### 3. HAProxy（兩台都可）

```bash
cd deploy/shadow-ha/haproxy
CASAOS_HOST=192.168.0.140 SYNOLOGY_HOST=192.168.0.220 docker compose up -d
```

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
