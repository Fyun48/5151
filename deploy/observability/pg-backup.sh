#!/bin/sh
# 5151 PostgreSQL 排程備份（systemd timer 每天執行一次）。
#
# 為什麼需要它（2026-09-27 查證發現）：
#   在此之前 **完全沒有排程備份** —— pg_dump 只在 production-predeploy-check 執行，
#   也就是「只有有人部署時才有備份」。若三個月不部署，最新備份就是三個月前。
#   而 standby（5151-postgres-A）救不了誤刪／誤改：它會在毫秒內把破壞一起複製過去。
#   所以實際曝險視窗 = 距離上次部署多久 = 無上限。這支腳本把它收斂成一天。
#
# 從 **standby** 取 dump（與 predeploy 一致，來源 pg_is_in_recovery=t），避免影響 primary。
#
# 原則：只讀取 PG（pg_dump），只寫自己的備份目錄，只刪自己前綴的舊檔。
# 保留 N 份（預設 7）；每次備份都驗證可讀（pg_restore -l）並記錄 sha256 與大小。
# 一行停用：sudo systemctl disable --now 5151-pg-backup.timer
set -u

PG_CONTAINER="${PG_CONTAINER:-5151-postgres-A}"
PG_DB_NAME="${PG_DB_NAME:-5151_shadow}"
BACKUP_DIR="${PG_BACKUP_DIR:-/mnt/Storage1/docker_data/5151-pg-backups}"
KEEP="${PG_BACKUP_KEEP:-7}"
LOG="${PG_BACKUP_LOG:-/var/log/5151/pg-backup.log}"
DOCKER_BIN="${DOCKER_BIN:-$(command -v docker || echo /usr/bin/docker)}"

mkdir -p "$BACKUP_DIR" "$(dirname "$LOG")" 2>/dev/null || true
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/pg-${PG_DB_NAME}-${STAMP}.dump"
TMP="$OUT.part"

fail() {
  printf '%s ok=0 stage=%s error=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >> "$LOG"
  rm -f "$TMP" 2>/dev/null || true
  echo "PG_BACKUP_ALERT: $1 $2" >&2
  exit 1
}

# 來源必須存在且可讀，否則寧可失敗也不要產出一份空備份。
"$DOCKER_BIN" inspect "$PG_CONTAINER" >/dev/null 2>&1 || fail inspect "container_$PG_CONTAINER"

"$DOCKER_BIN" exec "$PG_CONTAINER" pg_dump -U postgres -Fc -d "$PG_DB_NAME" > "$TMP" 2>/dev/null || fail dump pg_dump_failed

BYTES="$(wc -c < "$TMP" | tr -d ' ')"
[ "$BYTES" -gt 0 ] || fail verify empty_dump

# 可讀性驗證：pg_restore -l 能列出內容才算有效備份。
TABLES="$("$DOCKER_BIN" exec -i "$PG_CONTAINER" pg_restore -l < "$TMP" 2>/dev/null | grep -c 'TABLE DATA')"
[ "$TABLES" -gt 0 ] || fail verify "pg_restore_list_empty"

mv "$TMP" "$OUT" || fail publish mv_failed
SHA="$(sha256sum "$OUT" | cut -d' ' -f1)"

# 只清自己前綴的舊檔，保留最新 KEEP 份（依檔名時間戳排序）。
ls -1t "$BACKUP_DIR"/pg-"$PG_DB_NAME"-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  case "$old" in "$BACKUP_DIR"/pg-"$PG_DB_NAME"-*.dump) rm -f "$old" ;; esac
done

printf '%s ok=1 bytes=%s table_data=%s sha256=%s file=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$BYTES" "$TABLES" "$SHA" "$(basename "$OUT")" >> "$LOG"
exit 0
