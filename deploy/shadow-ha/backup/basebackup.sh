#!/usr/bin/env bash
# Physical backup (pg_basebackup) of the shadow primary with streamed WAL.
# Full-instance snapshot used to rebuild a standby or recover the whole node.
# Run on the primary host (CasaOS).
set -euo pipefail

# docker 可能不在非登入 shell 的 PATH（Synology 是 /usr/local/bin/docker）。
# failover 後 primary 換人，這支腳本要在「當下的 primary」主機跑，兩台都要能執行。
DOCKER="${DOCKER:-docker}"
command -v "${DOCKER}" >/dev/null 2>&1 || DOCKER=/usr/local/bin/docker

# failover 後 primary 換人：用 PG_CONTAINER 指向「當下的 primary」容器（預設 Synology）。
PG_CONTAINER="${PG_CONTAINER:-5151-postgres-B}"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backups"
OUT="${OUT_DIR}/base-${TS}"
mkdir -p "${OUT}"

# pg_basebackup must write to a directory path; stream into the container then
# copy the resulting data directory back out to the host.
"${DOCKER}" exec "${PG_CONTAINER}" rm -rf /tmp/pg-basebackup
"${DOCKER}" exec "${PG_CONTAINER}" pg_basebackup -U postgres --pgdata=/tmp/pg-basebackup \
  --format=plain --wal-method=stream --checkpoint=fast
"${DOCKER}" cp "${PG_CONTAINER}":/tmp/pg-basebackup/. "${OUT}/"
"${DOCKER}" exec "${PG_CONTAINER}" rm -rf /tmp/pg-basebackup

echo "basebackup: ${OUT}"
du -sh "${OUT}"
