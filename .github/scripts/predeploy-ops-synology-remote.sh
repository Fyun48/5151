#!/usr/bin/env bash
# READ-ONLY Synology OPS predeploy check. No container recreate/stop/delete, no DB write, no current switch.
set -euo pipefail

APP_ROOT="${APP_ROOT:-/volume1/docker/5151-ops/app}"
DATA_ROOT="${DATA_ROOT:-/volume1/docker/5151-ops/data}"
AUTH_ENV="${DATA_ROOT}/auth.env"

say() { printf '%s\n' "$*"; }
warn() { printf 'WARN %s\n' "$*"; }

say "== docker / docker compose =="
docker --version || { echo "::error::docker not available"; exit 1; }
docker compose version || { echo "::error::docker compose not available"; exit 1; }

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
( ss -ltn 2>/dev/null | grep ':5154 ' ) || say "port 5154 not currently listening"
( docker ps -a --filter "name=5151-ops" --format 'container={{.Names}} status={{.Status}} image={{.Image}}' ) || say "no 5151-ops container"

say "== auth.env =="
if [ -f "$AUTH_ENV" ]; then
  PERMS="$(stat -c '%a' "$AUTH_ENV" 2>/dev/null || stat -f '%Lp' "$AUTH_ENV")"
  say "auth_env_perms=$PERMS"
  case "$PERMS" in 400|600) ;; *) warn "auth.env perms should be 0400/0600 (got $PERMS)";; esac
  grep -Eq '^[[:space:]]*(OPS_OWNER_EMAIL|AUTH_EMAIL)[[:space:]]*=' "$AUTH_ENV" && say "owner_email_key=present" || warn "owner email key missing"
  grep -Eq '^[[:space:]]*(OPS_OWNER_PASSWORD|AUTH_PASSWORD)[[:space:]]*=' "$AUTH_ENV" && say "owner_password_key=present" || warn "owner password key missing"
  # only validate presence + 64-hex format; NEVER print the value
  if grep -E '^[[:space:]]*OPS_SECRET_AT_REST_KEY=' "$AUTH_ENV" | sed 's/^[^=]*=//' | tr -d '"'"'"' ' | grep -Eq '^[0-9a-fA-F]{64}$'; then
    say "secret_at_rest_key=present_64hex"
  else
    warn "OPS_SECRET_AT_REST_KEY missing or not 64-hex"
  fi
else
  say "auth_env=absent (first deploy must provision it)"
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
  [ -f "$CUR/.deployed-sha" ] && say "current_deployed_sha=$(cat "$CUR/.deployed-sha")" || warn "current missing .deployed-sha"
  [ -f "$CUR/.runtime-image" ] && say "current_runtime_image=$(cat "$CUR/.runtime-image")" || warn "current missing .runtime-image"
else
  say "current=absent (first deploy)"
fi

say "== first deploy =="
if [ -L "$APP_ROOT/current" ]; then say "first_deploy=false"; else say "first_deploy=true"; fi

say "PREDEPLOY_CHECK_DONE"
