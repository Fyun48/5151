#!/usr/bin/env bash
# OPS-only Synology deploy (remote). fail-closed; never touches v3 or other site services.
# Staged/versioned release model: each release holds source + compose + .runtime-image + .deployed-sha.
# Rollback restores previous source + runtime image + compose + DB snapshot.
set -euo pipefail

DEPLOY_SHA="${DEPLOY_SHA:?missing DEPLOY_SHA}"
OPS_RUNTIME_IMAGE="${OPS_RUNTIME_IMAGE:?missing OPS_RUNTIME_IMAGE}"
APP_ROOT="${OPS_SYNOLOGY_APP_ROOT:-/volume1/docker/5151-ops/app}"
DATA_ROOT="${OPS_SYNOLOGY_DATA_ROOT:-/volume1/docker/5151-ops/data}"
export OPS_SYNOLOGY_APP_ROOT="$APP_ROOT"
export OPS_SYNOLOGY_DATA_ROOT="$DATA_ROOT"

RELEASES="$APP_ROOT/releases"
INCOMING="$APP_ROOT/incoming/$DEPLOY_SHA"
CURRENT="$APP_ROOT/current"
BACKUP_DIR="${DATA_ROOT}/.backup/$(date -u +%Y%m%d%H%M%S)"

log() { echo "[ops-synology] $*"; }
fail() { echo "::error::[ops-synology] $*" >&2; exit 1; }

# runtime image must be an exact immutable digest reference (no mutable tag / :latest)
if ! printf '%s' "$OPS_RUNTIME_IMAGE" | grep -Eq '^ghcr.io/fyun48/5151@sha256:[0-9a-f]{64}$'; then
  fail "OPS_RUNTIME_IMAGE must be ghcr.io/fyun48/5151@sha256:<64 hex>"
fi

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

# ---------- resolve PREVIOUS + fail-closed on unknown unmanaged container ----------
PREVIOUS=""
if [ -L "$CURRENT" ]; then
  PREVIOUS="$(readlink -f "$CURRENT" 2>/dev/null || true)"
fi
if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^5151-ops$'; then
  if [ -z "$PREVIOUS" ] || [ ! -d "$PREVIOUS" ] || [ ! -f "$PREVIOUS/.deployed-sha" ] || [ ! -f "$PREVIOUS/.runtime-image" ]; then
    fail "existing 5151-ops container has no managed current release metadata; refusing to take over unknown deployment"
  fi
fi

# ---------- rollback state (armed before any destructive op) ----------
DEPLOY_COMMITTED=0
ROLLBACK_DONE=0
PRE_SQLITE_FILES=""

rollback() {
  [ "$ROLLBACK_DONE" = "1" ] && return 0
  ROLLBACK_DONE=1
  rollback_ok=0
  db_ok=1
  log "rollback: stop failed container, restore previous source+image+compose+DB"
  docker stop 5151-ops >/dev/null 2>&1 || true

  # DB/config restore：fail-closed（只對 predeploy 存在過的檔還原；新 sidecar 移除）。
  for f in ops.db ops.db-wal ops.db-shm; do
    case " $PRE_SQLITE_FILES " in
      *" $f "*)
        if [ -f "$BACKUP_DIR/$f" ]; then
          cp -p "$BACKUP_DIR/$f" "${DATA_ROOT}/$f" || db_ok=0
        fi
        ;;
      *) rm -f "${DATA_ROOT}/$f" || true ;;
    esac
  done
  if [ -f "$BACKUP_DIR/auth.env" ]; then
    cp -p "$BACKUP_DIR/auth.env" "$AUTH_ENV" || db_ok=0
    chmod 600 "$AUTH_ENV" || db_ok=0
  fi

  if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ] && [ -f "$PREVIOUS/.runtime-image" ] && [ -f "$PREVIOUS/docker-compose.ops.synology.yml" ]; then
    ln -sfn "$PREVIOUS" "$CURRENT" || true
    PREV_IMAGE="$(cat "$PREVIOUS/.runtime-image")"
    # validate PREV_IMAGE is an immutable expected repo digest before use
    if printf '%s' "$PREV_IMAGE" | grep -Eq '^ghcr.io/fyun48/5151@sha256:[0-9a-f]{64}$'; then
      if [ "$db_ok" = "1" ]; then
        if OPS_RUNTIME_IMAGE="$PREV_IMAGE" docker compose -f "$PREVIOUS/docker-compose.ops.synology.yml" up -d --no-build --no-deps --force-recreate 5151-ops; then
          for _ in $(seq 1 30); do
            if curl -fsS http://127.0.0.1:5154/ops/api/health | grep -q '"ok":true'; then rollback_ok=1; break; fi
            sleep 1
          done
        fi
      fi
    fi
    if [ "$rollback_ok" = "1" ]; then
      log "ROLLBACK_OK source=$PREVIOUS image=$PREV_IMAGE"
    else
      log "ROLLBACK_FAILED db_ok=$db_ok"
    fi
  else
    rm -f "$CURRENT" || true
    rm -rf "$RELEASES/$DEPLOY_SHA" || true
    if [ "$db_ok" = "1" ]; then
      rollback_ok=1
      log "ROLLBACK_OK first deploy: OPS left stopped, failed release removed"
    else
      log "ROLLBACK_FAILED first deploy: DB/config restore failed"
    fi
  fi
}

