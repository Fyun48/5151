#!/usr/bin/env python3
"""Deterministic v3/src content manifest. Reads bytes only; never executes JS."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys

SCHEMA = "pra-src-manifest-v1"
PREFIX = "v3/src"


def sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def build_doc(files: dict[str, str]) -> dict:
    ordered = dict(sorted(files.items()))
    if not ordered:
        raise SystemExit("v3/src manifest is empty")
    tree_blob = "".join(f"{path}\t{digest}\n" for path, digest in ordered.items()).encode()
    return {
        "schema": SCHEMA,
        "prefix": PREFIX,
        "file_count": len(ordered),
        "files": ordered,
        "tree_sha256": sha256_bytes(tree_blob),
    }


def write_doc(doc: dict, dest: str) -> None:
    with open(dest, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2, sort_keys=False)
        fh.write("\n")


def from_git(sha: str) -> dict:
    if not sha or len(sha) != 40:
        raise SystemExit("source sha must be a full 40-character commit")
    raw = subprocess.check_output(
        ["git", "ls-tree", "-r", "-z", sha, "--", PREFIX],
        stderr=subprocess.STDOUT,
    )
    files: dict[str, str] = {}
    for entry in raw.split(b"\0"):
        if not entry:
            continue
        meta, path_b = entry.split(b"\t", 1)
        _mode, typ, obj = meta.split()
        if typ != b"blob":
            continue
        path = path_b.decode()
        if not path.startswith(PREFIX + "/"):
            raise SystemExit(f"unexpected git path {path}")
        rel = path[len(PREFIX) + 1 :]
        data = subprocess.check_output(["git", "cat-file", "blob", obj.decode()])
        files[rel] = sha256_bytes(data)
    return build_doc(files)


def from_dir(root: str) -> dict:
    files: dict[str, str] = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(dirnames)
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            if not os.path.isfile(full) or os.path.islink(full):
                continue
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            with open(full, "rb") as fh:
                files[rel] = sha256_bytes(fh.read())
    return build_doc(files)


def from_docker(container: str, dest: str = "/app/src") -> dict:
    listing = subprocess.check_output(
        ["docker", "exec", container, "find", dest, "-type", "f", "-print0"],
        stderr=subprocess.STDOUT,
    )
    files: dict[str, str] = {}
    for full_b in listing.split(b"\0"):
        if not full_b:
            continue
        full = full_b.decode()
        rel = os.path.relpath(full, dest).replace("\\", "/")
        digest = subprocess.check_output(
            ["docker", "exec", container, "sha256sum", full],
            stderr=subprocess.STDOUT,
        ).decode().split()[0]
        if len(digest) != 64:
            raise SystemExit(f"docker sha256sum failed for {full}")
        files[rel] = "sha256:" + digest
    return build_doc(files)


def compare(expected: dict, actual: dict) -> None:
    exp_files = expected.get("files") or {}
    act_files = actual.get("files") or {}
    missing = sorted(set(exp_files) - set(act_files))
    extra = sorted(set(act_files) - set(exp_files))
    changed = sorted(path for path in set(exp_files) & set(act_files) if exp_files[path] != act_files[path])
    if missing or extra or changed or expected.get("tree_sha256") != actual.get("tree_sha256"):
        detail = {
            "missing": missing[:20],
            "extra": extra[:20],
            "changed": changed[:20],
            "expected_tree": expected.get("tree_sha256"),
            "actual_tree": actual.get("tree_sha256"),
        }
        raise SystemExit("v3/src manifest mismatch: " + json.dumps(detail, sort_keys=True))


def load(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Build or compare a v3/src content manifest")
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--from-git", metavar="SHA")
    src.add_argument("--from-dir", metavar="DIR")
    src.add_argument("--from-docker", metavar="CONTAINER")
    src.add_argument("--compare", nargs=2, metavar=("EXPECTED", "ACTUAL"))
    parser.add_argument("--out", metavar="FILE")
    parser.add_argument("--docker-src", default="/app/src")
    args = parser.parse_args(argv)

    if args.compare:
        compare(load(args.compare[0]), load(args.compare[1]))
        print("SRC_MANIFEST_OK")
        return 0

    if args.from_git:
        doc = from_git(args.from_git)
    elif args.from_dir:
        doc = from_dir(args.from_dir)
    else:
        doc = from_docker(args.from_docker, args.docker_src)

    if args.out:
        write_doc(doc, args.out)
    else:
        json.dump(doc, sys.stdout, indent=2)
        sys.stdout.write("\n")
    print(f"SRC_MANIFEST_BUILT files={doc['file_count']} tree={doc['tree_sha256']}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
