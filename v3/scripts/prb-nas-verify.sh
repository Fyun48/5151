#!/usr/bin/env bash
# Run on the existing NAS development host. All DB work stays in a newly
# created container on an internal network; no production PG URL is accepted.
set -euo pipefail
sha="${1:?usage: prb-nas-verify.sh <40-character-commit> [output-directory]}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'An exact commit SHA is required.' >&2; exit 2; }
root="$(git rev-parse --show-toplevel)"
git -C "$root" cat-file -e "$sha^{commit}"
command -v docker >/dev/null
output="${2:-$root/artifacts/prb-nas-$sha}"
mkdir -p "$output"
output="$(cd "$output" && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/prb-nas.XXXXXXXX")"
tag="prb-verify-$(basename "$work" | tr '[:upper:].' '[:lower:]-')"
network="$tag-net"
pg_container="$tag-pg"
app_container="$tag-app"
deps_volume="$tag-deps"
pg_volume="$tag-pgdata"
# Provenance labels: every resource this script creates stays attributable even
# if cleanup never runs, so an interrupted run cannot leave anonymous resources.
labels=(--label "prb-nas-verify=1" --label "prb-nas-verify.sha=$sha"
        --label "prb-nas-verify.script=v3/scripts/prb-nas-verify.sh")
cleanup() {
  docker rm -f "$app_container" "$pg_container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker volume rm "$deps_volume" "$pg_volume" >/dev/null 2>&1 || true
  git -C "$root" worktree remove --force "$work/checkout" >/dev/null 2>&1 || true
  rmdir "$work" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
git -C "$root" worktree add --detach "$work/checkout" "$sha"
docker pull node:22-bookworm
docker pull postgres:16.14-alpine
docker volume create "${labels[@]}" "$deps_volume" >/dev/null
docker volume create "${labels[@]}" "$pg_volume" >/dev/null
# Installation has registry access but receives no PG or infrastructure secrets.
docker run --rm "${labels[@]}" --name "$app_container" \
  --mount "type=bind,src=$work,dst=$work" \
  --mount "type=volume,src=$deps_volume,dst=$work/checkout/node_modules" \
  --workdir "$work/checkout" node:22-bookworm npm ci
docker network create --internal "${labels[@]}" "$network" >/dev/null
docker run -d "${labels[@]}" --name "$pg_container" --network "$network" --network-alias prb-pg \
  --mount "type=volume,src=$pg_volume,dst=/var/lib/postgresql/data" \
  --env POSTGRES_DB=tracker_prb_test --env POSTGRES_USER=postgres \
  --env POSTGRES_HOST_AUTH_METHOD=trust \
  --health-cmd 'pg_isready -U postgres -d tracker_prb_test' \
  --health-interval 2s --health-timeout 2s --health-retries 30 \
  postgres:16.14-alpine >/dev/null
ready=false
for ((attempt=0;attempt<60;attempt++)); do
  if [[ "$(docker inspect -f '{{.State.Health.Status}}' "$pg_container")" == healthy ]]; then ready=true; break; fi
  sleep 2
done
[[ "$ready" == true ]] || { docker logs "$pg_container" > "$output/postgres-startup.log" 2>&1; exit 1; }
docker inspect --format '{{.Image}}' "$pg_container" > "$output/postgres-image.txt"
docker image inspect --format '{{.Id}}' node:22-bookworm > "$output/node-image.txt"
# Both mounts preserve worktree .git paths. The original checkout stays read-only.
# The internal network has no route to production and publishes no host ports.
docker run --rm "${labels[@]}" --name "$app_container" --network "$network" \
  --mount "type=bind,src=$root,dst=$root,readonly" \
  --mount "type=bind,src=$work,dst=$work,readonly" \
  --mount "type=volume,src=$deps_volume,dst=$work/checkout/node_modules,readonly" \
  --mount "type=bind,src=$output,dst=/out" \
  --workdir "$work/checkout" \
  --env GIT_CONFIG_COUNT=1 --env GIT_CONFIG_KEY_0=safe.directory --env GIT_CONFIG_VALUE_0="$work/checkout" \
  --env TZ=UTC --env DATA_DIR=/tmp/prb-test-data \
  --env PG_URL=postgres://postgres@prb-pg:5432/tracker_prb_test \
  --env PG_TEST_URL=postgres://postgres@prb-pg:5432/tracker_prb_test \
  --env PG_STATEMENT_TIMEOUT_MS=15000 --env SOURCE_SHA="$sha" \
  --env PERF_TARGET=nas --env PERF_ROWS=120000 --env PERF_ACTIVE_ROWS=36000 \
  --env PERF_OUTPUT=/out/prb-search-benchmark.json \
  node:22-bookworm bash -euo pipefail -c \
  'npm run test:pg 2>&1 | tee /out/pg-tests.log
   node v3/scripts/prb-search-benchmark.mjs 2>&1 | tee /out/performance.log'
echo "Evidence: $output"
