#!/usr/bin/env bash
# Restore a logical backup into an ISOLATED database (never 5151_shadow) and
# verify it can be queried. Run on the primary host (CasaOS). Non-destructive
# to production and to the live shadow database.
set -euo pipefail

# docker 可能不在非登入 shell 的 PATH（Synology 是 /usr/local/bin/docker）。
# failover 後 primary 換人，這支腳本要在「當下的 primary」主機跑，兩台都要能執行。
DOCKER="${DOCKER:-docker}"
command -v "${DOCKER}" >/dev/null 2>&1 || DOCKER=/usr/local/bin/docker

# failover 後 primary 換人：用 PG_CONTAINER 指向「當下的 primary」容器（預設 Synology）。
PG_CONTAINER="${PG_CONTAINER:-5151-postgres-B}"

DUMP="${1:?usage: restore.sh <dump-file>}"
RESTORE_DB="${RESTORE_DB:-5151_restore_test}"
DUMP="$(cd "$(dirname "${DUMP}")" && pwd)/$(basename "${DUMP}")"
[ -f "${DUMP}" ] || { echo "dump not found: ${DUMP}" >&2; exit 1; }

# 識別字一律加雙引號：`5151_restore_test` 以數字開頭，未加引號會被 PostgreSQL 當成
# numeric literal（DROP DATABASE IF EXISTS 5151_restore_test → trailing junk after
# numeric literal），還原演練會在第 1 步就失敗。名稱仍由 env 提供，先用字元白名單擋掉注入。
case "${RESTORE_DB}" in
  *[!A-Za-z0-9_]*) echo "RESTORE_DB must match [A-Za-z0-9_]+: ${RESTORE_DB}" >&2; exit 1 ;;
esac
QDB="\"${RESTORE_DB}\""

# 同目錄若有 backup.sh 產生的 manifest，先驗 sha256，避免拿壞掉的備份去做還原。
MANIFEST="${DUMP%.dump}.manifest.json"
if [ -f "${MANIFEST}" ]; then
  EXPECTED="$(sed -n 's/.*"sha256":"\([0-9a-f]*\)".*/\1/p' "${MANIFEST}")"
  ACTUAL="$(sha256sum "${DUMP}" | awk '{print $1}')"
  if [ -z "${EXPECTED}" ] || [ "${EXPECTED}" != "${ACTUAL}" ]; then
    echo "sha256 mismatch (expected ${EXPECTED}, got ${ACTUAL})" >&2
    exit 1
  fi
  echo "sha256 verified: ${ACTUAL}"
fi

# Fresh isolated database so the drill is idempotent on re-run.
"${DOCKER}" exec "${PG_CONTAINER}" psql -U postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${QDB};"
"${DOCKER}" exec "${PG_CONTAINER}" psql -U postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${QDB};"

"${DOCKER}" exec -i "${PG_CONTAINER}" pg_restore -U postgres --dbname "${RESTORE_DB}" --no-owner --exit-on-error < "${DUMP}"

echo "=== verify restored database is queryable ==="
"${DOCKER}" exec "${PG_CONTAINER}" psql -U postgres -d "${RESTORE_DB}" -tAc "SELECT 'restore_ok';"

# 不假設任何特定 schema：shadow 只有 repl_test，沒有 production 的 listings。
# 檢查表數 > 0，並逐表列出 row count 當作還原證據。
TABLE_COUNT="$("${DOCKER}" exec "${PG_CONTAINER}" psql -U postgres -d "${RESTORE_DB}" -tAc \
  "SELECT count(*) FROM pg_tables WHERE schemaname = current_schema();")"
echo "restored tables: ${TABLE_COUNT}"
if [ "${TABLE_COUNT}" -eq 0 ]; then
  echo "restore produced no tables" >&2
  exit 1
fi
for t in $("${DOCKER}" exec "${PG_CONTAINER}" psql -U postgres -d "${RESTORE_DB}" -tAc \
  "SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename;"); do
  n="$("${DOCKER}" exec "${PG_CONTAINER}" psql -U postgres -d "${RESTORE_DB}" -tAc "SELECT count(*) FROM \"${t}\";")"
  echo "  ${t}: ${n} rows"
done
