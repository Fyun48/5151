#!/usr/bin/env bash
# Create the streaming-replication user and a physical replication slot on the
# shadow primary. Idempotent: safe to run again (duplicate role/slot are ignored).
set -euo pipefail

# docker 可能不在非登入 shell 的 PATH（Synology 是 /usr/local/bin/docker）。
# failover 後 primary 換人，這支腳本要在「當下的 primary」主機跑，兩台都要能執行。
DOCKER="${DOCKER:-docker}"
command -v "${DOCKER}" >/dev/null 2>&1 || DOCKER=/usr/local/bin/docker

CONTAINER="${CONTAINER:-5151-postgres-B}"   # 預設 primary = Synology（5151-postgres-B）
REPL_PASSWORD="${PG_REPLICATION_PASSWORD:?set PG_REPLICATION_PASSWORD}"

"${DOCKER}" exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'replicator') THEN
    CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '${REPL_PASSWORD}';
  ELSE
    ALTER ROLE replicator WITH REPLICATION LOGIN PASSWORD '${REPL_PASSWORD}';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_replication_slots WHERE slot_name = 'standby_b') THEN
    PERFORM pg_create_physical_replication_slot('standby_b');
  END IF;
END
\$\$;
SQL

echo "primary replication user + slot ready (slot: standby_b)"
