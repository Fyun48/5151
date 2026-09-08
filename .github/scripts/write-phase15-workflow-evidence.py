#!/usr/bin/env python3
"""Write machine-readable Phase 15 workflow evidence. No secrets.

Proof booleans must be supplied explicitly as exactly \"true\" or \"false\".
Missing or invalid values fail closed — this script will not invent PASS.
"""
import hashlib
import json
import os
import re
import sys

DIGEST_RE = re.compile(r"^sha256:[a-f0-9]{64}$")


def optional_env(name: str):
    raw = os.environ.get(name)
    return raw if raw else None


def require_exact_bool(name: str) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        raise SystemExit(f"{name} is required and must be exactly true or false")
    if raw == "true":
        return True
    if raw == "false":
        return False
    raise SystemExit(f"{name} must be exactly true or false")


def optional_exact_bool(name: str):
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return None
    if raw == "true":
        return True
    if raw == "false":
        return False
    raise SystemExit(f"{name} must be exactly true or false")


kind = os.environ.get("EVIDENCE_KIND") or "full"
if kind == "identity":
    schema = "phase15-run-identity-v1"
elif kind == "full":
    schema = "phase15-workflow-evidence-v1"
else:
    raise SystemExit("EVIDENCE_KIND must be identity or full")

doc = {
    "schema": schema,
    "workflow_file": os.environ.get("WF_FILE", ""),
    "workflow_ref": os.environ.get("WF_REF", ""),
    "workflow_run_id": os.environ.get("WF_RUN_ID", ""),
    "workflow_attempt": int(os.environ.get("WF_ATTEMPT") or "0"),
    "head_sha": os.environ.get("WF_HEAD_SHA", ""),
    "source_sha": os.environ.get("SOURCE_SHA", ""),
    "actor": os.environ.get("WF_ACTOR", ""),
    "triggering_actor": os.environ.get("WF_TRIGGERING_ACTOR", ""),
    "environment": os.environ.get("WF_ENVIRONMENT") or None,
    "release_intent_id": os.environ.get("RELEASE_INTENT_ID") or None,
    "image_digest": os.environ.get("IMAGE_DIGEST") or None,
    "oci_revision": os.environ.get("OCI_REVISION") or None,
    "oci_source": os.environ.get("OCI_SOURCE") or None,
    "confirmation": os.environ.get("CONFIRMATION") or None,
}

required = [
    "workflow_file",
    "workflow_ref",
    "workflow_run_id",
    "head_sha",
    "source_sha",
    "actor",
    "triggering_actor",
    "release_intent_id",
]
if doc["workflow_attempt"] < 1 or any(not doc.get(k) for k in required):
    raise SystemExit("phase15 evidence missing required identity")
if doc["workflow_file"].endswith("production-predeploy-check.yml") or doc["workflow_file"].endswith("deploy-v3.yml"):
    if doc.get("environment") != "production" or not doc.get("confirmation"):
        raise SystemExit("phase15 evidence missing environment or confirmation")
elif doc.get("environment"):
    raise SystemExit("phase15 build evidence must not claim a Production environment")

if kind == "full":
    backup_id = os.environ.get("BACKUP_ID")
    backup_hash = os.environ.get("BACKUP_HASH")
    if backup_id or backup_hash:
        if not backup_id or not backup_hash:
            raise SystemExit("BACKUP_ID and BACKUP_HASH are required together")
        doc["db_backup"] = {
            "backup_id": backup_id,
            "backup_hash": backup_hash,
            "verified": require_exact_bool("BACKUP_VERIFIED"),
        }

    current_digest = optional_env("CURRENT_DIGEST")
    current_image_ref = optional_env("CURRENT_IMAGE_REF")
    current_image_id = optional_env("CURRENT_IMAGE_ID")
    current_container = optional_env("CURRENT_CONTAINER")
    if current_digest or current_image_ref or current_image_id or current_container:
        if not current_digest or not DIGEST_RE.fullmatch(current_digest):
            raise SystemExit("CURRENT_DIGEST is required and must be an immutable sha256 digest")
        doc["current_production"] = {
            "digest": current_digest,
            "image_ref": current_image_ref,
            "image_id": current_image_id,
            "container": current_container,
        }

    health_observed = optional_exact_bool("HEALTH_OBSERVED")
    if health_observed is True:
        doc["health"] = {
            "passed": True,
            "health": require_exact_bool("HEALTH_API"),
            "landing": require_exact_bool("HEALTH_LANDING"),
            "login": require_exact_bool("HEALTH_LOGIN"),
            "container_running": require_exact_bool("HEALTH_CONTAINER"),
            "image_digest": os.environ.get("IMAGE_DIGEST") or None,
            "oci_revision": os.environ.get("OCI_REVISION") or None,
        }
        if not (
            doc["health"]["health"]
            and doc["health"]["landing"]
            and doc["health"]["login"]
            and doc["health"]["container_running"]
        ):
            doc["health"]["passed"] = False
    elif health_observed is False:
        raise SystemExit("HEALTH_OBSERVED=false cannot produce health proof")

canonical = json.dumps(doc, sort_keys=True, separators=(",", ":")).encode("utf-8")
doc["evidence_sha256"] = "sha256:" + hashlib.sha256(canonical).hexdigest()
path = sys.argv[1] if len(sys.argv) > 1 else (
    "phase15-run-identity.json" if kind == "identity" else "phase15-workflow-evidence.json"
)
open(path, "w").write(json.dumps(doc, indent=2) + "\n")
print(path)
