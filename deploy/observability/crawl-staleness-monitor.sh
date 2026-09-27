#!/bin/sh
# 5151 crawl 即時性唯讀監控（systemd timer 每 5 分鐘執行一次）。
#
# 原則與 projection-monitor.sh 相同：只讀、不改任何資料、可一行停用：
#   sudo systemctl disable --now 5151-crawl-staleness-monitor.timer
# 輸出：每次一行摘要寫入 /var/log/5151/crawl-staleness.log；
#       若 last_seen_at 停滯超過門檻（預設 1800 秒）會以非 0 結束 → journal 記錄 ALERT。
#
# 門檻可用 STALE_ALERT_SECONDS 覆寫。預設 30 分鐘的理由：正常 crawl 週期約 10-15 分鐘、
# 寫入是 bursty 但相鄰 burst 只差數十秒；30 分鐘對正常運作有極大餘裕，
# 卻能在兩次真實停擺（1.5 小時、5 小時）的早期就發出警報。
set -u

CONTAINER="${MONITOR_CONTAINER:-591-tracker-v3}"
SCRIPT_DIR="${SCRIPT_DIR:-/opt/5151-scripts}"
LOG="${MONITOR_LOG:-/var/log/5151/crawl-staleness.log}"
DOCKER_BIN="${DOCKER_BIN:-$(command -v docker || echo /usr/bin/docker)}"

mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

# 每次執行都把最新版查核腳本帶進容器（唯讀腳本，內容在 repo 內可稽核）
"$DOCKER_BIN" cp "$SCRIPT_DIR/crawl-staleness-check.mjs" "$CONTAINER:/app/crawl-staleness-check.mjs" >/dev/null 2>&1 || true

LINE="$("$DOCKER_BIN" exec -e "STALE_ALERT_SECONDS=${STALE_ALERT_SECONDS:-1800}" "$CONTAINER" \
  node /app/crawl-staleness-check.mjs 2>/dev/null | tail -n 1)"
[ -n "$LINE" ] || LINE="ok=0 error=CHECK_FAILED"

printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$LINE" >> "$LOG"

case "$LINE" in
  *"ok=1"*) exit 0 ;;
  *) echo "CRAWL_STALENESS_ALERT: $LINE (log: $LOG)" >&2; exit 1 ;;
esac
