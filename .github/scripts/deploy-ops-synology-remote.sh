#!/usr/bin/env bash
# OPS-only Synology deploy (remote). fail-closed; never touches v3 or other site services.
# Staged/versioned release model: source → releases/$DEPLOY_SHA, atomic `current` symlink switch,
# consistent DB snapshot (container stopped), rollback switches current back + restores DB.
set -euo pipefail

DEPLOY_SHA="${DEPLOY_SHA:?missing DEPLOY_SHA}"
APP_ROOT="${OPS_SYNOLOGY_APP_ROOT:-/volume1/docker/5151-ops/app}"
DATA_ROOT="${OPS_SYNOLOGY_DATA_ROOT:-/volume1/docker/5151-ops/data}"
RELEASES="$APP_ROOT/releases"
INCOMING="$APP_ROOT/incoming"
COMPOSE_FILE="$APP_ROOT/docker-compose.ops.synology.yml"
BACKUP_DIR="${DATA_ROOT}/.backup/$(date -u +%Y%m%d%H%M%S)"

log() { echo "[ops-synology] $*"; }
fail() { echo "::error::[ops-synology] $*" >&2; exit 1; }

# ---------- preflight: auth.env + secrets (never echo values) ----------
AUTH_ENV="${DATA_ROOT}/auth.env"
[ -f "$AUTH_ENV" ] || fail "auth.env not found at $AUTH_ENV"
PERMS="$(stat -c '%a' "$AUTH_ENV" 2>/dev/null || stat -f '%Lp' "$AUTH_ENV")"
{ [ "$PERMS" = "600" ] || [ "$PERMS" = "400" ]; } || fail "auth.env permissions must be 0600/0400 (got $PERMS)"
grep -Eq '^[[:space:]]*(OPS_OWNER_EMAIL|AUTH_EMAIL)[[:space:]]*=' "$AUTH_ENV" || fail "auth.env missing owner email"
grep -Eq '^[[:space:]]*(OPS_OWNER_PASSWORD|AUTH_PASSWORD)[[:space:]]*=' "$AUTH_ENV" || fail "auth.env missing owner password"
KEY_PRESENT=0
while IFS= read -r line; do
  case "$line" in
    OPS_SECRET_AT_REST_KEY=*) v="${line#OPS_SECRET_AT_REST_KEY=}"; v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"; printf '%s' "$v" | grep -Eq '^[0-9a-fA-F]{64}$' && KEY_PRESENT=1;;
  esac
done < "$AUTH_ENV"
[ "$KEY_PRESENT" = "1" ] || fail "auth.env missing a valid 64-hex OPS_SECRET_AT_REST_KEY"

# ---------- consistent backup (stop container, snapshot DB, keep stopped during switch) ----------
mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
PREVIOUS="$(readlink -f "$APP_ROOT/current" 2>/dev/null || true)"
docker compose -f "$COMPOSE_FILE" stop 5151-ops >/dev/null 2>&1 || true
for f in ops.db ops.db-wal ops.db-shm; do
  [ -f "${DATA_ROOT}/$f" ] && cp -p "${DATA_ROOT}/$f" "$BACKUP_DIR/$f" || true
done
cp -p "$AUTH_ENV" "$BACKUP_DIR/auth.env" 2>/dev/null || true
chmod 600 "$BACKUP_DIR/auth.env" 2>/dev/null || true
printf 'deploy_sha=%s\nprevious=%s\nbackup_at=%s\n' "$DEPLOY_SHA" "$PREVIOUS" "$(date -u +%FT%TZ)" > "$BACKUP_DIR/meta.txt"
log "backup at $BACKUP_DIR (previous=$PREVIOUS)"

# ---------- rollback (on any failure) ----------
rollback() {
  log "rollback to previous source + DB snapshot"
  if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ]; then
    ln -sfn "$PREVIOUS" "$APP_ROOT/current"
  fi
  for f in ops.db ops.db-wal ops.db-shm; do
    [ -f "$BACKUP_DIR/$f" ] && cp -p "$BACKUP_DIR/$f" "${DATA_ROOT}/$f" || true
  done
  if [ -f "$BACKUP_DIR/auth.env" ]; then cp -p "$BACKUP_DIR/auth.env" "$AUTH_ENV"; chmod 600 "$AUTH_ENV"; fi
  ( cd "$APP_ROOT" && docker compose -f "$COMPOSE_FILE" up -d --no-build --no-deps --force-recreate 5151-ops ) || true
  log "rollback complete"
}
trap 'ERR=$?; if [ "$ERR" != "0" ]; then rollback; fi' ERR

# ---------- promote staged release + atomic switch ----------
[ -d "$INCOMING/ops" ] || fail "incoming ops source missing at $INCOMING/ops"
[ -f "$INCOMING/docker-compose.ops.synology.yml" ] && mv "$INCOMING/docker-compose.ops.synology.yml" "$COMPOSE_FILE" || true
mkdir -p "$RELEASES"
rm -rf "$RELEASES/$DEPLOY_SHA"
mkdir -p "$RELEASES/$DEPLOY_SHA"
mv "$INCOMING/ops" "$RELEASES/$DEPLOY_SHA/ops"
printf '%s' "$DEPLOY_SHA" > "$RELEASES/$DEPLOY_SHA/.deployed-sha"

ln -sfn "$RELEASES/$DEPLOY_SHA" "$APP_ROOT/current"
cd "$APP_ROOT"
docker compose -f "$COMPOSE_FILE" up -d --no-build --no-deps --force-recreate 5151-ops

# ---------- health + source identity ----------
ok=0
for _ in $(seq 1 40); do
  if curl -fsS http://127.0.0.1:5154/ops/api/health | grep -q '"ok":true'; then ok=1; break; fi
  sleep 1
done
[ "$ok" = "1" ] || { docker logs 5151-ops 2>&1 | tail -n 40 || true; fail "OPS health did not become ready"; }

MARKER="$(cat "$APP_ROOT/current/.deployed-sha" 2>/dev/null || true)"
[ "$MARKER" = "$DEPLOY_SHA" ] || fail "deployed SHA marker mismatch (got $MARKER)"
RUNNING="$(docker inspect -f '{{.State.Status}}' 5151-ops)"
[ "$RUNNING" = "running" ] || fail "container not running (state=$RUNNING)"

# bounded retention: keep current + last 5 releases
( cd "$RELEASES" && ls -1t | tail -n +7 | xargs -r rm -rf )

log "DEPLOY_OPS_SYNOLOGY_OK source=$DEPLOY_SHA previous=$PREVIOUS"

