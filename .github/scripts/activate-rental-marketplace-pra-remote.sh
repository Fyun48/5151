#!/usr/bin/env bash
# Runs on CasaOS/NAS via SSH. PR A flag activation only.
# No deploy, no pull, no compose, no restart, no backup delete.
set -euo pipefail

fail() {
  echo "::error::$1"
  echo "PRA_ACTIVATION_FAIL: $1"
  exit 1
}

CONTAINER="${CONTAINER:-591-tracker-v3}"
SOURCE_SHA="${SOURCE_SHA:-}"
IMAGE_DIGEST="${IMAGE_DIGEST:-}"
BACKUP_ID="${BACKUP_ID:-}"
BACKUP_HASH="${BACKUP_HASH:-}"
DOMAIN_SCRIPT="${DOMAIN_SCRIPT:-}"
EXPECTED_SRC_MANIFEST="${EXPECTED_SRC_MANIFEST:-}"
SRC_MANIFEST_PY="${SRC_MANIFEST_PY:-}"
EXPECTED_SRC_MOUNT="${EXPECTED_SRC_MOUNT:-/mnt/Storage1/apps/5151/v3/src}"
RECEIPT_NAME="pra-activation-receipt.json"

printf '%s' "$SOURCE_SHA" | grep -Eq '^[0-9a-f]{40}$' || fail "source_sha is not a 40-character lowercase hex SHA"
printf '%s' "$IMAGE_DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail "image_digest is not sha256: plus 64 lowercase hex"
printf '%s' "$BACKUP_ID" | grep -Eq '^/DATA/AppData/591-tracker-v3-backups/predeploy-[0-9]{8}-[0-9]{6}$' || fail "backup_id is not a trusted predeploy backup path"
case "$BACKUP_ID" in
  *..*|*$'\n'*|*$'\r'*) fail "backup_id contains forbidden path characters" ;;
esac
printf '%s' "$BACKUP_HASH" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail "backup_hash is not sha256: plus 64 lowercase hex"
[ -n "$DOMAIN_SCRIPT" ] && [ -f "$DOMAIN_SCRIPT" ] || fail "domain activation script is missing"
[ -n "$EXPECTED_SRC_MANIFEST" ] && [ -f "$EXPECTED_SRC_MANIFEST" ] || fail "expected v3/src manifest is missing"
[ -n "$SRC_MANIFEST_PY" ] && [ -f "$SRC_MANIFEST_PY" ] || fail "src manifest helper is missing"
[ "$EXPECTED_SRC_MOUNT" = "/mnt/Storage1/apps/5151/v3/src" ] || fail "expected src mount path is not the Production v3 src path"
RECEIPT_PATH="$BACKUP_ID/$RECEIPT_NAME"

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
python3 "$SRC_MANIFEST_PY" --from-docker "$CONTAINER" --docker-src /app/src --out /tmp/pra-src-actual.json
python3 "$SRC_MANIFEST_PY" --compare "$EXPECTED_SRC_MANIFEST" /tmp/pra-src-actual.json || fail "running /app/src does not match source_sha v3/src manifest (fail-before-save)"
TREE_SHA="$(python3 - <<'PY'
import json
print(json.load(open("/tmp/pra-src-actual.json"))["tree_sha256"])
PY
)"
echo "SRC_RUNTIME_MATCH_OK"

[ -f "$BACKUP_ID/v3.db" ] || fail "backup db missing at $BACKUP_ID/v3.db"
ACTUAL_HASH="$(sha256sum "$BACKUP_ID/v3.db" | awk '{print $1}')"
EXPECTED_HASH="${BACKUP_HASH#sha256:}"
[ "$ACTUAL_HASH" = "$EXPECTED_HASH" ] || fail "backup db sha256 does not match input backup_hash"

