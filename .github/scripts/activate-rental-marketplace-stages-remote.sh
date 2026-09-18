#!/usr/bin/env bash
# Runs on CasaOS/NAS via SSH. Staged Stage 2 / 3 / 4 activation only.
# No deploy, no pull, no compose, no restart, no backup delete.
# Compensating rollback turns ONLY the target stage flags back to false; if that
# fails Production state is reported UNKNOWN and never repaired with raw SQL.
set -euo pipefail

fail() {
  echo "::error::$1"
  echo "STAGES_ACTIVATION_FAIL: $1"
  exit 1
}

CONTAINER="${CONTAINER:-591-tracker-v3}"
SOURCE_SHA="${SOURCE_SHA:-}"
IMAGE_DIGEST="${IMAGE_DIGEST:-}"
BACKUP_ID="${BACKUP_ID:-}"
BACKUP_HASH="${BACKUP_HASH:-}"
TARGET_STAGE="${TARGET_STAGE:-}"
OWNER_AUTHORIZATION="${OWNER_AUTHORIZATION:-}"
DOMAIN_SCRIPT="${DOMAIN_SCRIPT:-}"
PATH_SCRIPT="${PATH_SCRIPT:-}"
EVIDENCE_SCRIPT="${EVIDENCE_SCRIPT:-}"
POSTCHECK_SCRIPT="${POSTCHECK_SCRIPT:-}"
EXPECTED_SRC_MANIFEST="${EXPECTED_SRC_MANIFEST:-}"
SRC_MANIFEST_PY="${SRC_MANIFEST_PY:-}"
EXPECTED_SRC_MOUNT="${EXPECTED_SRC_MOUNT:-/mnt/Storage1/apps/5151/v3/src}"
RUN_ID="${RUN_ID:-${GITHUB_RUN_ID:-local}}"
RUN_ATTEMPT="${RUN_ATTEMPT:-${GITHUB_RUN_ATTEMPT:-1}}"
# Per-run unique transient evidence. Never reuse a prior run's fixed path.
INSPECT_PATH="/tmp/stages-inspect-${RUN_ID}-${RUN_ATTEMPT}.json"
RESULT_PATH="/tmp/stages-result-${RUN_ID}-${RUN_ATTEMPT}.json"
STATUS_PATH="/tmp/stages-status-${RUN_ID}-${RUN_ATTEMPT}.json"
POSTCHECK_PATH="/tmp/stages-postcheck-${RUN_ID}-${RUN_ATTEMPT}.json"
CORE_EVIDENCE_PATH="/tmp/stages-activation-core-${RUN_ID}-${RUN_ATTEMPT}.json"
ROLLBACK_EVIDENCE_PATH="/tmp/stages-rollback-evidence-${RUN_ID}-${RUN_ATTEMPT}.json"
PROBE_LOG="/tmp/stages-probe-log-${RUN_ID}-${RUN_ATTEMPT}.jsonl"

case "$TARGET_STAGE" in
  2|3|4) : ;;
  *) fail "target_stage '$TARGET_STAGE' is not 2, 3 or 4" ;;
esac
printf '%s' "$SOURCE_SHA" | grep -Eq '^[0-9a-f]{40}$' || fail "source_sha is not a 40-character lowercase hex SHA"
printf '%s' "$IMAGE_DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail "image_digest is not sha256: plus 64 lowercase hex"
printf '%s' "$BACKUP_ID" | grep -Eq '^/DATA/AppData/591-tracker-v3-backups/predeploy-[0-9]{8}-[0-9]{6}$' || fail "backup_id is not a trusted predeploy backup path"
case "$BACKUP_ID" in
  *..*|*$'\n'*|*$'\r'*) fail "backup_id contains forbidden path characters" ;;
