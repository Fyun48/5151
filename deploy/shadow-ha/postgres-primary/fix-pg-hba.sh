#!/usr/bin/env bash
# Add replication pg_hba entries (idempotent) and reload the shadow primary.
#
# 需要兩個網段，缺一就會出現實測到的失敗：
#   - LAN：standby 主機本身（例 192.168.0.220）
#   - docker 私有網段：從「peer 主機上的容器」發起 pg_basebackup/replication 時，
#     docker-proxy 會讓來源變成該主機的 bridge gateway（實測被拒：
#     `no pg_hba.conf entry for replication connection from host "172.21.0.1"`）。
# 兩者都仍要求 scram-sha-256 密碼，不是 trust。
set -euo pipefail

# docker 可能不在非登入 shell 的 PATH（Synology 是 /usr/local/bin/docker）。
# failover 後 primary 換人，這支腳本要在「當下的 primary」主機跑，兩台都要能執行。
DOCKER="${DOCKER:-docker}"
command -v "${DOCKER}" >/dev/null 2>&1 || DOCKER=/usr/local/bin/docker

CONTAINER="${CONTAINER:-5151-postgres-B}"   # 預設 primary = Synology（5151-postgres-B）
REPL_USER="${REPL_USER:-replicator}"
REPL_CIDRS="${REPL_CIDRS:-192.168.0.0/24 172.16.0.0/12}"

# 一律在「容器內」改檔（docker exec -u root）：
# Synology 上 tori 對 /volume1/@docker/volumes/... 沒有檔案權限（實測 Permission denied），
# 從主機路徑改會失敗；容器內就不受主機檔案權限限制，也不必推導 host 路徑。
PGDATA_IN_CONTAINER="$("${DOCKER}" exec "${CONTAINER}" printenv PGDATA || true)"
PG_HBA_PATH="${PG_HBA_PATH:-${PGDATA_IN_CONTAINER:-/var/lib/postgresql/data/pgdata}/pg_hba.conf}"

for cidr in ${REPL_CIDRS}; do
  LINE="host replication ${REPL_USER} ${cidr} scram-sha-256"
  if "${DOCKER}" exec "${CONTAINER}" grep -qF "${LINE}" "${PG_HBA_PATH}"; then
    echo "already present: ${LINE}"
  else
    "${DOCKER}" exec -u root "${CONTAINER}" sh -c "printf '\n%s\n' '${LINE}' >> '${PG_HBA_PATH}'"
    echo "appended: ${LINE}"
  fi
done

"${DOCKER}" exec "${CONTAINER}" psql -U postgres -c 'SELECT pg_reload_conf();'
echo "reload issued (pg_hba: ${PG_HBA_PATH})"
