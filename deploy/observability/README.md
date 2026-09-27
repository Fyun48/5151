# 5151 觀測與排程備份

本目錄是 NAS 上 systemd timer／service 的**可稽核來源**。主機上的 unit 會標註
`Documentation=repo:deploy/observability/README.md` 指回這裡。

安裝位置（CasaOS，`192.168.0.140`）：

| 檔案 | 主機路徑 |
|---|---|
| `*.sh`、`*.mjs` | `/opt/5151-scripts/` |
| `*.service`、`*.timer` | `/etc/systemd/system/` |
| 執行記錄 | `/var/log/5151/*.log`（每次一行，`ok=1` 代表正常） |

## 一、現有 timer

| Timer | 頻率 | 用途 |
|---|---|---|
| `5151-crawl-staleness-monitor.timer` | 每 5 分鐘 | crawler 即時性：`listings.last_seen_at` 是否停滯 |
| `5151-pg-backup.timer` | 每天 20:30 UTC | PostgreSQL 排程備份（取自 standby） |
| `5151-projection-monitor.timer` | 每 15 分鐘 | 唯讀投影完整性（見 PR #498，尚未合併進 master） |
| `5151-media-mount-guard.timer` | — | 媒體掛載守衛 |

一行停用任一項：`sudo systemctl disable --now <timer>`

## 二、crawl 停滯監控（2026-09-27 新增）

### 為什麼需要

2026-09-26／27 兩次 crawler 停擺都是**安靜地死**：一次約 5 小時、一次約 1.5 小時，
沒有任何告警。單一指標 `listings.last_seen_at` 有沒有在前進，就能在幾分鐘內抓到這兩次。
這是整個事件裡投報率最高的一個檢查。

### 門檻

預設 **1800 秒（30 分鐘）**，可用 `STALE_ALERT_SECONDS` 覆寫。理由：正常 crawl 週期約
10–15 分鐘、寫入是 bursty 但相鄰 burst 只差數十秒，30 分鐘對正常運作有極大餘裕，
卻能在上述兩次真實停擺的早期就發出警報。

### 輸出

```
2026-09-27T04:21:52Z ok=1 lag_s=2 threshold_s=1800 total=127594 fresh_1h=11176 stale_7d=87013 in_recovery=0
```

`ok=0` 時腳本以非 0 結束 → journal 記錄 `CRAWL_STALENESS_ALERT`。
唯讀：只做 SELECT。查核腳本每次執行都由 timer 重新帶進容器，內容以 repo 為準。

### 上線時的基準線（2026-09-27 04:21Z）

| 指標 | 值 |
|---|---|
| `lag_s` | 2 |
| `total` | 127,594 |
| `fresh_1h`（1 小時內更新） | 11,176（8.8%） |
| `stale_7d`（超過 7 天未更新） | 87,013（68.2%） |

`stale_7d` 細分：**已下架 1,502 筆、仍在上架中 85,511 筆**。
仍在上架卻超過 7 天未更新，可能是「crawler 只跑 19 組覆蓋條件、涵蓋範圍外本來就不更新」
的設計結果，但**目前沒有任何地方定義或量測這件事**。這是「完整性」尚無法回答的原因，
需要 Owner 確認預期涵蓋範圍後才能定門檻。

## 三、PostgreSQL 排程備份（2026-09-27 新增）

### 為什麼需要

在此之前**完全沒有排程備份**——`pg_dump` 只在 `production-predeploy-check.yml` 執行，
也就是「只有有人部署時才有備份」。若三個月不部署，最新備份就是三個月前。
而 standby（`5151-postgres-A`）救不了誤刪／誤改：它會在毫秒內把破壞一起複製過去。
實際曝險視窗 = 距離上次部署多久 = **無上限**。本 timer 把它收斂成一天。

### 行為

- 從 **standby**（`PG_CONTAINER`，預設 `5151-postgres-A`）取 `pg_dump -Fc`，與 predeploy 一致。
- 每次備份都驗證：`pg_restore -l` 能列出內容（`TABLE DATA` > 0）才算有效。
- 只保留最新 `PG_BACKUP_KEEP`（預設 7）份，且**只刪自己前綴** `pg-5151_shadow-*.dump` 的檔案。
- 目錄：`/mnt/Storage1/docker_data/5151-pg-backups/`
- 失敗一律非 0 結束 → journal 記錄 `PG_BACKUP_ALERT`。

### 這一項與 PITR 的關係（Owner 問過）

**PITR 不是 SQLite 退場的前提。** 兩者解決不同問題：

- **有沒有備份** → 本 timer 已補上（在此之前是缺的）。
- **能還原到多細** → PITR（`archive_mode=on` ＋ WAL 歸檔）才能還原到任一秒；
  目前 primary 是 `archive_mode=off`，所以最細只能還原到最近一份 dump。

建議順序：先有排程備份（本項，已完成）→ 再評估 PITR。

### 首次執行實測（2026-09-27 04:22Z）

```
2026-09-27T04:22:36Z ok=1 bytes=62507266 table_data=105 sha256=57c5560d... file=pg-5151_shadow-20260927T042208Z.dump
```

耗時 27.7 秒。
