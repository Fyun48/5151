#!/usr/bin/env bash
# Isolated query snapshot plus one Rakuya diagnostic. This is not a deployment.
set -euo pipefail
umask 077
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ $# == 5 ]] || fail 'Expected source SHA, application tree hash, account hash, helper payload, Rakuya flag'
expected_source=$1
expected_tree=$2
account_hash=$3
helper_payload=$4
include_rakuya=$5
[[ "$expected_source" =~ ^[0-9a-f]{40}$ ]] || fail 'Invalid source SHA'
[[ "$expected_tree" =~ ^[0-9a-f]{64}$ ]] || fail 'Invalid source tree hash'
[[ "$account_hash" =~ ^[0-9a-f]{64}$ ]] || fail 'Invalid account hash'
[[ "$helper_payload" =~ ^[A-Za-z0-9+/=]+$ ]] || fail 'Invalid helper payload'
[[ "$include_rakuya" == true || "$include_rakuya" == false ]] || fail 'Invalid Rakuya flag'
container=591-tracker-v3
[[ "$(docker inspect --format '{{.State.Status}}' "$container")" == running ]] || fail 'Production v3 is not running'
image_ref="$(docker inspect --format '{{.Config.Image}}' "$container")"
[[ "$image_ref" =~ ^ghcr\.io/fyun48/5151@sha256:[0-9a-f]{64}$ ]] || fail 'Production image is not digest-pinned'
image_id="$(docker inspect --format '{{.Image}}' "$container")"
revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")"
source="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.source"}}' "$image_id")"
[[ "$revision" == "$expected_source" ]] || fail 'Unexpected deployed revision'
[[ "$source" == https://github.com/Fyun48/5151 ]] || fail 'Unexpected image repository'

diagnostic_tmp="$(mktemp -d /tmp/v3-support.XXXXXXXX)"
test_container="v3-support-$(basename "$diagnostic_tmp")"
cleanup() {
  docker rm -f "$test_container" >/dev/null 2>&1 || true
  rm -rf -- "$diagnostic_tmp"
}
trap cleanup EXIT
printf '%s' "$helper_payload" | base64 -d > "$diagnostic_tmp/check.mjs"
actual_tree="$(docker exec -i -w /app "$container" node --input-type=module - source-hash < "$diagnostic_tmp/check.mjs")"
[[ "$actual_tree" == "$expected_tree" ]] || fail 'Mounted application source differs from expected commit'

# Discover only /data; never print container environment or copy auth files.
data_host="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$container")"
[[ "$data_host" == /* && -f "$data_host/v3.db" ]] || fail 'Live database mount not found'
mkdir "$diagnostic_tmp/data"
timeout 60 python3 - "$data_host/v3.db" "$diagnostic_tmp/data/v3.db" <<'PY'
import pathlib, shutil, sqlite3, sys, time
src, dest = map(pathlib.Path, sys.argv[1:])
if shutil.disk_usage(dest.parent).free < max(src.stat().st_size * 3, 512 * 1024 * 1024):
    raise SystemExit('Insufficient space for isolated snapshot')
started = time.monotonic()
def progress(*args):
    if time.monotonic() - started > 45:
        raise TimeoutError('Online backup exceeded 45 seconds')
source = sqlite3.connect(src.resolve().as_uri() + '?mode=ro', uri=True, timeout=5)
target = sqlite3.connect(dest)
try:
    # Match the existing production predeploy backup: copy all pages in one
    # backup step. Small page batches repeatedly restart under crawler writes.
    source.backup(target, progress=progress)
    if target.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
        raise RuntimeError('Snapshot integrity check failed')
finally:
    target.close()
    source.close()
PY
docker cp "$container:/app/src" "$diagnostic_tmp/src"
docker cp "$container:/app/public" "$diagnostic_tmp/public"

# Disposable test container: same local image, verified source copy, no network,
# no production database mount, no auth.env or media, and no published ports.
if ! timeout 90 docker run --rm -i --name "$test_container" --network none --read-only --memory 1g \
  --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=bind,src=$diagnostic_tmp/data,dst=/snapshot" \
  --mount "type=bind,src=$diagnostic_tmp/src,dst=/app/src,readonly" \
  --mount "type=bind,src=$diagnostic_tmp/public,dst=/app/public,readonly" \
  -e DATA_DIR=/snapshot -e ACCOUNT_EMAIL_SHA256="$account_hash" \
  --entrypoint node "$image_id" --input-type=module - snapshot \
  < "$diagnostic_tmp/check.mjs" > "$diagnostic_tmp/snapshot.json"; then
  printf '{"error_code":"SNAPSHOT_FAILED"}\n' > "$diagnostic_tmp/snapshot.json"
fi

# Rakuya uses the running host's existing network and deployed parser. One page,
# one request, no retry, redirect following, imports or anti-bot bypass.
if [[ "$include_rakuya" == false ]]; then
  printf '{"skipped":true,"reason":"snapshot_only"}\n' > "$diagnostic_tmp/rakuya.json"
elif ! timeout 25 docker exec -i -w /app "$container" node --input-type=module - rakuya-response \
  < "$diagnostic_tmp/check.mjs" > "$diagnostic_tmp/rakuya.json"; then
  printf '{"error_code":"RAKUYA_DIAGNOSTIC_FAILED"}\n' > "$diagnostic_tmp/rakuya.json"
fi
[[ "$(docker exec -i -w /app "$container" node --input-type=module - source-hash < "$diagnostic_tmp/check.mjs")" == "$expected_tree" ]] || fail 'Application source changed during collection'
python3 - "$diagnostic_tmp" "$revision" "$image_ref" "$expected_tree" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
result = {'source_sha': sys.argv[2], 'image_ref': sys.argv[3], 'source_tree_sha256': sys.argv[4],
          'snapshot': json.loads((root / 'snapshot.json').read_text()),
          'rakuya': json.loads((root / 'rakuya.json').read_text())}
print(json.dumps(result, ensure_ascii=False))
PY
