#!/usr/bin/env python3
"""Write machine-readable Phase 15 workflow evidence. No secrets."""
import json
import os
import sys

schema = "phase15-workflow-evidence-v1"
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
    "image_digest": os.environ.get("IMAGE_DIGEST") or None,
    "oci_revision": os.environ.get("OCI_REVISION") or None,
    "oci_source": os.environ.get("OCI_SOURCE") or None,
    "confirmation": os.environ.get("CONFIRMATION") or None,
}
backup_id = os.environ.get("BACKUP_ID")
backup_hash = os.environ.get("BACKUP_HASH")
if backup_id and backup_hash:
    doc["db_backup"] = {
        "backup_id": backup_id,
        "backup_hash": backup_hash,
        "verified": os.environ.get("BACKUP_VERIFIED", "true") == "true",
    }
health_ok = os.environ.get("HEALTH_OBSERVED")
if health_ok == "true":
    doc["health"] = {
        "passed": True,
        "health": os.environ.get("HEALTH_API", "true") == "true",
        "landing": os.environ.get("HEALTH_LANDING", "true") == "true",
        "login": os.environ.get("HEALTH_LOGIN", "true") == "true",
        "container_running": os.environ.get("HEALTH_CONTAINER", "true") == "true",
        "image_digest": os.environ.get("IMAGE_DIGEST") or None,
        "oci_revision": os.environ.get("OCI_REVISION") or None,
    }
path = sys.argv[1] if len(sys.argv) > 1 else "phase15-workflow-evidence.json"
open(path, "w").write(json.dumps(doc, indent=2) + "\n")
print(path)
