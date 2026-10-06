#!/usr/bin/env bash
# Runs on the PostgreSQL PRIMARY host (Synology) via SSH. Read-only pg_dump of the
# current primary; never writes to the database or to replication, never deploys.
# 對照 docs/runbooks/postgres-backup-restore.md §1/§3 與 deploy/shadow-ha/backup/backup.sh：
# 備份只在 primary 執行（standby 的 dump 會被 recovery conflict 隨機取消，且可能缺最新
# transaction），並用 --no-owner --no-acl。pg_dump 走容器內 unix socket（pg_hba trust），
# 不帶任何密碼、不帶連線字串。
set -euo pipefail

# Synology 的 docker 不在非登入 shell 的 PATH。
DOCKER="${DOCKER:-docker}"
command -v "$DOCKER" >/dev/null 2>&1 || DOCKER=/usr/local/bin/docker

fail() {
  echo "::error::$1"
  echo "PG_PREDEPLOY_FAIL: $1"
  exit 1
}

# 目前 primary 在 Synology（5151-postgres-B）；failover 後以 PREDEPLOY_PG_CONTAINER 指向新 primary。
PG_CONTAINER="${PREDEPLOY_PG_CONTAINER:-5151-postgres-B}"
PG_DB_NAME="${PREDEPLOY_PG_DB:-5151_shadow}"
# tori 的家目錄（runbook §6：備份放家目錄 ~/backups/5151/，不要放 /volume1/backups）。
PG_BACKUP_DIR="${PREDEPLOY_PG_BACKUP_DIR:-$HOME/backups/5151}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
# 固定檔名：predeploy 只留「最新一份」PG dump（每日定時保留由 runbook backup.sh 負責）。
PG_DUMP="$PG_BACKUP_DIR/pg-${PG_DB_NAME}.dump"
PG_EVIDENCE="$PG_BACKUP_DIR/pg-predeploy-evidence.json"

mkdir -p "$PG_BACKUP_DIR" || fail "cannot create $PG_BACKUP_DIR"

if ! "$DOCKER" inspect "$PG_CONTAINER" >/dev/null 2>&1; then
  fail "PG container $PG_CONTAINER not found; refusing a release without a PostgreSQL backup"
fi

PG_IN_RECOVERY="$("$DOCKER" exec "$PG_CONTAINER" psql -X -w -U postgres -d "$PG_DB_NAME" -At -c 'SELECT pg_is_in_recovery()' 2>/dev/null || echo unknown)"
echo "pg_container=$PG_CONTAINER pg_database=$PG_DB_NAME pg_in_recovery=$PG_IN_RECOVERY"
case "$PG_IN_RECOVERY" in
  t|true)
    fail "PG container $PG_CONTAINER is a hot standby (pg_is_in_recovery=t); pg_dump must target the PRIMARY. Point PREDEPLOY_PG_CONTAINER at the current primary."
    ;;
  f|false)
    echo "pg_source=primary"
    ;;
  *)
    fail "could not determine PG primary/standby state (pg_is_in_recovery='$PG_IN_RECOVERY'); refusing to dump"
    ;;
esac

# 先寫到 tmp 再 mv：pg_dump 失敗時不會蓋掉上一次成功的 dump。
PG_TMP="$PG_BACKUP_DIR/.pg-${PG_DB_NAME}.dump.tmp"
if ! "$DOCKER" exec "$PG_CONTAINER" pg_dump -U postgres -Fc --no-owner --no-acl -d "$PG_DB_NAME" > "$PG_TMP" 2>"$PG_BACKUP_DIR/pg_dump.err"; then
  tail -5 "$PG_BACKUP_DIR/pg_dump.err" 2>/dev/null || true
  rm -f "$PG_TMP"
  fail "pg_dump failed for $PG_CONTAINER/$PG_DB_NAME"
fi
PG_SIZE="$(stat -c%s "$PG_TMP" 2>/dev/null || stat -f%z "$PG_TMP")"
[ "${PG_SIZE:-0}" -gt 0 ] || { rm -f "$PG_TMP"; fail "PG dump is empty"; }
PG_SHA="$(sha256sum "$PG_TMP" | awk '{print $1}')"
PG_TABLES="$("$DOCKER" exec -i "$PG_CONTAINER" pg_restore -l < "$PG_TMP" 2>/dev/null | grep -c 'TABLE DATA' || true)"
[ "${PG_TABLES:-0}" -gt 0 ] || { rm -f "$PG_TMP"; fail "PG dump is not readable by pg_restore"; }
mv "$PG_TMP" "$PG_DUMP"

echo "pg_dump_bytes=$PG_SIZE pg_dump_table_data=$PG_TABLES pg_dump_sha256=$PG_SHA"
echo "pg_dump_path=$PG_DUMP"

# 回版指引（此 job 只備份、不還原）。還原到隔離庫先驗證，切換現役庫屬 Owner 手動核准。
echo "=== PG rollback guidance (this job only backs up, never restores) ==="
echo "rollback_ref=docs/runbooks/postgres-backup-restore.md (§3 preview, §4–§5 isolated restore)"
echo "rollback_preview: $DOCKER exec -i $PG_CONTAINER pg_restore -l < $PG_DUMP | head"
echo "rollback_restore_isolated: $DOCKER exec -i $PG_CONTAINER createdb -U postgres 5151_restore_test (only if absent); then $DOCKER exec -i $PG_CONTAINER pg_restore -U postgres --no-owner --no-acl --exit-on-error -d 5151_restore_test < $PG_DUMP"
echo "rollback_note: restore to an isolated DB and verify row counts first; switching the live DB is Owner-approved manual work (deploy-v3.yml rollback path)."

cat > "$PG_EVIDENCE" <<EOF
{
  "timestamp_utc": "$STAMP",
  "pg_backup_host": "syn-nas",
  "pg_container": "$PG_CONTAINER",
  "pg_database": "$PG_DB_NAME",
  "pg_backup_path": "$PG_DUMP",
  "pg_backup_file": "$(basename "$PG_DUMP")",
  "pg_backup_bytes": $PG_SIZE,
  "pg_backup_sha256": "$PG_SHA",
  "pg_backup_table_data": $PG_TABLES,
  "pg_dump_source_in_recovery": "$PG_IN_RECOVERY",
  "pg_backup_ok": true
}
EOF
echo "pg_evidence=$PG_EVIDENCE"
echo "PG_PREDEPLOY_OK"
