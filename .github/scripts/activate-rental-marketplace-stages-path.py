#!/usr/bin/env python3
"""Classify a staged Stage 2/3/4 activation path. Fail-closed. No mutation.

activate     : target stage OFF, all earlier stages ON, all later stages OFF, outbound OFF.
verify-only  : target stage already ON and the durable receipt matches this exact
               source SHA / digest / backup / tree / stage and is ACTIVATION_OK.
Anything else stops.
"""
from __future__ import annotations

import json
import os
import sys

STAGE_FLAGS = {
    2: ("offer_enabled",),
    3: ("public_share_v2_enabled",),
    4: ("owner_notifications_enabled", "notifications_enabled"),
}
EARLIER_FLAGS = {2: ("owner_matching_enabled",), 3: ("owner_matching_enabled", "offer_enabled")}
LATER_FLAGS = {
    2: ("public_share_v2_enabled", "owner_notifications_enabled", "notifications_enabled"),
    3: ("owner_notifications_enabled", "notifications_enabled"),
    4: (),
}
OUTBOUND_FLAGS = ("digest_enabled", "outbound_mail_enabled", "outbound_push_enabled")
IDENTITY_KEYS = ("source_sha", "image_digest", "backup_id", "backup_hash", "src_tree_sha256")


def fail(message: str) -> None:
    raise SystemExit(message)


def normalize_stage(raw) -> int:
    stage = int(str(raw).strip() or 0)
    if stage not in STAGE_FLAGS:
        fail(f"target_stage {raw!r} is not 2, 3 or 4; STOP")
    return stage


def classify(flags: dict, receipt_path: str, identity: dict, stage: int) -> str:
    wish = flags.get("wish") or {}
    if (flags.get("rental_catalog_v2") or {}).get("enabled") is not True:
        fail("PR A rental_catalog_v2.enabled is not true; STOP")
    if wish.get("lifecycle_enabled") is not True:
        fail("PR A wish.lifecycle_enabled is not true; STOP")
    if any(wish.get(key) is not False for key in OUTBOUND_FLAGS):
        fail("an outbound channel flag is already true; STOP")
    for key in EARLIER_FLAGS[stage]:
        if wish.get(key) is not True:
            fail(f"Stage {stage} requires earlier flag {key} ON; STOP")
    for key in LATER_FLAGS[stage]:
        if wish.get(key) is not False:
            fail(f"Stage {stage} requires later flag {key} OFF; STOP")

    mine = STAGE_FLAGS[stage]
    on = [key for key in mine if wish.get(key) is True]
    off = [key for key in mine if wish.get(key) is False]
    if off and on:
        fail(f"Stage {stage} target flags are inconsistent; STOP")
    if off:
        return "activate"
    if not on:
        fail(f"Stage {stage} target flag state is unknown; STOP")

    if not os.path.isfile(receipt_path):
        fail(f"Stage {stage} already ON but durable receipt is missing; STOP")
    receipt = json.load(open(receipt_path, encoding="utf-8"))
    for key in IDENTITY_KEYS:
        if receipt.get(key) != identity.get(key):
            fail(f"Stage {stage} already ON but receipt {key} does not match; STOP")
    if str(receipt.get("target_stage") or "") != str(stage):
        fail(f"Stage {stage} already ON but receipt target_stage does not match; STOP")
    if receipt.get("ACTIVATION_OK") is not True:
        fail(f"Stage {stage} already ON but receipt is not ACTIVATION_OK; STOP")
    return "verify-only"


def main(argv: list[str]) -> int:
    if len(argv) != 8:
        fail(
            "usage: activate-rental-marketplace-stages-path.py "
            "FLAGS_JSON RECEIPT_PATH TARGET_STAGE SOURCE_SHA IMAGE_DIGEST BACKUP_ID BACKUP_HASH TREE_SHA"
        )
    flags_json, receipt_path, raw_stage, source_sha, image_digest, backup_id, backup_hash, tree_sha = argv
    payload = json.load(open(flags_json, encoding="utf-8"))
    flags = payload.get("raw_flags") if isinstance(payload, dict) and "raw_flags" in payload else payload
    if not isinstance(flags, dict):
        fail("inspect flags payload is invalid")
    identity = {
        "source_sha": source_sha,
        "image_digest": image_digest,
        "backup_id": backup_id,
        "backup_hash": backup_hash,
        "src_tree_sha256": tree_sha,
    }
    print(classify(flags, receipt_path, identity, normalize_stage(raw_stage)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
