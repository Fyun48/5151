#!/usr/bin/env python3
"""Stage 1 fixture evidence contract. Fail-closed. No flag mutation."""
from __future__ import annotations

import json
import re
import sys

FORBIDDEN = ("SESSION_SECRET", "NAS_SSH_KEY", "AUTH_PASSWORD", "auth.env", "rank_score")
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
# Boundary-anchored so a compact fixture run id (stage1-fix:20260918061756:...)
# is not mistaken for a 09xxxxxxxx mobile number.
PHONE_RE = re.compile(r"(?<![0-9])09\d{8}(?![0-9])")
# Only these modes may run once the later stages are legitimately ON.
CLEANUP_MODES = ("cleanup", "reap-stale", "cleanup-activated")
STAGE_FLAGS = (
    "offer_enabled",
    "public_share_v2_enabled",
    "owner_notifications_enabled",
    "notifications_enabled",
)
OUTBOUND = ("digest_enabled", "outbound_mail_enabled", "outbound_push_enabled")


def fail(message: str) -> None:
    raise SystemExit(message)


def activated_posture(doc: dict) -> bool:
    """True only for an explicitly declared post-activation cleanup/reap run."""
    if doc.get("posture") != "post_activation":
        return False
    if doc.get("mode") not in CLEANUP_MODES:
        fail("prepare/verify must not run in the post-activation posture")
    return True


def assert_flags(flags, label: str, activated: bool = False) -> None:
    if not isinstance(flags, dict):
        fail(f"{label} flags missing")
    if (flags.get("rental_catalog_v2") or {}).get("enabled") is not True:
        fail(f"{label} rental_catalog_v2.enabled must be true")
    wish = flags.get("wish") or {}
    if wish.get("lifecycle_enabled") is not True:
        fail(f"{label} wish.lifecycle_enabled must be true")
    owner_expected = True if activated else False
    if wish.get("owner_matching_enabled") is not owner_expected:
        fail(f"{label} wish.owner_matching_enabled must be {owner_expected}")
    for key in STAGE_FLAGS:
        if wish.get(key) is not activated:
            fail(f"{label} wish.{key} must be {activated}")
    for key in OUTBOUND:
        if wish.get(key) is not False:
            fail(f"{label} wish.{key} must be false")


def assert_clean(doc: dict) -> None:
    blob = json.dumps(doc, ensure_ascii=False)
    for token in FORBIDDEN:
        if token in blob:
            fail(f"fixture evidence leaked {token}")
    if EMAIL_RE.search(blob):
        fail("fixture evidence leaked email")
    if PHONE_RE.search(blob):
        fail("fixture evidence leaked phone")


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        fail("usage: stage1-fixture-evidence.py JSON")
    doc = json.load(open(argv[0], encoding="utf-8"))
    if not isinstance(doc, dict):
        fail("fixture evidence is invalid")
    if doc.get("flags_mutated") is True:
        fail("fixture workflow must not mutate flags")
    activated = activated_posture(doc)
    assert_flags(doc.get("before_raw_flags") or doc.get("after_raw_flags") or {}, "fixture", activated)
    owner_expected = True if activated else False
    if doc.get("owner_matching_enabled") is not owner_expected:
        fail(f"owner_matching_enabled must be {owner_expected}")
    assert_clean(doc)
    print("FIXTURE_EVIDENCE_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
