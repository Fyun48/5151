#!/usr/bin/env bash
# Read-only inspection; execute only the diagnostic already present in v3.
set -euo pipefail

fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ $# == 2 ]] || fail 'Expected deployed source SHA and diagnostic script hash'
expected_source=$1
expected_script=$2
[[ "$expected_source" =~ ^[0-9a-f]{40}$ ]] || fail 'Invalid source SHA'
[[ "$expected_script" =~ ^[0-9a-f]{64}$ ]] || fail 'Invalid diagnostic script hash'

container=591-tracker-v3
state="$(docker inspect --format '{{.State.Status}}' "$container")"
[[ "$state" == running ]] || fail 'Production v3 is not running'
image_ref="$(docker inspect --format '{{.Config.Image}}' "$container")"
[[ "$image_ref" =~ ^ghcr\.io/fyun48/5151@sha256:[0-9a-f]{64}$ ]] || fail 'Production image is not digest-pinned'
image_id="$(docker inspect --format '{{.Image}}' "$container")"
revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")"
source="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.source"}}' "$image_id")"
[[ "$revision" == "$expected_source" ]] || fail 'Running v3 revision differs from expected source'
[[ "$source" == https://github.com/Fyun48/5151 ]] || fail 'Running image belongs to another repository'

# src is bind-mounted in production: verify the actual script, not only its
# image label, before executing it. This command reads a file and prints a hash.
script_hash="$(docker exec -w /app "$container" node --input-type=module -e '
  import { createHash } from "node:crypto";
  import { readFileSync } from "node:fs";
  console.log(createHash("sha256").update(readFileSync("src/diagnoseRakuya.js")).digest("hex"));
')"
[[ "$script_hash" == "$expected_script" ]] || fail 'Deployed diagnostic script differs from the expected source'

# The deployed script opens SQLite readOnly and performs exactly one bounded
# public request. A block is recorded; there is no retry or fallback transport.
printf '{"source_sha":"%s","image_ref":"%s","diagnostic_script_sha256":"%s","diagnostic":' \
  "$revision" "$image_ref" "$script_hash"
docker exec -w /app "$container" node src/diagnoseRakuya.js
printf '}\n'
