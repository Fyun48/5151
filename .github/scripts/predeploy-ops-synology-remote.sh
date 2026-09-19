#!/usr/bin/env bash
# READ-ONLY Synology OPS predeploy check. No container recreate/stop/delete, no DB write, no current switch.
# Blocking prerequisites are hard failures (exit non-zero + PREDEPLOY_RESULT=FAIL).
set -euo pipefail

APP_ROOT="${APP_ROOT:-/volume1/docker/5151-ops/app}"
DATA_ROOT="${DATA_ROOT:-/volume1/docker/5151-ops/data}"
AUTH_ENV="${DATA_ROOT}/auth.env"

say() { printf '%s\n' "$*"; }
warn() { printf 'WARN %s\n' "$*"; }
BLOCKED=0
block() { printf 'FAIL %s\n' "$*"; BLOCKED=1; }

say "== docker / docker compose =="
docker --version || { printf 'FAIL docker not available\n'; BLOCKED=1; }
docker compose version || { printf 'FAIL docker compose not available\n'; BLOCKED=1; }

say "== NAS architecture =="
say "arch=$(uname -m)"

say "== app/data root =="
say "APP_ROOT=$APP_ROOT"
say "DATA_ROOT=$DATA_ROOT"
[ -d "$APP_ROOT" ] || warn "APP_ROOT does not exist yet (first deploy will create it)"
[ -d "$DATA_ROOT" ] || warn "DATA_ROOT does not exist yet"

say "== disk free =="
df -h "$APP_ROOT" "$DATA_ROOT" 2>/dev/null || df -h /

say "== port 5154 / container status (read-only) =="
PORT_LISTENING=0
( ss -ltn 2>/dev/null | grep -q ':5154 ' ) && PORT_LISTENING=1
CONTAINER="$(docker ps -a --filter "name=5151-ops" --format '{{.Names}}' 2>/dev/null || true)"

if [ "$PORT_LISTENING" = "1" ]; then
  RUNNING="$(docker inspect -f '{{.State.Status}}' 5151-ops 2>/dev/null || echo unknown)"
  if echo "$CONTAINER" | grep -q '^5151-ops$' && [ "$RUNNING" = "running" ]; then
    BINDING="$(docker port 5151-ops 5154 2>/dev/null | tr -d '[:space:]' || true)"
    if [ "$BINDING" = "127.0.0.1:5154" ]; then
      say "port 5154 owned by running 5151-ops (loopback 127.0.0.1:5154)"
    else
      block "port 5154 listening but 5151-ops binding is not exactly 127.0.0.1:5154 (got '$BINDING')"
    fi
  else
    block "port 5154 listening but 5151-ops container is not running (ownership unproven)"
  fi
else
  say "port 5154 not currently listening"
fi
if echo "$CONTAINER" | grep -q '^5151-ops$'; then
  say "container=5151-ops present"
else
  say "no 5151-ops container"
fi

say "== auth.env =="
if [ -f "$AUTH_ENV" ]; then
  PERMS="$(stat -c '%a' "$AUTH_ENV" 2>/dev/null || stat -f '%Lp' "$AUTH_ENV")"
  say "auth_env_perms=$PERMS"
  case "$PERMS" in 400|600) ;; *) block "auth.env perms must be 0400/0600 (got $PERMS)";; esac
  grep -Eq '^[[:space:]]*(OPS_OWNER_EMAIL|AUTH_EMAIL)[[:space:]]*=' "$AUTH_ENV" && say "owner_email_key=present" || block "owner email key missing"
  grep -Eq '^[[:space:]]*(OPS_OWNER_PASSWORD|AUTH_PASSWORD)[[:space:]]*=' "$AUTH_ENV" && say "owner_password_key=present" || block "owner password key missing"
  if grep -E '^[[:space:]]*OPS_SECRET_AT_REST_KEY=' "$AUTH_ENV" | sed 's/^[^=]*=//' | tr -d '"'"'"' ' | grep -Eq '^[0-9a-fA-F]{64}$'; then
    say "secret_at_rest_key=present_64hex"
  else
    block "OPS_SECRET_AT_REST_KEY missing or not 64-hex"
  fi
else
  block "auth.env absent (first deploy must provision it before deploy)"
fi

say "== ops.db (read-only) =="
if [ -f "${DATA_ROOT}/ops.db" ]; then
  say "ops_db=present size=$(stat -c '%s' "${DATA_ROOT}/ops.db" 2>/dev/null || stat -f '%z' "${DATA_ROOT}/ops.db")"
else
  say "ops_db=absent (first deploy)"
fi

say "== current / previous release metadata =="
if [ -L "$APP_ROOT/current" ]; then
  CUR="$(readlink -f "$APP_ROOT/current" 2>/dev/null || true)"
  say "current=$CUR"
  if [ -f "$CUR/.deployed-sha" ] && [ -f "$CUR/.runtime-image" ]; then
    say "current_deployed_sha=$(cat "$CUR/.deployed-sha")"
    say "current_runtime_image=$(cat "$CUR/.runtime-image")"
  else
    block "managed current metadata incomplete (missing .deployed-sha or .runtime-image)"
  fi
else
  say "current=absent (first deploy)"
fi

# 既有 5151-ops container 但無 managed current metadata → block
if echo "$CONTAINER" | grep -q '^5151-ops$'; then
  if [ ! -L "$APP_ROOT/current" ]; then
    block "existing 5151-ops container has no managed current release metadata"
  fi
fi

say "== first deploy =="
if [ -L "$APP_ROOT/current" ]; then say "first_deploy=false"; else say "first_deploy=true"; fi

if [ "$BLOCKED" = "0" ]; then
  say "PREDEPLOY_RESULT=PASS"
else
  say "PREDEPLOY_RESULT=FAIL"
  exit 1
fi

