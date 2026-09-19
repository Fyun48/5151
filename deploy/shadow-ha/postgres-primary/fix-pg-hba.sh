#!/usr/bin/env bash
# Add a replication pg_hba entry (idempotent) and reload the shadow primary.
set -euo pipefail

PGHBA="/mnt/Storage1/docker_data/volumes/5151-shadow-pg-primary_5151-shadow-pg-a/_data/pgdata/pg_hba.conf"
LINE="host replication replicator 192.168.0.0/24 scram-sha-256"

if grep -q 'host replication replicator' "$PGHBA"; then
  echo "pg_hba replication entry already present"
else
  echo "$LINE" >> "$PGHBA"
  echo "pg_hba replication entry appended"
fi

docker exec 5151-postgres-A psql -U postgres -c 'SELECT pg_reload_conf();'
echo "reload issued"