# EXIT trap：在第一次 destructive op 之前武裝；非零 exit 且未 commit 時 rollback 一次。
trap 'code=$?; if [ "$code" != "0" ] && [ "$DEPLOY_COMMITTED" != "1" ]; then rollback; fi; exit "$code"' EXIT

# ---------- record predeploy SQLite files ----------
for f in ops.db ops.db-wal ops.db-shm; do
  if [ -f "${DATA_ROOT}/$f" ]; then PRE_SQLITE_FILES="$PRE_SQLITE_FILES $f"; fi
done

# ---------- consistent backup (fail-closed; rollback trap already armed) ----------
mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
if [ -n "$PREVIOUS" ] && [ -f "$PREVIOUS/docker-compose.ops.synology.yml" ]; then
  docker compose -f "$PREVIOUS/docker-compose.ops.synology.yml" stop 5151-ops >/dev/null 2>&1 || true
else
  docker stop 5151-ops >/dev/null 2>&1 || true
fi
for f in ops.db ops.db-wal ops.db-shm; do
  if [ -f "${DATA_ROOT}/$f" ]; then
    cp -p "${DATA_ROOT}/$f" "$BACKUP_DIR/$f" || fail "failed to snapshot $f"
  fi
done
cp -p "$AUTH_ENV" "$BACKUP_DIR/auth.env" || fail "failed to snapshot auth.env"
chmod 600 "$BACKUP_DIR/auth.env" || fail "failed to chmod auth.env snapshot"
printf 'deploy_sha=%s\nprevious=%s\nruntime_image=%s\nsqlite_files=%s\nbackup_at=%s\n' "$DEPLOY_SHA" "$PREVIOUS" "$OPS_RUNTIME_IMAGE" "$(echo $PRE_SQLITE_FILES)" "$(date -u +%FT%TZ)" > "$BACKUP_DIR/meta.txt" || fail "failed to write backup metadata"
log "backup at $BACKUP_DIR (previous=$PREVIOUS, sqlite=[$(echo $PRE_SQLITE_FILES)])"

# ---------- promote staged release (source + compose + runtime-image + sha) ----------
[ -d "$INCOMING/ops" ] || fail "incoming ops source missing at $INCOMING/ops"
[ -f "$INCOMING/docker-compose.ops.synology.yml" ] || fail "incoming compose missing at $INCOMING/docker-compose.ops.synology.yml"
mkdir -p "$RELEASES"
rm -rf "$RELEASES/$DEPLOY_SHA"
mkdir -p "$RELEASES/$DEPLOY_SHA"
mv "$INCOMING/ops" "$RELEASES/$DEPLOY_SHA/ops"
mv "$INCOMING/docker-compose.ops.synology.yml" "$RELEASES/$DEPLOY_SHA/docker-compose.ops.synology.yml"
printf '%s' "$DEPLOY_SHA" > "$RELEASES/$DEPLOY_SHA/.deployed-sha"
printf '%s' "$OPS_RUNTIME_IMAGE" > "$RELEASES/$DEPLOY_SHA/.runtime-image"

# ---------- atomic switch + recreate with new source + new image ----------
ln -sfn "$RELEASES/$DEPLOY_SHA" "$CURRENT"
OPS_RUNTIME_IMAGE="$OPS_RUNTIME_IMAGE" docker compose -f "$CURRENT/docker-compose.ops.synology.yml" up -d --no-build --no-deps --force-recreate 5151-ops

# ---------- health + identity ----------
ok=0
for _ in $(seq 1 40); do
  if curl -fsS http://127.0.0.1:5154/ops/api/health | grep -q '"ok":true'; then ok=1; break; fi
  sleep 1
done
[ "$ok" = "1" ] || { docker logs 5151-ops 2>&1 | tail -n 40 || true; fail "OPS health did not become ready"; }

MARKER="$(cat "$CURRENT/.deployed-sha" 2>/dev/null || true)"
[ "$MARKER" = "$DEPLOY_SHA" ] || fail "deployed SHA marker mismatch (got $MARKER)"
RUNNING="$(docker inspect -f '{{.State.Status}}' 5151-ops)"
[ "$RUNNING" = "running" ] || fail "container not running (state=$RUNNING)"

# new release verified: commit (EXIT trap no longer rolls back on clean exit)
DEPLOY_COMMITTED=1

# bounded retention: keep current + last 5 releases
( cd "$RELEASES" && ls -1t | tail -n +7 | xargs -r rm -rf )

log "DEPLOY_OPS_SYNOLOGY_OK source=$DEPLOY_SHA image=$OPS_RUNTIME_IMAGE previous=$PREVIOUS"

