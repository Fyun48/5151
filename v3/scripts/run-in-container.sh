#!/usr/bin/env bash
# 在容器內執行驗證腳本（**會先同步最新 src**，避免跑到舊版程式碼）
#
# 為什麼需要它：容器 /app 是「已部署」版本，驗證新程式碼時我們把 src 複製到 /tmp/kk 再跑；
# 若忘了重新複製，就會出現「程式碼明明改了、結果卻是舊行為」的假象（實際踩過兩次）。
#
# 用法：
#   bash v3/scripts/run-in-container.sh v3/scripts/kind-e2e-parity.mjs
#   bash v3/scripts/run-in-container.sh v3/scripts/q-e2e.mjs -d          # -d：背景執行（寫 /tmp/<name>.log）
#   ENV="PG_STATEMENT_TIMEOUT_MS=300000" bash v3/scripts/run-in-container.sh ...   # 追加環境變數
set -uo pipefail
CONTAINER="${CONTAINER:-591-tracker-v3}"
CASA="${CASA:-casa-nas}"
REMOTE_DIR="${REMOTE_DIR:-/tmp/kk}"

script="${1:?用法: run-in-container.sh <script.mjs> [-d]}"
shift || true
background=""
for arg in "$@"; do [ "$arg" = "-d" ] && background=1; done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[ -f "$script" ] || script="$repo_root/$script"
[ -f "$script" ] || { echo "找不到腳本：$1"; exit 2; }
name="$(basename "$script")"

echo "[1/3] 同步最新 src → ${CONTAINER}:${REMOTE_DIR}"
tar cz -C "$repo_root/v3" src public/cities.json | ssh -o BatchMode=yes -o ConnectTimeout=15 "$CASA" \
  "docker exec -i $CONTAINER sh -lc 'mkdir -p $REMOTE_DIR && tar xz -C $REMOTE_DIR'" || exit 1

echo "[2/3] 放入腳本 ${name}"
cat "$script" | ssh -o BatchMode=yes -o ConnectTimeout=15 "$CASA" \
  "docker exec -i $CONTAINER sh -lc 'cat > $REMOTE_DIR/$name'" || exit 1

# 驗證同步真的生效（同檔名在 repo 與容器內應一致）
local_sum="$(sha256sum "$script" | cut -c1-12)"
remote_sum="$(ssh -o BatchMode=yes -o ConnectTimeout=15 "$CASA" \
  "docker exec $CONTAINER sh -lc 'sha256sum $REMOTE_DIR/$name 2>/dev/null | cut -c1-12'")"
echo "      本機=$local_sum 容器=${remote_sum:-?}"
[ "$local_sum" = "${remote_sum:-}" ] || { echo "同步不一致，中止（避免用到舊版）"; exit 3; }

if [ -n "$background" ]; then
  log="/tmp/${name%.mjs}.log"
  echo "[3/3] 背景執行（容器內 $log）"
  ssh -o BatchMode=yes -o ConnectTimeout=15 "$CASA" \
    "docker exec -d -e PG_STATEMENT_TIMEOUT_MS=300000 $CONTAINER sh -lc 'cd $REMOTE_DIR && node $name > $log 2>&1'" || exit 1
  echo "      之後用：ssh $CASA \"docker exec $CONTAINER sh -lc 'tail -c 1500 $log'\""
else
  echo "[3/3] 前景執行"
  ssh -o BatchMode=yes -o ConnectTimeout=20 "$CASA" \
    "docker exec -e PG_STATEMENT_TIMEOUT_MS=300000 $CONTAINER sh -lc 'cd $REMOTE_DIR && node $name'"
fi
