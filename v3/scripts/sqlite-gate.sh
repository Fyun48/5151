#!/usr/bin/env bash
#
# sqlite-gate.sh — 節點 SQLite 停用閘的「查／開／關／回退」操作（可重跑、冪等、不印值）。
#
# 閘的語意（見 v3/src/db.js）：
#   PG_NO_SQLITE_OPEN=1 且 DB_DRIVER=postgres ⇒ 正式 PG 模式「根本不開啟」業務 SQLite，
#   任何同步 SQLite handle 存取都明確拋錯（孤島退場）。未設／0 ⇒ 行為與現在完全相同。
#
# 子命令：
#   status                    三容器目前的閘值、鏡像 digest、v3.db-wal mtime（唯讀）。
#   on   [target ...]         在三容器的對應 NAS `.env` **只**加 PG_NO_SQLITE_OPEN=1 並重建。
#   off  [target ...]         在三容器的對應 NAS `.env` **只**刪 PG_NO_SQLITE_OPEN 並重建。
#   rollback [target ...]     off 的別名，並印出「下一步要查的三個指令」。
#
#   target 可選：591-tracker-v3 / 5151-web-A / 5151-web-B；不給＝三台全做。
#
# 安全契約（照 #671 已驗證的 .env 寫法）：
#   * 每個 .env 異動都 `cp -p` 備份 → `sed`／append → `chmod` 還原原 mode →
#     `grep -c '^PG_NO_SQLITE_OPEN='` 必須＝1（off 則＝0）→ `grep -Fqx` 比對值。
#   * 全腳本不 echo 任何 `.env` 內容（只印 key 名與計數）。
#   * 不假設 PATH（遠端一律 `export PATH=/usr/local/bin:/bin:/usr/bin:$PATH`）。
#   * 重建用的 compose 檔由容器 label `com.docker.compose.project.config_files` 決定，
#     **不硬編 casaos-compose.yml**（那檔的 :latest 沒有 pg 套件，是踩過的坑）。
#   * 不用 `docker exec -i`＋heredoc、不用 scp 到 syn-nas。
#
# 離線自測（不連 NAS，只印將執行的遠端指令）：
#   DRY_RUN=1 bash v3/scripts/sqlite-gate.sh on
#   DRY_RUN=1 bash v3/scripts/sqlite-gate.sh off
#   DRY_RUN=1 bash v3/scripts/sqlite-gate.sh status
#
set -euo pipefail
export PATH=/usr/local/bin:/bin:/usr/bin:$PATH

KEY="PG_NO_SQLITE_OPEN"
SSH="${SSH:-ssh}"
DRY_RUN="${DRY_RUN:-0}"

ALL_TARGETS="591-tracker-v3 5151-web-A 5151-web-B"

host_of() {
  case "$1" in
    591-tracker-v3|5151-web-A) printf 'casa-nas';;
    5151-web-B) printf 'syn-nas';;
    *) return 1;;
  esac
}
container_of() { printf '%s' "$1"; }
env_file_of() {
  case "$1" in
    591-tracker-v3) printf '/mnt/Storage1/apps/5151/.env';;
    5151-web-A)     printf '/opt/5151-shadow/web-a/.env';;
    5151-web-B)     printf '/var/services/homes/tori/5151-shadow/web-b/.env';;
    *) return 1;;
  esac
}
wal_dir_of() {
  case "$1" in
    591-tracker-v3) printf '/mnt/Storage1/docker_data/591-tracker-v3';;
    5151-web-A)     printf '/opt/5151-shadow/web-a/data';;
    5151-web-B)     printf '/var/services/homes/tori/5151-shadow/web-b/data';;
    *) return 1;;
  esac
}

# 遠端腳本模板（單引號 heredoc：內容一字不改地送到 NAS 上由 `sh -s` 執行；
# __ENV_FILE__／__CONTAINER__／__WAL__ 是佔位符，送出前才替換）。
REMOTE_ON=$(cat <<'REMOTE_ON_EOF'
set -eu
export PATH=/usr/local/bin:/bin:/usr/bin:$PATH
ENV_FILE='__ENV_FILE__'
CONTAINER='__CONTAINER__'
KEY='PG_NO_SQLITE_OPEN'
VALUE='1'
if [ ! -f "$ENV_FILE" ]; then echo "sqlite-gate ERROR: missing .env at $ENV_FILE"; exit 1; fi
MODE="$(stat -c '%a' "$ENV_FILE")"
cp -p "$ENV_FILE" "$ENV_FILE.bak-sqlite-gate-$(date +%Y%m%d%H%M%S)"
if grep -q "^${KEY}=" "$ENV_FILE"; then
  sed -i "s|^${KEY}=.*|${KEY}=${VALUE}|" "$ENV_FILE"
else
  printf '%s=%s\n' "$KEY" "$VALUE" >> "$ENV_FILE"
fi
chmod "$MODE" "$ENV_FILE"
COUNT="$(grep -c "^${KEY}=" "$ENV_FILE")"
if [ "$COUNT" != "1" ]; then echo "sqlite-gate ERROR: $KEY count=$COUNT (want 1)"; exit 1; fi
grep -Fqx "${KEY}=${VALUE}" "$ENV_FILE" || { echo "sqlite-gate ERROR: $KEY value mismatch"; exit 1; }
echo "sqlite-gate ok: $KEY=1 count=1 mode=$MODE"
CFG="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$CONTAINER")"
PROJ_DIR="$(dirname "$(printf '%s' "$CFG" | cut -d, -f1)")"
cd "$PROJ_DIR"
set --
for f in $(printf '%s' "$CFG" | tr ',' ' '); do set -- "$@" -f "$f"; done
docker compose "$@" up -d
REMOTE_ON_EOF
)

