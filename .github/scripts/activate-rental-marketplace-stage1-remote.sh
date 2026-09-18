#!/usr/bin/env bash
# Runs on CasaOS/NAS via SSH. Stage 1 owner_matching activation only.
# No deploy, no pull, no compose, no restart, no backup delete.
# Compensating rollback turns only owner_matching_enabled back to false.
set -euo pipefail

fail() {
  echo "::error::$1"
  echo "STAGE1_ACTIVATION_FAIL: $1"
  exit 1
}

CONTAINER="${CONTAINER:-591-tracker-v3}"
SOURCE_SHA="${SOURCE_SHA:-}"
IMAGE_DIGEST="${IMAGE_DIGEST:-}"
BACKUP_ID="${BACKUP_ID:-}"
BACKUP_HASH="${BACKUP_HASH:-}"
OWNER_AUTHORIZATION="${OWNER_AUTHORIZATION:-}"
DOMAIN_SCRIPT="${DOMAIN_SCRIPT:-}"
PATH_SCRIPT="${PATH_SCRIPT:-}"
EVIDENCE_SCRIPT="${EVIDENCE_SCRIPT:-}"
POSTCHECK_SCRIPT="${POSTCHECK_SCRIPT:-}"
EXPECTED_SRC_MANIFEST="${EXPECTED_SRC_MANIFEST:-}"
SRC_MANIFEST_PY="${SRC_MANIFEST_PY:-}"
EXPECTED_SRC_MOUNT="${EXPECTED_SRC_MOUNT:-/mnt/Storage1/apps/5151/v3/src}"
RECEIPT_NAME="stage1-activation-receipt.json"
FIXTURE_DOMAIN_SCRIPT="${FIXTURE_DOMAIN_SCRIPT:-}"
RUN_ID="${RUN_ID:-${GITHUB_RUN_ID:-local}}"
RUN_ATTEMPT="${RUN_ATTEMPT:-${GITHUB_RUN_ATTEMPT:-1}}"
# Per-run unique transient evidence (P1-9). Never reuse a prior run's fixed path.
CORE_EVIDENCE_PATH="/tmp/stage1-activation-core-${RUN_ID}-${RUN_ATTEMPT}.json"
ROLLBACK_EVIDENCE_PATH="/tmp/stage1-rollback-evidence-${RUN_ID}-${RUN_ATTEMPT}.json"
FIXTURE_RUN_ID=""
FIXTURE_READINESS_AT=""

printf '%s' "$SOURCE_SHA" | grep -Eq '^[0-9a-f]{40}$' || fail "source_sha is not a 40-character lowercase hex SHA"
printf '%s' "$IMAGE_DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail "image_digest is not sha256: plus 64 lowercase hex"
printf '%s' "$BACKUP_ID" | grep -Eq '^/DATA/AppData/591-tracker-v3-backups/predeploy-[0-9]{8}-[0-9]{6}$' || fail "backup_id is not a trusted predeploy backup path"
case "$BACKUP_ID" in
  *..*|*$'\n'*|*$'\r'*) fail "backup_id contains forbidden path characters" ;;
esac
printf '%s' "$BACKUP_HASH" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail "backup_hash is not sha256: plus 64 lowercase hex"
EXPECTED_AUTH="AUTHORIZE-STAGE1:${SOURCE_SHA}:${IMAGE_DIGEST}:${BACKUP_ID}:${BACKUP_HASH}"
[ "$OWNER_AUTHORIZATION" = "$EXPECTED_AUTH" ] || fail "owner_authorization is not bound to this source SHA/digest/backup"
[ -n "$DOMAIN_SCRIPT" ] && [ -f "$DOMAIN_SCRIPT" ] || fail "domain activation script is missing"
[ -n "$PATH_SCRIPT" ] && [ -f "$PATH_SCRIPT" ] || fail "stage1 path classifier is missing"
[ -n "$EVIDENCE_SCRIPT" ] && [ -f "$EVIDENCE_SCRIPT" ] || fail "stage1 evidence contract script is missing"
[ -n "$POSTCHECK_SCRIPT" ] && [ -f "$POSTCHECK_SCRIPT" ] || fail "stage1 post-activation probe script is missing"
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
python3 "$SRC_MANIFEST_PY" --from-docker "$CONTAINER" --docker-src /app/src --out /tmp/stage1-src-actual.json
python3 "$SRC_MANIFEST_PY" --compare "$EXPECTED_SRC_MANIFEST" /tmp/stage1-src-actual.json || fail "running /app/src does not match source_sha v3/src manifest (fail-before-save)"
TREE_SHA="$(python3 - <<'PY'
import json
print(json.load(open("/tmp/stage1-src-actual.json"))["tree_sha256"])
PY
)"
echo "SRC_RUNTIME_MATCH_OK"

