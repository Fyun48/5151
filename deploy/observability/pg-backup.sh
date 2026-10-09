#!/bin/sh
# 5151 PostgreSQL 排程備份（systemd timer 每天執行一次）。
#
# 為什麼需要它（2026-09-27 查證發現）：
#   在此之前 **完全沒有排程備份** —— pg_dump 只在 production-predeploy-check 執行，
#   也就是「只有有人部署時才有備份」。若三個月不部署，最新備份就是三個月前。
#   而 standby 救不了誤刪／誤改：它會在毫秒內把破壞一起複製過去。
#   所以實際曝險視窗 = 距離上次部署多久 = 無上限。這支腳本把它收斂成一天。
#
# 背景（2026-10-09 起改從 primary 抓）：
#   舊版從 standby 抓 dump（來源 pg_is_in_recovery=t）。自 2026-10-02 起連 7 天
#   pg_dump_failed（`canceling statement due to conflict with recovery`）卻無人察覺，
#   因為失敗只寫進 log、沒有老化告警也沒人看。因此改成：
#     * 用 app 的 PG_URL 經 HAProxy pg-rw（預設 192.168.0.140:25433）抓 primary，
#       不再直連某一顆容器、也不再從 standby 抓。
#     * 抓之前先查 pg_is_in_recovery()，不是 `f` 就 fail-closed 中止。
#     * 成功／失敗都寫 status 檔，並在最新 dump 超過 MAX_AGE_H 小時時發出老化告警。
#
# 連線與位置：值一律來自環境變數／env_file（見 systemd unit 的 EnvironmentFile），
# 本檔不含任何密碼或連線字串。pg_dump／pg_restore／psql 需在 PATH 或由 *_BIN 覆寫。
#
# 原則：只讀取 PG（pg_dump），只寫自己的備份目錄與 status 檔，只刪自己前綴的舊檔。
# 保留 N 份（預設 7）；每次備份都驗證可讀（pg_restore -l 的 TABLE DATA 筆數）。
# 一行停用：sudo systemctl disable --now 5151-pg-backup.timer
set -u

PG_URL="${PG_URL:?set PG_URL (app 連線字串，經 HAProxy pg-rw)}"
PG_DB_NAME="${PG_DB_NAME:-5151_shadow}"
BACKUP_DIR="${PG_BACKUP_DIR:-/mnt/Storage1/docker_data/5151-pg-backups}"
KEEP="${PG_BACKUP_KEEP:-7}"
LOG="${PG_BACKUP_LOG:-/var/log/5151/pg-backup.log}"
STATUS_FILE="${PG_BACKUP_STATUS:-$BACKUP_DIR/status}"
MAX_AGE_H="${PG_BACKUP_MAX_AGE_H:-26}"
PG_DUMP_BIN="${PG_DUMP_BIN:-pg_dump}"
PG_RESTORE_BIN="${PG_RESTORE_BIN:-pg_restore}"
PSQL_BIN="${PSQL_BIN:-psql}"

mkdir -p "$BACKUP_DIR" "$(dirname "$LOG")" 2>/dev/null || true
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/pg-${PG_DB_NAME}-${STAMP}.dump"
TMP="$OUT.part"

write_status() {
  printf '%s ok=%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" > "$STATUS_FILE" 2>/dev/null || true
}

stale_check() {
  newest="$(ls -1t "$BACKUP_DIR"/pg-"$PG_DB_NAME"-*.dump 2>/dev/null | head -1)"
  [ -n "$newest" ] || return 0
  if [ -n "$(find "$newest" -mmin "+$((MAX_AGE_H * 60))" 2>/dev/null)" ]; then
    printf '%s ok=0 stage=stale newest=%s age_gt=%sh\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$newest")" "$MAX_AGE_H" >> "$LOG"
    echo "PG_BACKUP_STALE: newest dump $(basename "$newest") is older than ${MAX_AGE_H}h" >&2
  fi
}

fail() {
  printf '%s ok=0 stage=%s error=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >> "$LOG"
  write_status 0 "stage=$1 error=$2"
  rm -f "$TMP" 2>/dev/null || true
  stale_check
  echo "PG_BACKUP_ALERT: $1 $2" >&2
  exit 1
}

# 來源必須是 primary：pg_is_in_recovery() 不是 f 就 fail-closed，不從 standby 產出備份。
RECOVERY="$("$PSQL_BIN" "$PG_URL" -tAc 'SELECT pg_is_in_recovery();' 2>/dev/null)" \
  || fail recovery psql_query_failed
[ "$RECOVERY" = "f" ] || fail recovery "pg_is_in_recovery=${RECOVERY:-<empty>}"

"$PG_DUMP_BIN" -Fc -d "$PG_URL" > "$TMP" 2>/dev/null || fail dump pg_dump_failed

BYTES="$(wc -c < "$TMP" | tr -d ' ')"
[ "$BYTES" -gt 0 ] || fail verify empty_dump

# 可讀性驗證：pg_restore -l 能列出 TABLE DATA 才算有效備份。
TABLES="$("$PG_RESTORE_BIN" -l < "$TMP" 2>/dev/null | grep -c 'TABLE DATA')"
[ "$TABLES" -gt 0 ] || fail verify pg_restore_list_empty

mv "$TMP" "$OUT" || fail publish mv_failed
SHA="$(sha256sum "$OUT" | cut -d' ' -f1)"

# 只清自己前綴的舊檔，保留最新 KEEP 份（依檔名時間戳排序）。
ls -1t "$BACKUP_DIR"/pg-"$PG_DB_NAME"-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  case "$old" in "$BACKUP_DIR"/pg-"$PG_DB_NAME"-*.dump) rm -f "$old" ;; esac
done

printf '%s ok=1 bytes=%s table_data=%s sha256=%s file=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$BYTES" "$TABLES" "$SHA" "$(basename "$OUT")" >> "$LOG"
write_status 1 "bytes=$BYTES table_data=$TABLES file=$(basename "$OUT")"
stale_check
exit 0
