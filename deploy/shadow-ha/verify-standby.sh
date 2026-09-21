#!/usr/bin/env bash
# Verify the shadow standby is in recovery, sees replicated data, and rejects writes.
set -u

# docker 可能不在非登入 shell 的 PATH（Synology 是 /usr/local/bin/docker）。
# failover 後 primary 換人，這支腳本要在「當下的 standby」主機跑，兩台都要能執行。
DOCKER="${DOCKER:-docker}"
command -v "${DOCKER}" >/dev/null 2>&1 || DOCKER=/usr/local/bin/docker

# verify 的目標容器可用 PG_CONTAINER 覆寫（預設 standby = CasaOS 的 5151-postgres-A）。
PG_CONTAINER="${PG_CONTAINER:-5151-postgres-A}"

echo "=== pg_is_in_recovery (should be t) ==="
"${DOCKER}" exec "${PG_CONTAINER}" psql -U postgres -tAc "SELECT pg_is_in_recovery();"
echo "=== standby count (should match primary = 1) ==="
"${DOCKER}" exec "${PG_CONTAINER}" psql -U postgres -d 5151_shadow -tAc "SELECT count(*) FROM repl_test;"
echo "=== write on standby (should be rejected) ==="
"${DOCKER}" exec "${PG_CONTAINER}" psql -U postgres -d 5151_shadow -c "INSERT INTO repl_test VALUES (2, 'write to standby');" 2>&1 | head -2
