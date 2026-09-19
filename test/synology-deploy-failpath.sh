#!/usr/bin/env bash
# Executable deploy failure-path tests (run under bash; no NAS, no docker daemon).
# Proves: (1) explicit `fail` after start triggers rollback; (2) snapshot copy failure aborts;
# (3) failed first deploy leaves DB absent; (4) rollback removes newly created sidecars.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_SCRIPT="$SRC/.github/scripts/deploy-ops-synology-remote.sh"
[ -f "$DEPLOY_SCRIPT" ] || { echo "deploy script not found"; exit 1; }

NEW_IMAGE="ghcr.io/fyun48/5151@sha256:2222222222222222222222222222222222222222222222222222222222222222"
OLD_IMAGE="ghcr.io/fyun48/5151@sha256:1111111111111111111111111111111111111111111111111111111111111111"
KEY64="5ecf8e2a9d41b6f3c7a0e9d2b4f8a1c65ecf8e2a9d41b6f3c7a0e9d2b4f8a1c6"

fail() { echo "TEST FAIL: $*" >&2; exit 1; }

write_auth_env() {
  cat > "$1/data/auth.env" <<EOF
AUTH_EMAIL=owner@example.com
AUTH_PASSWORD=pass
OPS_SECRET_AT_REST_KEY=$KEY64
EOF
  chmod 600 "$1/data/auth.env"
}

# sandbox with a managed previous release (OLD) + ops.db (no wal/shm)
setup_nas_prev() {
  local T="$1"
  mkdir -p "$T/app/releases/OLD/ops" "$T/data" "$T/app/incoming/NEWSHA/ops"
  printf 'legacy-db' > "$T/data/ops.db"
  write_auth_env "$T"
  cat > "$T/app/releases/OLD/docker-compose.ops.synology.yml" <<'EOF'
services:
  5151-ops:
    image: ${OPS_RUNTIME_IMAGE:?required}
EOF
  printf 'OLD' > "$T/app/releases/OLD/.deployed-sha"
  printf '%s' "$OLD_IMAGE" > "$T/app/releases/OLD/.runtime-image"
  ln -s "$T/app/releases/OLD" "$T/app/current"
  printf 'x' > "$T/app/incoming/NEWSHA/ops/server.js"
  cat > "$T/app/incoming/NEWSHA/docker-compose.ops.synology.yml" <<'EOF'
services:
  5151-ops:
    image: ${OPS_RUNTIME_IMAGE:?required}
EOF
}

# mock docker + curl + stat. docker inspect returns "exited" to force a post-start failure.
mock_bin() {
  local B="$1"
  mkdir -p "$B"
  cat > "$B/docker" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  ps) echo "5151-ops";;
  inspect) echo "exited";;
  compose) exit 0;;
  stop) exit 0;;
  logs) exit 0;;
  *) exit 0;;
esac
EOF
  cat > "$B/curl" <<'EOF'
#!/usr/bin/env bash
echo '{"ok":true}'
EOF
  # stat: mock the auth.env perms probe (Windows chmod is a no-op; Linux passes the same 600).
  cat > "$B/stat" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  -c) echo "600";;
  *) exec /usr/bin/stat "$@";;
esac
EOF
  chmod +x "$B/docker" "$B/curl" "$B/stat"
}

T1="$(mktemp -d)"; T2="$(mktemp -d)"; T3="$(mktemp -d)"; T4="$(mktemp -d)"
trap 'rm -rf "$T1" "$T2" "$T3" "$T4"' EXIT

# ---- Scenario 1: explicit fail after start -> rollback restores OLD (BLOCKER 1) ----
setup_nas_prev "$T1"; mock_bin "$T1/bin"
set +e
PATH="$T1/bin:$PATH" DEPLOY_SHA="NEWSHA" OPS_RUNTIME_IMAGE="$NEW_IMAGE" \
  OPS_SYNOLOGY_APP_ROOT="$T1/app" OPS_SYNOLOGY_DATA_ROOT="$T1/data" \
  bash "$DEPLOY_SCRIPT" > "$T1/out.log" 2>&1
C1=$?
set -e
[ "$C1" != "0" ] || fail "scenario1: expected non-zero exit"
grep -q "ROLLBACK_OK" "$T1/out.log" || fail "scenario1: rollback not invoked"
[ "$(readlink -f "$T1/app/current")" = "$T1/app/releases/OLD" ] || fail "scenario1: current not rolled back to OLD"
[ -f "$T1/data/ops.db" ] || fail "scenario1: ops.db not restored"
echo "scenario1 PASS (explicit fail after start -> rollback)"

