#!/usr/bin/env bash
# Verify the shadow primary sees the standby and can write.
set -euo pipefail

# docker 可能不在非登入 shell 的 PATH（Synology 是 /usr/local/bin/docker）。
# failover 後 primary 換人，這支腳本要在「當下的 primary」主機跑，兩台都要能執行。
DOCKER="${DOCKER:-docker}"
command -v "${DOCKER}" >/dev/null 2>&1 || DOCKER=/usr/local/bin/docker

# verify 的目標容器可用 PG_CONTAINER 覆寫（預設 primary = Synology 的 5151-postgres-B）。
PG_CONTAINER="${PG_CONTAINER:-5151-postgres-B}"

echo "=== pg_stat_replication (primary view) ==="
"${DOCKER}" exec "${PG_CONTAINER}" psql -U postgres -tAc "SELECT client_addr, state, sync_state FROM pg_stat_replication;"
echo "=== create + write test row ==="
"${DOCKER}" exec "${PG_CONTAINER}" psql -U postgres -d 5151_shadow -c "DROP TABLE IF EXISTS repl_test;"
"${DOCKER}" exec "${PG_CONTAINER}" psql -U postgres -d 5151_shadow -c "CREATE TABLE repl_test (id int PRIMARY KEY, note text);"
"${DOCKER}" exec "${PG_CONTAINER}" psql -U postgres -d 5151_shadow -c "INSERT INTO repl_test VALUES (1, 'hello from primary');"
echo "=== primary count ==="
"${DOCKER}" exec "${PG_CONTAINER}" psql -U postgres -d 5151_shadow -tAc "SELECT count(*) FROM repl_test;"
