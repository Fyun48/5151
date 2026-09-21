#!/bin/sh
# Run the PG read+write drill (v3/evidence/pg-rw-drill-20260921) inside a throwaway container.
# Mirrors the live schema from the production SQLite snapshot and writes into a scratch schema.
# See v3/POSTGRES_SWITCH_PLAN.md section 6-7 for what it proved and what still falls back to SQLite.
# Run the PG read+write drill inside a throwaway container (app image + branch source).
set -e
ENVF=/root/5151-shadow-ha/shadow-ha/postgres-primary/.env
DOCKER=docker
[ -x /usr/local/bin/docker ] && DOCKER=/usr/local/bin/docker

PW=$(grep '^PG_SUPER_PASSWORD=' "$ENVF" | cut -d= -f2-)
[ -n "$PW" ] || { echo "no PG_SUPER_PASSWORD"; exit 2; }
IMG=$($DOCKER inspect 5151-web-A --format '{{.Config.Image}}')
echo "image: $IMG"

$DOCKER run --rm --network host \
  -v /root/pgtest/incoming:/incoming:ro \
  -v /root/pgsnap:/snap:ro \
  -e PG_URL="postgres://postgres:$PW@192.168.0.220:15432/5151_shadow" \
  -e DRILL_SCHEMA=drill_rw \
  -e SCHEMA_SOURCE_DB=/snap/v3-snap.db \
  -w /app "$IMG" sh -c 'cp -a /incoming/v3 /app/v3 && npm install pg --no-save --silent >/dev/null 2>&1 || true; DATA_DIR=/tmp/pg-rw-drill node /app/v3/evidence/pg-rw-drill-20260921/pg-rw-drill.mjs'