# ---- Scenario 2: snapshot copy failure -> no promotion/recreate (BLOCKER 2.1) ----
setup_nas_prev "$T2"; mock_bin "$T2/bin"
cat > "$T2/bin/cp" <<'EOF'
#!/usr/bin/env bash
if [ ! -f "$CP_FLAG" ]; then
  touch "$CP_FLAG"
  echo "cp: injected snapshot failure" >&2
  exit 1
fi
exec /usr/bin/cp "$@"
EOF
chmod +x "$T2/bin/cp"
set +e
PATH="$T2/bin:$PATH" CP_FLAG="$T2/cp.flag" DEPLOY_SHA="NEWSHA" OPS_RUNTIME_IMAGE="$NEW_IMAGE" \
  OPS_SYNOLOGY_APP_ROOT="$T2/app" OPS_SYNOLOGY_DATA_ROOT="$T2/data" \
  bash "$DEPLOY_SCRIPT" > "$T2/out.log" 2>&1
C2=$?
set -e
[ "$C2" != "0" ] || fail "scenario2: expected non-zero exit"
grep -q "failed to snapshot ops.db" "$T2/out.log" || fail "scenario2: snapshot failure not reported"
[ "$(readlink -f "$T2/app/current")" = "$T2/app/releases/OLD" ] || fail "scenario2: current should still be OLD"
[ ! -d "$T2/app/releases/NEWSHA" ] || fail "scenario2: new release must not be promoted"
[ -f "$T2/data/ops.db" ] || fail "scenario2: pre-existing ops.db must remain intact"
echo "scenario2 PASS (snapshot copy failure aborts before promotion)"

# ---- Scenario 3: first deploy, DB absent -> failed deploy leaves DB absent (BLOCKER 2.2) ----
mkdir -p "$T3/app/incoming/NEWSHA/ops" "$T3/data"
printf 'x' > "$T3/app/incoming/NEWSHA/ops/server.js"
cat > "$T3/app/incoming/NEWSHA/docker-compose.ops.synology.yml" <<'EOF'
services:
  5151-ops:
    image: ${OPS_RUNTIME_IMAGE:?required}
EOF
write_auth_env "$T3"
mock_bin "$T3/bin"
cat > "$T3/bin/docker" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  ps) exit 0;;
  inspect) echo "exited";;
  compose) exit 0;;
  stop) exit 0;;
  logs) exit 0;;
  *) exit 0;;
esac
EOF
chmod +x "$T3/bin/docker"
set +e
PATH="$T3/bin:$PATH" DEPLOY_SHA="NEWSHA" OPS_RUNTIME_IMAGE="$NEW_IMAGE" \
  OPS_SYNOLOGY_APP_ROOT="$T3/app" OPS_SYNOLOGY_DATA_ROOT="$T3/data" \
  bash "$DEPLOY_SCRIPT" > "$T3/out.log" 2>&1
C3=$?
set -e
[ "$C3" != "0" ] || fail "scenario3: expected non-zero exit"
grep -q "ROLLBACK_OK first deploy" "$T3/out.log" || fail "scenario3: first-deploy rollback not invoked"
[ ! -e "$T3/data/ops.db" ] || fail "scenario3: ops.db should remain absent after failed first deploy"
[ ! -L "$T3/app/current" ] || fail "scenario3: current should be removed"
echo "scenario3 PASS (failed first deploy leaves DB absent)"

# ---- Scenario 4: WAL/SHM absent predeploy -> rollback removes newly created sidecars (BLOCKER 2.3) ----
setup_nas_prev "$T4"; mock_bin "$T4/bin"
cat > "$T4/bin/docker" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  ps) echo "5151-ops";;
  inspect) echo "exited";;
  compose)
    if echo "$*" | grep -q ' up '; then
      if [ ! -f "$SIDECAR_FLAG" ]; then
        touch "$SIDECAR_FLAG"
        touch "$SIDECAR_ROOT/ops.db-wal" "$SIDECAR_ROOT/ops.db-shm"
      fi
    fi
    exit 0;;
  stop) exit 0;;
  logs) exit 0;;
  *) exit 0;;
