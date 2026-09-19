#!/usr/bin/env bash
# Pull a base backup from the shadow primary and prepare the data directory to
# start as a Hot Standby. Runs inside a one-shot postgres:16-alpine container
# with the standby volume mounted at /var/lib/postgresql/data.
#
# `pg_basebackup -R` writes primary_conninfo WITHOUT the password, which would
# break streaming on first reconnect. We therefore write recovery config
# explicitly (including the replication password) so the standby can stream.
set -euo pipefail

CASAOS_HOST="${CASAOS_HOST:?set CASAOS_HOST (primary LAN IP)}"
PG_REPLICATION_PASSWORD="${PG_REPLICATION_PASSWORD:?set PG_REPLICATION_PASSWORD}"
DATA="${PGDATA:-/var/lib/postgresql/data/pgdata}"
export PGPASSWORD="$PG_REPLICATION_PASSWORD"

echo ">> base backup from $CASAOS_HOST:15432"
rm -rf "$DATA"/*
pg_basebackup -h "$CASAOS_HOST" -p 15432 -U replicator \
  -D "$DATA" -X stream -P

echo ">> write standby.signal + recovery conf"
touch "$DATA/standby.signal"
cat > "$DATA/postgresql.auto.conf" <<CONF
primary_conninfo = 'host=$CASAOS_HOST port=15432 user=replicator password=$PG_REPLICATION_PASSWORD'
primary_slot_name = 'standby_b'
CONF

echo ">> standby data directory ready"