[ -f "$BACKUP_ID/v3.db" ] || fail "backup db missing at $BACKUP_ID/v3.db"
ACTUAL_HASH="$(sha256sum "$BACKUP_ID/v3.db" | awk '{print $1}')"
EXPECTED_HASH="${BACKUP_HASH#sha256:}"
[ "$ACTUAL_HASH" = "$EXPECTED_HASH" ] || fail "backup db sha256 does not match input backup_hash"

PROBE_LOG=/tmp/stage1-probe-log.jsonl
: > "$PROBE_LOG"

record_probe() {
  python3 - "$1" "$2" "$3" "$4" "$5" "$PROBE_LOG" <<'PY'
import json, sys
url, status, elapsed, five, busy, dest = sys.argv[1:]
open(dest, "a", encoding="utf-8").write(json.dumps({
    "url": url,
    "status": int(status) if str(status).isdigit() else 0,
    "elapsed_ms": int(elapsed),
    "http_5xx": five == "1",
    "sqlite_busy": busy == "1",
}) + "\n")
PY
}

http_probe() {
  local dest="$1"
  local url="$2"
  local extra="${3:-}"
  local started ended elapsed status
  local busy=0 five=0
  started="$(date +%s%3N)"
  set +e
  status="$(curl -sS --max-time 8 -o "$dest" -w '%{http_code}' $extra "$url" 2>/tmp/stage1-curl.err)"
  local rc=$?
  set -e
  ended="$(date +%s%3N)"
  elapsed=$((ended - started))
  if [ "$rc" -ne 0 ]; then
    echo "curl_error url=$url rc=$rc" >&2
    cat /tmp/stage1-curl.err >&2 || true
    record_probe "$url" "${status:-0}" "$elapsed" 0 0
    return 1
  fi
  if grep -Eqi 'SQLITE_BUSY|database is locked' "$dest" /tmp/stage1-curl.err 2>/dev/null; then
    busy=1
  fi
  if [ "${status:0:1}" = "5" ]; then
    five=1
  fi
  record_probe "$url" "$status" "$elapsed" "$five" "$busy"
  if [ "$busy" = 1 ]; then
    echo "sqlite_busy url=$url" >&2
    return 1
  fi
  if [ "$five" = 1 ]; then
    echo "http_5xx url=$url status=$status" >&2
    return 1
  fi
  printf '%s %s\n' "$status" "$elapsed"
}

run_domain() {
  local mode="$1"
  docker exec "$CONTAINER" rm -f /tmp/stage1-activate-domain.mjs /tmp/stage1-domain-result.json /tmp/stage1-domain-status.json
  docker cp "$DOMAIN_SCRIPT" "$CONTAINER:/tmp/stage1-activate-domain.mjs"
  set +e
  docker exec -w /app -e STAGE1_DOMAIN_MODE="$mode" \
    -e STAGE1_DOMAIN_STATUS_PATH=/tmp/stage1-domain-status.json \
    -e STAGE1_DOMAIN_RESULT_PATH=/tmp/stage1-domain-result.json \
    "$CONTAINER" node /tmp/stage1-activate-domain.mjs >/tmp/stage1-activate-domain.out 2>/tmp/stage1-activate-domain.err
  local rc=$?
  set -e
  docker cp "$CONTAINER:/tmp/stage1-domain-status.json" /tmp/stage1-domain-status.json 2>/dev/null || true
  if [ "$rc" -ne 0 ]; then
    echo "domain $mode stderr (no secrets expected):"
    cat /tmp/stage1-activate-domain.err || true
    docker cp "$CONTAINER:/tmp/stage1-domain-result.json" /tmp/stage1-domain.json 2>/dev/null || true
    docker exec "$CONTAINER" rm -f /tmp/stage1-activate-domain.mjs /tmp/stage1-domain-result.json /tmp/stage1-domain-status.json || true
    return 1
  fi
  if ! docker cp "$CONTAINER:/tmp/stage1-domain-result.json" /tmp/stage1-domain.json; then
    docker exec "$CONTAINER" rm -f /tmp/stage1-activate-domain.mjs /tmp/stage1-domain-result.json /tmp/stage1-domain-status.json || true
    return 1
  fi
  docker exec "$CONTAINER" rm -f /tmp/stage1-activate-domain.mjs /tmp/stage1-domain-result.json /tmp/stage1-domain-status.json || true
  return 0
}

