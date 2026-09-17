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
    if perf.get("ok") is True and within is False:
        fail("perf_smoke.ok contradicts measured times; refusing ACTIVATION_OK")


def assert_functional_smoke(func) -> None:
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
    if uat.get("prerequisite") != UAT_PREREQ:
        fail("authenticated cross-account prerequisite must be PRODUCTION_UAT_PASS")


def assert_activation_receipt(doc) -> None:
    if not isinstance(doc, dict):
        fail("activation receipt is invalid")
    assert_perf_smoke(doc.get("perf_smoke"))
    assert_functional_smoke(doc.get("functional_smoke"))
    if doc.get("ACTIVATION_OK") is not True:
        fail("ACTIVATION_OK is not true")


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[0] not in ("--check-runtime", "--check-receipt"):
        fail("usage: activate-rental-marketplace-stage1-evidence.py --check-runtime|--check-receipt JSON")
    payload = json.load(open(argv[1], encoding="utf-8"))
    if argv[0] == "--check-runtime":
        assert_perf_smoke(payload.get("perf_smoke"))
        assert_functional_smoke(payload.get("functional_smoke"))
        print("EVIDENCE_RUNTIME_OK")
        return 0
    assert_activation_receipt(payload)
    print("EVIDENCE_RECEIPT_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
