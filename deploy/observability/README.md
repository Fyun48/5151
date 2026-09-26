# 5151 唯讀監控（systemd timer）

本目錄是「定時但只讀」的監控，用來在看到人之前先發現結構性異常。
**設計原則**：只讀、冪等、可一行停用、輸出可稽核；**不做任何寫入**（有寫入的動作一律由人與代理在對話中執行並留證）。

## 目前的監控

| 名稱 | 頻率 | 內容 | 告警條件 |
|---|---|---|---|
| `5151-projection-monitor` | 每 15 分鐘（開機後 5 分鐘起） | PG 投影完整性（`missing`／`orphan`／`dup`／`nulls`／總數），單一 `REPEATABLE READ READ ONLY` 交易 | `orphan`／`dup`／`nulls` 任一不為 0（＝結構壞了）→ 非 0 結束，錯誤進 journal；`missing` 只記趨勢不告警（回填期間本來就 > 0） |

腳本：
- `projection-monitor.sh`（安裝到 `/opt/5151-scripts/`，host 端驅動）
- `v3/scripts/projection-check.mjs`（實際查核；每次執行會 `docker cp` 進容器，內容可在 repo 稽核）

## 安裝（casa；需要 root）

```sh
scp deploy/observability/projection-monitor.sh root@casa-nas:/opt/5151-scripts/
scp v3/scripts/projection-check.mjs root@casa-nas:/opt/5151-scripts/
scp deploy/observability/5151-projection-monitor.service deploy/observability/5151-projection-monitor.timer root@casa-nas:/etc/systemd/system/
ssh root@casa-nas 'chmod +x /opt/5151-scripts/projection-monitor.sh
  systemctl daemon-reload
  systemctl enable --now 5151-projection-monitor.timer
  systemctl start 5151-projection-monitor.service
  cat /var/log/5151/projection-monitor.log
  systemctl list-timers 5151-projection-monitor.timer --no-pager'
```

## 停用／移除

```sh
ssh root@casa-nas 'systemctl disable --now 5151-projection-monitor.timer
  rm -f /etc/systemd/system/5151-projection-monitor.{service,timer}
  systemctl daemon-reload'
```

## 日誌

- `/var/log/5151/projection-monitor.log`：每次一行
  `2026-09-24T13:40:00Z missing=75380 missing_visible=74857 orphan=0 dup=0 nulls=0 listings=119547 projection=44167 ok=1`
- `journalctl -u 5151-projection-monitor.service`：告警訊息（`PROJECTION_MONITOR_ALERT`）
