#!/usr/bin/env bash
# OPS-only CasaOS 發版／重建（Owner 指示 2026-10-07：OPS 要獨立於單一專案）。
#
# 在哪裡跑：在 casa-nas 上。從工作機這樣叫：
#   git archive <SHA> ops docker-compose.ops.casaos.yml \
#     | ssh casa-nas 'bash -s' < ops/scripts/deploy-ops-casaos.sh   # ← 不行，腳本要用下方形式
#   git archive <SHA> ops docker-compose.ops.casaos.yml > /tmp/ops.tar
#   ssh casa-nas "bash -s -- <SHA> <runtime-digest>" < ops/scripts/deploy-ops-casaos.sh < /tmp/ops.tar
#
# 性質：可重跑（冪等）。同一 SHA 重複跑只會重建容器，不會留下半成品 release。
# fail-closed：任何一步失敗 → 把 current 切回前一個 SHA 並重建，不留在壞狀態。
# 只碰 OPS（5151-ops / 5151-ops-cloudflared）；不碰 v3、不碰吉比的 compose project。
set -euo pipefail

DEPLOY_SHA="${1:?用法: $0 <git-sha> <runtime-image-digest  or  same>  （第二參數傳 '-' 沿用現行）}"
RUNTIME_IMAGE_ARG="${2:?缺少第二參數（digest 或 '-'）}"

APP_ROOT="${OPS_CASAOS_APP_ROOT:-/mnt/Storage1/docker/5151-ops/app}"
SECRET_DIR="${OPS_CASAOS_SECRET_DIR:-/mnt/Storage1/docker/5151-ops/secrets}"
ENV_FILE="${OPS_CASAOS_ENV_FILE:-$APP_ROOT/.env}"
COMPOSE_PROJECT="5151-ops"
HEALTH_URL="http://127.0.0.1:5154/console.html"
RELEASES="$APP_ROOT/releases"
CURRENT="$APP_ROOT/current"
INCOMING="$APP_ROOT/incoming/$DEPLOY_SHA"

log() { echo "[ops-casaos] $*"; }
fail() { echo "[ops-casaos][FAIL] $*" >&2; exit 1; }

# --- 解析 runtime image：'-' 表示沿用目前容器在跑的那個 digest ----------------------------
command -v docker >/dev/null 2>&1 || fail "找不到 docker（本腳本只能在 casa-nas 上跑）"
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
if [ "$RUNTIME_IMAGE_ARG" = "-" ]; then
  [ -n "${OPS_RUNTIME_IMAGE:-}" ] || fail "第二參數傳 '-' 但 $ENV_FILE 內沒有 OPS_RUNTIME_IMAGE"
else
  OPS_RUNTIME_IMAGE="$RUNTIME_IMAGE_ARG"
fi
export OPS_RUNTIME_IMAGE   # compose 的 ${OPS_RUNTIME_IMAGE:?} 只看 shell 環境（本腳本不走 --env-file，避免檔不存在就炸）
case "$OPS_RUNTIME_IMAGE" in
  *"@sha256:"[0-9a-f]*) ;;
  *) fail "OPS_RUNTIME_IMAGE 必須釘 digest（收到的是形如 '$OPS_RUNTIME_IMAGE'；:latest 一律拒絕）" ;;