esac
EOF
chmod +x "$T4/bin/docker"
set +e
PATH="$T4/bin:$PATH" SIDECAR_FLAG="$T4/sidecar.flag" SIDECAR_ROOT="$T4/data" \
  DEPLOY_SHA="NEWSHA" OPS_RUNTIME_IMAGE="$NEW_IMAGE" \
  OPS_SYNOLOGY_APP_ROOT="$T4/app" OPS_SYNOLOGY_DATA_ROOT="$T4/data" \
  bash "$DEPLOY_SCRIPT" > "$T4/out.log" 2>&1
C4=$?
set -e
[ "$C4" != "0" ] || fail "scenario4: expected non-zero exit"
grep -q "ROLLBACK_OK" "$T4/out.log" || fail "scenario4: rollback not invoked"
[ ! -e "$T4/data/ops.db-wal" ] || fail "scenario4: wal sidecar should be removed"
[ ! -e "$T4/data/ops.db-shm" ] || fail "scenario4: shm sidecar should be removed"
[ -f "$T4/data/ops.db" ] || fail "scenario4: ops.db should be restored"
echo "scenario4 PASS (rollback removes newly created sidecars)"

# ---- Scenario 5: DB restore copy failure -> ROLLBACK_FAILED, no previous recreate (BLOCKER 3) ----
T5="$(mktemp -d)"; trap 'rm -rf "$T1" "$T2" "$T3" "$T4" "$T5" "$T6"' EXIT
setup_nas_prev "$T5"; mock_bin "$T5/bin"
# mock cp: fail only when the SOURCE is under .backup/ (the rollback restore), not the snapshot.
cat > "$T5/bin/cp" <<'EOF'
#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in
    */.backup/*) echo "cp: injected restore failure" >&2; exit 1;;
  esac
done
exec /usr/bin/cp "$@"
EOF
chmod +x "$T5/bin/cp"
set +e
PATH="$T5/bin:$PATH" DEPLOY_SHA="NEWSHA" OPS_RUNTIME_IMAGE="$NEW_IMAGE" \
  OPS_SYNOLOGY_APP_ROOT="$T5/app" OPS_SYNOLOGY_DATA_ROOT="$T5/data" \
  bash "$DEPLOY_SCRIPT" > "$T5/out.log" 2>&1
C5=$?
set -e
[ "$C5" != "0" ] || fail "scenario5: expected non-zero exit"
grep -q "ROLLBACK_FAILED" "$T5/out.log" || fail "scenario5: rollback must report ROLLBACK_FAILED"
if grep -q "ROLLBACK_OK" "$T5/out.log"; then fail "scenario5: must not report ROLLBACK_OK"; fi
echo "scenario5 PASS (DB restore copy failure -> ROLLBACK_FAILED, no previous recreate)"

# ---- Scenario 6: previous health never returns -> ROLLBACK_FAILED (BLOCKER 3) ----
T6="$(mktemp -d)"
setup_nas_prev "$T6"; mock_bin "$T6/bin"
# curl: ok until a flag is created (by docker inspect), then fail (rollback health fails).
cat > "$T6/bin/curl" <<'EOF'
#!/usr/bin/env bash
if [ -f "$CURL_FAIL_FLAG" ]; then
  exit 1
fi
echo '{"ok":true}'
EOF
chmod +x "$T6/bin/curl"
cat > "$T6/bin/docker" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  ps) echo "5151-ops";;
  inspect) touch "$CURL_FAIL_FLAG"; echo "exited";;
  compose) exit 0;;
  stop) exit 0;;
  logs) exit 0;;
  *) exit 0;;
esac
EOF
chmod +x "$T6/bin/docker"
set +e
PATH="$T6/bin:$PATH" CURL_FAIL_FLAG="$T6/fail.flag" DEPLOY_SHA="NEWSHA" OPS_RUNTIME_IMAGE="$NEW_IMAGE" \
  OPS_SYNOLOGY_APP_ROOT="$T6/app" OPS_SYNOLOGY_DATA_ROOT="$T6/data" \
  bash "$DEPLOY_SCRIPT" > "$T6/out.log" 2>&1
C6=$?
set -e
[ "$C6" != "0" ] || fail "scenario6: expected non-zero exit"
grep -q "ROLLBACK_FAILED" "$T6/out.log" || fail "scenario6: rollback must report ROLLBACK_FAILED"
if grep -q "ROLLBACK_OK" "$T6/out.log"; then fail "scenario6: must not report ROLLBACK_OK"; fi
echo "scenario6 PASS (previous health failure -> ROLLBACK_FAILED)"

echo "ALL FAILURE-PATH TESTS PASS"

