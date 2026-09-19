#!/usr/bin/env bash
# Verify the shadow primary sees the standby and can write.
set -euo pipefail
echo "=== pg_stat_replication (primary view) ==="
docker exec 5151-postgres-A psql -U postgres -tAc "SELECT client_addr, state, sync_state FROM pg_stat_replication;"
echo "=== create + write test row ==="
docker exec 5151-postgres-A psql -U postgres -d 5151_shadow -c "DROP TABLE IF EXISTS repl_test;"
docker exec 5151-postgres-A psql -U postgres -d 5151_shadow -c "CREATE TABLE repl_test (id int PRIMARY KEY, note text);"
docker exec 5151-postgres-A psql -U postgres -d 5151_shadow -c "INSERT INTO repl_test VALUES (1, 'hello from primary');"
echo "=== primary count ==="
docker exec 5151-postgres-A psql -U postgres -d 5151_shadow -tAc "SELECT count(*) FROM repl_test;"
