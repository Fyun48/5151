#!/usr/bin/env bash
# predeploy-primary-probe.sh — read-only role probe for ONE PostgreSQL host (casa | syn).
#
# 純觀測、唯讀：回答「本機的 PostgreSQL 是不是当下的 primary」。不寫任何東西、
# 不帶密碼、不印連線字串。兩個獨立 oracle 必須一致才算數（fail-closed，不猜答案）：
#   (1) agent 埠 25436（responder 5151-pg-agent）：只有本機是 primary 才回 "up"（否則 "down"）。
#   (2) 本機 PG 直連（docker exec 走容器內 unix socket，trust auth，不帶密碼）：
#       pg_is_in_recovery() 回 "f" 表 primary、"t" 表 standby。
#
# 用法（在該台 NAS 主機上跑；經 ssh stdin 亦可，CI 就是這樣跑）：
#   HOST_ROLE=casa PG_CONTAINER=5151-postgres-A LAN_IP=192.168.0.140 bash predeploy-primary-probe.sh
#   HOST_ROLE=syn  PG_CONTAINER=5151-postgres-B LAN_IP=192.168.0.220 bash predeploy-primary-probe.sh
#
# 成功輸出單行（供 CI 解析）：
#   ROLE_PROBE_OK host_role=<casa|syn> verdict=<primary|standby> agent=<up|down> recovery=<f|t>
# 任何失敗（查不到／兩 oracle 不一致）以非零退出並印 ::error::（fail-closed）。
set -euo pipefail

HOST_ROLE="${HOST_ROLE:?set HOST_ROLE (casa|syn)}"
PG_CONTAINER="${PG_CONTAINER:?set PG_CONTAINER (e.g. 5151-postgres-A)}"
LAN_IP="${LAN_IP:?set LAN_IP (this host LAN IP)}"
AGENT_PORT="${AGENT_PORT:-25436}"
AGENT_TIMEOUT="${AGENT_TIMEOUT:-3}"

# docker 可能不在非登入 shell 的 PATH（Synology 是 /usr/local/bin/docker）。
DOCKER="${DOCKER:-docker}"
command -v "$DOCKER" >/dev/null 2>&1 || DOCKER=/usr/local/bin/docker

fail() {
  echo "::error::$1"
  echo "PG_ROLE_PROBE_FAIL: $1"
  exit 1
}

# --- Oracle 1：agent 埠（25436）。responder 只回一行 up / down，零憑證。 ---
# 注意：HAProxy 是 network_mode:host，25433 現在「任何一台都導到当下的 primary」，
# 所以絕不能用 25433 判角色（兩台都會回 f、會誤判腦裂）。25436 只答本機角色，才是對的 oracle。
AGENT=""
if AGENT_RAW="$(timeout "$AGENT_TIMEOUT" bash -c "exec 3<>/dev/tcp/${LAN_IP}/${AGENT_PORT}; head -n 1 <&3" 2>/dev/null)"; then
  AGENT="$(printf '%s' "$AGENT_RAW" | tr -d '[:space:]')"
fi
case "$AGENT" in
  up|down) ;;
  *) fail "agent probe unreachable/unknown on ${LAN_IP}:${AGENT_PORT} (got '${AGENT}')" ;;
esac

# --- Oracle 2：本機 PG 直連（容器內 unix socket，trust，不帶密碼／不印連線字串）。 ---
# 注意：這裡「不能」加 docker exec -i——本腳本在 CI 走 ssh `bash -s` 由 stdin 餵入，
# `-i` 會讓 docker 續讀 stdin，把還沒被 bash 讀完的腳本吃掉（症狀：無輸出、exit 0）。
# psql -c 不需要 stdin，所以不帶 -i。
RECOVERY=""
if RECOVERY_RAW="$("$DOCKER" exec -u postgres "$PG_CONTAINER" psql -X -w -U postgres -d postgres -tA -c 'SELECT pg_is_in_recovery()' 2>/dev/null)"; then
  RECOVERY="$(printf '%s' "$RECOVERY_RAW" | tr -d '[:space:]')"
fi
case "$RECOVERY" in
  f|false) RECOVERY=f ;;
  t|true)  RECOVERY=t ;;
  *) fail "local PG probe failed for ${PG_CONTAINER} (pg_is_in_recovery='${RECOVERY}')" ;;
esac

# --- 兩個 oracle 必須一致（不一致＝角色不可信，fail-closed）。 ---
if [ "$AGENT" = up ] && [ "$RECOVERY" = f ]; then
  VERDICT=primary
elif [ "$AGENT" = down ] && [ "$RECOVERY" = t ]; then
  VERDICT=standby
else
  fail "oracles disagree on ${HOST_ROLE}: agent=${AGENT} recovery=${RECOVERY} (refusing to guess)"
fi

echo "ROLE_PROBE_OK host_role=${HOST_ROLE} verdict=${VERDICT} agent=${AGENT} recovery=${RECOVERY}"
