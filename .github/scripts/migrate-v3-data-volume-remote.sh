#!/usr/bin/env bash
# Move the live v3 data volume off the /DATA system volume onto the Storage1 pool.
#
# Run by .github/workflows/migrate-v3-data-volume.yml over SSH as a staged file
# (same pattern as production-predeploy-remote.sh) because drone-ssh's script_stop
# joins inline script lines with ';' and mangles '#' comments / multi-line blocks.
#
# Required env:
#   SOURCE_DIR     current live data dir (default /DATA/AppData/591-tracker-v3)
#   TARGET_DIR     Storage1 destination (default /mnt/Storage1/docker_data/591-tracker-v3)
#   STAGED_COMPOSE compose file staged from the workflow-definition checkout
# Optional env:
#   MODE  plan | apply   (default plan: verification only, no switch)
#   FORCE 1 to overwrite a non-empty target that differs from the source
set -euo pipefail

SOURCE_DIR="${SOURCE_DIR:-/DATA/AppData/591-tracker-v3}"
TARGET_DIR="${TARGET_DIR:-/mnt/Storage1/docker_data/591-tracker-v3}"
MODE="${MODE:-plan}"
APP_DIR=/mnt/Storage1/apps/5151
SERVICE=591-tracker-v3

case "$MODE" in plan|apply) ;; *) echo "MODE must be plan or apply (got '$MODE')"; exit 1 ;; esac
if [ "$SOURCE_DIR" = "$TARGET_DIR" ]; then echo "SOURCE_DIR and TARGET_DIR must differ"; exit 1; fi
if [ ! -d "$SOURCE_DIR" ]; then echo "source dir $SOURCE_DIR not found"; exit 1; fi
if [ ! -f "$SOURCE_DIR/v3.db" ]; then echo "source dir $SOURCE_DIR has no v3.db"; exit 1; fi
case "$TARGET_DIR" in /mnt/Storage1/*) ;; *) echo "TARGET_DIR must live on the Storage1 pool (got '$TARGET_DIR')"; exit 1 ;; esac

IMAGE_PIN="$(docker inspect -f '{{.Config.Image}}' "$SERVICE" 2>/dev/null || true)"
if [ -z "$IMAGE_PIN" ]; then echo "cannot resolve the running image; is $SERVICE up?"; exit 1; fi
echo "running_image=$IMAGE_PIN"

db_rows() {
  docker run --rm -v "$1":/data --entrypoint node "$IMAGE_PIN" -e '
    const { DatabaseSync } = require("node:sqlite");
    try {
      const db = new DatabaseSync("/data/v3.db", { readOnly: true });
      const one = (q) => db.prepare(q).get().n;
      process.stdout.write(JSON.stringify({
        listings: one("SELECT COUNT(*) AS n FROM listings"),
        wishes: one("SELECT COUNT(*) AS n FROM demand_posts"),
        users: one("SELECT COUNT(*) AS n FROM users"),
      }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ error: String(error.message || error) }));
    }
  '
}

sha_db() {
  if [ -f "$1/v3.db" ]; then sha256sum "$1/v3.db" | cut -d' ' -f1; else echo ""; fi
}

src_bytes="$(du -sk "$SOURCE_DIR" | cut -f1)"
target_parent="$(dirname "$TARGET_DIR")"
mkdir -p "$target_parent"
avail_kb="$(df -Pk "$target_parent" | awk 'NR==2 {print $4}')"
echo "source=$SOURCE_DIR bytes_kb=$src_bytes"
echo "target=$TARGET_DIR target_fs_avail_kb=$avail_kb"
if [ "$avail_kb" -lt $((src_bytes * 2)) ]; then
  echo "not enough free space on the target filesystem for a safe copy"
  exit 1
fi

src_sha="$(sha_db "$SOURCE_DIR")"
src_counts="$(db_rows "$SOURCE_DIR")"
echo "source_sha256=$src_sha"
echo "source_counts=$src_counts"
case "$src_counts" in *'"error"'*) echo "source database did not open read-only"; exit 1 ;; esac

if [ -d "$TARGET_DIR" ] && [ "$MODE" = "apply" ]; then
  tgt_counts_before="$(db_rows "$TARGET_DIR")"
  echo "target_counts_before=$tgt_counts_before"
  if [ -n "$(sha_db "$TARGET_DIR")" ] && [ "$(sha_db "$TARGET_DIR")" != "$src_sha" ] && [ "${FORCE:-0}" != "1" ]; then
    if printf '%s' "$tgt_counts_before" | grep -q '"listings":0,"wishes":0,"users":0'; then
      echo "target holds an empty database; it will be replaced by the source copy"
    else
      echo "target already holds a different non-empty database; confirm it is disposable before forcing"
      exit 1
    fi
  fi
fi

if [ "$MODE" = "plan" ]; then
  echo "MIGRATE_PLAN_OK source=$SOURCE_DIR target=$TARGET_DIR source_sha256=$src_sha source_counts=$src_counts"
  exit 0
fi

compose_backup="$APP_DIR/docker-compose.yml.bak.$(date +%Y%m%d%H%M%S)"
cp -f "$APP_DIR/docker-compose.yml" "$compose_backup"
echo "compose_backup=$compose_backup"

restore() {
  echo "restoring the previous compose and container"
  cp -f "$compose_backup" "$APP_DIR/docker-compose.yml" || true
  cd "$APP_DIR" || true
  docker compose -f docker-compose.yml -f docker-compose.override.yml up -d --no-build --no-deps --force-recreate "$SERVICE" || true
}
trap 'rc=$?; if [ "$rc" != 0 ]; then restore; fi' EXIT

echo "stopping $SERVICE"
docker stop "$SERVICE" >/dev/null

mkdir -p "$TARGET_DIR"
echo "copying data (the source directory is left in place as rollback)"
cp -a "$SOURCE_DIR"/. "$TARGET_DIR"/

tgt_sha="$(sha_db "$TARGET_DIR")"
echo "target_sha256=$tgt_sha"
if [ "$tgt_sha" != "$src_sha" ]; then echo "copied database hash does not match the source"; exit 1; fi
src_files="$(find "$SOURCE_DIR" -type f | wc -l | tr -d ' ')"
tgt_files="$(find "$TARGET_DIR" -type f | wc -l | tr -d ' ')"
echo "file_count source=$src_files target=$tgt_files"
if [ "$src_files" != "$tgt_files" ]; then echo "copied file count does not match the source"; exit 1; fi
tgt_counts="$(db_rows "$TARGET_DIR")"
echo "target_counts_after_copy=$tgt_counts"
if [ "$tgt_counts" != "$src_counts" ]; then echo "copied database row counts do not match the source"; exit 1; fi

cp -f "$STAGED_COMPOSE" "$APP_DIR/docker-compose.yml"
cd "$APP_DIR"
test -f docker-compose.override.yml
V3_CFG="$(docker compose -f docker-compose.yml -f docker-compose.override.yml config --format json)"
RENDERED="$(printf '%s' "$V3_CFG" | python3 -c 'import json,sys; d=json.load(sys.stdin)["services"]["591-tracker-v3"]; print([v["source"] for v in d["volumes"] if v["target"]=="/data"][0])')"
echo "rendered_data_mount=$RENDERED"
if [ "$RENDERED" != "$TARGET_DIR" ]; then echo "compose does not mount $TARGET_DIR at /data"; exit 1; fi

echo "recreating $SERVICE on the Storage1 data volume"
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d --no-build --no-deps --force-recreate "$SERVICE"

ok=0
for _ in $(seq 1 60); do if curl -fsS http://127.0.0.1:5153/api/health | grep -q '"ok":true'; then ok=1; break; fi; sleep 1; done
if [ "$ok" != 1 ]; then docker logs "$SERVICE" || true; echo "health did not become ready after the data move"; exit 1; fi
curl -fsS -o /dev/null http://127.0.0.1:5153/
curl -fsS -o /dev/null http://127.0.0.1:5153/login.html
curl -fsS -o /dev/null http://127.0.0.1:5155/api/health

LIVE_MOUNT="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$SERVICE")"
echo "live_data_mount=$LIVE_MOUNT"
if [ "$LIVE_MOUNT" != "$TARGET_DIR" ]; then echo "running container is not using the Storage1 data volume"; exit 1; fi
live_counts="$(db_rows "$TARGET_DIR")"
echo "live_counts=$live_counts"
if [ "$live_counts" != "$src_counts" ]; then echo "live database row counts do not match the pre-move source"; exit 1; fi

echo "rollback_hint=$compose_backup"
echo "MIGRATE_OK source=$SOURCE_DIR target=$TARGET_DIR source_sha256=$src_sha counts=$src_counts files=$src_files"
