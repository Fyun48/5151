#!/usr/bin/env bash
# 補跑被取消 / 失敗的 Gitea Actions run —— **一次一個**、自我修復式，可掛 nohup 自己去清。
#
# 為什麼需要：
#   * `rerun` 會沿用該 run **原本的** workflow 定義 → 舊定義的 `cancel-in-progress: true` 會把
#     較新的 run 取消掉（2026-09-20 實測：run 36 被 run 33 的 rerun 取消、run 56 被舊 CI 的 rerun
#     取消）。所以**只能一次一個、等前一個真的結束**再換下一個，否則只是互相取消、永遠清不完。
#   * backlog 的來源：workflow 早期版本有 `cancel-in-progress: true`，一 push 就砍掉前一個 run。
#   * 人工補過一次（31/32/36）之後就沒人盯 → 這支把它自動化。
#
# 用法（在 NAS 上跑；預設走內部 http://127.0.0.1:5251 以免撞 Cloudflare 100s 上限）：
#   GITEA_TOKEN=<pat> bash backfill-runs.sh list    [--only <workflow-file>] [--state cancelled|failure|both]
#   GITEA_TOKEN=<pat> bash backfill-runs.sh status
#   GITEA_TOKEN=<pat> bash backfill-runs.sh run     [--max N] [--only ci.yml] [--ids 47,50] [--dry-run]
#
# 環境變數：
#   GITEA_TOKEN（必填，scope repo/write:repository）
#   GITEA_URL=http://127.0.0.1:5251、GITEA_REPO=JimmyGOD/5151、GITEA_USER=JimmyGOD
#   SETTLE_POLL=20（輪詢秒數）、SETTLE_TIMEOUT=5400（等單一 run 結束的上限秒數）、MAX_RUNS=100
#
# 依賴：curl、jq（NAS 上 /usr/bin/jq 1.5 已確認可用）
set -uo pipefail

BASE="${GITEA_URL:-http://127.0.0.1:5251}"
REPO="${GITEA_REPO:-JimmyGOD/5151}"
USER="${GITEA_USER:-JimmyGOD}"
TOKEN="${GITEA_TOKEN:?set GITEA_TOKEN (repo/write:repository)}"
API="${BASE}/api/v1/repos/${REPO}"
SETTLE_POLL="${SETTLE_POLL:-20}"
SETTLE_TIMEOUT="${SETTLE_TIMEOUT:-5400}"
MAX_RUNS="${MAX_RUNS:-100}"

command -v jq >/dev/null || { echo "ERROR: jq is required (NAS: /usr/bin/jq)" >&2; exit 1; }

log() { echo "[$(date -u +%H:%M:%SZ)] $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

api()  { curl -sS -u "${USER}:${TOKEN}" "$@"; }
code() { curl -sS -o /dev/null -w '%{http_code}' -u "${USER}:${TOKEN}" "$@"; }

# 每行：<id>\t<ui#>\t<workflow>\t<status>\t<conclusion>\t<sha7>\t<title>\t<sha40>
runs_tsv() {
  api "${API}/actions/runs?limit=50&page=1" \
    | jq -r --argjson n "${MAX_RUNS}" '
        .workflow_runs[] | [.id, .run_number, (.path|split("@")[0]), .status,
                            (.conclusion // "-"), (.head_sha[0:7]), .display_title, .head_sha]
        | @tsv' \
    | head -n "${MAX_RUNS}" || true
}

# 注意：**不能**在還有 run 在跑的時候 rerun —— 舊定義的 cancel-in-progress 會把它砍掉。
wait_for_idle() {
  local busy attempt=0
  while :; do
    busy="$(runs_tsv | awk -F'\t' '$4=="in_progress"||$4=="waiting"||$4=="running"||$4=="queued"{print $1"("$4")"}' | tr '\n' ' ')"
    [ -z "${busy}" ] && return 0
    attempt=$((attempt + 1))
    log "等待閒置中（還有：${busy}）… ${attempt}"
    sleep "${SETTLE_POLL}"
  done
}

wait_for_run() { # $1 = run id → 印出最終 conclusion
  local id="$1" waited=0 st conc
  while [ "${waited}" -lt "${SETTLE_TIMEOUT}" ]; do
    st="$(api "${API}/actions/runs/${id}" | jq -r '.status // "?"')"
    conc="$(api "${API}/actions/runs/${id}" | jq -r '.conclusion // "-"')"
    if [ "${st}" = "completed" ]; then echo "${conc}"; return 0; fi
    sleep "${SETTLE_POLL}"; waited=$((waited + SETTLE_POLL))
  done
  echo "timeout"
}

cmd_list() {
  local only="${ONLY:-}" state="${STATE:-both}" with_sha=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --only)  only="$2"; shift 2 ;;
      --state) state="$2"; shift 2 ;;
      --with-sha) with_sha=1; shift ;;
      *) die "unknown argument: $1" ;;
    esac
  done
  echo "id  ui  workflow                    status     conclusion  sha      title"
  runs_tsv | awk -F'\t' -v only="${only}" -v state="${state}" -v ws="${with_sha}" '
    {
      if (only != "" && $3 != only) next
      if (state == "both")   { if ($5 != "cancelled" && $5 != "failure") next }
      else                   { if ($5 != state) next }
      printf "%-3s %-3s %-27s %-10s %-11s %-8s %s%s\n", $1, $2, $3, $4, $5, $6, substr($7,1,52), (ws ? "\t" $8 : "")
    }'
  echo
  echo "（待補 = cancelled/failure；available workflows: $(api "${API}/actions/workflows" | jq -r '[.workflows[].id]|join(", ")')）"
}