esac
printf '%s' "$BACKUP_HASH" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail "backup_hash is not sha256: plus 64 lowercase hex"
EXPECTED_AUTH="AUTHORIZE-STAGE${TARGET_STAGE}:${SOURCE_SHA}:${IMAGE_DIGEST}:${BACKUP_ID}:${BACKUP_HASH}"
[ "$OWNER_AUTHORIZATION" = "$EXPECTED_AUTH" ] || fail "owner_authorization is not bound to this stage/source SHA/digest/backup"
[ -n "$DOMAIN_SCRIPT" ] && [ -f "$DOMAIN_SCRIPT" ] || fail "staged domain activation script is missing"
[ -n "$PATH_SCRIPT" ] && [ -f "$PATH_SCRIPT" ] || fail "staged path classifier is missing"
[ -n "$EVIDENCE_SCRIPT" ] && [ -f "$EVIDENCE_SCRIPT" ] || fail "staged evidence contract script is missing"
[ -n "$POSTCHECK_SCRIPT" ] && [ -f "$POSTCHECK_SCRIPT" ] || fail "staged post-activation probe script is missing"
[ -n "$EXPECTED_SRC_MANIFEST" ] && [ -f "$EXPECTED_SRC_MANIFEST" ] || fail "expected v3/src manifest is missing"
[ -n "$SRC_MANIFEST_PY" ] && [ -f "$SRC_MANIFEST_PY" ] || fail "src manifest helper is missing"
[ "$EXPECTED_SRC_MOUNT" = "/mnt/Storage1/apps/5151/v3/src" ] || fail "expected src mount path is not the Production v3 src path"
RECEIPT_PATH="$BACKUP_ID/stage${TARGET_STAGE}-activation-receipt.json"

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
python3 "$SRC_MANIFEST_PY" --from-docker "$CONTAINER" --docker-src /app/src --out "/tmp/stages-src-actual-${RUN_ID}.json"
python3 "$SRC_MANIFEST_PY" --compare "$EXPECTED_SRC_MANIFEST" "/tmp/stages-src-actual-${RUN_ID}.json" || fail "running /app/src does not match source_sha v3/src manifest (fail-before-save)"
TREE_SHA="$(python3 - <<PY
import json
print(json.load(open("/tmp/stages-src-actual-${RUN_ID}.json"))["tree_sha256"])
PY
)"
echo "SRC_RUNTIME_MATCH_OK"

[ -f "$BACKUP_ID/v3.db" ] || fail "backup db missing at $BACKUP_ID/v3.db"
ACTUAL_HASH="$(sha256sum "$BACKUP_ID/v3.db" | awk '{print $1}')"
EXPECTED_HASH="${BACKUP_HASH#sha256:}"
[ "$ACTUAL_HASH" = "$EXPECTED_HASH" ] || fail "backup db sha256 does not match input backup_hash"

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

# http_probe <body-file> <url> [extra curl args] -> prints "<status> <elapsed_ms>"
http_probe() {
  local dest="$1"
  local url="$2"
  local extra="${3:-}"
  local started ended elapsed status
  local busy=0 five=0
  started="$(date +%s%3N)"
  set +e
  status="$(curl -sS --max-time 8 -o "$dest" -w '%{http_code}' $extra "$url" 2>/tmp/stages-curl.err)"
  local rc=$?
  set -e
  ended="$(date +%s%3N)"
  elapsed=$((ended - started))
  if [ "$rc" -ne 0 ]; then
    echo "curl_error url=$url rc=$rc" >&2
    cat /tmp/stages-curl.err >&2 || true
    record_probe "$url" "${status:-0}" "$elapsed" 0 0
    return 1
  fi
  if grep -Eqi 'SQLITE_BUSY|database is locked' "$dest" /tmp/stages-curl.err 2>/dev/null; then busy=1; fi
  if [ "${status:0:1}" = "5" ]; then five=1; fi
  record_probe "$url" "$status" "$elapsed" "$five" "$busy"
  if [ "$busy" = 1 ]; then echo "sqlite_busy url=$url" >&2; return 1; fi
  if [ "$five" = 1 ]; then echo "http_5xx url=$url status=$status" >&2; return 1; fi
  printf '%s %s\n' "$status" "$elapsed"
}