run_fixture_domain() {
  local mode="$1"
  [ -n "$FIXTURE_DOMAIN_SCRIPT" ] && [ -f "$FIXTURE_DOMAIN_SCRIPT" ] || fail "fixture domain script is missing"
  docker exec "$CONTAINER" rm -f /tmp/stage1-fixture-domain.mjs /tmp/stage1-fixture-result.json
  docker cp "$FIXTURE_DOMAIN_SCRIPT" "$CONTAINER:/tmp/stage1-fixture-domain.mjs"
  set +e
  docker exec -w /app \
    -e STAGE1_FIXTURE_MODE="$mode" \
    -e STAGE1_FIXTURE_RUN_ID="${FIXTURE_RUN_ID:-}" \
    -e STAGE1_FIXTURE_RESULT_PATH=/tmp/stage1-fixture-result.json \
    -e STAGE1_FIXTURE_SRC_ROOT=/app/src \
    -e GITHUB_RUN_ID="${RUN_ID}" \
    "$CONTAINER" node /tmp/stage1-fixture-domain.mjs >/tmp/stage1-fixture-domain.out 2>/tmp/stage1-fixture-domain.err
  local rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    echo "fixture domain $mode stderr (no secrets expected):"
    cat /tmp/stage1-fixture-domain.err || true
    docker exec "$CONTAINER" rm -f /tmp/stage1-fixture-domain.mjs /tmp/stage1-fixture-result.json || true
    return 1
  fi
  if ! docker cp "$CONTAINER:/tmp/stage1-fixture-result.json" /tmp/stage1-fixture-result.json; then
    docker exec "$CONTAINER" rm -f /tmp/stage1-fixture-domain.mjs /tmp/stage1-fixture-result.json || true
    return 1
  fi
  docker exec "$CONTAINER" rm -f /tmp/stage1-fixture-domain.mjs /tmp/stage1-fixture-result.json || true
  return 0
}

rollback_stage1_flag() {
  echo "=== compensating rollback via domain API (only owner_matching_enabled=false) ==="
  run_domain rollback || return 1
  python3 - <<'PY'
import json
doc = json.load(open("/tmp/stage1-domain.json"))
after = doc["after_raw_flags"]
later = (
    "offer_enabled",
    "public_share_v2_enabled",
    "owner_notifications_enabled",
    "notifications_enabled",
    "digest_enabled",
    "outbound_mail_enabled",
    "outbound_push_enabled",
)
if doc.get("mode") != "rollback":
    raise SystemExit("rollback domain result mode is not rollback")
if after["rental_catalog_v2"]["enabled"] is not True:
    raise SystemExit("rollback rental_catalog_v2.enabled is not true")
if after["wish"]["lifecycle_enabled"] is not True:
    raise SystemExit("rollback wish.lifecycle_enabled is not true")
if after["wish"].get("owner_matching_enabled") is not False:
    raise SystemExit("rollback wish.owner_matching_enabled is not false")
if any(after["wish"].get(key) is not False for key in later):
    raise SystemExit("rollback Stage 2-4/outbound flag is not false")
print("DOMAIN_ROLLBACK_OK")
PY
}

verify_runtime_stage1_off() {
  echo "=== rollback hydrate: GET /api/demand/aggregate + /api/demand/exposure ==="
  agg="$(http_probe /tmp/stage1-aggregate-rollback.json http://127.0.0.1:5153/api/demand/aggregate)" || return 1
  exp="$(http_probe /tmp/stage1-exposure-rollback.json http://127.0.0.1:5153/api/demand/exposure)" || return 1
  health="$(http_probe /tmp/stage1-health-rollback.json http://127.0.0.1:5153/api/health)" || return 1
  python3 - <<PY
import json
agg = json.load(open("/tmp/stage1-aggregate-rollback.json"))
exp = json.load(open("/tmp/stage1-exposure-rollback.json"))
health = json.load(open("/tmp/stage1-health-rollback.json"))
agg_status, _elapsed = "$agg".split()
if health.get("ok") is not True:
    raise SystemExit("rollback health is not ok")
if exp.get("enabled") is not False:
    raise SystemExit("rollback exposure.enabled is not false")
if agg_status != "404" or agg.get("code") != "owner_matching_disabled":
    raise SystemExit("rollback aggregate is not owner_matching_disabled")
print("RUNTIME_ROLLBACK_HYDRATE_OK")
PY
}

write_rollback_evidence() {
  local reason="$1"
  local ok="$2"
  python3 - "$reason" "$ok" "$RUN_ID" "$RUN_ATTEMPT" "$ROLLBACK_EVIDENCE_PATH" <<'PY'
import json, sys
from datetime import datetime, timezone
reason, ok, run_id, attempt, out_path = sys.argv[1:]
domain = {}
try:
    domain = json.load(open("/tmp/stage1-domain.json"))
except Exception:
    domain = {}
after = domain.get("after_raw_flags") or {}
wish = (after.get("wish") or {})
doc = {
    "schema": "stage1-rollback-evidence-v1",
    "timestamp": datetime.now(timezone.utc).isoformat(),
    "workflow_run_id": run_id,
    "workflow_attempt": attempt,
    "reason": reason,
    "rollback_used": True,
    "rollback_ok": ok == "true",
    "after_owner_matching_enabled": wish.get("owner_matching_enabled"),
    "authoritative_source": "post_activation_authenticated_probes",
}
open(out_path, "w", encoding="utf-8").write(json.dumps(doc, indent=2) + "\n")
print("ROLLBACK_EVIDENCE_OK")
PY
}

