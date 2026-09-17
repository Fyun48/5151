#!/usr/bin/env python3
"""Stage 1 activation evidence contract. Fail-closed. No mutation.

Post-activation authenticated probes are the only accepted source for
cross-account isolation and wish suppression. Pre-activation
PRODUCTION_UAT_PASS cannot satisfy ACTIVATION_OK.
"""
from __future__ import annotations

import json
import sys

PERF_BUDGET_MS = 5000
POST_ACTIVATION_SOURCE = "post_activation_authenticated_probes"
REQUIRED_PROBE_KEYS = ("name", "timestamp", "target", "method", "auth", "status", "result")
REQUIRED_SUPPRESSION = ("paused", "completed", "inactive")


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


def assert_probe_rows(probes, label) -> None:
    if not isinstance(probes, list) or not probes:
        fail(f"{label} probes are missing; refusing ACTIVATION_OK")
    blob = json.dumps(probes, ensure_ascii=False)
    if "PRODUCTION_UAT_PASS" in blob:
        fail("post-activation evidence must not cite PRODUCTION_UAT_PASS")
    for probe in probes:
        if not isinstance(probe, dict):
            fail(f"{label} probe is invalid")
        for key in REQUIRED_PROBE_KEYS:
            if probe.get(key) in (None, ""):
                fail(f"{label} probe missing {key}")
        if probe.get("result") in ("timeout", "http_5xx", "sqlite_busy"):
            fail(f"{label} probe {probe.get('name')} failed closed ({probe.get('result')})")
        if probe.get("http_5xx") is True or probe.get("sqlite_busy") is True or probe.get("timed_out") is True:
            fail(f"{label} probe {probe.get('name')} recorded a fail-closed signal")


def refuse_pre_activation_uat(block, label) -> None:
    if not isinstance(block, dict):
        fail(f"{label} block is missing")
    source = block.get("authoritative_source")
    if source == "PRODUCTION_UAT_PASS" or block.get("uat_attestation_bound") is True:
        fail(f"pre-activation PRODUCTION_UAT_PASS cannot satisfy post-activation {label} evidence")
    if source != POST_ACTIVATION_SOURCE:
        fail(f"{label} authoritative_source must be {POST_ACTIVATION_SOURCE}")


def assert_functional_smoke(func) -> None:
    if not isinstance(func, dict) or not func:
        fail("functional_smoke is missing")
    if "cross_account" in func:
        fail("functional_smoke.cross_account must not be claimed from unauth probes")
    if func.get("summary_unauth") != 401 or func.get("detail_unauth") != 401:
        fail("unauth match probes must be 401")
    if func.get("unauth_match_denied") is not True:
        fail("unauth_match_denied must be true")
    cross = func.get("authenticated_cross_account")
    refuse_pre_activation_uat(cross, "authenticated_cross_account")
    if cross.get("probed_here") is not True:
        fail("authenticated cross-account must be probed after Stage 1 ON")
    if cross.get("verified") is not True:
        fail("authenticated cross-account must be verified by post-activation probes")
    if cross.get("unauth_401_is_not_cross_account") is not True:
        fail("unauthenticated 401 cannot satisfy cross-account evidence")
    assert_probe_rows(cross.get("probes"), "authenticated_cross_account")
    results = [row.get("result") for row in cross.get("probes")]
    statuses = [row.get("status") for row in cross.get("probes")]
    codes = [row.get("code") for row in cross.get("probes")]
    if any(status == 401 for status in statuses) or "unauth_style_401" in results:
        fail("unauthenticated 401 cannot satisfy cross-account evidence")
    if "opaque_denial" not in results:
        fail("authenticated cross-account missing opaque denial probe")
    if "listing_not_found" not in codes:
        fail("authenticated cross-account must record opaque listing_not_found")


def assert_suppression(block) -> None:
    if not isinstance(block, dict) or not block:
        fail("suppression block is missing")
    if block.get("row_counts_are_not_verification") is not True:
        fail("row counts alone cannot satisfy suppression verification")
    if block.get("district_rent_heuristics_are_not_sufficient") is not True:
        fail("district/rent overlap cannot satisfy suppression fixtures")
    if block.get("counterfactual_eligible_required") is not True:
        fail("suppression fixtures must be counterfactually eligible via evaluateMatch")
    refuse_pre_activation_uat(block, "suppression")
    if not block.get("probes"):
        fail("row counts alone cannot satisfy suppression verification")
    if block.get("verified") is not True or block.get("probed_here") is not True:
        fail("suppression must be verified by post-activation probes")
    if type(block.get("suppressed_candidate_count")) is not int or block.get("suppressed_candidate_count") < 1:
        fail("suppression candidates missing; refusing ACTIVATION_OK")
    if block.get("leaked_count") != 0:
        fail("suppressed wishes leaked into matching results")
    checked = block.get("lifecycles_checked") or []
    for name in REQUIRED_SUPPRESSION:
        if name not in checked:
            fail(f"suppression did not check {name} wishes")
    assert_probe_rows(block.get("probes"), "suppression")
    if not any(row.get("result") == "owner_ok" for row in block.get("probes")):
        fail("suppression probe did not record owner_ok matching results")


def assert_post_activation(block) -> None:
    if not isinstance(block, dict) or not block:
        fail("post_activation evidence is missing")
    if block.get("phase") != "post_activation":
        fail("post_activation.phase must be post_activation")
    if block.get("probed_here") is not True:
        fail("post_activation must be probed here")
    if block.get("authoritative_source") != POST_ACTIVATION_SOURCE:
        fail("post_activation authoritative_source must be post_activation_authenticated_probes")
    if not block.get("started_at") or not block.get("finished_at"):
        fail("post_activation timestamp provenance is missing")
    assert_probe_rows(block.get("probes"), "post_activation")


def assert_runtime_contract(payload) -> None:
    if payload.get("uat_attestation") or payload.get("uat_attestation_bound") is True:
        fail("pre-activation PRODUCTION_UAT_PASS cannot satisfy post-activation evidence")
    assert_perf_smoke(payload.get("perf_smoke"))
    assert_functional_smoke(payload.get("functional_smoke"))
    assert_suppression(payload.get("suppression"))
    assert_post_activation(payload.get("post_activation") or payload)
    assert_probe_provenance(payload.get("http_5xx"), "http_5xx")
    assert_probe_provenance(payload.get("sqlite_busy"), "sqlite_busy")


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
