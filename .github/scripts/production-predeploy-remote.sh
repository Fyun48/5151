#!/usr/bin/env bash
# Runs on CasaOS/NAS via SSH. Inspection + backup only. No deploy, no compose up, no image pull.
set -euo pipefail

CONTAINER="${CONTAINER:-591-tracker-v3}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
EVIDENCE="/tmp/predeploy-evidence-${STAMP}.json"
WORKDIR="/tmp/predeploy-work-${STAMP}"
mkdir -p "$WORKDIR"

fail() {
  echo "::error::$1"
  echo "PREDEPLOY_FAIL: $1"
  exit 1
}

echo "=== discover container ==="
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  fail "v3 container '$CONTAINER' is missing"
fi

STATE="$(docker inspect -f '{{.State.Status}}' "$CONTAINER")"
echo "container_state=$STATE"

mapfile -t DATA_MOUNTS < <(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{"\n"}}{{end}}{{end}}' "$CONTAINER" | sed '/^$/d')
if [ "${#DATA_MOUNTS[@]}" -eq 0 ]; then
  fail "no host mount for container destination /data"
fi
if [ "${#DATA_MOUNTS[@]}" -gt 1 ]; then
  fail "multiple ambiguous /data mounts: ${DATA_MOUNTS[*]}"
fi
DATA_HOST="${DATA_MOUNTS[0]}"
[ -n "$DATA_HOST" ] || fail "empty /data source path"
[ -f "$DATA_HOST/v3.db" ] || fail "v3.db is absent at $DATA_HOST/v3.db"

echo "discovered_data_host=$DATA_HOST"

IMAGE_REF="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"
IMAGE_ID="$(docker inspect -f '{{.Image}}' "$CONTAINER")"
[ -n "$IMAGE_ID" ] || fail "container image id is empty"
if ! docker image inspect "$IMAGE_ID" >/dev/null 2>&1; then
  fail "docker image inspect failed for resolved image id (fail-closed; not fabricating a digest)"
fi
REPO_DIGESTS="$(docker image inspect -f '{{range .RepoDigests}}{{.}} {{end}}' "$IMAGE_ID")"
ARCH="$(docker image inspect -f '{{.Architecture}}/{{.Os}}' "$IMAGE_ID")"
[ -n "$ARCH" ] && [ "$ARCH" != "/" ] || fail "docker image inspect returned empty Architecture/Os"
NODE_VER="$(docker exec "$CONTAINER" node -p "process.version")"

echo "image_ref=$IMAGE_REF"
echo "image_id=$IMAGE_ID"
echo "repo_digests=${REPO_DIGESTS:-none}"
echo "architecture=$ARCH"
echo "container_node=$NODE_VER"

echo "=== current sharp (read-only, no install) ==="
SHARP_STATUS="SHARP_MISSING"
if docker exec "$CONTAINER" node -e "import('sharp').then(()=>console.log('SHARP_OK')).catch(()=>{console.error('SHARP_MISSING'); process.exit(1)})"; then
  SHARP_STATUS="SHARP_OK"
else
  SHARP_STATUS="SHARP_MISSING"
  echo "SHARP_MISSING"
fi

echo "=== wish room read-only ==="
INSPECT_SRC="${INSPECT_SCRIPT:-}"
if [ -z "$INSPECT_SRC" ] || [ ! -f "$INSPECT_SRC" ]; then
  fail "sqlite-readonly-inspect.mjs not provided on NAS"
fi
docker cp "$INSPECT_SRC" "$CONTAINER:/tmp/sqlite-readonly-inspect.mjs"
set +e
DEMAND_JSON="$(docker exec "$CONTAINER" node /tmp/sqlite-readonly-inspect.mjs /data/v3.db demand 2>"$WORKDIR/demand.err")"
DEMAND_RC=$?
set -e
docker exec "$CONTAINER" rm -f /tmp/sqlite-readonly-inspect.mjs
if [ "$DEMAND_RC" -ne 0 ]; then
  echo "demand inspect stderr (no secrets expected):"
  cat "$WORKDIR/demand.err" || true
  fail "read-only demand_posts inspect failed (fail-closed)"
fi
echo "$DEMAND_JSON" > "$WORKDIR/demand.json"
echo "$DEMAND_JSON"

echo "=== capability detect SQLite online backup ==="
BACKUP_METHOD=""
BACKUP_HELPER="${BACKUP_SCRIPT:-}"
BACKUP_PY="${BACKUP_PY_SCRIPT:-}"
[ -n "$BACKUP_HELPER" ] && [ -f "$BACKUP_HELPER" ] && docker cp "$BACKUP_HELPER" "$CONTAINER:/tmp/sqlite-online-backup.mjs"

set +e
API_CHECK="$(docker exec "$CONTAINER" node --input-type=module -e 'import * as s from "node:sqlite"; console.log(typeof s.backup)' 2>/dev/null || true)"
SQLITE3_BIN="$(command -v sqlite3 || true)"
IN_CONTAINER_SQLITE3="$(docker exec "$CONTAINER" sh -c 'command -v sqlite3 || true')"
HOST_PYTHON="$(command -v python3 || true)"
HOST_NODE_SQLITE=""
if command -v node >/dev/null 2>&1; then
  HOST_NODE_SQLITE="$(node --input-type=module -e 'import("node:sqlite").then(()=>process.stdout.write("yes")).catch(()=>process.exit(1))' 2>/dev/null || true)"