compensate_and_fail() {
  local reason="$1"
  echo "STAGE1_POSTCHECK_FAIL: $reason"
  if ! rollback_stage1_flag; then
    write_rollback_evidence "$reason" false || true
    fail "post-check failed ($reason) and domain rollback failed (PRODUCTION_STATE_UNKNOWN; no raw SQL repair)"
  fi
  if ! verify_runtime_stage1_off; then
    write_rollback_evidence "$reason" false || true
    fail "domain rollback succeeded but running server hydrate is inconsistent (PRODUCTION_STATE_UNKNOWN)"
  fi
  write_rollback_evidence "$reason" true || true
  fail "post-check failed ($reason); Stage 1 flag rolled back via domain API; PR A flags left ON"
}

compensate_if_mutated() {
  local reason="$1"
  local phase="unknown"
  if [ -f /tmp/stage1-domain-status.json ]; then
    phase="$(python3 - <<'PY'
import json
print(json.load(open("/tmp/stage1-domain-status.json")).get("phase") or "unknown")
PY
)"
  fi
  echo "STAGE1_ACTIVATE_PROCESS_FAIL phase=$phase reason=$reason"
  if [ "$phase" = "before-save" ] || [ "$phase" = "already-on" ]; then
    fail "domain activate failed before mutation ($reason)"
  fi
  compensate_and_fail "$reason"
}

