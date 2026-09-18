#!/usr/bin/env python3
"""Validate a staged Stage 2/3/4 activation run and emit evidence + durable receipt.

Fail-closed: writes ACTIVATION_OK only when the class, before/after flag
contract, postcheck and identity binding all agree. Never repairs production.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone

STAGE_FLAGS = {
    2: ("offer_enabled",),
    3: ("public_share_v2_enabled",),
    4: ("owner_notifications_enabled", "notifications_enabled"),
}
EARLIER_FLAGS = {
    2: ("owner_matching_enabled",),
    3: ("owner_matching_enabled", "offer_enabled"),
    4: ("owner_matching_enabled", "offer_enabled", "public_share_v2_enabled"),
}
LATER_FLAGS = {
    2: ("public_share_v2_enabled", "owner_notifications_enabled", "notifications_enabled"),
    3: ("owner_notifications_enabled", "notifications_enabled"),
    4: (),
}
OUTBOUND_FLAGS = ("digest_enabled", "outbound_mail_enabled", "outbound_push_enabled")
UNKNOWN_PHASES = ("PRODUCTION_STATE_UNKNOWN",)
REQUIRED_POSTCHECK_CHECKS = (
    "pr_a_flags_on",
    "stage1_on",
    "target_stage_on",
    "later_stages_off",
    "outbound_off",
    "privacy_redaction",
)
# `redaction` mixes boolean checks with the `leak_report` *report* (the list of
# leaks found). A report is NOT a boolean: requiring it to be `true` would fail
# the activation precisely when zero leaks were found, so reports get their own
# handling below and must be an explicit empty list.
REDACTION_CHECKS = (
    "probe_bodies_without_pii",
    "closed_gate_responses_are_opaque",
    "authenticated_probe_requires_session",
)
REDACTION_REPORTS = ("leak_report",)


def load(path: str) -> dict:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def wish_of(payload: dict) -> dict:
    """Resolve the wish block from an inspect snapshot or a domain result.

    A domain `activate` result carries `after_raw_flags`/`before_raw_flags` while
    an `inspect` snapshot carries `raw_flags`; both shapes must resolve.
    """
    flags = payload.get("after_raw_flags") or payload.get("raw_flags") or payload
    return (flags or {}).get("wish") or {}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", type=int, required=True)
    parser.add_argument("--class", dest="klass", required=True)
    parser.add_argument("--inspect", required=True)
    parser.add_argument("--result", required=True)
    parser.add_argument("--status", required=True)
    parser.add_argument("--postcheck", required=True)
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--workflow", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--tree-sha", required=True)
    parser.add_argument("--image-digest", required=True)
    parser.add_argument("--backup-id", required=True)
    parser.add_argument("--backup-hash", required=True)
    return parser.parse_args()


def collect_problems(args, inspect_doc, result_doc, status_doc, postcheck_doc) -> list[str]:
    before_wish = wish_of(inspect_doc)
    after_wish = wish_of(result_doc)
    problems: list[str] = []

    if status_doc.get("phase") in UNKNOWN_PHASES:
        problems.append("domain reported PRODUCTION_STATE_UNKNOWN")
    # A successful activate ends in `after-verify` with mutated=true (flags really
    # were changed). A verify-only run must never have started a mutation.
    if args.klass == "activate" and status_doc.get("phase") != "after-verify":
        problems.append(
            f"activate class ended in domain phase {status_doc.get('phase')!r} instead of 'after-verify'"
        )
    if args.klass == "verify-only" and status_doc.get("mutated") is True:
        problems.append("verify-only class started a mutation")

    for key in EARLIER_FLAGS[args.stage]:
        if before_wish.get(key) is not True:
            problems.append(f"before: earlier flag {key} was not ON")
        if after_wish.get(key) is not True:
            problems.append(f"after: earlier flag {key} was not ON")
    for key in LATER_FLAGS[args.stage]:
        if after_wish.get(key) is not False:
            problems.append(f"after: later flag {key} was not OFF")
    for key in OUTBOUND_FLAGS:
        if after_wish.get(key) is not False:
            problems.append(f"after: outbound flag {key} was not OFF")

    if args.klass == "activate":
        for key in STAGE_FLAGS[args.stage]:
            if before_wish.get(key) is not False:
                problems.append(f"before: target flag {key} was not OFF")
            if after_wish.get(key) is not True:
                problems.append(f"after: target flag {key} was not ON")
        if result_doc.get("mode") != "activate":
            problems.append(f"activate class but domain mode={result_doc.get('mode')!r}")
    else:
        if result_doc.get("mode") != "inspect":
            problems.append("verify-only class requires the unmutated inspect snapshot")
        for key in STAGE_FLAGS[args.stage]:
            if after_wish.get(key) is not True:
                problems.append(f"verify-only: target flag {key} was not ON")

    checks = postcheck_doc.get("checks") or {}
    for key in REQUIRED_POSTCHECK_CHECKS:
        if checks.get(key) is not True:
            problems.append(f"postcheck {key} did not pass")
    if postcheck_doc.get("ok") is not True:
        problems.append("postcheck ok was not true")
    if postcheck_doc.get("stage") != args.stage:
        problems.append("postcheck stage does not match the target stage")
    if postcheck_doc.get("source_sha") != args.source_sha:
        problems.append("postcheck ran against a different source SHA")
    redaction = postcheck_doc.get("redaction") or {}
    if not redaction:
        problems.append("privacy redaction evidence missing")
    for name in REDACTION_CHECKS:
        if redaction.get(name) is not True:
            problems.append(f"privacy redaction {name} not verified")
    for name in REDACTION_REPORTS:
        report = redaction.get(name)
        if not isinstance(report, list):
            problems.append(f"privacy redaction {name} report missing")
        elif report:
            problems.append(f"privacy redaction {name} reported leaks")
    for name, value in redaction.items():
        if name in REDACTION_CHECKS or name in REDACTION_REPORTS:
            continue
        if not isinstance(value, bool):
            problems.append(f"privacy redaction {name} is not a boolean check")
        elif value is not True:
            problems.append(f"privacy redaction {name} not verified")

    return problems


def main() -> int:
    args = parse_args()
    if args.stage not in STAGE_FLAGS:
        raise SystemExit(f"unsupported --stage {args.stage}")
    if args.klass not in ("activate", "verify-only"):
        raise SystemExit(f"unsupported --class {args.klass}")

    inspect_doc = load(args.inspect)
    result_doc = load(args.result)
    status_doc = load(args.status)
    postcheck_doc = load(args.postcheck)

    before_wish = wish_of(inspect_doc)
    after_wish = wish_of(result_doc)
    problems = collect_problems(args, inspect_doc, result_doc, status_doc, postcheck_doc)

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    identity = {
        "source_sha": args.source_sha,
        "src_tree_sha256": args.tree_sha,
        "image_digest": args.image_digest,
        "backup_id": args.backup_id,
        "backup_hash": args.backup_hash,
        "target_stage": args.stage,
        "workflow": args.workflow,
        "run_id": args.run_id,
    }
    evidence = {
        "schema": "rental-marketplace-staged-activation/v1",
        "generated_at": now,
        "identity": identity,
        "class": args.klass,
        "domain_mode": result_doc.get("mode"),
        "domain_phase": status_doc.get("phase"),
        "target_flags": {
            key: {"before": before_wish.get(key), "after": after_wish.get(key)}
            for key in STAGE_FLAGS[args.stage]
        },
        "stage_boundary": {
            "earlier_flags_on": {key: after_wish.get(key) for key in EARLIER_FLAGS[args.stage]},
            "later_flags_off": {key: after_wish.get(key) for key in LATER_FLAGS[args.stage]},
            "outbound_off": {key: after_wish.get(key) for key in OUTBOUND_FLAGS},
        },
        "postcheck": postcheck_doc,
        "mutation_kinds": ["settings:rental-marketplace"] if args.klass == "activate" else [],
        "problems": problems,
    }

    with open(args.evidence, "w", encoding="utf-8") as handle:
        json.dump(evidence, handle, indent=2, sort_keys=True)
        handle.write("\n")

    if problems:
        print(json.dumps({"ACTIVATION_OK": False, "problems": problems}, indent=2))
        return 1

    receipt = {
        **identity,
        "ACTIVATION_OK": True,
        "activated_at": now,
        "evidence_schema": evidence["schema"],
        "domain_mode": result_doc.get("mode"),
    }
    with open(args.receipt, "w", encoding="utf-8") as handle:
        json.dump(receipt, handle, indent=2, sort_keys=True)
        handle.write("\n")

    print(json.dumps({"ACTIVATION_OK": True, "stage": args.stage, "class": args.klass}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