esac
log "runtime image = ${OPS_RUNTIME_IMAGE%@sha256:*}@sha256:$(printf %s "${OPS_RUNTIME_IMAGE#*@sha256:}" | cut -c1-12)…"

# --- 前置檢查：token 檔要用掛檔，不能缺（缺了就不该把 OPS 的對外入口一起拆掉）------------
TOKEN_FILE="$SECRET_DIR/ops-tunnel-token"
SKIP_TUNNEL=0
if [ ! -s "$TOKEN_FILE" ]; then
  log "! 找不到 $TOKEN_FILE（0 字节或不存在）→ 這輪只重建 5151-ops，不動 tunnel 服務"
  SKIP_TUNNEL=1
else
  chmod 600 "$TOKEN_FILE" || true
fi

# --- 收 tar（stdin）→ incoming → 驗證 → 才落到 releases/<SHA> ----------------------------
rm -rf "$INCOMING"; mkdir -p "$INCOMING" "$RELEASES"
tar -x -C "$INCOMING" || fail "解 tar 失敗"
[ -d "$INCOMING/ops/src" ] || fail "tar 內缺少 ops/src（git archive 要帶 ops 這個路徑）"
[ -f "$INCOMING/docker-compose.ops.casaos.yml" ] || fail "tar 內缺少 docker-compose.ops.casaos.yml"
# 上線前防呆：canonical compose 不准出現 :latest 的 ops 映像、不准把 token 寫進 argv
grep -q 'OPS_RUNTIME_IMAGE:?' "$INCOMING/docker-compose.ops.casaos.yml" || fail "compose 檔形狀不符（映像未由 env 釘 digest）"
if grep -qE '^\s*command:.*--token' "$INCOMING/docker-compose.ops.casaos.yml"; then
  fail "compose 檔把 tunnel token 寫進 command line，拒絕上線"
fi
NJS=$(find "$INCOMING/ops" -name '*.js' | wc -l)
log "來源就绪：ops js 檔 $NJS 個"

if [ -d "$RELEASES/$DEPLOY_SHA" ]; then
  log "releases/$DEPLOY_SHA 已存在 → 內容以本次為準（先備份再整份取代）"
  mv "$RELEASES/$DEPLOY_SHA" "$RELEASES/$DEPLOY_SHA.replaced-$(date -u +%Y%m%d%H%M%S)"
fi
mv "$INCOMING" "$RELEASES/$DEPLOY_SHA"
printf '%s\n' "$OPS_RUNTIME_IMAGE" > "$RELEASES/$DEPLOY_SHA/.runtime-image"
printf '%s\n' "$(date -u +%FT%TZ)" > "$RELEASES/$DEPLOY_SHA/.deployed-at"

# --- 切換 current（原子：tmp symlink + mv），並記下前一版供 rollback ----------------------
PREV_SHA=""
[ -L "$CURRENT" ] && PREV_SHA="$(basename "$(readlink -f "$CURRENT")")"
FLIPPED=0
flip() { ln -sfn "$RELEASES/$1" "$CURRENT.tmp" && mv -T "$CURRENT.tmp" "$CURRENT"; }
rollback() {
  rc=$?
  trap - EXIT
  if [ "$FLIPPED" = 1 ] && [ -n "$PREV_SHA" ] && [ -d "$RELEASES/$PREV_SHA" ]; then
    log "復原：current 切回 $PREV_SHA 並重建容器"
    flip "$PREV_SHA" || true
    ( cd "$RELEASES/$PREV_SHA" && OPS_RUNTIME_IMAGE="$OPS_RUNTIME_IMAGE" \
        docker compose -p "$COMPOSE_PROJECT" -f docker-compose.ops.casaos.yml up -d 2>&1 | tail -2 ) || true
  fi
  log "退出碼 $rc（未留下半成品：current=$(basename "$(readlink -f "$CURRENT" 2>/dev/null || echo none)")）"
  if [ -z "$PREV_SHA" ] && ! docker inspect 5151-ops >/dev/null 2>&1; then
    log "! 這是第一次搬 project：沒有前版可自动回滚，而且 5151-ops 目前不存在。"
    log "! 手工回生（用吉比 project 的舊定義，資料與代碼都還在原位）："
    log "!   cd /mnt/Storage1/apps/5151 && docker compose up -d 5151-ops"
  fi
  exit $rc
}
trap rollback EXIT

# --- 先解析驗證，才准摘容器 ---------------------------------------------------------------
# 2026-10-07 實測教訓：compose 的 YAML 錯誤（`${VAR:?msg}` 的 msg 含「冒號＋空格」）是在
# `docker rm -f 5151-ops` 之後才爆，等於当场把 OPS 停住。解析放前面，壞檔就根本不會動到現有容器。
docker compose -p "$COMPOSE_PROJECT" -f "$RELEASES/$DEPLOY_SHA/docker-compose.ops.casaos.yml" config -q >/dev/null 2>&1 \
  || fail "新 compose 檔解析失敗 → 中止，**尚未摘除任何容器**，目前 OPS 仍舊在跑"
log "compose config -q 通過 ✔（还没动现有容器）"

# --- 舊容器若是吉比 project（591-tracker）建的，先摘掉同名容器 ---------------------------
if docker inspect 5151-ops >/dev/null 2>&1; then
  OLDPROJ=$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' 5151-ops 2>/dev/null || echo "")
  if [ "$OLDPROJ" != "$COMPOSE_PROJECT" ]; then
    log "目前 5151-ops 屬於 project='$OLDPROJ' → 改為獨立 project '$COMPOSE_PROJECT'（資料在宿主 /DATA，不受影響）"
    docker rm -f 5151-ops >/dev/null || fail "移不了舊 5151-ops 容器"
  fi
fi

log "切換 current: ${PREV_SHA:-（尚無）} → $DEPLOY_SHA"
flip "$DEPLOY_SHA"; FLIPPED=1
printf '%s\n' "$OPS_RUNTIME_IMAGE" > "$ENV_FILE.tmp"
[ -f "$ENV_FILE" ] && grep -vE '^OPS_RUNTIME_IMAGE=' "$ENV_FILE" >> "$ENV_FILE.tmp" || true
mv "$ENV_FILE.tmp" "$ENV_FILE"; chmod 600 "$ENV_FILE" || true

# --- 起容器（只起需要的服務）------------------------------------------------------------
COMPOSE_ARGS=(-p "$COMPOSE_PROJECT" -f "$CURRENT/docker-compose.ops.casaos.yml")
if [ "$SKIP_TUNNEL" = 1 ]; then
  docker compose "${COMPOSE_ARGS[@]}" up -d 5151-ops 2>&1 | tail -3 || fail "5151-ops 起失敗"
else
  docker compose "${COMPOSE_ARGS[@]}" up -d 2>&1 | tail -4 || fail "起容器失敗"
fi

# --- 健康檢查（照 L-0131：不要用 curl -f，也不用 `|| echo 000` 造成 000000）-------------
sleep 3
code=""
for _ in 1 2 3 4 5 6; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 "$HEALTH_URL" 2>/dev/null || true)
  [ -n "$code" ] && [ "$code" != "000" ] && break
  sleep 2
