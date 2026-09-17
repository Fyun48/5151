#!/usr/bin/env python3
"""Normalize / recover Production UAT evidence. Fail-closed. No mutation.

A recovered recording pack is valid provenance for pre-activation UAT.
It cannot satisfy Stage 1 ON matching isolation or suppression.
Missing GitHub video is not the same as missing UAT; missing SHA is
allowed only when size + rejection provenance are recorded.
"""
from __future__ import annotations

import hashlib
import json
import sys

SCHEMA = "production-uat-evidence-pack-v1"
POST_ON_SOURCE = "post_activation_authenticated_probes"


def fail(message: str) -> None:
    raise SystemExit(message)


def file_sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def assert_recovered_pack(doc: dict) -> None:
    if not isinstance(doc, dict):
        fail("UAT evidence pack is invalid")
    if doc.get("schema") != SCHEMA:
        fail("UAT evidence pack schema is not production-uat-evidence-pack-v1")
    if doc.get("can_satisfy_post_activation_matching_gate") is True:
        fail("recovered UAT pack cannot satisfy post-activation matching gate")
    if doc.get("coverage_verdict") != "owner_matching_off_cannot_satisfy_post_activation_matching_gate":
        fail("coverage verdict must declare owner_matching OFF cannot satisfy post-activation gate")
    flags = doc.get("flag_snapshot") or {}
    if flags.get("wish.owner_matching_enabled") is not False:
        fail("recovered pack flag snapshot is not owner_matching OFF")
    if flags.get("phase") != "pre_activation":
        fail("recovered pack phase must be pre_activation")
    identity = doc.get("identity") or {}
    if not isinstance(identity.get("source_sha"), str) or len(identity.get("source_sha") or "") != 40:
        fail("recovered pack source_sha is missing")
    digest = identity.get("image_digest") or ""
    if not str(digest).startswith("sha256:") or len(digest) != 71:
        fail("recovered pack image_digest is not immutable")
    recordings = doc.get("recordings") or []
    if not isinstance(recordings, list) or not recordings:
        fail("recovered pack recordings are missing; missing GitHub video is not missing UAT")
    for rec in recordings:
        if not rec.get("filename") or type(rec.get("bytes")) is not int or rec.get("bytes") < 1:
            fail("recording filename/size provenance is missing")
        if rec.get("sha256") in (None, ""):
            if rec.get("github_upload") != "rejected_for_size":
                fail("recording sha256 missing without GitHub size-rejection provenance")
            if not rec.get("sha256_unavailable_reason"):
                fail("recording sha256 unavailable reason is missing")
        if rec.get("covers_post_activation_isolation") is True or rec.get("covers_post_activation_suppression") is True:
            fail("pre-activation recording cannot claim post-activation matching coverage")
    matching = doc.get("matching_safety") or {}
    if matching.get("post_activation_cross_account_isolation") != "not_covered":
        fail("pack must not claim post-activation cross-account coverage")
    if matching.get("post_activation_paused_completed_inactive_suppression") != "not_covered":
        fail("pack must not claim post-activation suppression coverage")
    if doc.get("required_next_gate") != POST_ON_SOURCE:
        fail("required next gate must be post_activation_authenticated_probes")
    if "PRODUCTION_UAT_PASS" == doc.get("authoritative_source"):
        fail("pre-activation PRODUCTION_UAT_PASS cannot satisfy post-activation evidence")


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[0] != "--check-pack":
        fail("usage: normalize-production-uat-evidence.py --check-pack JSON")
    path = argv[1]
    doc = json.load(open(path, encoding="utf-8"))
    assert_recovered_pack(doc)
    print("UAT_EVIDENCE_PACK_OK")
    print(file_sha256(path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