run_domain() {
  local mode="$1"
  local result_out="$2"
  docker exec "$CONTAINER" rm -f /tmp/stages-domain.mjs /tmp/stages-domain-result.json /tmp/stages-domain-status.json
  docker cp "$DOMAIN_SCRIPT" "$CONTAINER:/tmp/stages-domain.mjs"
  set +e
  docker exec -w /app -e STAGES_DOMAIN_MODE="$mode" \
    -e STAGES_TARGET_STAGE="$TARGET_STAGE" \
    -e STAGES_DOMAIN_STATUS_PATH=/tmp/stages-domain-status.json \
    -e STAGES_DOMAIN_RESULT_PATH=/tmp/stages-domain-result.json \
    "$CONTAINER" node /tmp/stages-domain.mjs >/tmp/stages-domain.out 2>/tmp/stages-domain.err
  local rc=$?
  set -e
  docker cp "$CONTAINER:/tmp/stages-domain-status.json" "$STATUS_PATH" 2>/dev/null || true
  docker cp "$CONTAINER:/tmp/stages-domain-result.json" "$result_out" 2>/dev/null || true
  docker exec "$CONTAINER" rm -f /tmp/stages-domain.mjs /tmp/stages-domain-result.json || true
  if [ "$rc" -ne 0 ]; then
    echo "domain $mode stderr (no secrets expected):"
    cat /tmp/stages-domain.err || true
    return 1
  fi
  [ -f "$result_out" ] || return 1
  return 0
}

