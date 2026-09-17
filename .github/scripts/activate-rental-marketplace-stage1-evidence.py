#!/usr/bin/env python3
"""Stage 1 activation evidence contract. Fail-closed. No mutation."""
from __future__ import annotations

import json
import sys

PERF_BUDGET_MS = 5000
UAT_PREREQ = "PRODUCTION_UAT_PASS"


def fail(message: str) -> None:
    raise SystemExit(message)


def assert_perf_smoke(perf) -> None:
    if not isinstance(perf, dict) or not perf:
        fail("perf_smoke is missing")
    budget = perf.get("budget_ms")
    if budget != PERF_BUDGET_MS:
        fail("perf_smoke.budget_ms must be 5000")
    agg = perf.get("aggregate_ms")
    exp = perf.get("exposure_ms")
    if type(agg) is not int or type(exp) is not int:
        fail("perf_smoke times must be integers")
    within = agg < budget and exp < budget
    if within is False:
        fail("perf smoke exceeded 5000ms budget; refusing ACTIVATION_OK")
    if perf.get("ok") is not True:
        fail("perf_smoke.ok is not true; refusing ACTIVATION_OK")


def assert_probe_provenance(value, name) -> None:
    if value is True or value is False:
        fail(f"{name} must not be a bare boolean; defined-probe provenance is required")
    if not isinstance(value, dict):
        fail(f"{name} provenance block is missing")
    if value.get("provenance") != "defined_probes":
        fail(f"{name} provenance must be defined_probes")
    probes = value.get("probes")
    if not isinstance(probes, list) or not probes:
        fail(f"{name} probes are missing; refusing ACTIVATION_OK")
    if value.get("observed") is not False:
        fail(f"{name} observed must be false after successful defined probes")


def assert_bound_uat_block(block, label, source_sha, image_digest) -> None:
    if not isinstance(block, dict):
        fail(f"{label} block is missing")
    if block.get("verified") is True or block.get("checked") is True:
        fail(f"{label} must not claim executed verification from this activation run")
    if block.get("authoritative_source") != UAT_PREREQ:
        fail(f"{label} authoritative_source must be PRODUCTION_UAT_PASS")
    if block.get("uat_attestation_bound") is not True:
        fail(f"{label} requires identity-bound PRODUCTION_UAT_PASS; refusing ACTIVATION_OK")
    if source_sha and block.get("bound_source_sha") != source_sha:
        fail(f"{label} bound_source_sha does not match")
    if image_digest and block.get("bound_image_digest") != image_digest:
        fail(f"{label} bound_image_digest does not match")


def assert_functional_smoke(func, source_sha="", image_digest="") -> None:
    if not isinstance(func, dict) or not func:
        fail("functional_smoke is missing")
    if "cross_account" in func:
        fail("functional_smoke.cross_account must not be claimed from unauth probes")
    if func.get("summary_unauth") != 401 or func.get("detail_unauth") != 401:
        fail("unauth match probes must be 401")
    if func.get("unauth_match_denied") is not True:
        fail("unauth_match_denied must be true")
    uat = func.get("authenticated_cross_account")
    if not isinstance(uat, dict):
        fail("authenticated_cross_account prerequisite block is missing")
    if uat.get("probed_here") is not False:
        fail("authenticated cross-account must not be claimed as probed here")
    if uat.get("unauth_401_is_not_cross_account") is not True:
        fail("unauthenticated 401 cannot satisfy cross-account evidence")
    assert_bound_uat_block(uat, "authenticated_cross_account", source_sha, image_digest)


def assert_suppression(block, source_sha="", image_digest="") -> None:
    if not isinstance(block, dict) or not block:
        fail("suppression block is missing")
    if block.get("row_counts_are_not_verification") is not True:
        fail("row counts alone cannot satisfy suppression verification")
    assert_bound_uat_block(block, "suppression", source_sha, image_digest)


def assert_runtime_contract(payload) -> None:
    source_sha = payload.get("source_sha") or ""
    image_digest = payload.get("image_digest") or ""
    assert_perf_smoke(payload.get("perf_smoke"))
    assert_functional_smoke(payload.get("functional_smoke"), source_sha, image_digest)
    assert_suppression(payload.get("suppression"), source_sha, image_digest)
    assert_probe_provenance(payload.get("http_5xx"), "http_5xx")
    assert_probe_provenance(payload.get("sqlite_busy"), "sqlite_busy")
    expected_uat = f"{UAT_PREREQ}:{source_sha}:{image_digest}" if source_sha and image_digest else ""
    if expected_uat and payload.get("uat_attestation") != expected_uat:
        fail("uat_attestation is not bound to source SHA and digest")


def assert_activation_receipt(doc) -> None:
    if not isinstance(doc, dict):
        fail("activation receipt is invalid")
    assert_runtime_contract(doc)
    if doc.get("ACTIVATION_OK") is not True:
        fail("ACTIVATION_OK is not true")
    if doc.get("owner_authorization_bound") is not True:
        fail("owner_authorization_bound is required for ACTIVATION_OK")


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[0] not in ("--check-runtime", "--check-receipt"):
        fail("usage: activate-rental-marketplace-stage1-evidence.py --check-runtime|--check-receipt JSON")
    payload = json.load(open(argv[1], encoding="utf-8"))
    if argv[0] == "--check-runtime":
        assert_runtime_contract(payload)
        print("EVIDENCE_RUNTIME_OK")
        return 0
    assert_activation_receipt(payload)
    print("EVIDENCE_RECEIPT_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
