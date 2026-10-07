#!/usr/bin/env bash
# 抓取沙盒的「一次性建置」腳本（2026-09-30，第九十四批）。
#
# 設計：
#   * **沙盒容器跑在 casa-nas**（192.168.0.140）——與正式站同一台、同一個出口 IP，
#     這樣「來源對我們的量／IP 的反應」才測得準。
#   * **資料庫在隔離的 repro PG 實例**（syn-nas 192.168.0.220:15434）的獨立資料庫
#     `crawl_sandbox`——與 live 測試用的 `repro` 分開，跑壞了也不影響別人。
#   * 這支腳本在**開發機（cline-dev）**跑：secrets 在這裡、也能連到 repro PG。
#
# 可重跑（idempotent）。用法：
#   bash v3/scripts/crawl-sandbox-setup.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SANDBOX_HOST="${SANDBOX_HOST:-casa-nas}"
SANDBOX_DIR="${SANDBOX_DIR:-/mnt/Storage1/apps/5151-sandbox}"
SANDBOX_DATA="${SANDBOX_DATA:-/mnt/Storage1/docker_data/5151-crawl-sandbox}"
SANDBOX_DB="${SANDBOX_DB:-crawl_sandbox}"
SECRETS_FILE="${SECRETS_FILE:-/home/cline/.secrets/postgres/5151-crawl-sandbox.env}"
REPRO_ENV="${REPRO_ENV:-/home/cline/.secrets/postgres/5151-live-repro.env}"
#   ⚠️ **那台 repro PG（還有旁邊的 prb-repro-haproxy）是 2026-09-27 的 `docker run` 手工孤兒，不是殘留垃圾**：
#     · 沙盒與 `v3/test/*-live-pg.test.js` 連的就是 `192.168.0.220:15434`，**刪掉 = 沙盒與 live-PG 測試全部失效**。
#     · 現況 `restart=no` ⇒ Synology 一重機這兩台不會自己回來（届时沙盒會连不上，先 docker start 即可）。
#     · `prb-repro-haproxy` 的設定檔原本**只存在容器內**（用 docker cp 塞進去、沒有掛載）；2026-10-07 已救出副本，
#       兩台的可重建來源（含既有 volume 的 external 指名）在 syn：
#       `/var/services/homes/tori/rebuild/prb-repro-{pg,haproxy}/docker-compose.yml`（只補來源，**未重建**）。
#     · 記錄全文見 `/home/cline/INFRA-INVENTORY.md`「孤兒容器的可重建來源」與「續二十一」。

[ -f "$SECRETS_FILE" ] || { echo "缺少 $SECRETS_FILE（沙盒的 PG 連線字串，見 .secrets/INDEX.md）" >&2; exit 1; }
[ -f "$REPRO_ENV" ] || { echo "缺少 $REPRO_ENV（建立沙盒庫需要隔離 PG 的管理連線）" >&2; exit 1; }
set -a; . "$SECRETS_FILE"; set +a
set -a; . "$REPRO_ENV"; set +a
: "${SANDBOX_PG_URL:?$SECRETS_FILE 必須有 SANDBOX_PG_URL}"

echo "[1/4] 建立資料庫 $SANDBOX_DB（隔離 PG；已存在就跳過）"
ADMIN_URL="${PG_LIVE_REPRO_URL%/*}/postgres" SANDBOX_DB="$SANDBOX_DB" node --input-type=module -e '
import { Client } from "pg";
const admin = new Client({ connectionString: process.env.ADMIN_URL, application_name: "crawl-sandbox-setup" });
await admin.connect();
const db = process.env.SANDBOX_DB;
const found = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [db]);
if (found.rowCount) console.log("      已存在");
else { await admin.query(`CREATE DATABASE "${db}"`); console.log("      已建立"); }
await admin.end();
'

echo "[2/4] 鏡射 schema 與可重現的列（pg-integration-setup.mjs）"
DATA_DIR="$(mktemp -d)" PG_URL="$SANDBOX_PG_URL" node "$REPO_ROOT/v3/scripts/pg-integration-setup.mjs" >/tmp/crawl-sandbox-schema.json
python3 -c 'import json;d=json.load(open("/tmp/crawl-sandbox-schema.json"));print("      tables=%s rows=%s sequences=%s" % (d.get("tables"), d.get("rows"), d.get("sequences")))' 2>/dev/null || head -2 /tmp/crawl-sandbox-schema.json

echo "[3/4] 準備沙盒目錄 $SANDBOX_HOST:$SANDBOX_DIR"
ssh "$SANDBOX_HOST" "mkdir -p '$SANDBOX_DIR/v3/src' '$SANDBOX_DIR/v3/scripts' '$SANDBOX_DATA' && chmod 700 '$SANDBOX_DATA'"
scp -q "$REPO_ROOT/docker-compose.crawl-sandbox.yml" "$SANDBOX_HOST:$SANDBOX_DIR/docker-compose.crawl-sandbox.yml"
PROD_IMAGE="$(ssh "$SANDBOX_HOST" "docker inspect -f '{{.Config.Image}}' 591-tracker-v3 2>/dev/null || true")"
ssh "$SANDBOX_HOST" "umask 077 && printf 'PG_URL=%s\nV3_IMAGE=%s\n' '$SANDBOX_PG_URL' '${PROD_IMAGE:-ghcr.io/fyun48/5151:latest}' > '$SANDBOX_DIR/.env' && chmod 600 '$SANDBOX_DIR/.env' && echo \"      V3_IMAGE=${PROD_IMAGE:-（fallback :latest）}\""

echo "[4/4] 同步程式碼並起容器"
bash "$REPO_ROOT/v3/scripts/crawl-sandbox-sync.sh"
echo "報告檔：$SANDBOX_HOST:$SANDBOX_DATA/crawl-sandbox.jsonl"
echo "看日誌：ssh $SANDBOX_HOST \"docker logs --tail 20 5151-crawl-sandbox\""
