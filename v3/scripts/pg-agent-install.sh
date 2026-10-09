#!/usr/bin/env bash
# 安裝／更新 5151 PG agent-check responder 到「單一節點」。
#
# 用法：  bash v3/scripts/pg-agent-install.sh casa|syn
#   casa → casa-nas（root） /opt/5151-shadow/pg-agent/
#   syn  → syn-nas（tori）  /var/services/homes/tori/5151-shadow/pg-agent/
#
# 給人跑（非 CI、非自動化）：只動單一節點的 responder，**不碰 HAProxy、不碰正式 DB 路由、
# 不碰 v1/v2、不觸發任何發版 workflow**。
#
# 行為：
#   1. 前置檢查：遠端必須已有 .env（PG_AGENT_IMAGE、PG_AGENT_DIRECT_URL 都從它來）。
#   2. 覆寫前先留 .bak-$(date +%Y%m%d-%H%M)（agent.mjs 與 docker-compose.yml）。
#   3. scp 推送新檔 → `docker compose config -q` 通過才 `up -d`；失敗就還原並 exit 非零。
#
# 可重建性（AGENTS 規則六）：容器 5151-pg-agent 唯一來源就是本目錄的
#   deploy/shadow-ha/pg-agent/{agent.mjs,docker-compose.yml} + 節點上的 .env，
#   不准出現「沒有 compose 標籤、沒人知道怎麼重建」的容器。
set -euo pipefail

NODE="${1:-}"
case "$NODE" in
  casa)
    SSH_ALIAS="casa-nas"
    REMOTE_DIR="/opt/5151-shadow/pg-agent"
    ;;
  syn)
    SSH_ALIAS="syn-nas"
    REMOTE_DIR="/var/services/homes/tori/5151-shadow/pg-agent"
    ;;
  *)
    echo "用法：$0 casa|syn" >&2
    exit 2
    ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC_DIR="$REPO_ROOT/deploy/shadow-ha/pg-agent"
STAMP="$(date +%Y%m%d-%H%M)"

# Synology 的 docker 在 /usr/local/bin，非登入 shell 不在 PATH（casa 也一視同仁先 export）。
REMOTE_EXPORT='export PATH=/usr/local/bin:/bin:/usr/bin:$PATH'

echo "==> 目標：${NODE}（${SSH_ALIAS}:${REMOTE_DIR}）"

# 1) .env 必須已存在（機密與映像 digest 都不在版控內）。
if ! ssh "${SSH_ALIAS}" "test -f '${REMOTE_DIR}/.env'"; then
  echo "錯誤：缺少 ${SSH_ALIAS}:${REMOTE_DIR}/.env（需要 PG_AGENT_IMAGE、PG_AGENT_DIRECT_URL）→ 請先建立" >&2
  exit 2
fi

ssh "${SSH_ALIAS}" "mkdir -p '${REMOTE_DIR}'"

# 2) 覆寫前先備份。
ssh "${SSH_ALIAS}" \
  "cd '${REMOTE_DIR}' && for f in agent.mjs docker-compose.yml; do if [ -e \"\$f\" ]; then cp -a \"\$f\" \"\$f.bak-${STAMP}\"; fi; done"

# 3) scp 推送。
scp "${SRC_DIR}/agent.mjs" "${SSH_ALIAS}:${REMOTE_DIR}/agent.mjs"
scp "${SRC_DIR}/docker-compose.yml" "${SSH_ALIAS}:${REMOTE_DIR}/docker-compose.yml"

# 4) compose 驗證通過才 up -d；失敗就還原並退出非零。
if ! ssh "${SSH_ALIAS}" \
  "${REMOTE_EXPORT}; cd '${REMOTE_DIR}' && docker compose -f docker-compose.yml config -q"; then
  echo "錯誤：docker compose config 驗證失敗 → 還原備份" >&2
  ssh "${SSH_ALIAS}" \
    "cd '${REMOTE_DIR}' && for f in agent.mjs docker-compose.yml; do if [ -e \"\$f.bak-${STAMP}\" ]; then mv \"\$f.bak-${STAMP}\" \"\$f\"; fi; done"
  exit 1
fi

# 5) 上線（映像釘 digest，up -d 會自行 pull 新 digest 並重建）。
ssh "${SSH_ALIAS}" \
  "${REMOTE_EXPORT}; cd '${REMOTE_DIR}' && docker compose -f docker-compose.yml up -d"

echo "==> 完成：${NODE} responder 已更新。驗證：ssh ${SSH_ALIAS} \"${REMOTE_EXPORT}; docker ps --filter name=5151-pg-agent\""
