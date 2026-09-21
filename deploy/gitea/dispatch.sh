#!/usr/bin/env bash
# Gitea Actions manual-only workflow 觸發 / 讀結果工具。
#
# 為什麼要有這支：
#   * Gitea 1.23+ 才有 dispatch API（`POST /repos/{owner}/{repo}/actions/workflows/{file}/dispatches`），
#     Gitea 1.22.6 沒有、UI 也不會給按鈕（見 evidence/runtime-modernization/GITEA-MIGRATION.md §2.6）。
#   * 2026-09-20 實測踩過：手打 curl 時 sha 取空 → workflow 的 fail-closed gate 正確拒絕（run 29）。
#     這支在送出前就地驗 40 碼 hex sha 與 release_mode/release_intent_id 的組合，先把那類錯誤擋掉。
#
# 用法（建議在 NAS 上跑；預設走內部 http://127.0.0.1:5251 以免撞 Cloudflare 100s 上限）：
#   GITEA_TOKEN=<pat> bash dispatch.sh run <workflow-file> <40-hex-sha> [--input k=v]... [--wait-secs N]
#   GITEA_TOKEN=<pat> bash dispatch.sh status <run-id>
#   GITEA_TOKEN=<pat> bash dispatch.sh logs <run-id> [--tail N]        # tail 0 = 全部
#
# 例：
#   GITEA_TOKEN=$PAT bash dispatch.sh run build-production-image.yml $(git rev-parse HEAD) \
#       --input release_mode=manual_owner --input release_intent_id=
#
# 環境變數：
#   GITEA_TOKEN（必填，scope 需 repo/write:repository）、GITEA_URL=http://127.0.0.1:5251
#   GITEA_REPO=JimmyGOD/5151、GITEA_USER=JimmyGOD（basic auth 用；token owner）
set -euo pipefail

BASE="${GITEA_URL:-http://127.0.0.1:5251}"
REPO="${GITEA_REPO:-JimmyGOD/5151}"
USER="${GITEA_USER:-JimmyGOD}"
API="${BASE}/api/v1/repos/${REPO}"
TOKEN="${GITEA_TOKEN:?set GITEA_TOKEN (repo/write:repository)}"

die() { echo "ERROR: $*" >&2; exit 1; }
api() { curl -sS -u "${USER}:${TOKEN}" "$@"; }

# status code → 文字（Gitea action_run.status：1=success 2=failure 3=cancelled 5=waiting 6=running）
status_text() {
  case "$1" in
    1) echo success ;; 2) echo failure ;; 3) echo cancelled ;;
    4) echo skipped ;; 5) echo waiting ;; 6) echo running ;; *) echo "status:$1" ;;
  esac
}