fi
set -e

echo "node_backup_typeof=$API_CHECK"
echo "host_python3=${HOST_PYTHON:-none}"
echo "host_sqlite3=${SQLITE3_BIN:-none}"
echo "container_sqlite3=${IN_CONTAINER_SQLITE3:-none}"
echo "host_node_sqlite=${HOST_NODE_SQLITE:-no}"

PARENT="$(dirname "$DATA_HOST")"
BASE="$(basename "$DATA_HOST")"
BACKUP_ROOT="${PARENT}/${BASE}-backups"
BACKUP_DIR="${BACKUP_ROOT}/predeploy-${STAMP}"
mkdir -p "$BACKUP_DIR"
echo "backup_dir=$BACKUP_DIR"

copy_media() {
  local dest="$1/member-media"
  if [ -d "$DATA_HOST/member-media" ]; then
    mkdir -p "$dest"
    if command -v rsync >/dev/null 2>&1; then
      rsync -a "$DATA_HOST/member-media/" "$dest/"
    else
      cp -a "$DATA_HOST/member-media/." "$dest/"
    fi
  fi
}

echo "=== media pass 1 ==="
copy_media "$BACKUP_DIR"

echo "=== sqlite online backup (must not raw-cp live db) ==="
DEST_DB="$BACKUP_DIR/v3.db"
if [ "$API_CHECK" = "function" ]; then
  docker exec "$CONTAINER" rm -f /tmp/v3-predeploy-backup.db
  docker exec "$CONTAINER" node /tmp/sqlite-online-backup.mjs /data/v3.db /tmp/v3-predeploy-backup.db
  docker cp "$CONTAINER:/tmp/v3-predeploy-backup.db" "$DEST_DB"
  docker exec "$CONTAINER" rm -f /tmp/v3-predeploy-backup.db
  BACKUP_METHOD="node:sqlite backup()"
elif [ -n "$HOST_PYTHON" ] && [ -n "$BACKUP_PY" ] && [ -f "$BACKUP_PY" ]; then
  python3 "$BACKUP_PY" "$DATA_HOST/v3.db" "$DEST_DB"
  BACKUP_METHOD="python3 sqlite3.Connection.backup"
elif [ -n "$IN_CONTAINER_SQLITE3" ]; then
  docker exec "$CONTAINER" rm -f /tmp/v3-predeploy-backup.db
  docker exec "$CONTAINER" sqlite3 /data/v3.db ".backup /tmp/v3-predeploy-backup.db"
  docker cp "$CONTAINER:/tmp/v3-predeploy-backup.db" "$DEST_DB"
  docker exec "$CONTAINER" rm -f /tmp/v3-predeploy-backup.db
  BACKUP_METHOD="sqlite3 .backup (container)"
elif [ -n "$SQLITE3_BIN" ]; then
  sqlite3 "$DATA_HOST/v3.db" ".backup '$DEST_DB'"
  BACKUP_METHOD="sqlite3 .backup (host)"
else
  docker exec "$CONTAINER" rm -f /tmp/sqlite-online-backup.mjs || true
  fail "no safe SQLite online backup capability (node:sqlite backup(), python3 Connection.backup, and sqlite3 .backup unavailable); refusing live raw cp"
fi
docker exec "$CONTAINER" rm -f /tmp/sqlite-online-backup.mjs || true

echo "backup_method=$BACKUP_METHOD"

echo "=== media pass 2 ==="
copy_media "$BACKUP_DIR"