cmd_status() {
  local busy done_s ok fail canc
  busy="$(runs_tsv | awk -F'\t' '$4=="in_progress"||$4=="waiting"{c++} END{print c+0}')"
  done_s="$(runs_tsv | awk -F'\t' '$4=="completed"{c++} END{print c+0}')"
  ok="$(runs_tsv   | awk -F'\t' '$5=="success"{c++} END{print c+0}')"
  fail="$(runs_tsv | awk -F'\t' '$5=="failure"{c++} END{print c+0}')"
  canc="$(runs_tsv | awk -F'\t' '$5=="cancelled"{c++} END{print c+0}')"
  echo "runs(最近 ${MAX_RUNS} 筆)：in_flight=${busy} completed=${done_s} success=${ok} failure=${fail} cancelled=${canc}"
}

cmd_run() {
  local ids="" dry=0 n=0 id ui wf sha conc elapsed t0
  while [ $# -gt 0 ]; do
    case "$1" in
      --ids)    ids="$2"; shift 2 ;;
      --dry-run) dry=1; shift ;;
      --max)    MAX_RUNS="$2"; shift 2 ;;
      --only)   ONLY="$2"; shift 2 ;;
      *) die "unknown argument: $1" ;;
    esac
  done

  local todo
  if [ -n "${ids}" ]; then
    todo="$(printf '%s' "${ids}" | tr ',' '\n' | while read -r x; do runs_tsv | awk -F'\t' -v i="${x}" '$1==i{print}'; done)"
  else
    todo="$(runs_tsv | awk -F'\t' -v only="${ONLY:-}" '
      { if (only != "" && $3 != only) next
        if ($5 != "cancelled" && $5 != "failure") next
        print }' | sort -t$'\t' -k1,1n)"
  fi
  [ -n "${todo}" ] || { log "沒有需要補的 run"; return 0; }

  log "待補 $(printf '%s\n' "${todo}" | wc -l) 個 run（由舊到新、一次一個）"
  printf '%s\n' "${todo}" | while IFS=$'\t' read -r id ui wf st conc sha title; do
    n=$((n + 1))
    log "--- [${n}] run ${id} (UI #${ui}) ${wf} ${sha} ${conc} :: ${title:0:60}"
    wait_for_idle
    if [ "${dry}" = "1" ]; then log "dry-run：略過 rerun"; continue; fi
    t0="$(date +%s)"
    local c; c="$(code -X POST "${API}/actions/runs/${id}/rerun")"
    case "${c}" in
      201|204) log "rerun accepted (HTTP ${c})" ;;
      409)     log "rerun 409（可能已在跑）→ 直接等它"; ;;
      *)       log "rerun 失敗 (HTTP ${c}) → 跳過"; continue ;;
    esac
    local res; res="$(wait_for_run "${id}")"
    elapsed=$(( $(date +%s) - t0 ))
    log "run ${id} (UI #${ui}) 結果=${res} 耗時=${elapsed}s"
  done
  log "補跑結束"; cmd_status
}

case "${1:-}" in
  list)   shift; cmd_list "$@" ;;
  status) shift; cmd_status "$@" ;;
  run)    shift; cmd_run "$@" ;;
  *) cat >&2 <<'USAGE'
usage:
  backfill-runs.sh list   [--only <workflow-file>] [--state cancelled|failure|both]
  backfill-runs.sh status
  backfill-runs.sh run    [--max N] [--only ci.yml] [--ids 47,50] [--dry-run]
USAGE
     exit 2 ;;
esac
