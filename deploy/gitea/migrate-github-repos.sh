#!/usr/bin/env bash
# GitHub → Gitea repo 遷移（含 private）與逐項驗收。
#
# 為什麼要有這支：
#   * migration API 一定要從 NAS 內部（http://127.0.0.1:5251）呼叫。走 Cloudflare
#     （jgitea01.reversalplay.me）對較大的 repo 會 HTTP 524，而且**留下一個空 repo**，
#     必須先刪掉再從內部重跑（見 evidence/runtime-modernization/GITEA-MIGRATION.md §1）。
#   * private repo 需要 auth_token；GitHub 端 0 commit 的空 repo 會讓 migration 回 409
#     `Git Repository is empty`，這種只能改用 POST /user/repos 建一個空 repo。
#   * 遷完必須驗收，否則「repo 在、內容殘缺」不會被發現。驗收用 API 的**精確總數**
#     （Gitea 的 X-Total-Count vs GitHub 的 Link rel="last"）比對分支/標籤數與預設分支
#     tip sha，再比 issues/PRs/releases —— 不用 git（Synology 上沒有 git）。
#
# 用法（在 NAS 上跑；token 建議用 stdin 帶，別留在 argv）：
#   GITEA_TOKEN=<pat> GH_TOKEN=<github-token> bash migrate-github-repos.sh plan   <repo>...
#   GITEA_TOKEN=<pat> GH_TOKEN=<github-token> bash migrate-github-repos.sh apply  <repo>...
#   GITEA_TOKEN=<pat> GH_TOKEN=<github-token> bash migrate-github-repos.sh verify <repo>...
#
# 例：
#   GITEA_TOKEN=$PAT GH_TOKEN=$GHP bash migrate-github-repos.sh apply cnndemo MBRIAPI ECPAPI
#
# 環境變數：
#   GITEA_TOKEN  必填。Gitea token（放在 basic auth 的密碼位置），scope 需 write:repository。
#   GH_TOKEN     必填。GitHub token（`gh auth token` 或 classic PAT），scope 需 repo（讀 private）。
#   GITEA_URL    default http://127.0.0.1:5251
#   GITEA_OWNER  default JimmyGOD
#   GH_OWNER     default Fyun48
#   PRIVATE      default true（這批是 private repo；要 public 才設 false）
set -euo pipefail

BASE="${GITEA_URL:-http://127.0.0.1:5251}"
GOWNER="${GITEA_OWNER:-JimmyGOD}"
HOWNER="${GH_OWNER:-Fyun48}"
TOKEN="${GITEA_TOKEN:?set GITEA_TOKEN}"
GHTOKEN="${GH_TOKEN:?set GH_TOKEN}"
PRIVATE="${PRIVATE:-true}"
API="${BASE}/api/v1"
GH_API="https://api.github.com"

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "[$(date -u +%H:%M:%SZ)] $*"; }

gapi()  { curl -sS -u "${GOWNER}:${TOKEN}" "$@"; }
gcode() { curl -sS -o /dev/null -w '%{http_code}' -u "${GOWNER}:${TOKEN}" "$@"; }
hapi()  { curl -sS -H "Authorization: token ${GHTOKEN}" \
                   -H 'Accept: application/vnd.github+json' "$@"; }

# jget <json> <key> → 值（去引號、去頭尾空白）。刻意不依賴 jq（Synology 上不保證有）。
# 兩邊的 JSON 格式不同，這裡必須同時吃：
#   Gitea   → 緊湊：{"size":7129,...}
#   GitHub  → 縮排多行 + 冒號後有空白：{\n  "size": 7129,\n ...}
# 2026-09-20 踩過：少了空白處理，`default_branch` 會取出 " main"（前面帶空格），
# 直接塞進 URL 就變成 `curl: (3) Error`（malformed URL）→ 驗收整欄空白。
jget() {
  printf '%s' "$1" | tr -d '\n' \
    | grep -o "\"$2\"[[:space:]]*:[[:space:]]*[^,}]*" | head -1 \
    | sed 's/^[^:]*:[[:space:]]*//; s/[[:space:]]*$//' | tr -d '"' || true
}

