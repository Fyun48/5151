# 節點唯讀採證（PR-A；供無法登入的節點，例如 web-B 由既有管理者執行）。
#
# 原則（依 ChatGPT 指令文件 §7）：
#  - 只輸出白名單欄位：角色、image revision／repo digest、重啟時間、DB_DRIVER、
#    去敏的 PG host:port/database、runtime 檔案 hash、SQLite 路徑／大小／mtime、PG 健康摘要。
#  - 不輸出完整 docker inspect、完整 env、auth.env、VAPID、連線字串或任何密碼。
#  - 純讀取；不安裝、不改設定、不啟動服務。
#
# 用法（在該節點上，具 docker 權限的帳號）：
#   bash v3/scripts/node-readonly-evidence.sh > evidence-<node>.json
set -u
emit() { printf '  "%s": %s' "$1" "$2"; }

CONTAINER="${EVIDENCE_CONTAINER:-591-tracker-v3}"
HOST_LABEL="${EVIDENCE_LABEL:-$(hostname)}"

echo "{"
emit "host" "\"$HOST_LABEL\""; echo ","
if ! command -v docker >/dev/null 2>&1; then
  emit "docker" '{"available": false}'; echo "; "
  emit "note" '"此節點沒有 docker 權限；請改用有權限的帳號重跑本腳本"'; echo ""
  echo "}"
  exit 0
fi

CONT_ID="$(docker ps -q -f "name=^/${CONTAINER}$" 2>/dev/null | head -1)"
emit "containerFound" "$([ -n "$CONT_ID" ] && echo true || echo false)"; echo ","
emit "container" "$(printf '{"name":"%s","id":"%s"}' "$CONTAINER" "${CONT_ID:0:12}")"; echo ","

if [ -n "$CONT_ID" ]; then
  emit "revision" "\"$(docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$CONT_ID" 2>/dev/null)\""; echo ","
  emit "imageDigest" "\"$(docker image inspect -f '{{ join .RepoDigests \",\" }}' "$(docker inspect -f '{{ .Image }}' "$CONT_ID" 2>/dev/null)" 2>/dev/null | head -c 160)\""; echo ","
  emit "startedAt" "\"$(docker inspect -f '{{ .State.StartedAt }}' "$CONT_ID" 2>/dev/null)\""; echo ","
  emit "restartCount" "$(docker inspect -f '{{ .RestartCount }}' "$CONT_ID" 2>/dev/null)"; echo ","
  emit "dbDriver" "\"$(docker exec "$CONT_ID" printenv DB_DRIVER 2>/dev/null)\""; echo ","
  # 只取 PG_URL 的 host / port / database，不含帳密
  PG_SAFE="$(docker exec "$CONT_ID" printenv PG_URL 2>/dev/null | sed -E 's#^[a-z]+://[^@]*@##')"
  emit "pgTarget" "\"$PG_SAFE\""; echo ","
  emit "runtimeHashes" "$(docker exec "$CONT_ID" sha256sum /app/src/db.js /app/src/server.js /app/src/watcher.js /app/src/listingSearchAsync.js /app/public/index.html 2>/dev/null | awk '{printf "%s{\"file\":\"%s\",\"sha256\":\"%s\"}", (NR>1?",":""), $2, $1}')"; echo ","
  emit "sqliteDb" "$(docker exec "$CONT_ID" sh -c 'if [ -e /data/v3.db ]; then printf "{\"bytes\":%s,\"mtime\":\"%s\"}" "$(stat -c %s /data/v3.db)" "$(stat -c %y /data/v3.db)"; else echo null; fi' 2>/dev/null)"; echo ","
  emit "sqliteWal" "$(docker exec "$CONT_ID" sh -c 'if [ -e /data/v3.db-wal ]; then printf "{\"bytes\":%s,\"mtime\":\"%s\"}" "$(stat -c %s /data/v3.db-wal)" "$(stat -c %y /data/v3.db-wal)"; else echo null; fi' 2>/dev/null)"; echo ","
  emit "dataMount" "\"$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$CONT_ID" 2>/dev/null)\""; echo ","
  emit "health" "\"$(docker exec "$CONT_ID" node -e 'fetch("http://127.0.0.1:5153/api/health").then(r=>r.text()).then(t=>console.log(t.slice(0,100))).catch(e=>console.log("ERR "+e.message))' 2>/dev/null | tr -d '\n')\""; echo ""
else
  # 找不到容器時仍輸出合法 JSON（先前版本會多一個逗號而無法解析）
  emit "revision" 'null'; echo ","
  emit "note" '"找不到指定容器（可用 EVIDENCE_CONTAINER 指定名稱，例如 5151-web-B）"'; echo ""
fi
echo "}"