echo "=== copy other persistent files (secrets stay NAS-local, never printed) ==="
SECRET_COPIED=0
shopt -s dotglob nullglob
for item in "$DATA_HOST"/*; do
  name="$(basename "$item")"
  case "$name" in
    v3.db|v3.db-wal|v3.db-shm|member-media) continue ;;
    auth.env|session.secret|*.secret|*.pem|*.key)
      cp -a "$item" "$BACKUP_DIR/$name"
      SECRET_COPIED=1
      echo "copied_secret_filename=$name"
      ;;
    *)
      cp -a "$item" "$BACKUP_DIR/$name"
      echo "copied_persistent=$name"
      ;;
  esac
done
shopt -u dotglob nullglob

echo "=== verify BACKUP db (not live db; not app db.js) ==="
[ -f "$DEST_DB" ] || fail "backup db missing"
BACKUP_SIZE="$(stat -c%s "$DEST_DB" 2>/dev/null || stat -f%z "$DEST_DB")"
[ "$BACKUP_SIZE" -gt 0 ] || fail "backup db size is zero"
ORIG_SIZE="$(stat -c%s "$DATA_HOST/v3.db" 2>/dev/null || stat -f%z "$DATA_HOST/v3.db")"
BACKUP_SHA="$(sha256sum "$DEST_DB" | awk '{print $1}')"

docker cp "$INSPECT_SRC" "$CONTAINER:/tmp/sqlite-readonly-inspect.mjs"
# Verify the backup without importing app db.js. Host Node is used only when node:sqlite is actually available.
if [ "$HOST_NODE_SQLITE" = "yes" ]; then
  INTEGRITY="$(node "$INSPECT_SRC" "$DEST_DB" integrity)"
elif [ -n "$HOST_PYTHON" ]; then
  INTEGRITY="$(python3 - "$DEST_DB" <<'PY'
import json, sqlite3, sys, urllib.parse
path = sys.argv[1]
uri = "file:" + urllib.parse.quote(path, safe="/") + "?mode=ro"
con = sqlite3.connect(uri, uri=True)
try:
    row = con.execute("PRAGMA integrity_check").fetchone()
    result = row[0] if row else None
finally:
    con.close()
print(json.dumps({"integrity_check": result, "ok": result == "ok"}))
PY
)"
else
  docker cp "$DEST_DB" "$CONTAINER:/tmp/v3-predeploy-backup-verify.db"
  INTEGRITY="$(docker exec "$CONTAINER" node /tmp/sqlite-readonly-inspect.mjs /tmp/v3-predeploy-backup-verify.db integrity)"
  docker exec "$CONTAINER" rm -f /tmp/v3-predeploy-backup-verify.db
fi
docker exec "$CONTAINER" rm -f /tmp/sqlite-readonly-inspect.mjs || true
echo "$INTEGRITY" > "$WORKDIR/integrity.json"
echo "$INTEGRITY"
echo "$INTEGRITY" | grep -q '"ok"' || fail "backup integrity_check is not ok"

count_files() {
  local dir="$1"
  if [ -d "$dir" ]; then
    find "$dir" -type f | wc -l
  else
    echo 0
  fi
}
bytes_dir() {
  local dir="$1"
  if [ -d "$dir" ]; then
    du -sb "$dir" | awk '{print $1}'
  else
    echo 0
  fi
}

SRC_MEDIA_COUNT="$(count_files "$DATA_HOST/member-media")"
SRC_MEDIA_BYTES="$(bytes_dir "$DATA_HOST/member-media")"
BK_MEDIA_COUNT="$(count_files "$BACKUP_DIR/member-media")"
BK_MEDIA_BYTES="$(bytes_dir "$BACKUP_DIR/member-media")"

MEDIA_MISMATCH="ok"
if [ "$SRC_MEDIA_COUNT" -gt "$BK_MEDIA_COUNT" ]; then
  MEDIA_MISMATCH="backup_missing_files"
fi

python3 - "$EVIDENCE" "$WORKDIR/demand.json" "$WORKDIR/integrity.json" \
  "$STAMP" "$CONTAINER" "$STATE" "$IMAGE_REF" "$IMAGE_ID" "$REPO_DIGESTS" "$ARCH" "$NODE_VER" \
  "$SHARP_STATUS" "$DATA_HOST" "$BACKUP_DIR" "$BACKUP_METHOD" "$ORIG_SIZE" "$BACKUP_SIZE" \
  "$BACKUP_SHA" "$SECRET_COPIED" "$SRC_MEDIA_COUNT" "$SRC_MEDIA_BYTES" "$BK_MEDIA_COUNT" \
  "$BK_MEDIA_BYTES" "$MEDIA_MISMATCH" <<'PY'
import json, sys
path, demand_path, integrity_path = sys.argv[1], sys.argv[2], sys.argv[3]
(
    stamp, container, state, image_ref, image_id, repo_digests, arch, node_ver,
    sharp, data_host, backup_dir, backup_method, orig_size, backup_size,
    backup_sha, secret_copied, src_mc, src_mb, bk_mc, bk_mb, media_mismatch,
) = sys.argv[4:]
demand = json.loads(open(demand_path).read())
integrity = json.loads(open(integrity_path).read())
doc = {
  "timestamp_utc": stamp,
  "container": container,
  "container_state": state,
  "image_ref": image_ref,
  "image_id": image_id,
  "repo_digests": repo_digests.strip(),
  "architecture": arch,
  "node": node_ver,
  "sharp": sharp,
  "production_data_path": data_host,
  "db_file": data_host + "/v3.db",
  "backup_dir": backup_dir,
  "backup_method": backup_method,
  "db_original_size": int(orig_size),
  "db_backup_size": int(backup_size),
  "backup_sha256": backup_sha,
  "integrity_check": integrity.get("integrity_check"),
  "secret_files_copied_to_nas_backup_only": bool(int(secret_copied)),
  "member_media_source_files": int(src_mc),
  "member_media_source_bytes": int(src_mb),
  "member_media_backup_files": int(bk_mc),
  "member_media_backup_bytes": int(bk_mb),
  "member_media_mismatch": media_mismatch,
  "wish_room": demand,
}
open(path, "w").write(json.dumps(doc, indent=2) + "\n")
print(json.dumps(doc, indent=2))
PY

echo "BEGIN_PREDEPLOY_EVIDENCE"
cat "$EVIDENCE"
echo "END_PREDEPLOY_EVIDENCE"
echo "PREDEPLOY_CHECK_OK"
