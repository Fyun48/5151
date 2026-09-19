#!/usr/bin/env bash
# Physical backup (pg_basebackup) of the shadow primary with streamed WAL.
# Full-instance snapshot used to rebuild a standby or recover the whole node.
# Run on the primary host (CasaOS).
set -euo pipefail

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backups"
OUT="${OUT_DIR}/base-${TS}"
mkdir -p "${OUT}"

# pg_basebackup must write to a directory path; stream into the container then
# copy the resulting data directory back out to the host.
docker exec 5151-postgres-A rm -rf /tmp/pg-basebackup
docker exec 5151-postgres-A pg_basebackup -U postgres --pgdata=/tmp/pg-basebackup \
  --format=plain --wal-method=stream --checkpoint=fast
docker cp 5151-postgres-A:/tmp/pg-basebackup/. "${OUT}/"
docker exec 5151-postgres-A rm -rf /tmp/pg-basebackup

echo "basebackup: ${OUT}"
du -sh "${OUT}"
