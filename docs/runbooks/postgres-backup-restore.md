# PostgreSQL Backup / Restore Runbook（Shadow）

適用兩節點（CasaOS Primary + Synology Hot Standby）的 shadow cluster。備份一律從
**Primary**（`CASAOS_HOST:15432`）拉，走 `pg_dump`（邏輯、可選表／可回單一時間點）與
`pg_basebackup`（實體、全 instance + WAL，供快速重建 standby）。**備份唯讀，不影響
replication 或正式 DB。**

## 原則

- 備份只在 Primary 執行；Standby 因 `pg_is_in_recovery()` 只讀，無法 `pg_dump` 全量（可 dump 但缺最新 transaction）。
- 一律走 env（`PG_SUPER_PASSWORD`），不 commit 明文。
- 保留 N 份 + 校驗；還原前先 dry-run / verify。
- 還原到**另一台 / 另一 database**，先驗證再切換，避免覆蓋現役。

## 名詞

- `P` = Primary（CasaOS，`CASAOS_HOST:15432`）
- `S` = Standby（Synology，`SYNOLOGY_HOST:15432`）
- `$CASAOS_HOST` / `$SYNOLOGY_HOST` = 兩 NAS 內網 IP（`192.168.0.140` / `192.168.0.220`）

## 1. 邏輯備份（pg_dump，custom format）

```bash
cd deploy/shadow-ha/backup
CASAOS_HOST=192.168.0.140 \
PG_SUPER_PASSWORD='<super>' \
bash backup.sh            # 產出 backups/5151_shadow-<ts>.dump + manifest
```

`backup.sh` 做的事：`docker exec 5151-postgres-A pg_dump -Fc --no-owner --no-acl`
→ 落到 `backups/`，並寫 `manifest.json`（含 pg_dump 版本、時間、檔案 sha256）。

單一資料庫、排程 cron 每日備份的典型選項。可用 `pg_restore -l` 看內容、`-t` 只還原部分表。

## 2. 實體備份（pg_basebackup，全 instance）

```bash
cd deploy/shadow-ha/backup
CASAOS_HOST=192.168.0.140 \
PG_SUPER_PASSWORD='<super>' \
bash basebackup.sh        # 產出 backups/base-<ts>/（full instance + WAL stream）
```

供**快速重建 standby / 災難還原整台**。因 shadow 資料量小，`--wal-method=stream` 單一步完成。

## 3. 驗證備份

```bash
# 列出 custom dump 內容（驗證可讀、非空）。注意：用 stdin 餵進容器，
# 容器內沒有 /backups 這個路徑（舊版 runbook 的範例路徑是錯的）。
docker exec -i 5151-postgres-A pg_restore -l < backups/5151_shadow-<ts>.dump | head
# 校驗檔案 sha256（restore.sh 也會自動與 manifest 比對）
sha256sum backups/5151_shadow-<ts>.dump
```

## 4. 還原（pg_restore，到隔離 database）

```bash
cd deploy/shadow-ha/backup
SYNOLOGY_HOST=192.168.0.220 \
PG_SUPER_PASSWORD='<super>' \
RESTORE_DB=5151_restore_test \
bash restore.sh backups/5151_shadow-<ts>.dump
```

`restore.sh` 會：先與 manifest 比對 sha256、在目標建立 `5151_restore_test`、
`pg_restore --exit-on-error`、`psql -c "SELECT 'restore_ok';"`，再列出每張表的 row count。
**還原到獨立 database，不碰 `5151_shadow`。**

> 演練修正（2026-09-20）：`5151_restore_test` 以數字開頭，SQL 內**必須加雙引號**
> （未加引號 → `trailing junk after numeric literal`，這個還原演練一直到 drill 才發現從未成功）。
> 驗證也不再假設 production 的 `listings` 表存在（shadow 沒有那張表）。

## 5. 還原後驗證

```bash
docker exec 5151-postgres-B psql -U postgres -d 5151_restore_test -c "SELECT count(*) FROM listings;"
# 與來源比對（備份當下的 row count 在 manifest.json）
```

## 6. 排程建議

- 每日邏輯備份（`pg_dump -Fc`），保留 7–14 份；每週一次 `pg_basebackup`。
- 備份檔複製到第二台 NAS（異地）：`scp backups/... tori@$SYNOLOGY_HOST:backups/5151/`
  （**不要**用 `/volume1/backups/...`：tori 沒有那個路徑的寫入權限，drill 實測失敗；
  用家目錄 `~/backups/5151/` 且已經實測 sha256 一致）。
- 定期「還原演練」（本 runbook §4）至少每月一次，驗證備份真的能還原。
- **failover 後**：primary 會換到另一台，腳本要在「當下的 primary」主機上跑，並指定容器：
  `PG_CONTAINER=5151-postgres-B bash backup.sh`（Synology 的 docker 在 `/usr/local/bin`，
  腳本會自動解析 `DOCKER`）。`restore.sh` 同樣支援 `PG_CONTAINER`。

## 演練實證（2026-09-20）

- 備份 + manifest + sha256 + 隔離還原 + 異地副本全部通過（`exit=0`、`repl_test: 1 rows`）。
- failover 後在新 primary（Synology）上實跑 `PG_CONTAINER=5151-postgres-B bash backup.sh` 成功。
- 完整記錄：`evidence/runtime-modernization/A4-HA-DRILL-20260920.md`。

## RPO / RTO

- 邏輯備份：RPO = 上次備份間隔（預設 24h）；RTO = 還原 + 驗證時間。
- 實體備份：RPO = 上次 basebackup（預設 7d，但與 streaming replication 併用時 RPO 近 0）；
  RTO = 重建 instance 時間（資料量小，分鐘級）。
- 真正的近零 RPO 依賴 streaming replication（見 `postgres-manual-failover.md`），備份是災難還原的
  最後一道防線，兩者互補。