REMOTE_OFF=$(cat <<'REMOTE_OFF_EOF'
set -eu
export PATH=/usr/local/bin:/bin:/usr/bin:$PATH
ENV_FILE='__ENV_FILE__'
CONTAINER='__CONTAINER__'
KEY='PG_NO_SQLITE_OPEN'
if [ ! -f "$ENV_FILE" ]; then echo "sqlite-gate ERROR: missing .env at $ENV_FILE"; exit 1; fi
MODE="$(stat -c '%a' "$ENV_FILE")"
cp -p "$ENV_FILE" "$ENV_FILE.bak-sqlite-gate-$(date +%Y%m%d%H%M%S)"
if grep -q "^${KEY}=" "$ENV_FILE"; then sed -i "/^${KEY}=/d" "$ENV_FILE"; fi
chmod "$MODE" "$ENV_FILE"
COUNT="$(grep -c "^${KEY}=" "$ENV_FILE")"
if [ "$COUNT" != "0" ]; then echo "sqlite-gate ERROR: $KEY still present count=$COUNT (want 0)"; exit 1; fi
echo "sqlite-gate ok: $KEY removed count=0 mode=$MODE"
CFG="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$CONTAINER")"
PROJ_DIR="$(dirname "$(printf '%s' "$CFG" | cut -d, -f1)")"
cd "$PROJ_DIR"
set --
for f in $(printf '%s' "$CFG" | tr ',' ' '); do set -- "$@" -f "$f"; done
docker compose "$@" up -d
REMOTE_OFF_EOF
)

STATUS_BODY=$(cat <<'STATUS_EOF'
set -eu
export PATH=/usr/local/bin:/bin:/usr/bin:$PATH
CONTAINER='__CONTAINER__'
WAL='__WAL__/v3.db-wal'
VAL="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER" | grep '^PG_NO_SQLITE_OPEN=' | cut -d= -f2-)"
[ -n "$VAL" ] || VAL='unset'
IMG="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"
MT="$(stat -c '%Y %y' "$WAL" 2>/dev/null || printf 'none')"
echo "container=$CONTAINER pg_no_sqlite_open=$VAL image=$IMG wal_mtime=$MT"
STATUS_EOF
)

run_remote() {
  local host="$1" body="$2"
  if [ "$DRY_RUN" = "1" ]; then
    printf '%s\n' "$body" | sed 's/^/[DRY] /'
  else
    printf '%s\n' "$body" | "$SSH" -o BatchMode=yes "$host" 'sh -s'
  fi
}

do_gate() {
  local action="$1"; shift
  local t host envf container body
  for t in "$@"; do
    host="$(host_of "$t")" || { echo "unknown target: $t" >&2; exit 2; }
    envf="$(env_file_of "$t")"
    container="$(container_of "$t")"
    if [ "$action" = on ]; then
      body="${REMOTE_ON//__ENV_FILE__/$envf}"
      body="${body//__CONTAINER__/$container}"
    else
      body="${REMOTE_OFF//__ENV_FILE__/$envf}"
      body="${body//__CONTAINER__/$container}"
    fi
    echo "[gate] $action $t (host=$host)" >&2
    run_remote "$host" "$body"
  done
}

do_status() {
  local t host container wal body
  for t in "$@"; do
    host="$(host_of "$t")" || { echo "unknown target: $t" >&2; exit 2; }
    container="$(container_of "$t")"
    wal="$(wal_dir_of "$t")"
    body="${STATUS_BODY//__CONTAINER__/$container}"
    body="${body//__WAL__/$wal}"
    echo "[gate] status $t (host=$host)" >&2
    run_remote "$host" "$body"
  done
}

print_rollback_next() {
  cat <<'EOF'
[rollback] off 已完成（閘旗標移除＋容器重建）。下一步要查的三個指令：
  1) bash v3/scripts/sqlite-gate.sh status          # 三容器閘值回到 unset、wal mtime 恢復前進
  2) curl -fsS https://jibbyrenth.reversalplay.me/api/health   # 公網 200
  3) ssh casa-nas 'export PATH=/usr/local/bin:/bin:/usr/bin:$PATH; docker logs --since 5m 591-tracker-v3 2>&1 | grep -c "business SQLite is closed"'   # 應回 0
EOF
}

usage() {
  cat <<'EOF'
用法：bash v3/scripts/sqlite-gate.sh {status|on|off|rollback} [target ...]
  target：591-tracker-v3 / 5151-web-A / 5151-web-B（不給＝三台全做）
EOF
}

cmd="${1:-}"
shift || true
targets="$*"
[ -n "$targets" ] || targets="$ALL_TARGETS"

case "$cmd" in
  status)   do_status $targets;;
  on)       do_gate on $targets;;
  off)      do_gate off $targets;;
  rollback) do_gate off $targets; print_rollback_next;;
  *)        usage; exit 2;;
esac
