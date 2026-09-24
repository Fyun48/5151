#!/bin/sh
# 5151 投影完整性唯讀監控（systemd timer 每 15 分鐘執行一次）。
#
# 原則：只讀（單一 REPEATABLE READ READ ONLY 交易）、不改任何資料、可一行停用：
#   sudo systemctl disable --now 5151-projection-monitor.timer
# 輸出：每次一行摘要寫入 /var/log/5151/projection-monitor.log；
#       若 orphan／dup／nulls 不為 0（代表投影結構壞了）會以非 0 結束 → journal 會記錄 ALERT。
#       missing 不列入告警條件：回填期間它本來就會大於 0（只看趨勢）。
set -u

CONTAINER="${MONITOR_CONTAINER:-591-tracker-v3}"
SCRIPT_DIR="${SCRIPT_DIR:-/opt/5151-scripts}"
LOG="${MONITOR_LOG:-/var/log/5151/projection-monitor.log}"
DOCKER_BIN="${DOCKER_BIN:-$(command -v docker || echo /usr/bin/docker)}"

mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

# 每次執行都把最新版查核腳本帶進容器（唯讀腳本，內容在 repo 內可稽核）
"$DOCKER_BIN" cp "$SCRIPT_DIR/projection-check.mjs" "$CONTAINER:/tmp/projection-check.mjs" >/dev/null 2>&1 || true

LINE="$("$DOCKER_BIN" exec -e SUMMARY=1 "$CONTAINER" node /tmp/projection-check.mjs 2>/dev/null | tail -n 1)"
[ -n "$LINE" ] || LINE="CHECK_FAILED"

printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$LINE" >> "$LOG"

# ok=1 由查核腳本自己算（orphan/dup/nulls 皆 0 且無錯誤）→ 監控端只信任這個欄位，避免字串順序造成誤報。
case "$LINE" in
  *"ok=1"*) exit 0 ;;
  *) echo "PROJECTION_MONITOR_ALERT: $LINE (log: $LOG)" >&2; exit 1 ;;
esac