assert_no_pii() {
  local file="$1"
  python3 - "$file" <<'PY'
import json, re, sys
path = sys.argv[1]
raw = open(path, encoding="utf-8").read()
blob = json.loads(raw) if raw.strip().startswith("{") or raw.strip().startswith("[") else {}
text = json.dumps(blob, ensure_ascii=False)
for token in (
    "SESSION_SECRET", "NAS_SSH_KEY", "AUTH_PASSWORD", "auth.env",
    "rank_score", "freshness_score", "activity_score", "wish_id", "last_active_at",
):
    if token in text:
        raise SystemExit(f"privacy leak token {token} in {path}")
if re.search(r"(?<![0-9])09\d{8}(?![0-9])", text):
    raise SystemExit(f"privacy leak phone in {path}")
if re.search(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", text):
    raise SystemExit(f"privacy leak email in {path}")
print("PRIVACY_OK")
PY
}


run_staged_postcheck() {
  echo "=== post-activation staged probes (Stage ${TARGET_STAGE} ON) ==="
  docker exec "$CONTAINER" rm -f /tmp/stages-postcheck.mjs /tmp/stages-postcheck.json
  docker cp "$POSTCHECK_SCRIPT" "$CONTAINER:/tmp/stages-postcheck.mjs"
  set +e
  docker exec -w /app \
    -e STAGES_POSTCHECK_BASE_URL="${STAGES_POSTCHECK_BASE_URL:-http://127.0.0.1:5153}" \
    -e STAGES_POSTCHECK_STAGE="$TARGET_STAGE" \
    -e STAGES_POSTCHECK_SOURCE_SHA="$SOURCE_SHA" \
    -e STAGES_POSTCHECK_RESULT_PATH=/tmp/stages-postcheck.json \
    "$CONTAINER" node /tmp/stages-postcheck.mjs >/tmp/stages-postcheck.out 2>/tmp/stages-postcheck.err
  local rc=$?
  set -e
  docker cp "$CONTAINER:/tmp/stages-postcheck.json" "$POSTCHECK_PATH" 2>/dev/null || true
  docker exec "$CONTAINER" rm -f /tmp/stages-postcheck.mjs /tmp/stages-postcheck.json || true
  if [ "$rc" -ne 0 ]; then
    echo "post-activation probe stderr (no secrets expected):"
    cat /tmp/stages-postcheck.err || true
    return 1
  fi
  [ -f "$POSTCHECK_PATH" ] || return 1
  assert_no_pii "$POSTCHECK_PATH" || return 1
  python3 - "$POSTCHECK_PATH" "$TARGET_STAGE" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
stage = int(sys.argv[2])
if doc.get("phase") != "post_activation":
    raise SystemExit("post-activation evidence phase is wrong")
if doc.get("probed_here") is not True:
    raise SystemExit("post-activation probes were not executed here")
if doc.get("authoritative_source") != "post_activation_authenticated_probes":
    raise SystemExit("post-activation source is not authenticated probes")
if doc.get("stage") != stage:
    raise SystemExit("post-activation evidence stage mismatch")
if doc.get("ok") is not True:
    raise SystemExit("post-activation probes did not pass")
if "PRODUCTION_UAT_PASS" in json.dumps(doc):
    raise SystemExit("pre-activation PRODUCTION_UAT_PASS cannot satisfy post-activation evidence")
print("POST_ACTIVATION_PROBES_OK")
PY
}

rollback_target_stage() {
  echo "=== compensating rollback via domain API (target Stage ${TARGET_STAGE} only) ==="
  run_domain rollback "$RESULT_PATH" || return 1
  python3 - "$RESULT_PATH" "$TARGET_STAGE" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
stage = int(sys.argv[2])
after = doc.get("after_raw_flags") or {}
wish = after.get("wish") or {}
mine = {2: ("offer_enabled",), 3: ("public_share_v2_enabled",), 4: ("owner_notifications_enabled", "notifications_enabled")}[stage]
later = {2: ("public_share_v2_enabled", "owner_notifications_enabled", "notifications_enabled"),
         3: ("owner_notifications_enabled", "notifications_enabled"), 4: ()}[stage]
if doc.get("mode") not in ("rollback", "rollback-already-off"):
    raise SystemExit("rollback domain result mode is not rollback")
if (after.get("rental_catalog_v2") or {}).get("enabled") is not True:
    raise SystemExit("rollback rental_catalog_v2.enabled is not true")
if wish.get("lifecycle_enabled") is not True:
    raise SystemExit("rollback wish.lifecycle_enabled is not true")
for key in mine:
    if wish.get(key) is not False:
        raise SystemExit(f"rollback wish.{key} is not false")
for key in later:
    if wish.get(key) is not False:
        raise SystemExit(f"rollback later flag {key} is not false")
for key in ("digest_enabled", "outbound_mail_enabled", "outbound_push_enabled"):
    if wish.get(key) is not False:
        raise SystemExit(f"rollback outbound flag {key} is not false")
print("DOMAIN_ROLLBACK_OK")
PY
}


verify_runtime_target_off() {
  echo "=== rollback hydrate: health + Stage 2 wish offer gate is closed again ==="
  http_probe /tmp/stages-health-rollback.json http://127.0.0.1:5153/api/health >/dev/null || return 1
  python3 - <<'PY'
import json
if json.load(open("/tmp/stages-health-rollback.json")).get("ok") is not True:
    raise SystemExit("rollback health is not ok")
print("RUNTIME_ROLLBACK_HYDRATE_OK")
PY
  if [ "$TARGET_STAGE" = "2" ]; then
    http_probe /tmp/stages-offers-rollback.json http://127.0.0.1:5153/api/wish-offers/owner >/dev/null || true
    python3 - <<'PY'
import json
doc = json.load(open("/tmp/stages-offers-rollback.json"))
if doc.get("code") != "wish_offer_disabled":
    raise SystemExit("rollback did not re-close the wish offer gate")
print("RUNTIME_ROLLBACK_OFFER_GATE_OK")
PY
  fi
  return 0
}

write_rollback_evidence() {
  local reason="$1"
  local ok="$2"
  python3 - "$reason" "$ok" "$RUN_ID" "$RUN_ATTEMPT" "$TARGET_STAGE" "$SOURCE_SHA" "$IMAGE_DIGEST" "$BACKUP_ID" "$BACKUP_HASH" "$ROLLBACK_EVIDENCE_PATH" <<'PY'
import json, sys
from datetime import datetime, timezone
reason, ok, run_id, attempt, stage, source_sha, digest, backup_id, backup_hash, out_path = sys.argv[1:]
doc = {
    "schema": "rental-marketplace-stages-rollback-evidence/v1",
    "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "target_stage": int(stage),
    "rollback_ok": ok == "true",
    "reason": reason,
    "run_id": run_id,
    "run_attempt": attempt,
    "source_sha": source_sha,
    "image_digest": digest,
    "backup_id": backup_id,
    "backup_hash": backup_hash,
    "compensation": "domain-settings-rollback-target-stage-only",
    "raw_sql_repair_used": False,
}
if ok != "true":
    doc["PRODUCTION_STATE_UNKNOWN"] = True
open(out_path, "w", encoding="utf-8").write(json.dumps(doc, indent=2) + "\n")
print("ROLLBACK_EVIDENCE_OK")
PY
}

compensate_and_fail() {
  local reason="$1"
  echo "STAGES_POSTCHECK_FAIL: $reason"
  if ! rollback_target_stage; then
    write_rollback_evidence "$reason" false || true
    fail "post-check failed ($reason) and domain rollback failed (PRODUCTION_STATE_UNKNOWN; no raw SQL repair)"
  fi
  if ! verify_runtime_target_off; then
    write_rollback_evidence "$reason" false || true
    fail "domain rollback succeeded but running server hydrate is inconsistent (PRODUCTION_STATE_UNKNOWN)"
  fi
  write_rollback_evidence "$reason" true || true
  fail "post-check failed ($reason); Stage ${TARGET_STAGE} rolled back via domain API; earlier stages left ON"
}

compensate_if_mutated() {
  local reason="$1"
  local phase="unknown"
  if [ -f "$STATUS_PATH" ]; then
    phase="$(python3 - <<PY
import json
print(json.load(open("$STATUS_PATH")).get("phase") or "unknown")
PY
)"
  fi
  echo "STAGES_ACTIVATE_PROCESS_FAIL phase=$phase reason=$reason"
  if [ "$phase" = "before-save" ] || [ "$phase" = "already-on" ] || [ "$phase" = "inspect" ]; then
    fail "domain activate failed before mutation ($reason)"
  fi
  compensate_and_fail "$reason"
}


