#!/bin/sh
# 由 haproxy.cfg template 產生實際設定後啟動 HAProxy。
#
# 為什麼需要這一層：docker compose 只會替換 compose YAML 內的 ${...}，
# **不會**替換「掛載檔案」的內容。把含 ${CASAOS_HOST} 的檔案直接掛進去，
# HAProxy 會把 ${CASAOS_HOST} 當成主機名去解析而失敗（所有 backend 變 DOWN）。
set -eu

: "${CASAOS_HOST:?set CASAOS_HOST (CasaOS LAN IP)}"
: "${SYNOLOGY_HOST:?set SYNOLOGY_HOST (Synology LAN IP)}"

TMPL=/usr/local/etc/haproxy/haproxy.cfg.tmpl
OUT=/tmp/haproxy.cfg

sed -e "s|\${CASAOS_HOST}|${CASAOS_HOST}|g" \
    -e "s|\${SYNOLOGY_HOST}|${SYNOLOGY_HOST}|g" \
    "$TMPL" > "$OUT"

# 沒展開完就別啟動：留著 ${...} 會讓 haproxy 解析失敗或 backend 全 DOWN。
# 只看非註解行——註解裡出現 ${...} 是說明文字，不是未展開的變數。
if grep -v '^[[:space:]]*#' "$OUT" | grep -q '\${'; then
  echo "haproxy template has unexpanded placeholders:" >&2
  grep -v '^[[:space:]]*#' "$OUT" | grep -n '\${' >&2
  exit 1
fi

# -W（master-worker）+ -db（前景）：容器內必須留在前景，否則 PID 1 結束就被判定停止。
exec haproxy -W -db -f "$OUT"