cmd_run() {
  local wf="${1:?usage: run <workflow-file> <40-hex-sha> [--input k=v]...}"
  local sha="${2:?usage: run <workflow-file> <40-hex-sha> [--input k=v]...}"
  shift 2

  [[ "${sha}" =~ ^[0-9a-f]{40}$ ]] || die "sha must be a full 40-char lowercase hex commit SHA (got '${sha}')"

  local inputs_json="" key val
  local -A input_map=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --input)
        key="${2%%=*}"; val="${2#*=}"
        [[ "${key}" =~ ^[A-Za-z0-9_]+$ ]] || die "--input key must match [A-Za-z0-9_]+ (got '${key}')"
        val="${val//\\/\\\\}"; val="${val//\"/\\\"}"
        input_map["${key}"]="${val}"
        shift 2 ;;
      --wait-secs) WAIT_SECS="$2"; shift 2 ;;
      *) die "unknown argument: $1" ;;
    esac
  done

  # 與 workflow 內的 fail-closed gate 同一組規則，先在本地擋一次（省一次 run）。
  # 注意：release_mode / release_intent_id **只在呼叫方有帶時才驗、才送** —— 像 agent.yml 這種
  # 沒有這兩個 input 的 workflow，硬塞會讓 dispatch 失敗（2026-09-20 實測踩到）。
  # sha 是 workflow 的 input 之一（不是 --input 參數）：少了它，gate 會回
  # `sha must be a full 40-character commit SHA`（2026-09-20 run 35 的教訓：工具自己要負責帶上）。
  input_map["sha"]="${sha}"

  local mode="${input_map[release_mode]:-}"
  local intent="${input_map[release_intent_id]:-}"
  if [ -n "${mode}" ]; then
    case "${mode}" in
      manual_owner) [ -z "${intent}" ] || die "manual_owner forbids a non-empty release_intent_id" ;;
      ops_phase15)  [ -n "${intent}" ] || die "ops_phase15 requires a non-empty release_intent_id" ;;
      *) die "release_mode must be manual_owner or ops_phase15 (got '${mode}')" ;;
    esac
  fi

  local k
  for k in "${!input_map[@]}"; do
    inputs_json="${inputs_json:+${inputs_json},}\"${k}\":\"${input_map[${k}]}\""
  done

  local body="{\"ref\":\"master\",\"inputs\":{${inputs_json}}}"
  local tmp; tmp="$(mktemp)"
  printf '%s' "${body}" > "${tmp}"
  echo "dispatch: ${wf} @ master  sha=${sha}  inputs=${body#*\"inputs\":}"
  local code
  code="$(api -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
    -X POST --data-binary "@${tmp}" "${API}/actions/workflows/${wf}/dispatches")"
  rm -f "${tmp}"
  [ "${code}" = "204" ] || die "dispatch failed (HTTP ${code}); Gitea <1.23 沒有這個端點（見 GITEA-MIGRATION.md §2.6）"
  echo "dispatch accepted (HTTP 204)"
}

find_run_for_sha() {
  local sha="$1"
  api "${API}/actions/runs?limit=20" \
    | tr '{' '\n' \
    | grep -F "\"head_sha\":\"${sha}\"" \
    | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2
}

job_id_of_run() {
  local rid="$1"
  api "${API}/actions/runs/${rid}/jobs" | tr ',' '\n' | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2
}

cmd_status() {
  # 注意：這裡吃的是**內部 id**（DB `action_run.id`），不是 UI 顯示的 `#N`。
  # Gitea UI 顯示的是 `run_number`，在 DB 就是 `action_run.index`（每個 workflow 自己的流水號）。
  # 兩者不同步（實測：id=38 ↔ index=35），所以一律把兩個都印出來。
  local rid="${1:?usage: status <run-id>}"
  local json idx s
  json="$(api "${API}/actions/runs/${rid}")"
  idx="$(printf '%s' "${json}" | grep -o '"run_number":[0-9]*' | head -1 | cut -d: -f2)"
  s="$(printf '%s' "${json}" | grep -o '"status":"[a-z_]*"' | head -1 | cut -d'"' -f4)"
  echo "run id=${rid} (UI #${idx:-?}): status=${s}"
}

cmd_logs() {
  local rid="${1:?usage: logs <run-id>}"; shift || true
  local tail_n=40
  while [ $# -gt 0 ]; do
    case "$1" in --tail) tail_n="$2"; shift 2 ;; *) die "unknown argument: $1" ;; esac
  done
  local jid; jid="$(job_id_of_run "${rid}")"
  [ -n "${jid}" ] || die "no job found for run ${rid}"
  if [ "${tail_n}" = "0" ]; then
    api "${API}/actions/jobs/${jid}/logs"
  else
    api "${API}/actions/jobs/${jid}/logs" | tail -n "${tail_n}"
  fi
}

case "${1:-}" in
  run)
    shift; cmd_run "$@"
    sha=""; for a in "$@"; do case "$a" in [0-9a-f]*) sha="$a" ;; esac; done
    rid="$(find_run_for_sha "${sha}")"
    [ -n "${rid}" ] || { echo "run not found yet (check the Actions page)"; exit 0; }
    echo "run id: ${rid}  (logs: bash dispatch.sh logs ${rid})"
    ;;
  status) shift; cmd_status "$@" ;;
  logs)   shift; cmd_logs "$@" ;;
  *) cat >&2 <<'USAGE'
usage:
  dispatch.sh run <workflow-file> <40-hex-sha> [--input k=v]...
  dispatch.sh status <run-id>
  dispatch.sh logs <run-id> [--tail N]
USAGE
     exit 2 ;;
esac