assert_no_pii() {
  local file="$1"
  python3 - "$file" <<'PY'
import json, re, sys
path = sys.argv[1]
raw = open(path, encoding="utf-8").read()
blob = json.loads(raw) if raw.strip().startswith("{") or raw.strip().startswith("[") else {}
text = json.dumps(blob, ensure_ascii=False)
forbidden = (
    "SESSION_SECRET", "NAS_SSH_KEY", "AUTH_PASSWORD", "auth.env",
    "rank_score", "freshness_score", "activity_score", "wish_id", "last_active_at",
)
for token in forbidden:
    if token in text:
        raise SystemExit(f"privacy leak token {token} in {path}")
if re.search(r"09\d{8}", text):
    raise SystemExit(f"privacy leak phone in {path}")
if re.search(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", text):
    raise SystemExit(f"privacy leak email in {path}")
print("PRIVACY_OK")
PY
}

run_post_activation_probes() {
  echo "=== post-activation authenticated matching probes (Stage 1 ON) ==="
  docker exec "$CONTAINER" rm -f /tmp/stage1-postcheck.mjs /tmp/stage1-post-activation.json
  docker cp "$POSTCHECK_SCRIPT" "$CONTAINER:/tmp/stage1-postcheck.mjs"
  set +e
  docker exec -w /app \
    -e STAGE1_POSTCHECK_BASE_URL=http://127.0.0.1:5153 \
    -e STAGE1_POSTCHECK_RESULT_PATH=/tmp/stage1-post-activation.json \
    "$CONTAINER" node /tmp/stage1-postcheck.mjs >/tmp/stage1-postcheck.out 2>/tmp/stage1-postcheck.err
  local rc=$?
  set -e
  docker cp "$CONTAINER:/tmp/stage1-post-activation.json" /tmp/stage1-post-activation.json 2>/dev/null || true
  docker exec "$CONTAINER" rm -f /tmp/stage1-postcheck.mjs || true
  if [ "$rc" -ne 0 ]; then
    echo "post-activation probe stderr (no secrets expected):"
    cat /tmp/stage1-postcheck.err || true
    return 1
  fi
  [ -f /tmp/stage1-post-activation.json ] || return 1
  assert_no_pii /tmp/stage1-post-activation.json || return 1
  python3 - <<'PY'
import json
doc = json.load(open("/tmp/stage1-post-activation.json"))
if doc.get("phase") != "post_activation":
    raise SystemExit("post-activation evidence phase is wrong")
if doc.get("probed_here") is not True:
    raise SystemExit("post-activation probes were not executed here")
if doc.get("authoritative_source") != "post_activation_authenticated_probes":
    raise SystemExit("post-activation source is not authenticated probes")
if "PRODUCTION_UAT_PASS" in json.dumps(doc):
    raise SystemExit("pre-activation PRODUCTION_UAT_PASS cannot satisfy post-activation evidence")
print("POST_ACTIVATION_PROBES_OK")
PY
}

write_core_and_receipt() {
  local verify_only="$1"
  python3 - "$SOURCE_SHA" "$IMAGE_DIGEST" "$BACKUP_ID" "$BACKUP_HASH" "$PIN" "$SOURCE_SHA" "$SRC_MOUNT" "$TREE_SHA" "$RECEIPT_PATH" "$verify_only" "$RUN_ID" "$RUN_ATTEMPT" "$CORE_EVIDENCE_PATH" "$FIXTURE_RUN_ID" "$FIXTURE_READINESS_AT" <<'PY'
import json, os, sys
source_sha, image_digest, backup_id, backup_hash, final_image, final_rev, src_mount, tree_sha, receipt_path, verify_only, run_id, attempt, core_path, fixture_run_id, fixture_readiness_at = sys.argv[1:]
domain = json.load(open("/tmp/stage1-domain.json"))
runtime = json.load(open("/tmp/stage1-runtime.env"))
if domain.get("mode") not in ("activate", "inspect", "activate-already-on"):
    raise SystemExit("core evidence domain mode is not activate/inspect/already-on")
before = domain.get("before_raw_flags") or domain.get("raw_flags")
after = domain.get("after_raw_flags") or domain.get("raw_flags")
before_counts = domain.get("before_counts") or domain.get("counts")
after_counts = domain.get("after_counts") or domain.get("counts")
original_run_id = run_id
original_attempt = attempt
original_fixture_run_id = fixture_run_id or ""
original_fixture_readiness_at = fixture_readiness_at or ""
original_fixture_cleanup = False
if verify_only == "true" and os.path.isfile(receipt_path):
    prev = json.load(open(receipt_path))
    before = prev.get("before_raw_flags") or before
    after = prev.get("after_raw_flags") or after
    before_counts = prev.get("before_counts") or before_counts
    after_counts = prev.get("after_counts") or after_counts
    original_run_id = prev.get("workflow_run_id") or run_id
    original_attempt = prev.get("workflow_attempt") or attempt
    original_fixture_run_id = prev.get("fixture_run_id") or original_fixture_run_id
    original_fixture_readiness_at = prev.get("fixture_readiness_at") or original_fixture_readiness_at
    original_fixture_cleanup = prev.get("fixture_cleanup") is True
fixture_cleanup = False
fixture_cleanup_doc = {}
try:
    fixture_cleanup_doc = json.load(open("/tmp/stage1-fixture-result.json"))
except Exception:
    fixture_cleanup_doc = {}
if fixture_cleanup_doc.get("mode") == "cleanup-activated":
    fixture_cleanup = (fixture_cleanup_doc.get("result") or {}).get("ok") is True
elif verify_only == "true":
    fixture_cleanup = original_fixture_cleanup
doc = {
    "schema": "stage1-activation-receipt-v1",
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
    "workflow_run_id": run_id,
    "workflow_attempt": attempt,
    "original_run_id": original_run_id,
    "original_attempt": original_attempt,
    "verification_run_id": run_id if verify_only == "true" else None,
    "verification_attempt": attempt if verify_only == "true" else None,
    "fixture_run_id": fixture_run_id or original_fixture_run_id or "",
    "fixture_readiness_at": fixture_readiness_at or original_fixture_readiness_at or "",
    "fixture_cleanup": fixture_cleanup,
    "before_raw_flags": before,
    "after_raw_flags": after,
    "before_counts": before_counts,
    "after_counts": after_counts,
    "lifecycle_counts": domain.get("lifecycle_counts") or runtime.get("lifecycle_counts") or [],
    "runtime_public_flags": runtime["runtime_public_flags"],
    "functional_smoke": runtime["functional_smoke"],
    "privacy_smoke": runtime["privacy_smoke"],
    "perf_smoke": runtime["perf_smoke"],
    "suppression": runtime["suppression"],
    "health": True,
    "landing": True,
    "login": True,
    "http_5xx": runtime["http_5xx"],
    "sqlite_busy": runtime["sqlite_busy"],
    "post_activation": runtime["post_activation"],
    "owner_authorization_bound": True,
    "final_digest": image_digest,
    "final_image": final_image,
    "final_oci_revision": final_rev,
    "rollback_used": False,
    "activation_status": "activated" if verify_only != "true" else "verify-only",
    "ACTIVATION_OK": True,
}
blob = json.dumps(doc)
for token in ("SESSION_SECRET", "NAS_SSH_KEY", "AUTH_PASSWORD", "auth.env"):
    if token in blob:
        raise SystemExit("activation receipt must not contain secrets")
open(core_path, "w").write(json.dumps(doc, indent=2) + "\n")
print("CORE_EVIDENCE_DRAFT_OK")
PY
  python3 "$EVIDENCE_SCRIPT" --check-receipt "$CORE_EVIDENCE_PATH" || return 1
  python3 - "$RECEIPT_PATH" "$CORE_EVIDENCE_PATH" <<'PY'
import os, shutil, sys
receipt_path, core_path = sys.argv[1:]
os.makedirs(os.path.dirname(receipt_path), exist_ok=True)
shutil.copyfile(core_path, receipt_path)
print("DURABLE_RECEIPT_OK")
print("CORE_EVIDENCE_OK")
PY
}

hydrate_runtime_on() {
  local demand_probe agg_probe exp_probe summary_probe detail_probe health_probe
  demand_probe="$(http_probe /tmp/stage1-demand-after.json http://127.0.0.1:5153/api/demand)" || return 1
  agg_probe="$(http_probe /tmp/stage1-aggregate-after.json http://127.0.0.1:5153/api/demand/aggregate)" || return 1
  exp_probe="$(http_probe /tmp/stage1-exposure-after.json http://127.0.0.1:5153/api/demand/exposure)" || return 1
  summary_probe="$(http_probe /tmp/stage1-summary-unauth.json http://127.0.0.1:5153/api/self-listings/1/matches/summary)" || return 1
  detail_probe="$(http_probe /tmp/stage1-detail-unauth.json http://127.0.0.1:5153/api/self-listings/1/matches)" || return 1
  health_probe="$(http_probe /tmp/stage1-health.json http://127.0.0.1:5153/api/health)" || return 1
  land_probe="$(http_probe /tmp/stage1-landing.html http://127.0.0.1:5153/)" || return 1
  login_html_probe="$(http_probe /tmp/stage1-login.html http://127.0.0.1:5153/login.html)" || return 1
  assert_no_pii /tmp/stage1-aggregate-after.json || return 1
  assert_no_pii /tmp/stage1-exposure-after.json || return 1
  run_post_activation_probes || return 1
  python3 - "$SOURCE_SHA" "$IMAGE_DIGEST" "$PROBE_LOG" <<PY
import json, sys
source_sha, image_digest, probe_log = sys.argv[1:]
demand = json.load(open("/tmp/stage1-demand-after.json"))
agg = json.load(open("/tmp/stage1-aggregate-after.json"))
exp = json.load(open("/tmp/stage1-exposure-after.json"))
summary = json.load(open("/tmp/stage1-summary-unauth.json"))
detail = json.load(open("/tmp/stage1-detail-unauth.json"))
health = json.load(open("/tmp/stage1-health.json"))
post = json.load(open("/tmp/stage1-post-activation.json"))
agg_status, agg_ms = "$agg_probe".split()
exp_status, exp_ms = "$exp_probe".split()
summary_status, _ = "$summary_probe".split()
detail_status, _ = "$detail_probe".split()
flags = demand.get("flags") or {}
wish = flags.get("wish") or {}
later = (
    "offer_enabled",
    "public_share_v2_enabled",
    "owner_notifications_enabled",
    "notifications_enabled",
    "digest_enabled",
    "outbound_mail_enabled",
    "outbound_push_enabled",
)
if health.get("ok") is not True:
    raise SystemExit("health is not ok")
if (flags.get("rental_catalog_v2") or {}).get("enabled") is not True:
    raise SystemExit("runtime rental_catalog_v2.enabled is not true")
if wish.get("lifecycle_enabled") is not True:
    raise SystemExit("runtime wish.lifecycle_enabled is not true")
if any(wish.get(key) is not False for key in later):
    raise SystemExit("runtime public Stage 2-4/outbound flag is not false")
if exp_status != "200" or exp.get("enabled") is not True:
    raise SystemExit("exposure did not become available")
if agg_status != "200" or agg.get("enabled") is not True:
    raise SystemExit("aggregate did not become available")
if summary_status != "401":
    raise SystemExit("unauth summary is not fail-closed 401")
if detail_status != "401":
    raise SystemExit("unauth detail is not fail-closed 401")
if "請先登入" not in str(summary.get("error") or "") or "請先登入" not in str(detail.get("error") or ""):
    raise SystemExit("unauth match APIs did not fail-closed")
agg_ms_n = int(agg_ms)
exp_ms_n = int(exp_ms)
if agg_ms_n >= 5000 or exp_ms_n >= 5000:
    raise SystemExit("perf smoke exceeded 5000ms budget")
if post.get("phase") != "post_activation" or post.get("probed_here") is not True:
    raise SystemExit("post-activation probes are missing")
if post.get("authoritative_source") != "post_activation_authenticated_probes":
    raise SystemExit("post-activation source is not authenticated probes")
if "PRODUCTION_UAT_PASS" in json.dumps(post):
    raise SystemExit("pre-activation PRODUCTION_UAT_PASS cannot satisfy post-activation evidence")
probes = []
for line in open(probe_log, encoding="utf-8"):
    if line.strip():
        probes.append(json.loads(line))
for row in post.get("probes") or []:
    probes.append({
        "url": row.get("target"),
        "status": row.get("status") or 0,
        "elapsed_ms": row.get("elapsed_ms") or 0,
        "http_5xx": row.get("http_5xx") is True,
        "sqlite_busy": row.get("sqlite_busy") is True,
    })
if not probes:
    raise SystemExit("defined probes produced no provenance; refusing ACTIVATION_OK")
if any(row.get("http_5xx") is True for row in probes):
    raise SystemExit("http_5xx observed during defined probes")
if any(row.get("sqlite_busy") is True for row in probes):
    raise SystemExit("sqlite_busy observed during defined probes")
if any(row.get("timed_out") is True or row.get("result") == "timeout" for row in (post.get("probes") or [])):
    raise SystemExit("timeout observed during post-activation probes")
lifecycle = json.load(open("/tmp/stage1-domain.json")).get("lifecycle_counts") or []
probe_urls = [row.get("url") for row in probes if row.get("url")]
cross = post["functional_smoke"]["authenticated_cross_account"]
suppression = post["suppression"]
open("/tmp/stage1-runtime.env", "w").write(
    json.dumps({
        "runtime_public_flags": flags,
        "source_sha": source_sha,
        "image_digest": image_digest,
        "post_activation": post,
        "functional_smoke": {
            "aggregate_status": int(agg_status),
            "exposure_enabled": True,
            "summary_unauth": int(summary_status),
            "detail_unauth": int(detail_status),
            "unauth_match_denied": True,
            "authenticated_cross_account": {
                **cross,
                "unauth_401_is_not_cross_account": True,
            },
        },
        "privacy_smoke": {
            "aggregate_clean": True,
            "exposure_clean": True,
            "internal_rank_leaked": False,
            "owner_matches_clean": True,
        },
        "perf_smoke": {
            "aggregate_ms": agg_ms_n,
            "exposure_ms": exp_ms_n,
            "budget_ms": 5000,
            "ok": True,
        },
        "suppression": {
            **suppression,
            "row_counts_are_not_verification": True,
            "lifecycle_counts": lifecycle,
        },
        "http_5xx": {
            "observed": False,
            "provenance": "defined_probes",
            "probes": probe_urls,
        },
        "sqlite_busy": {
            "observed": False,
            "provenance": "defined_probes",
            "probes": probe_urls,
        },
        "lifecycle_counts": lifecycle,
        "health": True,
        "landing": True,
        "login": True,
    })
    + "\n"
)
print("RUNTIME_HYDRATE_OK")
PY
  python3 "$EVIDENCE_SCRIPT" --check-runtime /tmp/stage1-runtime.env || return 1
}

echo "=== inspect current raw flags (no mutation) ==="
run_domain inspect || fail "domain inspect failed before mutation"
PATH_KIND="$(python3 "$PATH_SCRIPT" /tmp/stage1-domain.json "$RECEIPT_PATH" "$SOURCE_SHA" "$IMAGE_DIGEST" "$BACKUP_ID" "$BACKUP_HASH" "$TREE_SHA")"

echo "=== pre-activation running-server snapshot ==="
BEFORE_AGG="$(http_probe /tmp/stage1-aggregate-before.json http://127.0.0.1:5153/api/demand/aggregate || true)"
BEFORE_EXP="$(http_probe /tmp/stage1-exposure-before.json http://127.0.0.1:5153/api/demand/exposure)" || fail "pre-activation /api/demand/exposure failed"
curl -fsS -o /tmp/stage1-demand-before.json http://127.0.0.1:5153/api/demand || fail "pre-activation /api/demand failed"

if [ "$PATH_KIND" = "activate" ]; then
  python3 - <<'PY'
import json
exp = json.load(open("/tmp/stage1-exposure-before.json"))
try:
    agg = json.load(open("/tmp/stage1-aggregate-before.json"))
except Exception:
    agg = {}
if exp.get("enabled") is not False:
    raise SystemExit("before exposure.enabled must be false")
if agg.get("code") not in ("owner_matching_disabled",) and agg.get("enabled") is True:
    raise SystemExit("before aggregate must be disabled")
print("BEFORE_STAGE1_OFF_OK")
PY
fi

if [ "$PATH_KIND" = "verify-only" ]; then
  echo "=== verify-only recovery (no mutation; durable receipt identity matched) ==="
  hydrate_runtime_on || compensate_and_fail "verify-only post-activation probes failed"
  AFTER_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"
  AFTER_ID="$(docker inspect -f '{{.Image}}' "$CONTAINER")"
  AFTER_REV="$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$AFTER_ID")"
  [ "$AFTER_IMAGE" = "$PIN" ] || fail "verify-only running image digest changed"
  [ "$AFTER_REV" = "$SOURCE_SHA" ] || fail "verify-only OCI revision changed"
  write_core_and_receipt true || fail "verify-only durable receipt refresh failed"
  echo "STAGE1_ACTIVATION_OK verify-only source=$SOURCE_SHA digest=$IMAGE_DIGEST receipt=$RECEIPT_PATH"
  exit 0
