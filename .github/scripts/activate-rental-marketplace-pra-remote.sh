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
echo "SRC_RUNTIME_MATCH_OK"

[ -f "$BACKUP_ID/v3.db" ] || fail "backup db missing at $BACKUP_ID/v3.db"
ACTUAL_HASH="$(sha256sum "$BACKUP_ID/v3.db" | awk '{print $1}')"
EXPECTED_HASH="${BACKUP_HASH#sha256:}"
[ "$ACTUAL_HASH" = "$EXPECTED_HASH" ] || fail "backup db sha256 does not match input backup_hash"

echo "=== pre-activation running-server snapshot ==="
curl -fsS -o /tmp/pra-demand-before.json http://127.0.0.1:5153/api/demand || fail "pre-activation /api/demand failed"
POSTS_BEFORE="$(python3 - <<'PY'
import json
doc = json.load(open("/tmp/pra-demand-before.json"))
print(len(doc.get("posts") or []))
PY
)"

run_domain() {
  local mode="$1"
  docker exec "$CONTAINER" rm -f /tmp/pra-activate-domain.mjs /tmp/pra-domain-result.json
  docker cp "$DOMAIN_SCRIPT" "$CONTAINER:/tmp/pra-activate-domain.mjs"
  set +e
  docker exec -w /app -e PRA_DOMAIN_MODE="$mode" "$CONTAINER" node /tmp/pra-activate-domain.mjs >/tmp/pra-activate-domain.out 2>/tmp/pra-activate-domain.err
  local rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    echo "domain $mode stderr (no secrets expected):"
    cat /tmp/pra-activate-domain.err || true
    docker exec "$CONTAINER" rm -f /tmp/pra-activate-domain.mjs /tmp/pra-domain-result.json || true
    return 1
  fi
  if ! docker cp "$CONTAINER:/tmp/pra-domain-result.json" /tmp/pra-domain.json; then
    docker exec "$CONTAINER" rm -f /tmp/pra-activate-domain.mjs /tmp/pra-domain-result.json || true
    return 1
  fi
  docker exec "$CONTAINER" rm -f /tmp/pra-activate-domain.mjs /tmp/pra-domain-result.json || true
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

compensate_and_fail() {
  local reason="$1"
  echo "PRA_POSTCHECK_FAIL: $reason"
  if ! rollback_pra_flags; then
    fail "post-check failed ($reason) and domain rollback failed (PRODUCTION_STATE_UNKNOWN; no raw SQL repair)"
  fi
  fail "post-check failed ($reason); PR A flags rolled back via domain API"
}

echo "=== domain activation (single node process, no raw SQL flag write) ==="
run_domain activate || fail "domain get/saveRentalMarketplaceFlags process failed (fail-closed; no raw SQL repair)"
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
curl -fsS -o /tmp/pra-demand-after.json http://127.0.0.1:5153/api/demand || compensate_and_fail "post-activation /api/demand failed"
curl -fsS -o /tmp/pra-health.json http://127.0.0.1:5153/api/health || compensate_and_fail "post-activation /api/health failed"
curl -fsS -o /dev/null http://127.0.0.1:5153/ || compensate_and_fail "post-activation landing failed"
curl -fsS -o /dev/null http://127.0.0.1:5153/login.html || compensate_and_fail "post-activation login failed"

if ! python3 - "$POSTS_BEFORE" <<'PY'
import json, sys
before_posts = int(sys.argv[1])
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
if posts != before_posts:
    raise SystemExit(f"runtime posts changed: before={before_posts} after={posts}")
if before_posts != 0 or posts != 0:
    raise SystemExit("runtime posts are not 0 after 0/0 activation")
open("/tmp/pra-runtime.env", "w").write(
    json.dumps({
        "runtime_public_flags": flags,
        "auto_expire": True,
        "catalog_present": True,
        "condition_count": len(conditions),
        "posts_before": before_posts,
        "posts_after": posts,
        "health": True,
        "landing": True,
        "login": True,
    })
    + "\n"
)
print("RUNTIME_HYDRATE_OK")
PY
then
  compensate_and_fail "runtime hydrate/public flag post-check failed"
fi

AFTER_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"
AFTER_ID="$(docker inspect -f '{{.Image}}' "$CONTAINER")"
AFTER_REV="$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$AFTER_ID")"
[ "$AFTER_IMAGE" = "$PIN" ] || compensate_and_fail "running image digest changed after activation"
[ "$AFTER_REV" = "$SOURCE_SHA" ] || compensate_and_fail "OCI revision changed after activation"
AFTER_MOUNT="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/src"}}{{.Source}}{{end}}{{end}}' "$CONTAINER")"
[ "$AFTER_MOUNT" = "$EXPECTED_SRC_MOUNT" ] || compensate_and_fail "container /app/src mount changed after activation"

TREE_SHA="$(python3 - <<'PY'
import json
print(json.load(open("/tmp/pra-src-actual.json"))["tree_sha256"])
PY
)"

python3 - "$SOURCE_SHA" "$IMAGE_DIGEST" "$BACKUP_ID" "$BACKUP_HASH" "$AFTER_IMAGE" "$AFTER_REV" "$SRC_MOUNT" "$TREE_SHA" <<'PY'
import json, sys
source_sha, image_digest, backup_id, backup_hash, final_image, final_rev, src_mount, tree_sha = sys.argv[1:]
domain = json.load(open("/tmp/pra-domain.json"))
runtime = json.load(open("/tmp/pra-runtime.env"))
doc = {
    "source_sha": source_sha,
    "image_digest": image_digest,
    "backup_id": backup_id,
    "backup_hash": backup_hash,
    "backup_verified": True,
    "src_mount": src_mount,
    "src_manifest_verified": True,
    "src_tree_sha256": tree_sha,
    "before_raw_flags": domain["before_raw_flags"],
    "after_raw_flags": domain["after_raw_flags"],
    "before_counts": domain["before_counts"],
    "after_counts": domain["after_counts"],
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
open("/tmp/pra-activation-core.json", "w").write(json.dumps(doc, indent=2) + "\n")
print("CORE_EVIDENCE_OK")
PY

echo "PRA_ACTIVATION_OK source=$SOURCE_SHA digest=$IMAGE_DIGEST"
