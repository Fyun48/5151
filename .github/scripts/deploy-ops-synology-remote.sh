#!/usr/bin/env bash
# OPS-only Synology deploy (remote). fail-closed; never touches v3 or other site services.
set -euo pipefail

DEPLOY_SHA="${DEPLOY_SHA:?missing DEPLOY_SHA}"
APP_ROOT="${OPS_SYNOLOGY_APP_ROOT:-/volume1/docker/5151-ops/app}"
DATA_ROOT="${OPS_SYNOLOGY_DATA_ROOT:-/volume1/docker/5151-ops/data}"
COMPOSE_FILE="${APP_ROOT}/docker-compose.ops.synology.yml"
BACKUP_DIR="${DATA_ROOT}/.backup/$(date -u +%Y%m%d%H%M%S)"

log() { echo "[ops-synology] $*"; }
fail() { echo "::error::[ops-synology] $*" >&2; exit 1; }

# ---------- preflight: auth.env + secrets (never echo values) ----------
AUTH_ENV="${DATA_ROOT}/auth.env"
[ -f "$AUTH_ENV" ] || fail "auth.env not found at $AUTH_ENV"
PERMS="$(stat -c '%a' "$AUTH_ENV" 2>/dev/null || stat -f '%Lp' "$AUTH_ENV")"
{ [ "$PERMS" = "600" ] || [ "$PERMS" = "400" ]; } || fail "auth.env permissions must be 0600/0400 (got $PERMS)"
grep -Eq '^[[:space:]]*(OPS_OWNER_EMAIL|AUTH_EMAIL)[[:space:]]*=' "$AUTH_ENV" || fail "auth.env missing owner email (OPS_OWNER_EMAIL/AUTH_EMAIL)"
grep -Eq '^[[:space:]]*(OPS_OWNER_PASSWORD|AUTH_PASSWORD)[[:space:]]*=' "$AUTH_ENV" || fail "auth.env missing owner password (OPS_OWNER_PASSWORD/AUTH_PASSWORD)"

# 只驗證「存在且為 64-hex」，不印出值。
KEY_PRESENT=0
while IFS= read -r line; do
  case "$line" in
    OPS_SECRET_AT_REST_KEY=*)
      val="${line#OPS_SECRET_AT_REST_KEY=}"
      val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
      printf '%s' "$val" | grep -Eq '^[0-9a-fA-F]{64}$' && KEY_PRESENT=1
      ;;
  esac
done < "$AUTH_ENV"
[ "$KEY_PRESENT" = "1" ] || fail "auth.env missing a valid 64-hex OPS_SECRET_AT_REST_KEY"

# ---------- predeploy backup (ops.db + config metadata; never echo secrets) ----------
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
# best-effort WAL checkpoint via the running container (may not exist yet), then snapshot files.
docker exec 5151-ops node -e 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/data/ops.db");d.exec("PRAGMA wal_checkpoint(TRUNCATE)");d.close();' >/dev/null 2>&1 || true
for f in ops.db ops.db-wal ops.db-shm; do
  [ -f "${DATA_ROOT}/$f" ] && cp -p "${DATA_ROOT}/$f" "$BACKUP_DIR/$f" || true
done
cp -p "$AUTH_ENV" "$BACKUP_DIR/auth.env" 2>/dev/null || true
chmod 600 "$BACKUP_DIR/auth.env" 2>/dev/null || true
cp -p "$COMPOSE_FILE" "$BACKUP_DIR/docker-compose.ops.synology.yml" 2>/dev/null || true
printf 'deploy_sha=%s\nbackup_at=%s\n' "$DEPLOY_SHA" "$(date -u +%FT%TZ)" > "$BACKUP_DIR/meta.txt"
log "backup stored at $BACKUP_DIR"

# ---------- rollback (on any failure) ----------
rollback() {
  log "rollback to previous snapshot"
  [ -f "$BACKUP_DIR/docker-compose.ops.synology.yml" ] && cp -p "$BACKUP_DIR/docker-compose.ops.synology.yml" "$COMPOSE_FILE"
  for f in ops.db ops.db-wal ops.db-shm; do
    [ -f "$BACKUP_DIR/$f" ] && cp -p "$BACKUP_DIR/$f" "${DATA_ROOT}/$f" || true
  done
  if [ -f "$BACKUP_DIR/auth.env" ]; then cp -p "$BACKUP_DIR/auth.env" "$AUTH_ENV"; chmod 600 "$AUTH_ENV"; fi
  ( cd "$APP_ROOT" && docker compose -f docker-compose.ops.synology.yml up -d --no-build --no-deps --force-recreate 5151-ops ) || true
  log "rollback complete"
}

trap 'ERR=$?; if [ "$ERR" != "0" ]; then rollback; fi' ERR

# ---------- deploy ----------
log "deploying $DEPLOY_SHA (Synology OPS-only)"
[ -f "$COMPOSE_FILE" ] || fail "compose file missing: $COMPOSE_FILE"
cd "$APP_ROOT"
docker compose -f docker-compose.ops.synology.yml up -d --no-build --no-deps --force-recreate 5151-ops

# ---------- health + source identity ----------
ok=0
for _ in $(seq 1 40); do
  if curl -fsS http://127.0.0.1:5154/ops/api/health | grep -q '"ok":true'; then ok=1; break; fi
  sleep 1
done
[ "$ok" = "1" ] || { docker logs 5151-ops 2>&1 | tail -n 40 || true; fail "OPS health did not become ready"; }

printf '%s' "$DEPLOY_SHA" > "${DATA_ROOT}/.deployed-sha"
MARKER="$(cat "${DATA_ROOT}/.deployed-sha")"
[ "$MARKER" = "$DEPLOY_SHA" ] || fail "deployed SHA marker mismatch"
RUNNING="$(docker inspect -f '{{.State.Status}}' 5151-ops)"
[ "$RUNNING" = "running" ] || fail "container not running (state=$RUNNING)"

log "DEPLOY_OPS_SYNOLOGY_OK source=$DEPLOY_SHA container=5151-ops"
