#!/usr/bin/env python3
"""Fail-closed SQLite integrity JSON.

Accepts only an object whose integrity_check is exactly \"ok\" and whose ok
flag is the boolean True. Presence of the key \"ok\" is not enough.
"""
import json
import sys


def verify_integrity_doc(doc) -> None:
    if not isinstance(doc, dict):
        raise SystemExit("integrity json must be an object")
    if doc.get("integrity_check") != "ok" or doc.get("ok") is not True:
        raise SystemExit("sqlite integrity check failed")


def verify_integrity_json(raw: str) -> None:
    try:
        doc = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"integrity json is not valid JSON: {exc}") from exc
    verify_integrity_doc(doc)


if __name__ == "__main__":
    if len(sys.argv) > 1:
        raw = open(sys.argv[1], encoding="utf-8").read()
    else:
        raw = sys.stdin.read()
    verify_integrity_json(raw)
