#!/usr/bin/env bash
# Pull a base backup from the shadow primary and prepare the data directory to
# start as a Hot Standby. Runs inside a one-shot postgres:16-alpine container
# with the standby volume mounted at /var/lib/postgresql/data.
#
# `pg_basebackup -R` writes primary_conninfo WITHOUT the password, which would
# break streaming on first reconnect. We therefore write recovery config
# explicitly (including the replication password) so the standby can stream.
#
# 反向重建（failover 後把舊 primary 接回來）用 PRIMARY_HOST 指向「現在」的 primary，
# 並用 SLOT_NAME 對應新 primary 上為這台建立的 replication slot。
set -euo pipefail

PRIMARY_HOST="${PRIMARY_HOST:-${SYNOLOGY_HOST:?set PRIMARY_HOST (or SYNOLOGY_HOST) to the current primary LAN IP}}"
PRIMARY_PORT="${PRIMARY_PORT:-15432}"
SLOT_NAME="${SLOT_NAME:-standby_a}"
PG_REPLICATION_PASSWORD="${PG_REPLICATION_PASSWORD:?set PG_REPLICATION_PASSWORD}"
DATA="${PGDATA:-/var/lib/postgresql/data/pgdata}"
export PGPASSWORD="$PG_REPLICATION_PASSWORD"

echo ">> base backup from $PRIMARY_HOST:$PRIMARY_PORT (slot: $SLOT_NAME)"
rm -rf "$DATA"/*
pg_basebackup -h "$PRIMARY_HOST" -p "$PRIMARY_PORT" -U replicator \
  -D "$DATA" -X stream -P

echo ">> write standby.signal + recovery conf"
touch "$DATA/standby.signal"
cat > "$DATA/postgresql.auto.conf" <<CONF
primary_conninfo = 'host=$PRIMARY_HOST port=$PRIMARY_PORT user=replicator password=$PG_REPLICATION_PASSWORD'
primary_slot_name = '$SLOT_NAME'
CONF

echo ">> standby data directory ready"
