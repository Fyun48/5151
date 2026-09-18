#!/usr/bin/env python3
"""Write durable Stage 1 evidence even when activation/rollback failed.

Never treats a missing or rollback artifact as ACTIVATION_OK.
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
PHONE_RE = re.compile(r"09\d{8}")


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


def main() -> int:
    core = load_json(os.environ.get("STAGE1_CORE_PATH") or "nas-activation-core.json")
    rollback = load_json(os.environ.get("STAGE1_ROLLBACK_PATH") or "nas-rollback-evidence.json")
    out_path = os.environ.get("STAGE1_EVIDENCE_OUT") or "stage1-activation-evidence.json"
    now = datetime.now(timezone.utc).isoformat()

    activation_ok = bool(core and core.get("ACTIVATION_OK") is True and core.get("rollback_used") is not True)
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
        "core": sanitize(core) if core else None,
        "rollback": sanitize(rollback) if rollback else None,
    }
    if core:
        for key in (
            "before_raw_flags", "after_raw_flags", "runtime_public_flags",
            "post_activation", "functional_smoke", "privacy_smoke", "perf_smoke",
            "suppression", "http_5xx", "sqlite_busy", "health", "landing", "login",
            "final_digest", "final_oci_revision", "receipt_path",
        ):
            if key in core:
                doc[key] = sanitize(core.get(key))
    assert_clean(doc)
    open(out_path, "w", encoding="utf-8").write(json.dumps(doc, indent=2) + "\n")
    print(f"STAGE1_EVIDENCE_WRITTEN:{activation_result}:{rollback_result}:{str(activation_ok).lower()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