fi

[ "$PATH_KIND" = "activate" ] || fail "unsupported activation path $PATH_KIND"

echo "=== pre-activation fixture readiness gate (fail-before-save) ==="
if ! run_fixture_domain verify; then
  fail "pre-activation fixture readiness gate failed; owner_matching left off (fail-before-save)"
fi
FIXTURE_RUN_ID="$(python3 - <<'PY'
import json
doc = json.load(open("/tmp/stage1-fixture-result.json"))
result = doc.get("result") or {}
rid = result.get("run_id") or doc.get("run_id") or ""
if not rid:
    raise SystemExit("pre-activation fixture gate did not produce a run_id")
print(rid)
PY
)"
[ -n "$FIXTURE_RUN_ID" ] || fail "pre-activation fixture gate produced an empty run_id"
assert_no_pii /tmp/stage1-fixture-result.json || fail "pre-activation fixture evidence leaked PII"
FIXTURE_READINESS_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "PRE_ACTIVATION_FIXTURE_READY run_id=$FIXTURE_RUN_ID at=$FIXTURE_READINESS_AT"

echo "=== domain activation (single node process, only owner_matching_enabled, no raw SQL) ==="
if ! run_domain activate; then
  compensate_if_mutated "domain get/saveRentalMarketplaceFlags process failed"