done
[ "$code" = "200" ] || fail "$HEALTH_URL 回 '$code'（預期 200）"
log "console.html = $code ✔"

# 未登入時受保護端點必須是 401（不是 200、不是 500）
api_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 http://127.0.0.1:5154/ops/api/feedback 2>/dev/null || true)
[ "$api_code" = "401" ] || fail "/ops/api/feedback 回 '$api_code'（預期 401）"
log "受保護端點 = $api_code ✔"

if [ "$SKIP_TUNNEL" = 0 ]; then
  up=$(docker inspect -f '{{.State.Status}}' 5151-ops-cloudflared 2>/dev/null || echo absent)
  [ "$up" = "running" ] || fail "5151-ops-cloudflared 狀態=$up"
  log "ops tunnel 容器 running ✔"
fi

# --- 驗明真的在跑這版碼 ---------------------------------------------------------------
digest_in=$(docker exec 5151-ops md5sum /app/ops/src/server.js 2>/dev/null | cut -c1-32 || echo "")
host_in=$(md5sum "$CURRENT/ops/src/server.js" 2>/dev/null | cut -c1-32 || echo "")
[ -n "$digest_in" ] && [ "$digest_in" = "$host_in" ] || fail "容器內 /app/ops/src/server.js 與 releases/$DEPLOY_SHA 不一致"
log "容器內程式碼 = releases/$DEPLOY_SHA ✔"

if [ -n "$PREV_SHA" ] && [ "$PREV_SHA" != "$DEPLOY_SHA" ]; then
  printf '%s\n' "$PREV_SHA" > "$APP_ROOT/.previous-sha"
  log "rollback 錨點已記：$APP_ROOT/.previous-sha = $PREV_SHA"
  log "  （回滚：bash $0 $PREV_SHA -）"
fi
printf 'DEPLOY_SHA=%s\nRUNTIME_IMAGE=%s\nHEALTH=%s\n' "$DEPLOY_SHA" "$OPS_RUNTIME_IMAGE" "$code" > "$APP_ROOT/.last-deploy"
trap - EXIT
log "完成：OPS 現行 = $DEPLOY_SHA（runtime 釘 digest；資料與 tunnel token 均未進 git）"
