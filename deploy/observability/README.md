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
| `5151-pg-backup.timer` | 每天 20:30 UTC | PostgreSQL 排程備份（取自 primary，經 HAProxy pg-rw） |
| `5151-projection-monitor.timer` | 每 15 分鐘 | 唯讀投影完整性：`listing_search_projection` 的 orphan／dup／nulls |
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

### 基準線（2026-09-27 05:04Z，**修正後**）

| 指標 | 值 |
|---|---|
| `lag_s` | 2 |
| `total` | 127,610 |
| `fresh_1h`（1 小時內更新） | **3,406** |
| `stale_7d`（超過 7 天未更新） | **87,742** |
| `unparsable`（格式無法解析） | 0 |

> ⚠️ **2026-09-27 修正**：本節初版的數字（`fresh_1h=11,176`、`stale_7d=87,013`）**是錯的**。
> 原因：`last_seen_at` 是 TEXT（`2026-09-27T…Z`），而 `(now() - interval '1 hour')::text`
> 產生的是 `2026-09-27 04:04:21+00`（**空格**而非 `T`）。字典序下 `'T'(0x54) > ' '(0x20)`，
> 所以 `last_seen_at > 邊界` **每一列都成立**，`fresh_1h` 會等於總數；`stale_7d` 則因同一個
> 原因把邊界日整批排除、少算。已改為 `::timestamptz` 比較（並加 `unparsable` 欄位確認全部可解析）。
>
> **告警本身不受影響**：`ok` 與 `lag_s` 是在 JS 用 `Date.parse` 算的，本來就正確。

`stale_7d` 細分：**已下架 1,502 筆、仍在上架中 85,511 筆**（此細分取自修正前的查詢，
但因為它只依賴 `stale_7d` 的集合，數字接近；重新確認後為 87,742 筆）。
仍在上架卻超過 7 天未更新，可能是「crawler 只跑 19 組覆蓋條件、涵蓋範圍外本來就不更新」
的設計結果，但**目前沒有任何地方定義或量測這件事**。這是「完整性」尚無法回答的原因，
需要 Owner 確認預期涵蓋範圍後才能定門檻。

## 三、PostgreSQL 排程備份（2026-09-27 新增）

### 為什麼需要

在此之前**完全沒有排程備份**——`pg_dump` 只在 `production-predeploy-check.yml` 執行，
也就是「只有有人部署時才有備份」。若三個月不部署，最新備份就是三個月前。
而 standby（`5151-postgres-A`）救不了誤刪／誤改：它會在毫秒內把破壞一起複製過去。
實際曝險視窗 = 距離上次部署多久 = **無上限**。本 timer 把它收斂成一天。

### 行為（2026-10-09 起；舊版見下方「2026-10-09 變更」）

- 從 **primary** 取 `pg_dump -Fc`：改用 app 的 `PG_URL` 經 HAProxy `pg-rw`
  （`192.168.0.140:25433`）抓，不再直連某一顆容器、也不再從 standby 抓。
- 內建 `pg_is_in_recovery()` 檢查：來源**非 `f` 就 fail-closed**（不是 primary 就拒絕產出備份）。
- 內建 status 檔與 **26 小時老化檢查**：太久沒成功備份會被發現（不會再發生「備份悄悄斷掉」）。
- 每次備份都驗證：`pg_restore -l` 能列出內容（`TABLE DATA` > 0）才算有效。
- 只保留最新 `PG_BACKUP_KEEP`（預設 7）份，且**只刪自己前綴** `pg-5151_shadow-*.dump` 的檔案。
- 目錄：`/mnt/Storage1/docker_data/5151-pg-backups/`
- 失敗一律非 0 結束 → journal 記錄 `PG_BACKUP_ALERT`。

> ⚠️ **2026-10-09 變更（repo 檔尚未同步）**：本目錄的 `pg-backup.sh` 仍是**舊版「從 standby 抓」**
> （`PG_CONTAINER` 預設 `5151-postgres-A`），與已上線的 `/opt/5151-scripts/pg-backup.sh`（改抓 primary）
> 不一致。**舊腳本從 standby 抓，自 2026-10-02 起連 7 天 `pg_dump_failed` 卻無人察覺**，才改成抓
> primary。把 `pg-backup.sh` 與 `5151-pg-backup.service` 的描述同步成新行為屬程式變更，另開 PR，
> 不在本 docs PR 範圍。

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

## 四、投影完整性監控（唯讀，2026-09-24 起）

### 為什麼需要

搜尋主要靠 `listing_search_projection` 這張**衍生投影表**。主表 `listings` 寫入成功但投影沒跟上，
訪客搜尋就會少看到房源；反向（投影有、主表沒有）或同 `post_id` 重複、`post_id` 為 NULL，
都是結構壞了的徵兆。這個檢查在「看到人之前」先抓到結構異常。

### 檢查內容（單一 `REPEATABLE READ READ ONLY` 交易，只有 SELECT）

| 指標 | 意義 | 告警？ |
|---|---|---|
| `missing`／`missing_visible` | 主表有、投影沒有的列數（含／不含 hidden、offline） | 否，只看趨勢（回填期間本來就 > 0） |
| `orphan` | 投影有、主表沒有的列數 | **是**（≠ 0 即告警） |
| `dup` | 投影內同 `post_id` 重複的群數 | **是**（≠ 0 即告警） |
| `nulls` | 投影內 `post_id` 為 NULL 的列數 | **是**（≠ 0 即告警） |

`ok=1` 由查核腳本自己算（orphan／dup／nulls 皆 0 且無錯誤）→ 監控端只信任這個欄位，
避免字串順序造成誤報。`ok=0` 時以非 0 結束 → journal 記錄 `PROJECTION_MONITOR_ALERT`。

### 檔案

- `projection-monitor.sh`（host 端 wrapper，裝到 `/opt/5151-scripts/`）
- `projection-check.mjs`（實際查核，每次執行 `docker cp` 進容器後執行；內容以 repo 為準）
- `5151-projection-monitor.service`／`.timer`（裝到 `/etc/systemd/system/`）

> 2026-10-06 現況：正式站 PG 路由缺口已歸零（`missing=0`、`listings == projection`）。
> 此監控的價值已從「追回填進度」轉為「永久守住結構不變壞」（orphan／dup／nulls）。

### 安裝／停用（casa；需要 root）

```sh
scp deploy/observability/projection-monitor.sh root@casa-nas:/opt/5151-scripts/
scp deploy/observability/projection-check.mjs root@casa-nas:/opt/5151-scripts/
scp deploy/observability/5151-projection-monitor.service deploy/observability/5151-projection-monitor.timer root@casa-nas:/etc/systemd/system/
ssh root@casa-nas 'chmod +x /opt/5151-scripts/projection-monitor.sh
  systemctl daemon-reload
  systemctl enable --now 5151-projection-monitor.timer
  systemctl start 5151-projection-monitor.service
  cat /var/log/5151/projection-monitor.log
  systemctl list-timers 5151-projection-monitor.timer --no-pager'
```

停用：`ssh root@casa-nas 'systemctl disable --now 5151-projection-monitor.timer'`

### 首次執行實測（2026-10-06，正式站 PG 已切）

```
2026-10-06T01:15:01Z missing=0 missing_visible=0 orphan=0 dup=0 nulls=0 listings=167490 projection=167490 ok=1
```