# 精確計數刻意不用 git：Synology 上**沒有 git**（實測 command -v git = MISSING），
# 而 `git ls-remote` 是唯一能同時拿到「分支總數 + HEAD sha」的方法 → 改用兩個 API 的等效訊號：
#   * Gitea 的 list 端點會回 `X-Total-Count`，實測是**真總數**（5151 branches?limit=1 → 65，
#     與本機 `git ls-remote --refs | grep -c refs/heads/` 的 65 完全相同）。
#   * GitHub 不回 X-Total-Count，改讀 Link header 的 `rel="last"`：帶 `?per_page=1` 時
#     最後一頁的頁碼就等於總數（5151 branches?per_page=1 → page=65，同樣等於 65）。
# ⚠️ 這裡所有 helper 都**必須回傳 0**：腳本是 `set -euo pipefail`，而 `x="$(helper ...)"`
# 的退出碼會直接決定腳本生死 —— 空 repo（沒有 branch）取不到 sha、grep 沒命中就回 1，
# 會讓整個驗收表在那一列**直接中斷且不報錯**（2026-09-20 實測踩到）。所以一律 `|| true`。
gt_count() { # gt_count <Gitea list path 含 query>
  curl -sS -D - -o /dev/null -u "${GOWNER}:${TOKEN}" "${API}$1" \
    | tr -d '\r' | awk 'tolower($1)=="x-total-count:"{print $2; exit}' || true
}

gh_count() { # gh_count <GitHub list path 含 ?per_page=1>
  local h b n
  h="$(umask 077; mktemp)"; b="$(umask 077; mktemp)"
  curl -sS -D "${h}" -o "${b}" -H "Authorization: token ${GHTOKEN}" \
    -H 'User-Agent: cline' "${GH_API}$1"
  # 注意 `[?&]page=`：單純寫 `page=` 會先命中 URL 裡的 `per_page=1` → 永遠得到 1（實測踩過）。
  n="$(tr -d '\r' < "${h}" | tr ',' '\n' | grep 'rel="last"' | grep -o '[?&]page=[0-9]*' | grep -o '[0-9]*$' | head -1)"
  if [ -z "${n}" ]; then
    # 只有一頁 → 沒有 rel="last"：body 是空陣列＝0，否則＝1。
    if grep -q '[0-9a-f]' "${b}"; then n=1; else n=0; fi
  fi
  rm -f "${h}" "${b}"
  echo "${n:-0}"
}

# GitHub search API 的 total_count（issues 與 PRs 必須分開問，且一定要帶 type:）
htotal() { jget "$(hapi "${GH_API}/search/issues?per_page=1&q=repo:${HOWNER}/${1}+type:${2}")" total_count || true; }

# default branch 的 tip sha。兩邊的 /branches/{branch} 回傳結構不同（Gitea `commit.id`、
# GitHub `commit.sha`），而且 **GitHub 的 JSON 冒號後有空白**，所以 pattern 要允許空白。
gt_head_sha() {
  gapi "${API}/repos/${GOWNER}/${1}/branches/${2}" \
    | grep -o '"id":[[:space:]]*"[0-9a-f]\{40\}"' | head -1 | grep -o '[0-9a-f]\{40\}' || true
}
gh_head_sha() {
  hapi "${GH_API}/repos/${HOWNER}/${1}/branches/${2}" \
    | grep -o '"sha":[[:space:]]*"[0-9a-f]\{40\}"' | head -1 | grep -o '[0-9a-f]\{40\}' || true
}
gt_repo() { gapi "${API}/repos/${GOWNER}/${1}"; }

gh_repo_json() {
  local j; j="$(hapi "${GH_API}/repos/${HOWNER}/${1}")"
  [ -n "${j}" ] || die "GitHub repo 讀不到：${HOWNER}/${1}（token scope 需 repo）"
  printf '%s' "${j}"
}

