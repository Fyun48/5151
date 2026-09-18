#!/usr/bin/env bash
# Runs on CasaOS/NAS via SSH. Stage 1 fixture prepare/verify/cleanup only.
# No deploy, no pull, no compose, no restart, no feature-flag mutation.
set -euo pipefail

fail() {
  echo "::error::$1"
  echo "STAGE1_FIXTURE_FAIL: $1"
  exit 1
}

CONTAINER="${CONTAINER:-591-tracker-v3}"
SOURCE_SHA="${SOURCE_SHA:-}"
IMAGE_DIGEST="${IMAGE_DIGEST:-}"
BACKUP_ID="${BACKUP_ID:-}"
BACKUP_HASH="${BACKUP_HASH:-}"
OWNER_AUTHORIZATION="${OWNER_AUTHORIZATION:-}"
FIXTURE_MODE="${FIXTURE_MODE:-verify}"
DOMAIN_SCRIPT="${DOMAIN_SCRIPT:-}"
EVIDENCE_SCRIPT="${EVIDENCE_SCRIPT:-}"
EXPECTED_SRC_MANIFEST="${EXPECTED_SRC_MANIFEST:-}"
SRC_MANIFEST_PY="${SRC_MANIFEST_PY:-}"
EXPECTED_SRC_MOUNT="${EXPECTED_SRC_MOUNT:-/mnt/Storage1/apps/5151/v3/src}"
RUN_ID="${RUN_ID:-${GITHUB_RUN_ID:-local}}"
RUN_ATTEMPT="${RUN_ATTEMPT:-${GITHUB_RUN_ATTEMPT:-1}}"
# Per-run unique transient fixture evidence (P1-9). Never reuse a prior run's fixed path.
FIXTURE_CORE_PATH="/tmp/stage1-fixture-core-${RUN_ID}-${RUN_ATTEMPT}.json"

printf '%s' "$SOURCE_SHA" | grep -Eq '^[0-9a-f]{40}$' || fail "source_sha is not a 40-character lowercase hex SHA"
printf '%s' "$IMAGE_DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail "image_digest is not sha256: plus 64 lowercase hex"
printf '%s' "$BACKUP_ID" | grep -Eq '^/DATA/AppData/591-tracker-v3-backups/predeploy-[0-9]{8}-[0-9]{6}$' || fail "backup_id is not a trusted predeploy backup path"
case "$BACKUP_ID" in
  *..*|*$'\n'*|*$'\r'*) fail "backup_id contains forbidden path characters" ;;
esac
printf '%s' "$BACKUP_HASH" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail "backup_hash is not sha256: plus 64 lowercase hex"
case "$FIXTURE_MODE" in
  prepare|verify|cleanup|reap-stale) ;;
  *) fail "FIXTURE_MODE must be prepare, verify, cleanup, or reap-stale" ;;
esac
EXPECTED_AUTH="AUTHORIZE-STAGE1-FIXTURES:${FIXTURE_MODE}:${SOURCE_SHA}:${IMAGE_DIGEST}:${BACKUP_ID}:${BACKUP_HASH}"
[ "$OWNER_AUTHORIZATION" = "$EXPECTED_AUTH" ] || fail "owner_authorization is not bound to this fixture mode/source SHA/digest/backup"
[ -n "$DOMAIN_SCRIPT" ] && [ -f "$DOMAIN_SCRIPT" ] || fail "fixture domain script is missing"
[ -n "$EVIDENCE_SCRIPT" ] && [ -f "$EVIDENCE_SCRIPT" ] || fail "fixture evidence contract script is missing"
[ -n "$EXPECTED_SRC_MANIFEST" ] && [ -f "$EXPECTED_SRC_MANIFEST" ] || fail "expected v3/src manifest is missing"
[ -n "$SRC_MANIFEST_PY" ] && [ -f "$SRC_MANIFEST_PY" ] || fail "src manifest helper is missing"
[ "$EXPECTED_SRC_MOUNT" = "/mnt/Storage1/apps/5151/v3/src" ] || fail "expected src mount path is not the Production v3 src path"

docker inspect "$CONTAINER" >/dev/null 2>&1 || fail "v3 container '$CONTAINER' is missing"
STATE="$(docker inspect -f '{{.State.Status}}' "$CONTAINER")"
[ "$STATE" = "running" ] || fail "v3 container is not running (state=$STATE)"

IMAGE_ID="$(docker inspect -f '{{.Image}}' "$CONTAINER")"
[ -n "$IMAGE_ID" ] || fail "container image id is empty"
CFG_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"
PIN="ghcr.io/fyun48/5151@${IMAGE_DIGEST}"
[ "$CFG_IMAGE" = "$PIN" ] || fail "running Config.Image is not the requested digest pin"

REPO_DIGESTS="$(docker image inspect -f '{{range .RepoDigests}}{{.}} {{end}}' "$IMAGE_ID")"
printf '%s' "$REPO_DIGESTS" | grep -Fq "$PIN" || fail "running RepoDigest does not include the requested digest"
DIGEST_MATCH=0
for raw in $REPO_DIGESTS "$CFG_IMAGE"; do
  found="$(printf '%s' "$raw" | grep -Eo 'sha256:[0-9a-f]{64}' || true)"
  if [ "$found" = "$IMAGE_DIGEST" ]; then
    DIGEST_MATCH=1
  fi
