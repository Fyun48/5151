#!/bin/sh
# Snapshot the live SQLite store (VACUUM INTO) and import it into PostgreSQL with the tool that
# lives in this repo (v3/scripts/pg-import.mjs), so the cutover import is reproducible from a
# checkout instead of a one-off script on the NAS.
#
# Usage: sh deploy/shadow-ha/pg-import-run.sh [env_file] [src_dir] [prod_data_dir] [pg_host]
#   env_file       holds PG_SUPER_PASSWORD (default: the shadow primary's .env)
#   src_dir        checkout to run (default /root/pgtest/incoming; only v3/ is copied)
#   prod_data_dir  the live DATA_DIR that holds v3.db
#   pg_host        PostgreSQL host (default the shadow primary 192.168.0.220)
#
# Extra env for the tool is passed through: IMPORT_SCHEMA, TABLES, SKIP_TABLES, SKIP_ROWS,
# INDEXES=1, BATCH_SIZE, MULTI_ROW=0, DRY_RUN=1. IMPORT_DB picks the target database.
set -e
ENVF="${1:-/root/5151-shadow-ha/shadow-ha/postgres-primary/.env}"
SRC="${2:-/root/pgtest/incoming}"
PROD_DATA="${3:-/mnt/Storage1/docker_data/591-tracker-v3}"
PGHOST_IP="${4:-192.168.0.220}"
PG_DB="${IMPORT_DB:-5151_import_test}"
SNAP_DIR="${SNAP_DIR:-/root/pgsnap}"
DOCKER=docker
[ -x /usr/local/bin/docker ] && DOCKER=/usr/local/bin/docker

PW=$(grep '^PG_SUPER_PASSWORD=' "$ENVF" | cut -d= -f2-)
[ -n "$PW" ] || { echo "no PG_SUPER_PASSWORD in $ENVF"; exit 2; }

IMG=$($DOCKER inspect 5151-web-A --format '{{.Config.Image}}')
mkdir -p "$SNAP_DIR"

echo "=== 1) VACUUM INTO snapshot of the live DB ==="
rm -f "$SNAP_DIR/v3-snap.db" "$SNAP_DIR/v3-snap.db-wal" "$SNAP_DIR/v3-snap.db-shm"
$DOCKER run --rm -v "$PROD_DATA":/src:ro -v "$SNAP_DIR":/out "$IMG" node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/src/v3.db', { readOnly: true });
db.exec(\"VACUUM INTO '/out/v3-snap.db'\");
const n = db.prepare('select count(*) as n from listings').get().n;
db.close();
console.log('snapshot ok, listings=' + n);
"
ls -l "$SNAP_DIR/v3-snap.db"

echo "=== 2) import the snapshot into PostgreSQL ($PG_DB) ==="
$DOCKER run --rm --network host \
  -v "$SRC":/incoming:ro \
  -v "$SNAP_DIR":/snap:ro \
  -e SNAP_DB=/snap/v3-snap.db \
  -e PG_URL="postgres://postgres:$PW@$PGHOST_IP:15432/$PG_DB" \
  -e IMPORT_SCHEMA="${IMPORT_SCHEMA:-}" \
  -e TABLES="${TABLES:-}" \
  -e SKIP_TABLES="${SKIP_TABLES:-}" \
  -e SKIP_ROWS="${SKIP_ROWS:-}" \
  -e INDEXES="${INDEXES:-}" \
  -e BATCH_SIZE="${BATCH_SIZE:-}" \
  -e MULTI_ROW="${MULTI_ROW:-}" \
  -e DRY_RUN="${DRY_RUN:-}" \
  -w /app "$IMG" sh -c 'cp -a /incoming/v3 /app/v3 && npm install pg --no-save --silent >/dev/null 2>&1 || true; node /app/v3/scripts/pg-import.mjs'
echo "=== done ==="

