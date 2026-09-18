#!/usr/bin/env bash
# Issue #333 consolidated Production functional UAT - NAS side.
#
# Read-only with respect to feature flags: it never writes flags, never restarts,
# never redeploys. It copies the UAT helpers into the running container, runs the
# fixture + item harness there, and pulls the evidence back.
#
# Requires: SOURCE_SHA, IMAGE_DIGEST, BACKUP_ID, BACKUP_HASH, RUN_ID, and the two
# helper scripts already scp'd to $HELPERS_DIR.
set -euo pipefail

CONTAINER="${CONTAINER:-591-tracker-v3}"
EXPECTED_SRC_MOUNT="${EXPECTED_SRC_MOUNT:-/mnt/Storage1/apps/5151/v3/src}"
BASE_URL="${UAT_BASE_URL:-http://127.0.0.1:5153}"
HELPERS_DIR="${HELPERS_DIR:-/tmp/5151-uat-helpers}"
DOMAIN_SCRIPT="${DOMAIN_SCRIPT:-$HELPERS_DIR/.github/scripts/production-uat-stages-domain.mjs}"
WIRING_SCRIPT="${WIRING_SCRIPT:-$HELPERS_DIR/.github/scripts/production-uat-stages-wiring.mjs}"
SOURCE_SHA="${SOURCE_SHA:-}"
IMAGE_DIGEST="${IMAGE_DIGEST:-}"
BACKUP_ID="${BACKUP_ID:-}"
BACKUP_HASH="${BACKUP_HASH:-}"
RUN_ID="${RUN_ID:-local}"
RUN_ATTEMPT="${RUN_ATTEMPT:-1}"
EVIDENCE_OUT="${EVIDENCE_OUT:-/tmp/uat-evidence.json}"
CONTAINER_DIR="/tmp/issue333-uat-${RUN_ID}-${RUN_ATTEMPT}"

fail() {
  echo "UAT_STAGES_FAIL: $1" >&2
  exit 1
}

[ -n "$SOURCE_SHA" ] || fail "SOURCE_SHA is required"
[ -n "$IMAGE_DIGEST" ] || fail "IMAGE_DIGEST is required"
[ -f "$DOMAIN_SCRIPT" ] || fail "UAT domain helper is missing at $DOMAIN_SCRIPT"
[ -f "$WIRING_SCRIPT" ] || fail "UAT wiring helper is missing at $WIRING_SCRIPT"

echo "=== container + identity guards ==="
docker inspect "$CONTAINER" >/dev/null 2>&1 || fail "v3 container '$CONTAINER' is missing"
[ "$(docker inspect -f '{{.State.Status}}' "$CONTAINER")" = "running" ] || fail "v3 container is not running"
SRC_MOUNT="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/src"}}{{.Source}}{{end}}{{end}}' "$CONTAINER")"
[ "$SRC_MOUNT" = "$EXPECTED_SRC_MOUNT" ] || fail "container /app/src mount is '$SRC_MOUNT', expected $EXPECTED_SRC_MOUNT"

IMAGE_ID="$(docker inspect -f '{{.Image}}' "$CONTAINER")"
OCI_REVISION="$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$IMAGE_ID")"
REPO_DIGESTS="$(docker image inspect -f '{{range .RepoDigests}}{{.}} {{end}}' "$IMAGE_ID")"
[ "$OCI_REVISION" = "$SOURCE_SHA" ] || fail "running OCI revision '$OCI_REVISION' is not the expected source '$SOURCE_SHA'"
printf '%s' "$REPO_DIGESTS" | grep -q "${IMAGE_DIGEST#sha256:}" || fail "running image is not the expected digest $IMAGE_DIGEST"
echo "identity ok source=$SOURCE_SHA digest=$IMAGE_DIGEST backup=$BACKUP_ID@${BACKUP_HASH:0:16}"

echo "=== stage readiness (flags must be Stage 1-4 ON, outbound OFF) ==="
docker exec "$CONTAINER" node -e '
const url = process.argv[1];
const read = async (p) => { const r = await fetch(url + p); return { status: r.status, body: await r.json().catch(() => ({})) }; };
(async () => {
  const health = await read("/api/health");
  if (health.status !== 200) { console.error("READINESS_FAIL health=" + health.status); process.exit(1); }
  const exposure = await read("/api/demand/exposure");
  if (exposure.status !== 200) { console.error("READINESS_FAIL exposure=" + exposure.status); process.exit(1); }
  console.log("READINESS_HTTP_OK");
})();
' "$BASE_URL"

echo "=== run the consolidated UAT inside the container ==="
docker exec "$CONTAINER" rm -rf "$CONTAINER_DIR" || true
docker exec "$CONTAINER" mkdir -p "$CONTAINER_DIR"
docker cp "$DOMAIN_SCRIPT" "$CONTAINER:$CONTAINER_DIR/production-uat-stages-domain.mjs"
docker cp "$WIRING_SCRIPT" "$CONTAINER:$CONTAINER_DIR/production-uat-stages-wiring.mjs"

docker exec -w /app \
  -e UAT_RUN_ID="$RUN_ID-$RUN_ATTEMPT" \
  -e UAT_BASE_URL="$BASE_URL" \
  -e UAT_RESULT_PATH="$CONTAINER_DIR/evidence.json" \
  -e UAT_WORKFLOW="production-uat-stages-functional.yml" \
  -e UAT_SRC_ROOT="/app/src" \
  "$CONTAINER" node "$CONTAINER_DIR/production-uat-stages-wiring.mjs" \
  >/tmp/uat-stages-run.out 2>/tmp/uat-stages-run.err || UAT_RC=$?
UAT_RC="${UAT_RC:-0}"
echo "uat_exit=$UAT_RC"
echo "--- stdout (no secrets expected) ---"; cat /tmp/uat-stages-run.out || true
echo "--- stderr (no secrets expected) ---"; cat /tmp/uat-stages-run.err || true

docker cp "$CONTAINER:$CONTAINER_DIR/evidence.json" "$EVIDENCE_OUT" || fail "UAT evidence was not produced inside the container"
docker exec "$CONTAINER" rm -rf "$CONTAINER_DIR" || true
echo "STAGES_UAT_EVIDENCE=$EVIDENCE_OUT"

if [ "$UAT_RC" -ne 0 ]; then
  echo "STAGES_UAT_RESULT=FAIL"
  exit 1
fi
echo "STAGES_UAT_RESULT=PASS"
