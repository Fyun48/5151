#!/usr/bin/env python3
"""Write durable Stage 1 evidence even when activation/rollback failed.

Never treats a missing or rollback artifact as ACTIVATION_OK.
Success path must satisfy the PR #330 contract. Failure/rollback may be
incomplete, but ACTIVATION_OK stays false.
Strips email / phone / session / password / secret / internal scores.
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone

FORBIDDEN = (
    "SESSION_SECRET",
    "NAS_SSH_KEY",
    "AUTH_PASSWORD",
    "auth.env",
    "rank_score",
    "freshness_score",
    "activity_score",
)
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
# Boundary-anchored so compact fixture run ids / timestamps are neither redacted
# nor reported as a leaked 09xxxxxxxx phone number.
PHONE_RE = re.compile(r"(?<![0-9])09\d{8}(?![0-9])")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
LATER = (
    "offer_enabled",
    "public_share_v2_enabled",
    "owner_notifications_enabled",
    "notifications_enabled",
    "digest_enabled",
    "outbound_mail_enabled",
    "outbound_push_enabled",
)
REQUIRED_SUCCESS_KEYS = (
    "source_sha", "image_digest", "backup_id", "backup_hash",
    "src_mount", "src_tree_sha256", "receipt_path",
    "before_raw_flags", "after_raw_flags", "before_counts", "after_counts",
    "runtime_public_flags", "functional_smoke", "privacy_smoke", "perf_smoke",
    "suppression", "post_activation", "http_5xx", "sqlite_busy",
    "health", "landing", "login", "final_digest", "final_oci_revision",
)


def load_json(path: str) -> dict | None:
    if not path or not os.path.exists(path):
        return None
    try:
        doc = json.load(open(path, encoding="utf-8"))
    except Exception:
        return None
    return doc if isinstance(doc, dict) else None


def sanitize(value):
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            lowered = str(key).lower()
            if lowered in {"email", "owner_email", "other_email", "phone", "session", "password", "cookie"}:
                continue
            if key in {"listing_id"}:
                continue
            out[key] = sanitize(item)
        return out
    if isinstance(value, list):
        return [sanitize(item) for item in value]
    if isinstance(value, str) and (EMAIL_RE.search(value) or PHONE_RE.search(value)):
        return "[redacted]"
    return value


def assert_clean(doc: dict) -> None:
    blob = json.dumps(doc, ensure_ascii=False)
    for token in FORBIDDEN:
        if token in blob:
            raise SystemExit(f"activation evidence leaked {token}")
    if EMAIL_RE.search(blob):
        raise SystemExit("activation evidence leaked email")
    if PHONE_RE.search(blob):
        raise SystemExit("activation evidence leaked phone")


def success_contract_error(core: dict | None, env: dict | None = None) -> str:
    env = env or os.environ
    if not isinstance(core, dict):
        return "activation NAS evidence incomplete"
    if not all(core.get(k) for k in REQUIRED_SUCCESS_KEYS):
        return "activation NAS evidence incomplete"
    if core.get("backup_verified") is not True or core.get("src_manifest_verified") is not True:
        return "activation NAS evidence is not verified"
    if core.get("ACTIVATION_OK") is not True or core.get("rollback_used") is not False:
        return "activation NAS evidence is not verified"
    if core.get("durable_receipt") is not True or core.get("verify_only") not in (True, False):
        return "activation receipt metadata is incomplete"
    if "/stage1-activation-receipt.json" not in str(core.get("receipt_path") or ""):
        return "activation receipt_path is not durable"
    if not str(core.get("fixture_run_id") or ""):
        return "activation fixture_run_id is missing"
    if core.get("fixture_cleanup") is not True:
        return "activation fixture_cleanup is not verified"
    if not DIGEST_RE.fullmatch(str(core.get("backup_hash") or "")):
        return "activation backup_hash is not immutable"
    if not DIGEST_RE.fullmatch(str(core.get("final_digest") or "")):
        return "activation final_digest is not immutable"
    source = env.get("SOURCE_SHA") or ""
    digest = env.get("IMAGE_DIGEST") or ""
    backup_id = env.get("BACKUP_ID") or ""
    backup_hash = env.get("BACKUP_HASH") or ""
    if source and core.get("source_sha") != source:
        return "activation source_sha does not match input"
    if digest and core.get("image_digest") != digest:
        return "activation image_digest does not match input"
    if backup_id and core.get("backup_id") != backup_id:
        return "activation backup_id does not match input"
    if backup_hash and core.get("backup_hash") != backup_hash:
        return "activation backup_hash does not match input"
    if digest and core.get("final_digest") != digest:
        return "activation final_digest does not match input image_digest"
    if source and core.get("final_oci_revision") != source:
        return "activation final_oci_revision does not match input source_sha"
    after = core.get("after_raw_flags") or {}
    try:
        if after["rental_catalog_v2"]["enabled"] is not True:
            return "after PRA catalog flag is not ON"
        if after["wish"]["lifecycle_enabled"] is not True:
            return "after PRA lifecycle flag is not ON"
        if after["wish"]["owner_matching_enabled"] is not True:
            return "after Stage 1 owner_matching is not ON"
        if any(after["wish"].get(key) is not False for key in LATER):
            return "after Stage 2-4/outbound flag is not OFF"
    except Exception:
        return "after flags are incomplete"
    post = core.get("post_activation") or {}
    if post.get("phase") != "post_activation" or post.get("probed_here") is not True:
        return "NAS evidence is missing post-activation probes"
    if "PRODUCTION_UAT_PASS" in json.dumps(core):
        return "pre-activation PRODUCTION_UAT_PASS cannot satisfy post-activation evidence"
    if core.get("health") is not True or core.get("landing") is not True or core.get("login") is not True:
        return "activation evidence health/landing/login is not true"
    return ""


def evidence_matches_current_run(doc, env=None) -> bool:
    """P1-9: a prior-run transient evidence file must never satisfy this run."""
    env = env or os.environ
    if not isinstance(doc, dict):
        return False
    run_id = str(env.get("WF_RUN_ID") or "")
    if not run_id:
        return True
    if str(doc.get("workflow_run_id") or "") != run_id:
        return False
    attempt = str(env.get("WF_ATTEMPT") or "")
    if attempt and str(doc.get("workflow_attempt") or "") and str(doc.get("workflow_attempt")) != attempt:
        return False
    return True


def build_doc(core, rollback) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    if core and not evidence_matches_current_run(core):
        core = None
    if rollback and not evidence_matches_current_run(rollback):
        rollback = None
    contract_error = success_contract_error(core) if core else "activation NAS evidence incomplete"
    activation_ok = contract_error == ""
    if rollback and rollback.get("rollback_used") is True:
        activation_ok = False

    if activation_ok:
        activation_result = "activated"
        rollback_result = "not_used"
    elif rollback and rollback.get("rollback_ok") is True:
        activation_result = "rolled_back"
        rollback_result = "ok"
    elif rollback and rollback.get("rollback_used") is True:
        activation_result = "rolled_back"
        rollback_result = "failed" if rollback.get("rollback_ok") is False else "unknown"
    elif core:
        activation_result = "failed"
        rollback_result = "not_used"
    else:
        activation_result = "evidence_unavailable"
        rollback_result = "unknown"

    source = core or rollback or {}
    doc = {
        "schema": "stage1-activation-evidence-v1",
        "written_at": now,
        "workflow_file": os.environ.get("WF_FILE") or ".github/workflows/activate-rental-marketplace-stage1.yml",
        "workflow_ref": os.environ.get("WF_REF") or "",
        "workflow_run_id": os.environ.get("WF_RUN_ID") or "",
        "workflow_attempt": int(os.environ.get("WF_ATTEMPT") or "0"),
        "workflow_sha": os.environ.get("WF_HEAD_SHA") or "",
        "head_sha": os.environ.get("WF_HEAD_SHA") or "",
        "source_sha": os.environ.get("SOURCE_SHA") or source.get("source_sha") or "",
        "image_digest": os.environ.get("IMAGE_DIGEST") or source.get("image_digest") or "",
        "backup_id": os.environ.get("BACKUP_ID") or source.get("backup_id") or "",
        "backup_hash": os.environ.get("BACKUP_HASH") or source.get("backup_hash") or "",
        "actor": os.environ.get("WF_ACTOR") or "",
        "triggering_actor": os.environ.get("WF_TRIGGERING_ACTOR") or "",
        "confirmation": os.environ.get("CONFIRMATION") or "",
        "owner_authorization_bound": True,
        "activation_result": activation_result,
        "rollback_result": rollback_result,
        "rollback_used": rollback_result != "not_used",
        "ACTIVATION_OK": activation_ok,
        "evidence_available": bool(core or rollback),
        "success_contract_error": "" if activation_ok else contract_error,
        "core": sanitize(core) if core else None,
        "rollback": sanitize(rollback) if rollback else None,
    }
    if core:
        for key in (
            "before_raw_flags", "after_raw_flags", "runtime_public_flags",
            "post_activation", "functional_smoke", "privacy_smoke", "perf_smoke",
            "suppression", "http_5xx", "sqlite_busy", "health", "landing", "login",
            "final_digest", "final_oci_revision", "receipt_path",
            "backup_id", "backup_hash", "backup_verified",
            "src_mount", "src_manifest_verified", "src_tree_sha256",
            "durable_receipt", "verify_only", "before_counts", "after_counts",
            "workflow_run_id", "workflow_attempt",
            "fixture_run_id", "fixture_readiness_at", "fixture_cleanup",
            "original_run_id", "original_attempt",
            "verification_run_id", "verification_attempt",
        ):
            if key in core:
                doc[key] = sanitize(core.get(key))
    assert_clean(doc)
    return doc


def main() -> int:
    if len(sys.argv) == 3 and sys.argv[1] == "--check-success":
        doc = load_json(sys.argv[2])
        err = success_contract_error(doc)
        if err:
            raise SystemExit(err)
        if doc.get("ACTIVATION_OK") is not True:
            raise SystemExit("ACTIVATION_OK is not true")
        print("STAGE1_SUCCESS_CONTRACT_OK")
        return 0
    core = load_json(os.environ.get("STAGE1_CORE_PATH") or "nas-activation-core.json")
    rollback = load_json(os.environ.get("STAGE1_ROLLBACK_PATH") or "nas-rollback-evidence.json")
    out_path = os.environ.get("STAGE1_EVIDENCE_OUT") or "stage1-activation-evidence.json"
    doc = build_doc(core, rollback)
    open(out_path, "w", encoding="utf-8").write(json.dumps(doc, indent=2) + "\n")
    print(
        "STAGE1_EVIDENCE_WRITTEN:%s:%s:%s"
        % (doc["activation_result"], doc["rollback_result"], str(doc["ACTIVATION_OK"]).lower())
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
