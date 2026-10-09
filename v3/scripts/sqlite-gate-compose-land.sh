#!/usr/bin/env bash
#
# sqlite-gate-compose-land.sh — 把「PG_NO_SQLITE_OPEN 直通」落地到 deploy-v3.yml **不會**同步的
# web-a／web-b 主機正本 compose 檔（可重跑、冪等、不印檔內容）。
#
# 為什麼需要這支：deploy-v3.yml 的 "Copy" 步驟只帶
#   v3/src, v3/public, docker-compose.yml, casaos-compose.yml, docker-compose.override.yml
# 到 casa-nas `/mnt/Storage1/apps/5151`（＝591-tracker-v3）。它**不帶**以下兩份「主機正本」：
#   * /opt/5151-shadow/web-a/docker-compose.yml          （casa-nas，5151-web-A）
#   * /var/services/homes/tori/5151-shadow/web-b/docker-compose.yml  （syn-nas，5151-web-B）
# 這兩份正本含有硬編的憑證（SESSION_SECRET／PG_URL／R2_*），發版只覆寫它們的 .env、不動 compose。
# 因此 repo 模板 `deploy/shadow-ha/web/web-{a,b}/docker-compose.yml` 加了直通之後，
# 必須由人用本腳本把「同一行」插進正本（位置緊跟在 PG_SQLITE_FALLBACK 之後）。
#
# 用法：
#   bash v3/scripts/sqlite-gate-compose-land.sh          # 落地 web-a＋web-b
#   DRY_RUN=1 bash v3/scripts/sqlite-gate-compose-land.sh  # 只印將執行的遠端指令
#
# 不需落地（會自動跟進）：
#   * 591-tracker-v3：docker-compose.yml／casaos-compose.yml 由 deploy-v3.yml 帶到 NAS。
#   * 5151-crawl-sandbox：docker-compose.crawl-sandbox.yml 由 crawl-sandbox-sync.sh 帶到 NAS。
set -euo pipefail
export PATH=/usr/local/bin:/bin:/usr/bin:$PATH

SSH="${SSH:-ssh}"
DRY_RUN="${DRY_RUN:-0}"

LAND_BODY=$(cat <<'LAND_EOF'
set -eu
export PATH=/usr/local/bin:/bin:/usr/bin:$PATH
F='__FILE__'
if grep -q '^[[:space:]]*PG_NO_SQLITE_OPEN:' "$F"; then
  echo "[land] already present (skip): $F"
  exit 0
fi
MODE="$(stat -c '%a' "$F")"
cp -p "$F" "$F.bak-sqlite-gate-$(date +%Y%m%d%H%M%S)"
sed -i '/^[[:space:]]*PG_SQLITE_FALLBACK:/a\      PG_NO_SQLITE_OPEN: ${PG_NO_SQLITE_OPEN:-0}' "$F"
chmod "$MODE" "$F"
N="$(grep -c '^[[:space:]]*PG_NO_SQLITE_OPEN:' "$F")"
if [ "$N" -lt 1 ]; then echo "[land] FAILED: no PG_NO_SQLITE_OPEN line in $F"; exit 1; fi
echo "[land] ok: $F (PG_NO_SQLITE_OPEN lines=$N mode=$MODE)"
LAND_EOF
)

run_remote() {
  local host="$1" file="$2" body
  body="${LAND_BODY//__FILE__/$file}"
  echo "[land] $host $file" >&2
  if [ "$DRY_RUN" = "1" ]; then
    printf '%s\n' "$body" | sed 's/^/[DRY] /'
  else
    printf '%s\n' "$body" | "$SSH" -o BatchMode=yes "$host" 'sh -s'
  fi
}

run_remote casa-nas /opt/5151-shadow/web-a/docker-compose.yml
run_remote syn-nas  /var/services/homes/tori/5151-shadow/web-b/docker-compose.yml

cat <<'EOF' >&2
[land] 提示：591-tracker-v3（docker-compose.yml/casaos-compose.yml）與 5151-crawl-sandbox
       （docker-compose.crawl-sandbox.yml）不需要本腳本——前者由 deploy-v3.yml、後者由
       crawl-sandbox-sync.sh 自動帶到 NAS。本腳本只管 web-a／web-b 的主機正本。
EOF