echo "=== inspect current Marketplace flags (no mutation) ==="
run_domain inspect "$INSPECT_PATH" || fail "inspect of Marketplace flags failed"
set +e
CLASS="$(python3 "$PATH_SCRIPT" "$INSPECT_PATH" "$RECEIPT_PATH" "$TARGET_STAGE" "$SOURCE_SHA" "$IMAGE_DIGEST" "$BACKUP_ID" "$BACKUP_HASH" "$TREE_SHA" 2>/tmp/stages-path.err)"
CLASS_RC=$?
set -e
if [ "$CLASS_RC" -ne 0 ]; then
  cat /tmp/stages-path.err >&2 || true
  fail "staged path classification failed (fail-closed before any mutation)"
fi
echo "STAGES_PATH_CLASS=$CLASS"
case "$CLASS" in
  activate|verify-only) : ;;
  *) fail "staged path classifier returned an unsupported class '$CLASS'" ;;
esac

if [ "$CLASS" = "activate" ]; then
  run_domain activate "$RESULT_PATH" || compensate_if_mutated "domain activate failed"
  set +e
  python3 - "$RESULT_PATH" "$TARGET_STAGE" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
stage = int(sys.argv[2])
before = doc["before_raw_flags"]
after = doc["after_raw_flags"]
mine = {2: ("offer_enabled",), 3: ("public_share_v2_enabled",), 4: ("owner_notifications_enabled", "notifications_enabled")}[stage]
earlier = {2: ("owner_matching_enabled",), 3: ("owner_matching_enabled", "offer_enabled"),
           4: ("owner_matching_enabled", "offer_enabled", "public_share_v2_enabled")}[stage]
