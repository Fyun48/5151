#!/usr/bin/env bash
# smoke 拓撲診斷（在 NAS 上跑）：證明「job 容器看不到 host 發佈的埠」與「同網路用容器名可以」。
#
# 為什麼要有這支：build workflow 的 smoke 步驟連紅多次（run 30/35/37/51/54…），一直被誤判成
# 「NAS 啟動慢、等待窗不夠」。2026-09-20 用這支實測才定位真因（run 57/#54 的 log 是 150 次
# `Failed to connect to 127.0.0.1 port 32771`）：
#   1. app 在 NAS 上 **4–5 秒**就 ready（`docker logs` 顯示它早就 listen 了）→ 不是啟動慢；
#   2. `-p 127.0.0.1::5153` 只綁 host loopback → 從 bridge 連 `127.0.0.1:<host_port>`（那是它自己）
#      或 gateway IP 都**不通**；
#   3. 把 smoke 容器放進 job 容器**同一個網路**、用**容器名**連（不發佈任何埠）→ 5 秒 ready，
#      `/api/health`、`/`、`/login.html` 全部 200，`docker exec` 照常。
# → 所以 workflow 改成「完全不發佈 host port + `--network` + 容器名」，順帶解掉撞 `5151-web-B` 的固定埠。
#
# 用法（NAS）：
#   bash smoke-topology-diag.sh <image:tag> [network]
#   例：bash smoke-topology-diag.sh ghcr.io/fyun48/5151:10817d6c40d8846f27b4d43b7fe63f6fc49bcb0b
set -uo pipefail

DOCKER="${DOCKER:-/usr/local/bin/docker}"
IMG="${1:?usage: smoke-topology-diag.sh <image:tag> [network]}"
NET="${2:-5151-gitea_default}"
NAME="smoke-diag-$$"

cleanup() { "${DOCKER}" rm -f -v "${NAME}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "=== job 容器的網路（runner 設定值）==="
"${DOCKER}" network ls | grep -iE "gitea" || true
GW="$("${DOCKER}" network inspect "${NET}" --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || echo none)"
echo "network=${NET} gateway=${GW}"

echo
echo "=== [A] 照 CI 舊做法：-p 127.0.0.1::5153，從 host 量測啟動時間 ==="
"${DOCKER}" rm -f "${NAME}" >/dev/null 2>&1
T0="$(date +%s)"
"${DOCKER}" run -d --name "${NAME}" --platform linux/amd64 \
  -e HOST=0.0.0.0 -e PORT=5153 -e DATA_DIR=/data -e OPS_FEEDBACK_DELIVERY=0 \
  -e PUBLIC_BASE_URL=http://127.0.0.1:5153 \
  -e AUTH_EMAIL=predeploy-smoke@example.com -e AUTH_PASSWORD=predeploy-smoke-not-production \
  -p 127.0.0.1::5153 "${IMG}" node src/server.js >/dev/null
HP="$("${DOCKER}" port "${NAME}" 5153/tcp | head -1 | awk -F: '{print $NF}')"
echo "host_port=${HP}"
READY=never
for i in $(seq 1 240); do
  if curl -fsS "http://127.0.0.1:${HP}/api/health" 2>/dev/null | grep -q '"ok":true'; then
    READY=$(( $(date +%s) - T0 )); break
  fi
  sleep 1
done
echo "HOST_READY_AFTER=${READY}s"
echo "-- 從 sibling container（模擬 job 容器）測 127.0.0.1:<host_port> → 預期不通 --"
"${DOCKER}" run --rm --platform linux/amd64 --network "${NET}" "${IMG}" node -e \
  "fetch('http://127.0.0.1:${HP}/api/health').then(r=>r.text()).then(t=>console.log('SIBLING_127_OK',t)).catch(e=>console.log('SIBLING_127_FAIL',e.message))" 2>&1 | tail -1
"${DOCKER}" rm -f "${NAME}" >/dev/null 2>&1

echo
echo "=== [B] 新做法：同一個網路、不發佈任何埠、用容器名 ==="
T0="$(date +%s)"
"${DOCKER}" run -d --name "${NAME}" --network "${NET}" --platform linux/amd64 \
  -e HOST=0.0.0.0 -e PORT=5153 -e DATA_DIR=/data -e OPS_FEEDBACK_DELIVERY=0 \
  -e PUBLIC_BASE_URL="http://${NAME}:5153" \
  -e AUTH_EMAIL=predeploy-smoke@example.com -e AUTH_PASSWORD=predeploy-smoke-not-production \
  "${IMG}" node src/server.js >/dev/null
READY=never
for i in $(seq 1 60); do
  if "${DOCKER}" run --rm --network "${NET}" --platform linux/amd64 "${IMG}" node -e \
      "fetch('http://${NAME}:5153/api/health').then(r=>r.text()).then(t=>{console.log(t);process.exit(t.includes('\"ok\":true')?0:1)}).catch(e=>{console.log('FAIL',e.message);process.exit(1)})" 2>&1 | tail -1 | grep -q '"ok":true'; then
    READY=$(( $(date +%s) - T0 )); break
  fi
  sleep 1
done
echo "SIBLING_BY_NAME_READY_AFTER=${READY}s"
"${DOCKER}" run --rm --network "${NET}" --platform linux/amd64 "${IMG}" node -e "
const base='http://${NAME}:5153';
(async()=>{ for (const p of ['/api/health','/','/login.html']) { const r=await fetch(base+p); console.log(p, r.status, (await r.text()).length); } })().catch(e=>{console.log('ERR',e.message);process.exit(1)})" 2>&1 | tail -3
echo "-- docker exec 仍可用（sharp）--"
"${DOCKER}" exec "${NAME}" node -e 'import("sharp").then(()=>console.log("SHARP_OK"))' 2>&1 | tail -1
"${DOCKER}" inspect -f 'networks={{range $k,$v := .NetworkSettings.Networks}}{{$k}}={{.IPAddress}} {{end}}' "${NAME}"
echo "diag_done"