cmd_plan() {
  [ $# -gt 0 ] || die "usage: plan <repo>..."
  printf '%-26s %-9s %-8s %-14s %-9s %-8s %s\n' \
    repo gh_heads gh_tags gh_head gh_sizeKB gh_issues gitea
  local repo j
  for repo in "$@"; do
    j="$(gh_repo_json "${repo}")"
    printf '%-26s %-9s %-8s %-14s %-9s %-8s %s\n' \
      "${repo}" \
      "$(gh_count "/repos/${HOWNER}/${repo}/branches?per_page=1")" \
      "$(gh_count "/repos/${HOWNER}/${repo}/tags?per_page=1")" \
      "$(gh_head_sha "${repo}" "$(jget "${j}" default_branch)" | cut -c1-12)" \
      "$(jget "${j}" size)" \
      "$(htotal "${repo}" issue)" \
      "$([ "$(gcode "${API}/repos/${GOWNER}/${repo}")" = "200" ] && echo present || echo ABSENT)"
  done
}

# 驗收。refs（分支數/預設分支 tip sha）要求**相等**；issues/PRs/releases 只要求
# 「Gitea 不少於 GitHub」（Gitea 可能因為 GitHub 端的 rate limit 而有取不到的項目）。
# 任何一項不符 → 印 FAIL<原因> 並以非 0 結束。
cmd_verify() {
  [ $# -gt 0 ] || die "usage: verify <repo>..."
  printf '%-26s %-11s %-10s %-14s %-11s %-10s %-11s %-7s %s\n' \
    repo br_gh/gt tag_gh/gt head_gh/gt iss_gh/gt pr_gh/gt rel_gh/gt private verdict
  local repo rc=0 j gt_code gh_br gt_br gh_tag gt_tag gh_head gt_head \
        gh_iss gt_iss gh_pr gt_pr gh_rel gt_rel priv v branch
  for repo in "$@"; do
    j="$(gh_repo_json "${repo}")"
    gt_code="$(gcode "${API}/repos/${GOWNER}/${repo}")"
    if [ "${gt_code}" != "200" ]; then
      printf '%-26s %s\n' "${repo}" "FAIL(not in gitea: http ${gt_code})"
      rc=1; continue
    fi
    branch="$(jget "${j}" default_branch)"
    gh_br="$(gh_count "/repos/${HOWNER}/${repo}/branches?per_page=1")"
    gt_br="$(gt_count "/repos/${GOWNER}/${repo}/branches?limit=1")"
    gh_tag="$(gh_count "/repos/${HOWNER}/${repo}/tags?per_page=1")"
    gt_tag="$(gt_count "/repos/${GOWNER}/${repo}/tags?limit=1")"
    gh_head="$(gh_head_sha "${repo}" "${branch}" | cut -c1-12)"
    gt_head="$(gt_head_sha "${repo}" "${branch}" | cut -c1-12)"
    gh_iss="$(htotal "${repo}" issue)"
    gt_iss="$(gt_count "/repos/${GOWNER}/${repo}/issues?state=all&type=issues&limit=1")"
    gh_pr="$(htotal "${repo}" pr)"
    gt_pr="$(gt_count "/repos/${GOWNER}/${repo}/issues?state=all&type=pulls&limit=1")"
    gh_rel="$(gh_count "/repos/${HOWNER}/${repo}/releases?per_page=1")"
    gt_rel="$(jget "$(gt_repo "${repo}")" release_counter)"
    priv="$(jget "$(gt_repo "${repo}")" private)"

    v=""
    [ "${gh_br}" = "${gt_br}" ]                   || v="${v}+branches"
    [ "${gh_tag}" = "${gt_tag}" ]                 || v="${v}+tags"
    [ -z "${gh_head}" ] || [ "${gh_head}" = "${gt_head}" ] || v="${v}+head"
    [ "$(( ${gt_iss:-0} + 0 ))" -ge "$(( ${gh_iss:-0} + 0 ))" ] || v="${v}+issues"
    [ "$(( ${gt_pr:-0} + 0 ))"  -ge "$(( ${gh_pr:-0} + 0 ))"  ] || v="${v}+prs"
    [ "$(( ${gt_rel:-0} + 0 ))" -ge "$(( ${gh_rel:-0} + 0 ))" ] || v="${v}+releases"
    if [ "${PRIVATE}" = "true" ] && [ "${priv}" != "true" ]; then v="${v}+not-private"; fi
    if [ -n "${v}" ]; then v="FAIL${v}"; rc=1; else v="OK"; fi
    printf '%-26s %-11s %-10s %-14s %-11s %-10s %-11s %-7s %s\n' \
      "${repo}" "${gh_br}/${gt_br}" "${gh_tag}/${gt_tag}" "${gh_head:0:8}/${gt_head:0:8}" \
      "${gh_iss}/${gt_iss}" "${gh_pr}/${gt_pr}" "${gh_rel}/${gt_rel}" "${priv}" "${v}"
  done
  if [ "${rc}" = "0" ]; then echo "ALL OK"; else echo "有 FAIL 項目（見上表）"; fi
  return "${rc}"
}

# 遷移單一 repo。已存在就跳過（冪等，重跑安全）；空 repo 走另一條路。
migrate_one() {
  local repo="$1" j gh_heads desc tmp code
  if [ "$(gcode "${API}/repos/${GOWNER}/${repo}")" = "200" ]; then
    info "${repo}: 已存在於 Gitea → 跳過（要重遷請先刪掉 Gitea 上的它）"
    return 0
  fi
  j="$(gh_repo_json "${repo}")"
  gh_heads="$(gh_count "/repos/${HOWNER}/${repo}/branches?per_page=1")"
  desc="$(jget "${j}" description | sed 's/\\/\\\\/g; s/"/\\"/g')"
  tmp="$(umask 077; mktemp)"

  if [ "${gh_heads}" = "0" ]; then
    # GitHub 端 0 commit：migration API 會回 409 `Git Repository is empty`，
    # 只能單純建一個空 repo 來保留「它存在」這件事。
    info "${repo}: GitHub 端 0 commit（空 repo）→ 改用 POST /user/repos 建空 repo"
    printf '{"name":"%s","description":"%s","private":%s,"auto_init":false}' \
      "${repo}" "${desc}" "${PRIVATE}" > "${tmp}"
    code="$(gapi -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
      -X POST --data-binary "@${tmp}" "${API}/user/repos")"
    rm -f "${tmp}"
    [ "${code}" = "201" ] || die "${repo}: 建空 repo 失敗 (HTTP ${code})"
    info "${repo}: 空 repo 已建立 (HTTP 201)"
    return 0
  fi

  info "${repo}: migrating（GitHub heads=${gh_heads}, size=$(jget "${j}" size)KB）..."
  printf '{"clone_addr":"https://github.com/%s/%s.git","repo_name":"%s","repo_owner":"%s","service":"github","auth_token":"%s","auth_username":"%s","mirror":false,"private":%s,"description":"%s","issues":true,"pull_requests":true,"labels":true,"milestones":true,"releases":true,"wiki":false,"lfs":true}' \
    "${HOWNER}" "${repo}" "${repo}" "${GOWNER}" "${GHTOKEN}" "${HOWNER}" "${PRIVATE}" "${desc}" > "${tmp}"
  code="$(gapi -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
    -X POST --data-binary "@${tmp}" "${API}/repos/migrate")"
  rm -f "${tmp}"
  case "${code}" in
    201) info "${repo}: migrated (HTTP 201)" ;;
    403) die "${repo}: forbidden (HTTP 403) — GITEA_TOKEN 的 scope 不足（需 write:repository）" ;;
    409) die "${repo}: conflict (HTTP 409) — GitHub 端為空，或 Gitea 上已存在同名 repo" ;;
    *)   die "${repo}: migration 失敗 (HTTP ${code})" ;;
  esac
}

cmd_apply() {
  [ $# -gt 0 ] || die "usage: apply <repo>..."
  local repo
  for repo in "$@"; do migrate_one "${repo}"; done
  echo
  info "遷移後驗收："
  cmd_verify "$@"
}

case "${1:-}" in
  plan)   shift; cmd_plan   "$@" ;;
  apply)  shift; cmd_apply  "$@" ;;
  verify) shift; cmd_verify "$@" ;;
  *)
    cat >&2 <<'USAGE'
usage:
  migrate-github-repos.sh plan   <repo>...   # 只讀：列出 GitHub 端狀態與 Gitea 是否已有
  migrate-github-repos.sh apply  <repo>...   # 遷移（已存在會跳過）→ 自動驗收
  migrate-github-repos.sh verify <repo>...   # 只驗收

必要環境變數：GITEA_TOKEN（write:repository）、GH_TOKEN（repo，讀 private）
USAGE
    exit 2 ;;
esac
