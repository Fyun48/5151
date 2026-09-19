#!/usr/bin/env bash
# Create the streaming-replication user and a physical replication slot on the
# shadow primary. Idempotent: safe to run again (duplicate role/slot are ignored).
set -euo pipefail

CONTAINER="${CONTAINER:-5151-postgres-A}"
REPL_PASSWORD="${PG_REPLICATION_PASSWORD:?set PG_REPLICATION_PASSWORD}"

docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'replicator') THEN
    CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '${REPL_PASSWORD}';
  ELSE
    ALTER ROLE replicator WITH REPLICATION LOGIN PASSWORD '${REPL_PASSWORD}';
  END IF;
END
\$\$;
SELECT slot_name FROM pg_create_physical_replication_slot('standby_b')
WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = 'standby_b');
SQL

echo "primary replication user + slot ready (slot: standby_b)"
