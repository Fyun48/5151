#!/usr/bin/env python3
"""SQLite Online Backup API via Python's sqlite3.Connection.backup()."""
import json
import sqlite3
import sys


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: sqlite-online-backup.py <src.db> <dest.db>", file=sys.stderr)
        return 2
    src, dest = sys.argv[1], sys.argv[2]
    source = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    try:
        dest_conn = sqlite3.connect(dest)
        try:
            source.backup(dest_conn)
        finally:
            dest_conn.close()
    finally:
        source.close()
    print(json.dumps({"ok": True, "method": "python3 sqlite3.Connection.backup"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