run_domain() {
  local mode="$1"
  docker exec "$CONTAINER" rm -f /tmp/pra-activate-domain.mjs /tmp/pra-domain-result.json /tmp/pra-domain-status.json
  docker cp "$DOMAIN_SCRIPT" "$CONTAINER:/tmp/pra-activate-domain.mjs"
  set +e
  docker exec -w /app -e PRA_DOMAIN_MODE="$mode" "$CONTAINER" node /tmp/pra-activate-domain.mjs >/tmp/pra-activate-domain.out 2>/tmp/pra-activate-domain.err
  local rc=$?
  set -e
  docker cp "$CONTAINER:/tmp/pra-domain-status.json" /tmp/pra-domain-status.json 2>/dev/null || true
  if [ "$rc" -ne 0 ]; then
    echo "domain $mode stderr (no secrets expected):"
    cat /tmp/pra-activate-domain.err || true
    docker cp "$CONTAINER:/tmp/pra-domain-result.json" /tmp/pra-domain.json 2>/dev/null || true
    docker exec "$CONTAINER" rm -f /tmp/pra-activate-domain.mjs /tmp/pra-domain-result.json /tmp/pra-domain-status.json || true
    return 1
  fi
  if ! docker cp "$CONTAINER:/tmp/pra-domain-result.json" /tmp/pra-domain.json; then
    docker exec "$CONTAINER" rm -f /tmp/pra-activate-domain.mjs /tmp/pra-domain-result.json /tmp/pra-domain-status.json || true
    return 1
  fi
  docker exec "$CONTAINER" rm -f /tmp/pra-activate-domain.mjs /tmp/pra-domain-result.json /tmp/pra-domain-status.json || true
  return 0
}

rollback_pra_flags() {
  echo "=== compensating rollback via domain API (no raw SQL) ==="
  run_domain rollback || return 1
  python3 - <<'PY'
import json
doc = json.load(open("/tmp/pra-domain.json"))
after = doc["after_raw_flags"]
reserved = (
    "owner_matching_enabled",
    "offer_enabled",
    "public_share_v2_enabled",
    "owner_notifications_enabled",
)
if doc.get("mode") != "rollback":
    raise SystemExit("rollback domain result mode is not rollback")
if after["rental_catalog_v2"]["enabled"] is not False:
    raise SystemExit("rollback rental_catalog_v2.enabled is not false")
if after["wish"]["lifecycle_enabled"] is not False:
    raise SystemExit("rollback wish.lifecycle_enabled is not false")
if any(after["wish"].get(key) is not False for key in reserved):
    raise SystemExit("rollback reserved flag is not false")
if doc["after_counts"] != {"total_posts": 0, "total_open": 0}:
    raise SystemExit("rollback demand_posts counts are not 0/0")
print("DOMAIN_ROLLBACK_OK")
PY
}

verify_runtime_off() {
  echo "=== rollback hydrate: GET /api/demand to refresh long-lived server ==="
  curl -fsS -o /tmp/pra-demand-rollback.json http://127.0.0.1:5153/api/demand || return 1
  curl -fsS -o /tmp/pra-health-rollback.json http://127.0.0.1:5153/api/health || return 1
  python3 - <<'PY'
import json
demand = json.load(open("/tmp/pra-demand-rollback.json"))
health = json.load(open("/tmp/pra-health-rollback.json"))
flags = demand.get("flags") or {}
wish = flags.get("wish") or {}
reserved = (
    "owner_matching_enabled",
    "offer_enabled",
    "public_share_v2_enabled",
    "owner_notifications_enabled",
)
if health.get("ok") is not True:
    raise SystemExit("rollback health is not ok")
if (flags.get("rental_catalog_v2") or {}).get("enabled") is not False:
    raise SystemExit("rollback runtime rental_catalog_v2.enabled is not false")
if wish.get("lifecycle_enabled") is not False:
    raise SystemExit("rollback runtime wish.lifecycle_enabled is not false")
if any(wish.get(key) is not False for key in reserved):
    raise SystemExit("rollback runtime reserved public flag is not false")
if demand.get("auto_expire") is not False:
    raise SystemExit("rollback auto_expire is not false")
if demand.get("catalog") is not None:
    raise SystemExit("rollback catalog is not null")
if len(demand.get("posts") or []) != 0:
    raise SystemExit("rollback runtime posts are not 0")
print("RUNTIME_ROLLBACK_HYDRATE_OK")
PY
}

