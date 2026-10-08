#!/usr/bin/env bash
# 把「這一份 checkout」的爬蟲程式碼同步到沙盒容器並重啟（2026-09-30，第九十四批）。
#
# 為什麼要一支腳本而不是讓部署自動同步：沙盒的用途是**在部署前**測還沒上線的候選版本。
# 所以同步的時機由人決定（開 PR 前、驗收前），而不是跟著正式站的部署跑。
#
# 用法：
#   bash v3/scripts/crawl-sandbox-sync.sh          # 同步目前 checkout 的 v3/src、v3/scripts（排程維持啟用）
#   SANDBOX_ROUNDS=1 bash v3/scripts/crawl-sandbox-sync.sh   # 同步後跑一輪：先停內部排程→跑輪→自動恢復排程
#
# SANDBOX_ROUNDS>0 時會自動「暫停內部排程 → 跑 N 輪 → 恢復排程」，避免手動輪與容器內部
# 排程在 owner lock 上撞車（否則 jsonl 會混入 skipped=owner_busy／timed_out 的噪音）。
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SANDBOX_HOST="${SANDBOX_HOST:-casa-nas}"
SANDBOX_DIR="${SANDBOX_DIR:-/mnt/Storage1/apps/5151-sandbox}"
SANDBOX_DATA="${SANDBOX_DATA:-/mnt/Storage1/docker_data/5151-crawl-sandbox}"
CONTAINER="${CONTAINER:-5151-crawl-sandbox}"
ROUNDS="${SANDBOX_ROUNDS:-0}"
# 可選：把額外環境帶進「手動測試輪」，用來故意製造條件。例：
#   SANDBOX_EXTRA_ENV="CRAWL_EXTERNAL_PHASE_MAX_MINUTES=3"  ⇒ 每家外站只有 3 分鐘階段預算，
#   這樣才看得到「預算用盡 ⇒ 這一輪這家算 partial、不算失敗」那條路（正常 10 分鐘 Sandbox 跑不满）。
EXTRA_ENV="${SANDBOX_EXTRA_ENV:-}"
env_args=""
for _kv in $EXTRA_ENV; do env_args="$env_args -e $_kv"; done

# $1 = 排程器狀態（0 停用／1 啟用）。重建容器並印出容器狀態＋實際生效的排程器值。
compose_recreate() {
  local sched="$1"
  ssh "$SANDBOX_HOST" "cd '$SANDBOX_DIR' && CRAWL_SANDBOX_SCHEDULER=$sched docker compose -f docker-compose.crawl-sandbox.yml up -d --force-recreate >/dev/null && docker inspect -f '{{.State.Status}} | {{.Config.Image}}' $CONTAINER && printf ' | CRAWL_SANDBOX_SCHEDULER=' && docker exec $CONTAINER printenv CRAWL_SANDBOX_SCHEDULER"
}

echo "[sync] $REPO_ROOT/v3/{src,scripts} → $SANDBOX_HOST:$SANDBOX_DIR/v3/"
ssh "$SANDBOX_HOST" "mkdir -p '$SANDBOX_DIR/v3/src' '$SANDBOX_DIR/v3/scripts'"
scp -q -r "$REPO_ROOT/v3/src/." "$SANDBOX_HOST:$SANDBOX_DIR/v3/src/"
scp -q -r "$REPO_ROOT/v3/scripts/." "$SANDBOX_HOST:$SANDBOX_DIR/v3/scripts/"
scp -q "$REPO_ROOT/docker-compose.crawl-sandbox.yml" "$SANDBOX_HOST:$SANDBOX_DIR/docker-compose.crawl-sandbox.yml"

if [ "$ROUNDS" != "0" ]; then
  echo "[sync] 停用排程器（CRAWL_SANDBOX_SCHEDULER=0）再重啟容器"
  compose_recreate 0

  # 無論手動輪成敗，都務必恢復排程器（最怕沙盒停擺沒人知道）。失敗只警告、不掩蓋原錯誤。
  restore_scheduler() {
    echo "[sync] 恢復排程器（CRAWL_SANDBOX_SCHEDULER=1）"
    compose_recreate 1 || echo "[sync] ⚠️ 恢復排程器失敗！請手動執行：ssh $SANDBOX_HOST \"cd $SANDBOX_DIR && docker compose -f docker-compose.crawl-sandbox.yml up -d --force-recreate\""
  }
  trap restore_scheduler EXIT

  echo "[sync] 立刻跑 $ROUNDS 輪（--rounds $ROUNDS）並等它結束"
  ssh "$SANDBOX_HOST" "docker exec$env_args $CONTAINER node scripts/crawl-sandbox.mjs --rounds $ROUNDS --json | tail -$ROUNDS"
  echo "[sync] 最近報告："
  ssh "$SANDBOX_HOST" "tail -$ROUNDS '$SANDBOX_DATA/crawl-sandbox.jsonl'"

  # 正常路徑也在這裡恢復；trap 稍後會再觸發一次，重複 up -d 是冪等的（多一次沒關係，少一次才危險）。
  restore_scheduler
  trap - EXIT
else
  echo "[sync] 重啟容器（吃新的 v3/src 掛載；排程維持啟用）"
  compose_recreate 1
fi
