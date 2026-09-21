#!/usr/bin/env bash
# 把 workflow / 腳本的結果推到 Discord（P1：讓 Owner 關掉電腦也能收到結果）。
#
# 為什麼需要：Owner 不想一直盯畫面；Gitea/runner 在 NAS 上就算關機也照跑，
# 但「結果」要有出口 —— 推播到手機的 Discord 頻道。
#
# 用法
#   DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/…' \
#     STATUS=success TITLE="build #37" RUN_URL="https://…/actions/runs/40" \
#     FIELDS="sha=dd9289e,digest=sha256:728d…" bash notify.sh
#   bash notify.sh "一句話訊息"          # 直接給訊息文字
#
# 環境變數
#   DISCORD_WEBHOOK_URL（或用第 1 個參數）——**沒設定時只印一行 skipped 並 exit 0**，
#     這樣還沒設通知前 workflow 不會因此紅燈。
#   STATUS=success|failure|cancelled|running|info   → 決定顏色與 emoji
#   TITLE / RUN_URL / FIELDS（`k=v,k2=v2`，最多 8 個）/ MESSAGE
#   NOTIFY_STRICT=1 → webhook 打不通時 exit 1（預設只印警告，不影響 job 結果）
#   NOTIFY_DRY_RUN=1 → 只印出要送的 JSON，不真的送
set -uo pipefail

WEBHOOK="${DISCORD_WEBHOOK_URL:-}"
if [ -z "${WEBHOOK}" ] && [ $# -gt 0 ] && printf '%s' "${1}" | grep -qE '^https?://'; then
  WEBHOOK="${1}"; shift
fi
MESSAGE="${MESSAGE:-${1:-}}"
STATUS="${STATUS:-info}"
TITLE="${TITLE:-${GITHUB_WORKFLOW:-notification}}"
RUN_URL="${RUN_URL:-}"
FIELDS="${FIELDS:-}"

if [ -z "${WEBHOOK}" ]; then
  echo "notify: skipped (DISCORD_WEBHOOK_URL not set; set it as repo variable/secret to enable)"
  exit 0
fi

# status → (emoji, color)
case "${STATUS}" in
  success)   EMOJI="✅"; COLOR=3066993  ;;
  failure)   EMOJI="❌"; COLOR=15158332 ;;
  cancelled) EMOJI="⚪"; COLOR=9807270  ;;
  running)   EMOJI="⏳"; COLOR=3447003  ;;
  *)         EMOJI="ℹ️"; COLOR=10070709 ;;
esac

# Discord 單則訊息上限 2000 字元 → 先保守截斷，避免整個通知送不出去。
trunc() { printf '%s' "${1}" | head -c "${2:-900}"; }

json_escape() {
  local s="${1//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/}"
  s="${s//$'\t'/\\t}"
  printf '%s' "${s}"
}

DESC="$(json_escape "$(trunc "${MESSAGE}" 900)")"
TITLE_ESC="$(json_escape "$(trunc "${TITLE}" 200)")"

FIELDS_JSON=""
if [ -n "${FIELDS}" ]; then
  IFS=',' read -r -a pairs <<< "${FIELDS}"
  n=0
  for p in "${pairs[@]}"; do
    [ "${n}" -ge 8 ] && break
    k="${p%%=*}"; v="${p#*=}"
    [ -z "${k}" ] && continue
    [ "${k}" = "${v}" ] && { k="info"; v="${p}"; }
    FIELDS_JSON="${FIELDS_JSON:+${FIELDS_JSON},}{\"name\":\"$(json_escape "$(trunc "${k}" 60)")\",\"value\":\"$(json_escape "$(trunc "${v}" 300)")\",\"inline\":false}"
    n=$((n + 1))
  done
fi

BODY="{"
BODY="${BODY}\"username\":\"5151 Gitea\","
BODY="${BODY}\"embeds\":[{"
BODY="${BODY}\"title\":\"${EMOJI} ${TITLE_ESC}\","
[ -n "${DESC}" ] && BODY="${BODY}\"description\":\"${DESC}\","
[ -n "${RUN_URL}" ] && BODY="${BODY}\"url\":\"$(json_escape "$(trunc "${RUN_URL}" 500)")\","
BODY="${BODY}\"color\":${COLOR},"
[ -n "${FIELDS_JSON}" ] && BODY="${BODY}\"fields\":[${FIELDS_JSON}],"
BODY="${BODY}\"footer\":{\"text\":\"$(json_escape "$(trunc "${GITHUB_REPOSITORY:-JimmyGOD/5151} ${GITHUB_RUN_ID:-run ${GITHUB_RUN_NUMBER:-?}} ${STATUS}" 200)")\"}"
BODY="${BODY}}]}"

if [ "${NOTIFY_DRY_RUN:-0}" = "1" ]; then
  echo "notify: dry-run payload → ${BODY}"
  exit 0
fi

CODE="$(curl -sS -o /tmp/notify-resp.txt -w '%{http_code}' -H 'Content-Type: application/json' \
  -X POST --data-binary "${BODY}" "${WEBHOOK}" 2>/dev/null || echo 000)"
case "${CODE}" in
  200|204) echo "notify: sent (HTTP ${CODE})"; exit 0 ;;
  429)     echo "notify: rate limited (429) — retrying once after 5s"; sleep 5
           CODE="$(curl -sS -o /tmp/notify-resp.txt -w '%{http_code}' -H 'Content-Type: application/json' \
             -X POST --data-binary "${BODY}" "${WEBHOOK}" 2>/dev/null || echo 000)"
           [ "${CODE}" = "200" ] && { echo "notify: sent on retry (HTTP 200)"; exit 0; } ;;
esac

echo "notify: FAILED (HTTP ${CODE}): $(head -c 200 /tmp/notify-resp.txt 2>/dev/null)" >&2
[ "${NOTIFY_STRICT:-0}" = "1" ] && exit 1
exit 0