compensate_and_fail() {
  local reason="$1"
  echo "PRA_POSTCHECK_FAIL: $reason"
  if ! rollback_pra_flags; then
    fail "post-check failed ($reason) and domain rollback failed (PRODUCTION_STATE_UNKNOWN; no raw SQL repair)"
  fi
  if ! verify_runtime_off; then
    fail "domain rollback succeeded but running server hydrate is inconsistent (PRODUCTION_STATE_UNKNOWN)"
  fi
  fail "post-check failed ($reason); PR A flags rolled back via domain API and runtime re-hydrated"
}

compensate_if_mutated() {
  local reason="$1"
  local phase="unknown"
  if [ -f /tmp/pra-domain-status.json ]; then
    phase="$(python3 - <<'PY'
import json
print(json.load(open("/tmp/pra-domain-status.json")).get("phase") or "unknown")
PY
)"
  fi
  echo "PRA_ACTIVATE_PROCESS_FAIL phase=$phase reason=$reason"
  if [ "$phase" = "before-save" ]; then
    fail "domain activate failed before mutation ($reason)"
  fi
  compensate_and_fail "$reason"
}

write_core_and_receipt() {
  local verify_only="$1"
  python3 - "$SOURCE_SHA" "$IMAGE_DIGEST" "$BACKUP_ID" "$BACKUP_HASH" "$PIN" "$SOURCE_SHA" "$SRC_MOUNT" "$TREE_SHA" "$RECEIPT_PATH" "$verify_only" <<'PY'
import json, os, sys
source_sha, image_digest, backup_id, backup_hash, final_image, final_rev, src_mount, tree_sha, receipt_path, verify_only = sys.argv[1:]
domain = json.load(open("/tmp/pra-domain.json"))
runtime = json.load(open("/tmp/pra-runtime.env"))
if domain.get("mode") not in ("activate", "inspect"):
    raise SystemExit("core evidence domain mode is not activate/inspect")
before = domain.get("before_raw_flags") or domain.get("raw_flags")
after = domain.get("after_raw_flags") or domain.get("raw_flags")
before_counts = domain.get("before_counts") or domain.get("counts")
after_counts = domain.get("after_counts") or domain.get("counts")
if verify_only == "true" and os.path.isfile(receipt_path):
    prev = json.load(open(receipt_path))
    before = prev.get("before_raw_flags") or before
    after = prev.get("after_raw_flags") or after
    before_counts = prev.get("before_counts") or before_counts
    after_counts = prev.get("after_counts") or after_counts
doc = {
    "schema": "pra-activation-receipt-v1",
    "source_sha": source_sha,
    "image_digest": image_digest,
    "backup_id": backup_id,
    "backup_hash": backup_hash,
    "backup_verified": True,
    "src_mount": src_mount,
    "src_manifest_verified": True,
    "src_tree_sha256": tree_sha,
    "receipt_path": receipt_path,
    "durable_receipt": True,
    "verify_only": verify_only == "true",
    "before_raw_flags": before,
    "after_raw_flags": after,
    "before_counts": before_counts,
    "after_counts": after_counts,
    "runtime_public_flags": runtime["runtime_public_flags"],
    "auto_expire": runtime["auto_expire"],
    "catalog_present": runtime["catalog_present"],
    "condition_count": runtime["condition_count"],
    "posts_before": runtime["posts_before"],
    "posts_after": runtime["posts_after"],
    "health": True,
    "landing": True,
    "login": True,
    "final_digest": image_digest,
    "final_image": final_image,
    "final_oci_revision": final_rev,
    "rollback_used": False,
    "ACTIVATION_OK": True,
}
blob = json.dumps(doc)
for token in ("SESSION_SECRET", "NAS_SSH_KEY", "AUTH_PASSWORD", "auth.env"):
    if token in blob:
        raise SystemExit("activation receipt must not contain secrets")
os.makedirs(os.path.dirname(receipt_path), exist_ok=True)
open(receipt_path, "w").write(json.dumps(doc, indent=2) + "\n")
open("/tmp/pra-activation-core.json", "w").write(json.dumps(doc, indent=2) + "\n")
print("DURABLE_RECEIPT_OK")
print("CORE_EVIDENCE_OK")
PY
}

