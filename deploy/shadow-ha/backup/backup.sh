#!/usr/bin/env bash
# Logical backup (pg_dump -Fc) of the shadow primary. Read-only; does not
# touch replication or the production DB. Run on the primary host (CasaOS).
# Outputs backups/5151_shadow-<ts>.dump + a manifest with pg version / size /
# sha256 for later verification.
set -euo pipefail

# docker 可能不在非登入 shell 的 PATH（Synology 是 /usr/local/bin/docker）。
# failover 後 primary 換人，這支腳本要在「當下的 primary」主機跑，兩台都要能執行。
DOCKER="${DOCKER:-docker}"
command -v "${DOCKER}" >/dev/null 2>&1 || DOCKER=/usr/local/bin/docker

# failover 後 primary 換人：用 PG_CONTAINER 指向「當下的 primary」容器
# （預設 Synology 的 5151-postgres-B；primary 若在 CasaOS 請帶 5151-postgres-A）。
PG_CONTAINER="${PG_CONTAINER:-5151-postgres-B}"

DB="${PG_DATABASE:-5151_shadow}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backups"
mkdir -p "${OUT_DIR}"
OUT="${OUT_DIR}/${DB}-${TS}.dump"
MANIFEST="${OUT_DIR}/${DB}-${TS}.manifest.json"

# pg_dump runs inside the primary container via the local unix socket
# (peer/trust auth), so no password is passed on the command line.
"${DOCKER}" exec "${PG_CONTAINER}" pg_dump -U postgres --format=custom --no-owner --no-acl "${DB}" > "${OUT}"

PG_VERSION="$("${DOCKER}" exec "${PG_CONTAINER}" psql -U postgres -tAc 'SHOW server_version;' | tr -d '[:space:]')"
SIZE="$(wc -c < "${OUT}" | tr -d '[:space:]')"
SHA="$(sha256sum "${OUT}" | awk '{print $1}')"

cat > "${MANIFEST}" <<EOF
{"database":"${DB}","created_at":"${TS}","pg_version":"${PG_VERSION}","size_bytes":${SIZE},"sha256":"${SHA}"}
EOF

echo "backup:   ${OUT}"
echo "manifest: ${MANIFEST}"
cat "${MANIFEST}"