done
[ "$DIGEST_MATCH" = 1 ] || fail "running RepoDigest does not exactly equal input image_digest"

OCI_REVISION="$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$IMAGE_ID")"
[ "$OCI_REVISION" = "$SOURCE_SHA" ] || fail "OCI revision '$OCI_REVISION' != source_sha $SOURCE_SHA"

echo "=== runtime source integrity (bind-mount /app/src vs source_sha tree) ==="
SRC_MOUNT="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/src"}}{{.Source}}{{end}}{{end}}' "$CONTAINER")"
[ "$SRC_MOUNT" = "$EXPECTED_SRC_MOUNT" ] || fail "container /app/src mount is '$SRC_MOUNT', expected $EXPECTED_SRC_MOUNT"
python3 "$SRC_MANIFEST_PY" --from-docker "$CONTAINER" --docker-src /app/src --out /tmp/stage1-fixture-src-actual.json
python3 "$SRC_MANIFEST_PY" --compare "$EXPECTED_SRC_MANIFEST" /tmp/stage1-fixture-src-actual.json || fail "running /app/src does not match source_sha v3/src manifest"
echo "SRC_RUNTIME_MATCH_OK"

if [ ! -f "$BACKUP_ID/v3.db" ]; then
  fail "backup db is missing"
fi
ACTUAL_BACKUP_HASH="sha256:$(sha256sum "$BACKUP_ID/v3.db" | awk '{print $1}')"
[ "$ACTUAL_BACKUP_HASH" = "$BACKUP_HASH" ] || fail "backup hash does not match verified predeploy backup"
echo "BACKUP_VERIFIED_OK"

if ! docker exec "$CONTAINER" test -f /app/src/stage1FixtureOps.js; then
  fail "running image is missing stage1FixtureOps.js; deploy this SHA before creating fixtures"
fi

echo "=== fixture domain $FIXTURE_MODE (no flag mutation) ==="
docker exec "$CONTAINER" rm -f /tmp/stage1-fixture-domain.mjs /tmp/stage1-fixture-result.json
docker cp "$DOMAIN_SCRIPT" "$CONTAINER:/tmp/stage1-fixture-domain.mjs"
if ! docker exec -w /app \
  -e STAGE1_FIXTURE_MODE="$FIXTURE_MODE" \
  -e STAGE1_FIXTURE_RUN_ID="${STAGE1_FIXTURE_RUN_ID:-}" \
  -e STAGE1_FIXTURE_RESULT_PATH=/tmp/stage1-fixture-result.json \
  -e STAGE1_FIXTURE_SRC_ROOT=/app/src \
  -e GITHUB_RUN_ID="${GITHUB_RUN_ID:-local}" \
  "$CONTAINER" node /tmp/stage1-fixture-domain.mjs; then
  docker cp "$CONTAINER:/tmp/stage1-fixture-result.json" /tmp/stage1-fixture-result.json 2>/dev/null || true
  docker exec "$CONTAINER" rm -f /tmp/stage1-fixture-domain.mjs /tmp/stage1-fixture-result.json || true
  fail "fixture domain $FIXTURE_MODE failed"
fi
docker cp "$CONTAINER:/tmp/stage1-fixture-result.json" /tmp/stage1-fixture-result.json
docker exec "$CONTAINER" rm -f /tmp/stage1-fixture-domain.mjs /tmp/stage1-fixture-result.json || true

python3 - "$SOURCE_SHA" "$IMAGE_DIGEST" "$BACKUP_ID" "$BACKUP_HASH" "$FIXTURE_MODE" "$RUN_ID" "$RUN_ATTEMPT" "$FIXTURE_CORE_PATH" <<'PY'
import json, sys
from datetime import datetime, timezone
source_sha, image_digest, backup_id, backup_hash, mode, run_id, attempt, out_path = sys.argv[1:]
domain = json.load(open("/tmp/stage1-fixture-result.json"))
if domain.get("flags_mutated") is True:
    raise SystemExit("fixture domain mutated flags")
if domain.get("owner_matching_enabled") is not False:
    raise SystemExit("owner_matching_enabled is not false")
doc = {
    "schema": "stage1-fixture-core-v1",
    "timestamp": datetime.now(timezone.utc).isoformat(),
    "mode": mode,
    "workflow_run_id": run_id,
    "workflow_attempt": attempt,
    "source_sha": source_sha,
    "image_digest": image_digest,
    "backup_id": backup_id,
    "backup_hash": backup_hash,
    "flags_mutated": False,
    "owner_matching_enabled": False,
    "before_raw_flags": domain.get("before_raw_flags"),
    "after_raw_flags": domain.get("after_raw_flags"),
    "result": domain.get("result"),
}
open(out_path, "w", encoding="utf-8").write(json.dumps(doc, indent=2) + "\n")
print("FIXTURE_CORE_OK")
PY
python3 "$EVIDENCE_SCRIPT" "$FIXTURE_CORE_PATH"
echo "STAGE1_FIXTURE_DOMAIN_OK"