hydrate_runtime_on() {
  curl -fsS -o /tmp/pra-demand-after.json http://127.0.0.1:5153/api/demand || return 1
  curl -fsS -o /tmp/pra-health.json http://127.0.0.1:5153/api/health || return 1
  curl -fsS -o /dev/null http://127.0.0.1:5153/ || return 1
  curl -fsS -o /dev/null http://127.0.0.1:5153/login.html || return 1
  python3 - <<'PY'
import json
demand = json.load(open("/tmp/pra-demand-after.json"))
health = json.load(open("/tmp/pra-health.json"))
flags = demand.get("flags") or {}
wish = flags.get("wish") or {}
reserved = (
    "owner_matching_enabled",
    "offer_enabled",
    "public_share_v2_enabled",
    "owner_notifications_enabled",
)
if health.get("ok") is not True:
    raise SystemExit("health is not ok")
if (flags.get("rental_catalog_v2") or {}).get("enabled") is not True:
    raise SystemExit("runtime rental_catalog_v2.enabled is not true")
if wish.get("lifecycle_enabled") is not True:
    raise SystemExit("runtime wish.lifecycle_enabled is not true")
if any(wish.get(key) is not False for key in reserved):
    raise SystemExit("runtime reserved public flag is not false")
if demand.get("auto_expire") is not True:
    raise SystemExit("auto_expire is not true")
if demand.get("catalog") is None:
    raise SystemExit("catalog is null")
conditions = demand.get("conditions") or []
if not conditions:
    raise SystemExit("canonical conditions are empty")
posts = len(demand.get("posts") or [])
if posts != 0:
    raise SystemExit("runtime posts are not 0")
open("/tmp/pra-runtime.env", "w").write(
    json.dumps({
        "runtime_public_flags": flags,
        "auto_expire": True,
        "catalog_present": True,
        "condition_count": len(conditions),
        "posts_before": 0,
        "posts_after": posts,
        "health": True,
        "landing": True,
        "login": True,
    })
    + "\n"
)
print("RUNTIME_HYDRATE_OK")
PY
}

echo "=== inspect current raw flags (no mutation) ==="
run_domain inspect || fail "domain inspect failed before mutation"
PATH_KIND="$(python3 - "$RECEIPT_PATH" "$SOURCE_SHA" "$IMAGE_DIGEST" "$BACKUP_ID" "$BACKUP_HASH" "$TREE_SHA" <<'PY'
import json, os, sys
receipt_path, source_sha, image_digest, backup_id, backup_hash, tree_sha = sys.argv[1:]
doc = json.load(open("/tmp/pra-domain.json"))
flags = doc["raw_flags"]
counts = doc["counts"]
reserved = (
    "owner_matching_enabled",
    "offer_enabled",
    "public_share_v2_enabled",
    "owner_notifications_enabled",
)
if doc.get("mode") != "inspect":
    raise SystemExit("inspect result mode is not inspect")
if any(flags["wish"].get(key) is not False for key in reserved):
    raise SystemExit("reserved flag is already true; STOP")
catalog = flags["rental_catalog_v2"]["enabled"]
life = flags["wish"]["lifecycle_enabled"]
if catalog is False and life is False:
    if counts != {"total_posts": 0, "total_open": 0}:
        raise SystemExit("demand_posts total/open are not exact 0/0; stop and redo backup/review")
    print("activate")
    raise SystemExit
if catalog is True and life is True:
    if not os.path.isfile(receipt_path):
        raise SystemExit("flags already true but durable receipt is missing; STOP")
    receipt = json.load(open(receipt_path))
    identity = {
        "source_sha": source_sha,
        "image_digest": image_digest,
        "backup_id": backup_id,
        "backup_hash": backup_hash,
        "src_tree_sha256": tree_sha,
    }
    for key, value in identity.items():
        if receipt.get(key) != value:
            raise SystemExit(f"flags already true but receipt {key} does not match; STOP")
    if receipt.get("ACTIVATION_OK") is not True:
        raise SystemExit("flags already true but receipt is not ACTIVATION_OK; STOP")
    print("verify-only")
    raise SystemExit
