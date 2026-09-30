#!/usr/bin/env bash
# 把「這一份 checkout」的爬蟲程式碼同步到沙盒容器並重啟（2026-09-30，第九十四批）。
#
# 為什麼要一支腳本而不是讓部署自動同步：沙盒的用途是**在部署前**測還沒上線的候選版本。
# 所以同步的時機由人決定（開 PR 前、驗收前），而不是跟著正式站的部署跑。
#
# 用法：
#   bash v3/scripts/crawl-sandbox-sync.sh          # 同步目前 checkout 的 v3/src、v3/scripts
#   SANDBOX_ROUNDS=1 bash v3/scripts/crawl-sandbox-sync.sh   # 同步後跑一輪（--once）並印出報告
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SANDBOX_HOST="${SANDBOX_HOST:-casa-nas}"
SANDBOX_DIR="${SANDBOX_DIR:-/mnt/Storage1/apps/5151-sandbox}"
SANDBOX_DATA="${SANDBOX_DATA:-/mnt/Storage1/docker_data/5151-crawl-sandbox}"
CONTAINER="${CONTAINER:-5151-crawl-sandbox}"
ROUNDS="${SANDBOX_ROUNDS:-0}"

echo "[sync] $REPO_ROOT/v3/{src,scripts} → $SANDBOX_HOST:$SANDBOX_DIR/v3/"
ssh "$SANDBOX_HOST" "mkdir -p '$SANDBOX_DIR/v3/src' '$SANDBOX_DIR/v3/scripts'"
scp -q -r "$REPO_ROOT/v3/src/." "$SANDBOX_HOST:$SANDBOX_DIR/v3/src/"
scp -q -r "$REPO_ROOT/v3/scripts/." "$SANDBOX_HOST:$SANDBOX_DIR/v3/scripts/"
scp -q "$REPO_ROOT/docker-compose.crawl-sandbox.yml" "$SANDBOX_HOST:$SANDBOX_DIR/docker-compose.crawl-sandbox.yml"

echo "[sync] 重啟容器（吃新的 v3/src 掛載）"
ssh "$SANDBOX_HOST" "cd '$SANDBOX_DIR' && docker compose -f docker-compose.crawl-sandbox.yml up -d --force-recreate >/dev/null && docker inspect -f '{{.State.Status}} | {{.Config.Image}}' $CONTAINER"

if [ "$ROUNDS" != "0" ]; then
  echo "[sync] 立刻跑 $ROUNDS 輪（--rounds $ROUNDS）並等它結束"
  ssh "$SANDBOX_HOST" "docker exec $CONTAINER node scripts/crawl-sandbox.mjs --rounds $ROUNDS --json | tail -$ROUNDS"
  echo "[sync] 最近報告："
  ssh "$SANDBOX_HOST" "tail -$ROUNDS '$SANDBOX_DATA/crawl-sandbox.jsonl'"
fi
