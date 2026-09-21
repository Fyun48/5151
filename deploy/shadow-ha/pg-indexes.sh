#!/bin/sh
# Create the hot-path PostgreSQL indexes (idempotent). Safe to re-run.
#
# Why this exists: the SQLite→PostgreSQL import (pgSchema.ensurePgSchema with indexes: false,
# because SQLite index DDL can carry SQLite-only syntax) creates tables and primary keys only.
# The listings hot path then scans listing_search_projection instead of using the district
# index, so a cutover must create these first. See
# v3/evidence/pg-explain-20260921/README.md for the measured before/after.
#
# Mirrors the projection indexes repository/listings.js ships (ensureProjection()) plus the
# supporting indexes for the visibility clauses (listings.offline/offline_confirmed,
# listings.match_verdict, user_listing_flags(user_id, post_id)).
#
# Usage: sh pg-indexes.sh <database> [container]
#   On Synology (the default primary) docker lives in /usr/local/bin.
set -e
DB="${1:?usage: pg-indexes.sh <database> [container]}"
CONTAINER="${2:-5151-postgres-B}"
DOCKER=/usr/local/bin/docker
[ -x /usr/local/bin/docker ] || DOCKER=docker

run_sql() { $DOCKER exec "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -c "$1"; }

run_sql "CREATE INDEX IF NOT EXISTS idx_proj_district ON listing_search_projection(district)"
run_sql "CREATE INDEX IF NOT EXISTS idx_proj_updated_at ON listing_search_projection(updated_at DESC, post_id)"
run_sql "CREATE INDEX IF NOT EXISTS idx_proj_total_cost ON listing_search_projection(total_monthly_cost)"
run_sql "CREATE INDEX IF NOT EXISTS idx_proj_commute ON listing_search_projection(commute_km)"
run_sql "CREATE INDEX IF NOT EXISTS idx_user_flags_user_post ON user_listing_flags(user_id, post_id)"
run_sql "CREATE INDEX IF NOT EXISTS idx_listings_offline_state ON listings(offline, offline_confirmed)"
run_sql "CREATE INDEX IF NOT EXISTS idx_listings_match_verdict ON listings(match_verdict)"

echo "--- non-primary-key indexes now ---"
$DOCKER exec "$CONTAINER" psql -U postgres -d "$DB" -tAc \
  "select indexname from pg_indexes where schemaname = 'public' and indexname not like '%_pkey' order by indexname"