raise SystemExit("raw flags are inconsistent with a completed PR A activation; STOP")
PY
)"

echo "=== pre-activation running-server snapshot ==="
curl -fsS -o /tmp/pra-demand-before.json http://127.0.0.1:5153/api/demand || fail "pre-activation /api/demand failed"

if [ "$PATH_KIND" = "verify-only" ]; then
  echo "=== verify-only recovery (no mutation; durable receipt identity matched) ==="
  hydrate_runtime_on || fail "verify-only runtime checks failed; STOP without mutation"
  AFTER_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"
  AFTER_ID="$(docker inspect -f '{{.Image}}' "$CONTAINER")"
  AFTER_REV="$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$AFTER_ID")"
  [ "$AFTER_IMAGE" = "$PIN" ] || fail "verify-only running image digest changed"
  [ "$AFTER_REV" = "$SOURCE_SHA" ] || fail "verify-only OCI revision changed"
  write_core_and_receipt true || fail "verify-only durable receipt refresh failed"
  echo "PRA_ACTIVATION_OK verify-only source=$SOURCE_SHA digest=$IMAGE_DIGEST receipt=$RECEIPT_PATH"
  exit 0
fi

[ "$PATH_KIND" = "activate" ] || fail "unsupported activation path $PATH_KIND"

echo "=== domain activation (single node process, no raw SQL flag write) ==="
if ! run_domain activate; then
  compensate_if_mutated "domain get/saveRentalMarketplaceFlags process failed"
fi
python3 - <<'PY'
import json
doc = json.load(open("/tmp/pra-domain.json"))
before = doc["before_raw_flags"]
after = doc["after_raw_flags"]
reserved = (
    "owner_matching_enabled",
    "offer_enabled",
    "public_share_v2_enabled",
    "owner_notifications_enabled",
)
if doc.get("mode") != "activate":
    raise SystemExit("domain result mode is not activate")
if before["rental_catalog_v2"]["enabled"] is not False:
    raise SystemExit("before rental_catalog_v2.enabled is not false")
if before["wish"]["lifecycle_enabled"] is not False:
    raise SystemExit("before wish.lifecycle_enabled is not false")
if any(before["wish"].get(key) is not False for key in reserved):
    raise SystemExit("before reserved flag is not false")
if after["rental_catalog_v2"]["enabled"] is not True:
    raise SystemExit("after rental_catalog_v2.enabled is not true")
if after["wish"]["lifecycle_enabled"] is not True:
    raise SystemExit("after wish.lifecycle_enabled is not true")
if any(after["wish"].get(key) is not False for key in reserved):
    raise SystemExit("after reserved flag is not false")
if doc["before_counts"] != {"total_posts": 0, "total_open": 0}:
    raise SystemExit("before demand_posts counts are not exact 0/0")
if doc["after_counts"] != {"total_posts": 0, "total_open": 0}:
    raise SystemExit("after demand_posts counts are not exact 0/0")
print("DOMAIN_ACTIVATION_OK")
PY

echo "=== running server hydrate + post-check (no restart) ==="
hydrate_runtime_on || compensate_and_fail "runtime hydrate/public flag post-check failed"

AFTER_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"
AFTER_ID="$(docker inspect -f '{{.Image}}' "$CONTAINER")"
AFTER_REV="$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$AFTER_ID")"
[ "$AFTER_IMAGE" = "$PIN" ] || compensate_and_fail "running image digest changed after activation"
[ "$AFTER_REV" = "$SOURCE_SHA" ] || compensate_and_fail "OCI revision changed after activation"
AFTER_MOUNT="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/src"}}{{.Source}}{{end}}{{end}}' "$CONTAINER")"
[ "$AFTER_MOUNT" = "$EXPECTED_SRC_MOUNT" ] || compensate_and_fail "container /app/src mount changed after activation"

write_core_and_receipt false || compensate_and_fail "durable receipt write failed after mutation"

echo "PRA_ACTIVATION_OK source=$SOURCE_SHA digest=$IMAGE_DIGEST receipt=$RECEIPT_PATH"
