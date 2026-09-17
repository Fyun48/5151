#!/usr/bin/env python3
"""Classify Stage 1 owner_matching activation path. Fail-closed. No mutation."""
from __future__ import annotations

import json
import os
import sys

STAGE2_PLUS = (
    "offer_enabled",
    "public_share_v2_enabled",
    "owner_notifications_enabled",
    "notifications_enabled",
    "digest_enabled",
    "outbound_mail_enabled",
    "outbound_push_enabled",
)

IDENTITY_KEYS = (
    "source_sha",
    "image_digest",
    "backup_id",
    "backup_hash",
    "src_tree_sha256",
)


def fail(message: str) -> None:
    raise SystemExit(message)


def classify(flags: dict, receipt_path: str, identity: dict) -> str:
    wish = flags.get("wish") or {}
    if (flags.get("rental_catalog_v2") or {}).get("enabled") is not True:
        fail("PRA rental_catalog_v2.enabled is not true; STOP")
    if wish.get("lifecycle_enabled") is not True:
        fail("PRA wish.lifecycle_enabled is not true; STOP")
    if any(wish.get(key) is not False for key in STAGE2_PLUS):
        fail("Stage 2-4 or outbound flag is already true; STOP")
    matching = wish.get("owner_matching_enabled")
    if matching is False:
        return "activate"
    if matching is not True:
        fail("owner_matching flag is inconsistent; STOP")
    if not os.path.isfile(receipt_path):
        fail("owner_matching already true but durable receipt is missing; STOP")
    receipt = json.load(open(receipt_path, encoding="utf-8"))
    for key in IDENTITY_KEYS:
        if receipt.get(key) != identity.get(key):
            fail(f"owner_matching already true but receipt {key} does not match; STOP")
    if receipt.get("ACTIVATION_OK") is not True:
        fail("owner_matching already true but receipt is not ACTIVATION_OK; STOP")
    return "verify-only"


def main(argv: list[str]) -> int:
    if len(argv) != 7:
        fail(
            "usage: activate-rental-marketplace-stage1-path.py "
            "FLAGS_JSON RECEIPT_PATH SOURCE_SHA IMAGE_DIGEST BACKUP_ID BACKUP_HASH TREE_SHA"
        )
    flags_json, receipt_path, source_sha, image_digest, backup_id, backup_hash, tree_sha = argv
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
    print(classify(flags, receipt_path, identity))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
