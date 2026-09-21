#!/usr/bin/env bash
# A4 drill runner（shadow HA）— 把 2026-09-20 的手動演練固化成可重跑流程。
#
# 依據：
#   docs/runbooks/postgres-manual-failover.md                （failover 步驟與踩到的坑）
#   docs/runbooks/postgres-backup-restore.md                 （backup / restore 步驟）
#   evidence/runtime-modernization/A4-HA-DRILL-20260920.md   （實測結果）
#
# 安全設計（重要）：
#   * `preflight` / `backup` 只做唯讀或隔離操作，可隨時重跑 —— 每季演練跑這兩個。
#   * `failover` 會真的改變 cluster 角色。依 runbook 必須「人工在場 + 先 fence 舊 primary」：
#     需要 CONFIRM_FAILOVER=yes 且 FENCED=yes，而且**只做本機（要 promote 的那台）的步驟**；
#     跨主機的 fence / rejoin 一律印出指令讓人工執行（本腳本不做遠端 SSH）。
#   * 全程不引入自動 promotion（runbook 的 Split-brain prevention 條款）。
#
# 用法（在 shadow 節點主機上跑；Synology 端 docker 在 /usr/local/bin，本腳本會自動解析）：
#   bash drill.sh preflight [--expect-role primary|standby]
#   bash drill.sh backup
#   CONFIRM_FAILOVER=yes FENCED=yes bash drill.sh failover     # 在「要 promote 的那台」上跑
#
# 環境變數：
#   PG_CONTAINER=5151-postgres-B        本機要操作的容器（預設 primary = Synology 的 B）
#   PG_CONTAINER_PEER=5151-postgres-A   報告用的對側容器名（純記錄，不會去連它）
#   PG_DATABASE=5151_shadow、HAPROXY_HOST=192.168.0.140、PG_RW_PORT=25433
#   DRILL_REPORT_DIR=<dir>（預設 <本檔目錄>/drill-reports）
set -euo pipefail

DOCKER="${DOCKER:-docker}"
command -v "${DOCKER}" >/dev/null 2>&1 || DOCKER=/usr/local/bin/docker

PG_CONTAINER="${PG_CONTAINER:-5151-postgres-B}"
PG_CONTAINER_PEER="${PG_CONTAINER_PEER:-5151-postgres-A}"
PG_DATABASE="${PG_DATABASE:-5151_shadow}"
HAPROXY_HOST="${HAPROXY_HOST:-192.168.0.140}"
PG_RW_PORT="${PG_RW_PORT:-25433}"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPORT_DIR="${DRILL_REPORT_DIR:-${SELF_DIR}/drill-reports}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT="${REPORT_DIR}/drill-${TS}.txt"

psql_c() { "${DOCKER}" exec "${PG_CONTAINER}" psql -U postgres -tAc "$1"; }
log() { echo "$@" | tee -a "${REPORT}"; }

report_start() {
  mkdir -p "${REPORT_DIR}"
  log "A4 drill — ${1} — host=$(hostname) — ${TS}Z"
  log "container=${PG_CONTAINER} peer=${PG_CONTAINER_PEER} db=${PG_DATABASE} docker=${DOCKER}"
  log "------------------------------------------------------------"
}

cmd_preflight() {
  local expect_role=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --expect-role) expect_role="${2:?--expect-role needs primary|standby}"; shift 2 ;;
      *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
  done
  report_start preflight

  local in_recovery role
  in_recovery="$(psql_c 'SELECT pg_is_in_recovery();')"
  case "${in_recovery}" in
    t) role="standby" ;;
    f) role="primary" ;;
    *) log "FAIL: cannot read pg_is_in_recovery() from ${PG_CONTAINER} (got '${in_recovery}')"; exit 1 ;;
  esac
  log "local role: ${role} (pg_is_in_recovery=${in_recovery})"

  if [ "${role}" = "primary" ]; then
    log "replication: $(psql_c 'SELECT client_addr, state, sync_state FROM pg_stat_replication;' | tr '\n' ';')"
  else
    local rec rep
    rec="$(psql_c 'SELECT pg_last_wal_receive_lsn();')"
    rep="$(psql_c 'SELECT pg_last_wal_replay_lsn();')"
    log "wal receive/replay: ${rec} / ${rep}"
    if [ "${rec}" = "${rep}" ]; then
      log "wal backlog: none (receive == replay)"
    else
      log "wal backlog: receive=${rec} != replay=${rep} → standby 還在追"
    fi
    # 注意：時間差在 primary 閒置時會很大卻不等於落後（2026-09-20 實測 10213s），
    # 所以判斷一律看上面的 LSN 是否相等，時間戳只當參考。
    log "last replayed xact: $(psql_c 'SELECT pg_last_xact_replay_timestamp();')"
  fi

  # 經 HAProxy 的 pg-rw 是否落在正確角色。這一跳走 TCP，pg_hba 要求密碼
  # （只有容器內 local socket 是 trust），所以要 PG_SUPER_PASSWORD；沒給就標 skipped，
  # 不要讓它看起來像故障（2026-09-20 實測：不給密碼會得到 fe_sendauth: no password supplied）。
  if [ -n "${HAPROXY_HOST}" ] && [ -n "${PG_SUPER_PASSWORD:-}" ]; then
    log "haproxy ${HAPROXY_HOST}:${PG_RW_PORT} pg_is_in_recovery() = $("${DOCKER}" exec -e PGPASSWORD="${PG_SUPER_PASSWORD}" \
      "${PG_CONTAINER}" psql -U postgres -h "${HAPROXY_HOST}" -p "${PG_RW_PORT}" -tAc 'SELECT pg_is_in_recovery();' 2>&1 | tail -1)"
  elif [ -n "${HAPROXY_HOST}" ]; then
    log "haproxy ${HAPROXY_HOST}:${PG_RW_PORT} probe skipped (set PG_SUPER_PASSWORD to enable; TCP path needs a password)"
  fi

  if [ -n "${expect_role}" ] && [ "${role}" != "${expect_role}" ]; then
    log "FAIL: expected role '${expect_role}' but this node is '${role}'"
    exit 1
  fi
  log "preflight OK"
  echo "report: ${REPORT}"
}