fi
python3 - <<'PY'
import json
doc = json.load(open("/tmp/stage1-domain.json"))
before = doc["before_raw_flags"]
after = doc["after_raw_flags"]
later = (
    "offer_enabled",
    "public_share_v2_enabled",
    "owner_notifications_enabled",
    "notifications_enabled",
    "digest_enabled",
    "outbound_mail_enabled",
    "outbound_push_enabled",
)
if doc.get("mode") != "activate":
    raise SystemExit("domain result mode is not activate")
if before["rental_catalog_v2"]["enabled"] is not True:
    raise SystemExit("before rental_catalog_v2.enabled is not true")
if before["wish"]["lifecycle_enabled"] is not True:
    raise SystemExit("before wish.lifecycle_enabled is not true")
if before["wish"].get("owner_matching_enabled") is not False:
    raise SystemExit("before wish.owner_matching_enabled is not false")
if after["rental_catalog_v2"]["enabled"] is not True:
    raise SystemExit("after rental_catalog_v2.enabled is not true")
if after["wish"]["lifecycle_enabled"] is not True:
    raise SystemExit("after wish.lifecycle_enabled is not true")
if after["wish"].get("owner_matching_enabled") is not True:
    raise SystemExit("after wish.owner_matching_enabled is not true")
if any(before["wish"].get(key) is not False or after["wish"].get(key) is not False for key in later):
    raise SystemExit("Stage 2-4/outbound flag changed or is true")
if doc["before_counts"] != doc["after_counts"]:
    raise SystemExit("demand_posts counts changed during Stage 1 activation")
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

echo "=== post-activation fixture cleanup (exact run_id, no flag mutation) ==="
if ! run_fixture_domain cleanup-activated; then
  compensate_and_fail "post-activation fixture cleanup failed"
fi
python3 - <<'PY'
import json
doc = json.load(open("/tmp/stage1-fixture-result.json"))
if doc.get("mode") != "cleanup-activated":
    raise SystemExit("fixture cleanup result mode is not cleanup-activated")
if doc.get("flags_mutated") is not False:
    raise SystemExit("fixture cleanup mutated flags")
if doc.get("owner_matching_enabled") is not True:
    raise SystemExit("fixture cleanup ran with owner_matching unexpectedly off")
result = doc.get("result") or {}
if result.get("ok") is not True:
    raise SystemExit("fixture cleanup result is not ok")
print("FIXTURE_CLEANUP_ACTIVATED_OK")
PY

write_core_and_receipt false || compensate_and_fail "durable receipt write failed after mutation"

echo "STAGE1_ACTIVATION_OK source=$SOURCE_SHA digest=$IMAGE_DIGEST receipt=$RECEIPT_PATH"