later = {2: ("public_share_v2_enabled", "owner_notifications_enabled", "notifications_enabled"),
         3: ("owner_notifications_enabled", "notifications_enabled"), 4: ()}[stage]
if doc.get("mode") != "activate":
    raise SystemExit("domain result mode is not activate")
for snapshot, label in ((before, "before"), (after, "after")):
    if (snapshot.get("rental_catalog_v2") or {}).get("enabled") is not True:
        raise SystemExit(f"{label} rental_catalog_v2.enabled is not true")
    if (snapshot.get("wish") or {}).get("lifecycle_enabled") is not True:
        raise SystemExit(f"{label} wish.lifecycle_enabled is not true")
for key in earlier:
    if before["wish"].get(key) is not True or after["wish"].get(key) is not True:
        raise SystemExit(f"earlier-stage flag {key} was not ON across activation")
for key in mine:
    if before["wish"].get(key) is not False:
        raise SystemExit(f"before wish.{key} is not false")
    if after["wish"].get(key) is not True:
        raise SystemExit(f"after wish.{key} is not true")
for key in later:
    if before["wish"].get(key) is not False or after["wish"].get(key) is not False:
        raise SystemExit(f"later-stage flag {key} changed or is true")
for key in ("digest_enabled", "outbound_mail_enabled", "outbound_push_enabled"):
    if before["wish"].get(key) is not False or after["wish"].get(key) is not False:
        raise SystemExit(f"outbound flag {key} changed or is true")
print("DOMAIN_ACTIVATION_OK")
PY
  DOMAIN_RC=$?
  set -e
  [ "$DOMAIN_RC" -eq 0 ] || compensate_and_fail "domain activation contract validation failed"
else
  cp "$INSPECT_PATH" "$RESULT_PATH"
  echo "STAGES_VERIFY_ONLY: target Stage ${TARGET_STAGE} already ON; no mutation performed"
fi

echo "=== hydrate runtime caches (GET /api/health + /api/demand/exposure, no restart) ==="
http_probe /tmp/stages-health.json http://127.0.0.1:5153/api/health >/dev/null || compensate_and_fail "health probe failed after activation"
http_probe /tmp/stages-exposure.json http://127.0.0.1:5153/api/demand/exposure >/dev/null || compensate_and_fail "exposure probe failed after activation"

run_staged_postcheck || compensate_and_fail "post-activation staged probes failed"

AFTER_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"
AFTER_ID="$(docker inspect -f '{{.Image}}' "$CONTAINER")"
AFTER_REV="$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$AFTER_ID")"
[ "$AFTER_IMAGE" = "$PIN" ] || compensate_and_fail "running image digest changed during activation"
[ "$AFTER_REV" = "$SOURCE_SHA" ] || compensate_and_fail "OCI revision changed during activation"
AFTER_MOUNT="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/src"}}{{.Source}}{{end}}{{end}}' "$CONTAINER")"
[ "$AFTER_MOUNT" = "$EXPECTED_SRC_MOUNT" ] || compensate_and_fail "container /app/src mount changed during activation"


echo "=== write core evidence bundle ($CORE_EVIDENCE_PATH) ==="
python3 - "$CLASS" "$TARGET_STAGE" "$SOURCE_SHA" "$IMAGE_DIGEST" "$TREE_SHA" "$SRC_MOUNT" "$BACKUP_ID" "$BACKUP_HASH" \
  "$PIN" "$AFTER_REV" "$AFTER_MOUNT" "$RUN_ID" "$RUN_ATTEMPT" \
  "$INSPECT_PATH" "$RESULT_PATH" "$STATUS_PATH" "$POSTCHECK_PATH" "$PROBE_LOG" "$CORE_EVIDENCE_PATH" <<'PY'