cmd_backup() {
  report_start backup
  local out dump restore_out
  out="$(PG_CONTAINER="${PG_CONTAINER}" PG_DATABASE="${PG_DATABASE}" bash "${SELF_DIR}/backup/backup.sh")"
  dump="$(printf '%s\n' "${out}" | sed -n 's/^backup:[[:space:]]*//p' | head -1)"
  if [ -z "${dump}" ] || [ ! -f "${dump}" ]; then
    log "FAIL: backup.sh did not produce a dump"
    exit 1
  fi
  log "logical backup: ${dump} ($(wc -c < "${dump}" | tr -d ' ') bytes)"
  log "manifest: $(cat "${dump%.dump}.manifest.json")"

  # restore.sh 會自己驗 sha256，且只還原到隔離 DB（預設 5151_restore_test），不碰 5151_shadow。
  restore_out="$(PG_CONTAINER="${PG_CONTAINER}" bash "${SELF_DIR}/backup/restore.sh" "${dump}" 2>&1)"
  printf '%s\n' "${restore_out}" >> "${REPORT}"
  printf '%s\n' "${restore_out}" | grep -q 'restore_ok' || { log "FAIL: restored DB not queryable"; exit 1; }
  log "isolated restore OK (db=${RESTORE_DB:-5151_restore_test})"
  log "backup drill OK"
  echo "report: ${REPORT}"
}

cmd_failover() {
  report_start failover
  if [ "${CONFIRM_FAILOVER:-}" != "yes" ]; then
    log "REFUSED: failover 會改變 cluster 角色。人工在場時用 CONFIRM_FAILOVER=yes（fence 完再加上 FENCED=yes）重跑。"
    exit 2
  fi

  local in_recovery
  in_recovery="$(psql_c 'SELECT pg_is_in_recovery();')"
  if [ "${in_recovery}" != "t" ]; then
    log "REFUSED: ${PG_CONTAINER} 不是 standby（pg_is_in_recovery=${in_recovery}）"
    exit 1
  fi
  log "step1 OK: 本機是 standby"
  log "step2 wal receive/replay: $(psql_c 'SELECT pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn();')"

  if [ "${FENCED:-}" != "yes" ]; then
    cat <<EOF
先 fence 舊 primary（runbook §3；在「舊 primary」那台上執行），再回來：
  docker stop ${PG_CONTAINER_PEER}
  docker exec ${PG_CONTAINER_PEER} psql -U postgres -tAc 'SELECT pg_is_in_recovery();'   # 應連不上
  FENCED=yes CONFIRM_FAILOVER=yes bash drill.sh failover
EOF
    exit 0
  fi

  log "step3 promote:"
  "${DOCKER}" exec -u postgres "${PG_CONTAINER}" pg_ctl promote -D /var/lib/postgresql/data/pgdata 2>&1 | tee -a "${REPORT}" || {
    log "pg_ctl 失敗，改用 SELECT pg_promote()"
    psql_c 'SELECT pg_promote();' | tee -a "${REPORT}"
  }
  sleep 2
  log "step4 pg_is_in_recovery()=$(psql_c 'SELECT pg_is_in_recovery();')  (expect f)"
  "${DOCKER}" exec "${PG_CONTAINER}" psql -U postgres -d "${PG_DATABASE}" -v ON_ERROR_STOP=1 \
    -c 'CREATE TABLE IF NOT EXISTS failover_check(id int); DROP TABLE failover_check;' >/dev/null
  log "step5 新 primary 可寫 OK"
  if [ -n "${HAPROXY_HOST}" ]; then
    log "step6 haproxy pg-rw pg_is_in_recovery()=$("${DOCKER}" exec "${PG_CONTAINER}" \
      psql -U postgres -h "${HAPROXY_HOST}" -p "${PG_RW_PORT}" -tAc 'SELECT pg_is_in_recovery();' 2>&1 | tail -1)"
  fi
  cat <<EOF | tee -a "${REPORT}"

rejoin 舊 primary（runbook §8；slot 建在新 primary、basebackup 用舊節點自己的 volume）：
  docker exec -u postgres ${PG_CONTAINER} psql -U postgres -c "SELECT pg_create_physical_replication_slot('standby_a');"
  # 舊 primary 那台：docker stop ${PG_CONTAINER_PEER} → 用該節點 volume 跑 setup-standby.sh
  #   （PRIMARY_HOST=<新 primary IP>、SLOT_NAME=standby_a）→ docker start ${PG_CONTAINER_PEER}
  # pg_hba 若擋 172.21.0.1：postgres-primary/fix-pg-hba.sh（CONTAINER=<新 primary>）
EOF
  log "failover drill OK（rejoin 需人工）"
  echo "report: ${REPORT}"
}

case "${1:-}" in
  preflight) shift; cmd_preflight "$@" ;;
  backup)    shift; cmd_backup "$@" ;;
  failover)  shift; cmd_failover "$@" ;;
  *)
    cat >&2 <<'USAGE'
usage:
  drill.sh preflight [--expect-role primary|standby]
  drill.sh backup
  CONFIRM_FAILOVER=yes FENCED=yes drill.sh failover
USAGE
    exit 2
    ;;
esac
