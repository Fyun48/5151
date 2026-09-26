# PG WAL 封存／PITR Runbook（2026-09-24）

> 狀態：**尚未執行**。本文是「先貼命令、再執行」用的操作書。所有命令都會在執行前再貼一次給 Owner 確認。

## 一、現況（唯讀量測，非推論）

| 項目 | 量測值 | 意義 |
|---|---|---|
| PostgreSQL 版本 | **16.14** | `pg_basebackup`／`recovery_target_*` 皆可用 |
| `wal_level` | `replica` | 對實體複寫與 base backup 足夠（PITR 不需 `logical`）|
| **`archive_mode`** | **`off`** | ✗ **WAL 沒有封存 ⇒ 沒有 PITR** |
| `archive_command` | `(disabled)` | ✗ |
| `archive_timeout` | `0` | ✗（低流量時 WAL 段會長時間不切換）|
| `pg_stat_archiver` | `archived_count=0, failed_count=0` | 從未封存過 |
| 複寫槽 | `standby_a`（physical，`active=true`）| 非同步 standby 正常運作中 |
| WAL 目錄大小 / DB 大小 | **80 MB** / **549 MB** | 封存成本很低 |

⇒ 現況 = **有 HA（非同步 standby）但沒有時間點還原能力**。任何誤刪／誤改都無法回到「事故前 1 分鐘」。

## 二、目標

1. 開啟 WAL 連續封存（archive ✓），使 **PITR（時間點還原）** 成為可能。
2. 以 `pg_basebackup` 建立週期性實體備份（PITR 的起點）。
3. **必須做一次還原演練**：沒有演練過的備份不算備份。

## 三、前置檢查（執行前逐項確認）

```sql
-- 封存目的地要有空間；建議放在 NAS 的獨立 volume，並確認 postgres 使用者可寫
SHOW data_directory;
SELECT pg_size_pretty(COALESCE(SUM(size),0)) AS wal_dir FROM pg_ls_waldir();
-- 確認目前沒有長時間執行的交易（重啟前）
SELECT pid, state, now() - xact_start AS age FROM pg_stat_activity WHERE xact_start IS NOT NULL ORDER BY age DESC LIMIT 5;
-- 確認 standby 追得上（重啟前的落後量）
SELECT client_addr, state, sent_lsn, replay_lsn, (sent_lsn - replay_lsn) AS lag_bytes FROM pg_stat_replication;
```

- **需要 Owner 提供**：封存目錄的**實際路徑**（本 runbook 以 `/volume1/pg-archive/5151` 為範例，請以實機為準）。
- 需要確認：該路徑的容量規劃與保留策略（見第六節）。

## 四、執行步驟

> ⚠️ `archive_mode` **需要重啟** PostgreSQL 才生效（`archive_command`／`archive_timeout` 只需 reload）。重啟會造成**秒級中斷**，且因為 standby 是**非同步**，HAProxy 可能觸發切換。**請排在低流量時段**，並先通知使用者。

```sql
-- 1) 設定（ALTER SYSTEM 寫入 postgresql.auto.conf，可回復）
ALTER SYSTEM SET archive_mode = on;
ALTER SYSTEM SET archive_command = 'test ! -f /volume1/pg-archive/5151/%f && cp %p /volume1/pg-archive/5151/%f';
ALTER SYSTEM SET archive_timeout = '60s';   -- 低流量時最多 60 秒封存一次，界定 RPO 上界
```

`archive_command` 用 `test ! -f ... && cp ...` 是刻意的：**原子且可重試**，檔案已存在時回傳成功，避免重複封存造成 archiver 卡住。

```bash
# 2) 建立封存目錄並確認權限（在 PG 主機上，以 root 執行）
install -d -o postgres -g postgres /volume1/pg-archive/5151

# 3) reload 讓 archive_command／archive_timeout 生效
psql -c 'SELECT pg_reload_conf();'

# 4) 重啟讓 archive_mode 生效（主機上的服務名稱請以實機為準）
systemctl restart postgresql    # 或 pg_ctl restart -D <data_directory>

# 5) 建立第一個 base backup（PITR 的起點；可線上執行，不需停機）
pg_basebackup -D /volume1/pg-backup/5151-base-$(date +%Y%m%d) -Ft -z -P -X stream
```

## 五、驗證（必做，逐項留證據）

```sql
-- A. 封存真的在動：archived_count 應持續增加，failed_count 保持 0
SELECT archived_count, failed_count, last_archived_wal, last_archived_time FROM pg_stat_archiver;
-- B. 設定已生效
SHOW archive_mode;      -- on
SHOW archive_command;
-- C. 封存目的地真的有檔案（主機上）
--    ls -1 /volume1/pg-archive/5151 | tail -5
-- D. standby 仍正常（重啟後）
SELECT client_addr, state, (sent_lsn - replay_lsn) AS lag_bytes FROM pg_stat_replication;
```

E. **還原演練（PITR 的真正證明）** —— 在**另一台機器或另一個埠**上做，絕不動正式資料：

```bash
# 1) 解開 base backup 到暫存目錄
mkdir -p /tmp/pitr-drill && tar -xzf /volume1/pg-backup/5151-base-<日期>/base.tar.gz -C /tmp/pitr-drill

# 2) 設定還原目標（時間點）
cat >> /tmp/pitr-drill/postgresql.auto.conf <<'EOF'
restore_command = 'cp /volume1/pg-archive/5151/%f %p'
recovery_target_time = '2026-09-24 15:00:00+08'
recovery_target_action = 'promote'
EOF
touch /tmp/pitr-drill/recovery.signal

# 3) 用不同埠啟動，確認資料回到目標時間點
pg_ctl -D /tmp/pitr-drill -o '-p 55433' start
psql -p 55433 -c 'SELECT COUNT(*) FROM listings;'     # 應為目標時間點的列數
psql -p 55433 -c 'SELECT pg_is_in_recovery();'        # promote 後為 false
pg_ctl -D /tmp/pitr-drill stop
```

## 六、保留策略與成本（必須同時決定，否則會爆碟）

- WAL 封存會**持續累積**：每 16 MB 一個段，`archive_timeout=60s` 時低流量也有固定量。
- 建議：**每日 base backup + 保留 7 天**；WAL 保留對應「可還原到過去 7 天內任一時刻」。
- 以目前規模（DB 549 MB、WAL 目錄 80 MB）估算，成本可忽略；但**必須有清理機制**（cron／Synology 排程刪除過期 WAL 與舊 base backup）。

## 七、回退（任何一步出問題）

```sql
ALTER SYSTEM RESET archive_mode;         -- 或 SET archive_mode = off
ALTER SYSTEM RESET archive_command;
ALTER SYSTEM RESET archive_timeout;
SELECT pg_reload_conf();
```
之後重啟 PostgreSQL。已封存的 WAL 檔案可保留（無害）或人工清除。

## 八、風險清單

| 風險 | 說明 | 對策 |
|---|---|---|
| 重啟造成短暫中斷 | `archive_mode` 需重啟 | 低流量時段執行；事前確認 standby 落後量 |
| 可能觸發 HA 切換 | standby 為非同步 | 事前通知；切換後確認新主庫角色與複寫重建 |
| 封存目錄權限／不存在 | `postgres` 使用者必須可寫 | 步驟 2 先建目錄、驗證寫入 |
| 磁碟成長 | WAL 與 base backup 累積 | 第六節的保留策略與清理排程 |
| 備份從未演練 | 最常見的「假備份」 | 第五節 E 的還原演練，並記錄結果 |