import json, os, sys
from datetime import datetime, timezone
(klass, stage, source_sha, digest, tree_sha, src_mount, backup_id, backup_hash,
 final_image, final_rev, final_mount, run_id, attempt,
 inspect_path, result_path, status_path, postcheck_path, probe_log, out_path) = sys.argv[1:]

def load(path, default=None):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return default

probes = []
if os.path.isfile(probe_log):
    with open(probe_log, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                probes.append(json.loads(line))

doc = {
    "schema": "rental-marketplace-stages-core-evidence/v1",
    "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "class": klass,
    "target_stage": int(stage),
    "identity": {
        "source_sha": source_sha,
        "image_digest": digest,
        "src_tree_sha256": tree_sha,
        "backup_id": backup_id,
        "backup_hash": backup_hash,
        "run_id": run_id,
        "run_attempt": attempt,
    },
    "runtime_after": {
        "final_image": final_image,
        "final_revision": final_rev,
        "final_src_mount": final_mount,
        "expected_src_mount": src_mount,
    },
    "inspect": load(inspect_path, {}),
    "result": load(result_path, {}),
    "status": load(status_path, {}),
    "postcheck": load(postcheck_path, {}),
    "probes": probes,
    "mutation_kinds": ["settings:rental-marketplace"] if klass == "activate" else [],
}
with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(doc, handle, indent=2, sort_keys=True)
    handle.write("\n")
print("CORE_EVIDENCE_OK")
PY

if [ "$CLASS" = "activate" ]; then
  echo "=== durable receipt write ($RECEIPT_PATH) ==="
  python3 - "$TARGET_STAGE" "$SOURCE_SHA" "$IMAGE_DIGEST" "$TREE_SHA" "$BACKUP_ID" "$BACKUP_HASH" "$RUN_ID" "$RUN_ATTEMPT" "$INSPECT_PATH" "$RESULT_PATH" "$POSTCHECK_PATH" "$RECEIPT_PATH" <<'PY'
import json, sys
from datetime import datetime, timezone
(stage, source_sha, digest, tree_sha, backup_id, backup_hash, run_id, attempt,
 inspect_path, result_path, postcheck_path, receipt_path) = sys.argv[1:]
doc = json.load(open(result_path))
postcheck = json.load(open(postcheck_path))
inspect = json.load(open(inspect_path))
mine = {2: ("offer_enabled",), 3: ("public_share_v2_enabled",), 4: ("owner_notifications_enabled", "notifications_enabled")}[int(stage)]
after = doc["after_raw_flags"]
before = doc["before_raw_flags"]
if postcheck.get("ok") is not True:
    raise SystemExit("refusing to write a receipt without passing post-activation probes")
for key in mine:
    if after["wish"].get(key) is not True:
        raise SystemExit(f"refusing to write a receipt while wish.{key} is not true")
receipt = {
    "schema": "rental-marketplace-staged-activation-receipt/v1",
    "source_sha": source_sha,
    "image_digest": digest,
    "src_tree_sha256": tree_sha,
    "backup_id": backup_id,
    "backup_hash": backup_hash,
    "target_stage": int(stage),
    "target_flags": {key: after["wish"].get(key) for key in mine},
    "ACTIVATION_OK": True,
    "activated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "workflow_run_id": run_id,
    "workflow_attempt": attempt,
    "before_raw_flags": before,
    "after_raw_flags": after,
    "postcheck_ok": True,
}
with open(receipt_path, "w", encoding="utf-8") as handle:
    json.dump(receipt, handle, indent=2, sort_keys=True)
    handle.write("\n")
print("DURABLE_RECEIPT_OK")
PY
else
  echo "STAGES_VERIFY_ONLY: durable receipt preserved at $RECEIPT_PATH"
fi

rm -f "$PROBE_LOG" || true
echo "STAGES_ACTIVATION_OK stage=$TARGET_STAGE class=$CLASS source=$SOURCE_SHA digest=$IMAGE_DIGEST receipt=$RECEIPT_PATH core=$CORE_EVIDENCE_PATH"

