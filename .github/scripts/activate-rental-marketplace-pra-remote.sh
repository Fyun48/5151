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

printf '%s' "$SOURCE_SHA" | grep -Eq '^[0-9a-f]{40}$' || fail "source_sha is not a 40-character lowercase hex SHA"
printf '%s' "$IMAGE_DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail "image_digest is not sha256: plus 64 lowercase hex"
printf '%s' "$BACKUP_ID" | grep -Eq '^/DATA/AppData/591-tracker-v3-backups/predeploy-[0-9]{8}-[0-9]{6}$' || fail "backup_id is not a trusted predeploy backup path"
case "$BACKUP_ID" in
  *..*|*$'\n'*|*$'\r'*) fail "backup_id contains forbidden path characters" ;;
esac
printf '%s' "$BACKUP_HASH" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail "backup_hash is not sha256: plus 64 lowercase hex"
[ -n "$DOMAIN_SCRIPT" ] && [ -f "$DOMAIN_SCRIPT" ] || fail "domain activation script is missing"

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

echo "=== domain activation (single node process, no raw SQL flag write) ==="
docker exec "$CONTAINER" rm -f /tmp/pra-activate-domain.mjs /tmp/pra-domain-result.json
docker cp "$DOMAIN_SCRIPT" "$CONTAINER:/tmp/pra-activate-domain.mjs"
set +e
docker exec -w /app "$CONTAINER" node /tmp/pra-activate-domain.mjs >/tmp/pra-activate-domain.out 2>/tmp/pra-activate-domain.err
DOMAIN_RC=$?
set -e
if [ "$DOMAIN_RC" -ne 0 ]; then
  echo "domain activation stderr (no secrets expected):"
  cat /tmp/pra-activate-domain.err || true
  docker exec "$CONTAINER" rm -f /tmp/pra-activate-domain.mjs /tmp/pra-domain-result.json || true
  fail "domain get/saveRentalMarketplaceFlags process failed (fail-closed; no raw SQL repair)"
fi
if ! docker cp "$CONTAINER:/tmp/pra-domain-result.json" /tmp/pra-domain.json; then
  docker exec "$CONTAINER" rm -f /tmp/pra-activate-domain.mjs /tmp/pra-domain-result.json || true
  fail "domain process did not write result JSON (fail-closed; no raw SQL repair)"
fi
docker exec "$CONTAINER" rm -f /tmp/pra-activate-domain.mjs /tmp/pra-domain-result.json || true
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
if doc["before_counts"] != doc["after_counts"]:
    raise SystemExit("demand_posts counts changed during activation")
print("DOMAIN_ACTIVATION_OK")
PY

echo "=== running server hydrate + post-check (no restart) ==="
curl -fsS -o /tmp/pra-demand-after.json http://127.0.0.1:5153/api/demand || fail "post-activation /api/demand failed"
curl -fsS -o /tmp/pra-health.json http://127.0.0.1:5153/api/health || fail "post-activation /api/health failed"
curl -fsS -o /dev/null http://127.0.0.1:5153/ || fail "post-activation landing failed"
curl -fsS -o /dev/null http://127.0.0.1:5153/login.html || fail "post-activation login failed"

python3 - "$POSTS_BEFORE" <<'PY'
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

AFTER_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"
AFTER_ID="$(docker inspect -f '{{.Image}}' "$CONTAINER")"
AFTER_REV="$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$AFTER_ID")"
[ "$AFTER_IMAGE" = "$PIN" ] || fail "running image digest changed after activation"
[ "$AFTER_REV" = "$SOURCE_SHA" ] || fail "OCI revision changed after activation"

python3 - "$SOURCE_SHA" "$IMAGE_DIGEST" "$BACKUP_ID" "$BACKUP_HASH" "$AFTER_IMAGE" "$AFTER_REV" <<'PY'
import json, sys
source_sha, image_digest, backup_id, backup_hash, final_image, final_rev = sys.argv[1:]
domain = json.load(open("/tmp/pra-domain.json"))
runtime = json.load(open("/tmp/pra-runtime.env"))
doc = {
    "source_sha": source_sha,
    "image_digest": image_digest,
    "backup_id": backup_id,
    "backup_hash": backup_hash,
    "backup_verified": True,
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
    "ACTIVATION_OK": True,
}
open("/tmp/pra-activation-core.json", "w").write(json.dumps(doc, indent=2) + "\n")
print("CORE_EVIDENCE_OK")
PY

echo "PRA_ACTIVATION_OK source=$SOURCE_SHA digest=$IMAGE_DIGEST"
