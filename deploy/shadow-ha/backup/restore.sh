#!/usr/bin/env bash
# Restore a logical backup into an ISOLATED database (never 5151_shadow) and
# verify it can be queried. Run on the primary host (CasaOS). Non-destructive
# to production and to the live shadow database.
set -euo pipefail

DUMP="${1:?usage: restore.sh <dump-file>}"
RESTORE_DB="${RESTORE_DB:-5151_restore_test}"
DUMP="$(cd "$(dirname "${DUMP}")" && pwd)/$(basename "${DUMP}")"
[ -f "${DUMP}" ] || { echo "dump not found: ${DUMP}" >&2; exit 1; }

# Fresh isolated database so the drill is idempotent on re-run.
docker exec 5151-postgres-A psql -U postgres -c "DROP DATABASE IF EXISTS ${RESTORE_DB};"
docker exec 5151-postgres-A psql -U postgres -c "CREATE DATABASE ${RESTORE_DB};"

docker exec -i 5151-postgres-A pg_restore -U postgres --dbname "${RESTORE_DB}" --no-owner --exit-on-error < "${DUMP}"

echo "=== verify restored database is queryable ==="
docker exec 5151-postgres-A psql -U postgres -d "${RESTORE_DB}" -tAc "SELECT 'restore_ok';"
docker exec 5151-postgres-A psql -U postgres -d "${RESTORE_DB}" -tAc "SELECT count(*) FROM listings;"
