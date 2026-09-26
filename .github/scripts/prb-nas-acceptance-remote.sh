#!/usr/bin/env bash
# Fixed CasaOS disposable benchmark; stdout is only the evidence archive.
set -euo pipefail
sha="${1:?source SHA}"; run_id="${2:?run ID}"; attempt="${3:?attempt}"
[[ "$sha" =~ ^[0-9a-f]{40}$ && "$run_id" =~ ^[0-9]+$ && "$attempt" =~ ^[0-9]+$ ]] || exit 2
[[ "$(hostname)" == ubuntucasaos ]] || exit 3
grep -q N3450 /proc/cpuinfo || exit 3
checkout=/mnt/Storage1/prb-acceptance/5151
cd "$checkout"
[[ "$(git rev-parse --show-toplevel)" == "$checkout" ]] || exit 3
# Fetch only the established PR branch; never checkout/reset the shared checkout.
git fetch origin fix/pr-b-persist-listing-transaction >/dev/null 2>&1 || { echo 'FETCH_FAILED' >&2; exit 4; }
git merge-base --is-ancestor "$sha" FETCH_HEAD || exit 4
resource_ids() {
  if [[ "$1" == container ]]; then
    docker container ls -aq --filter label=prb-nas-verify=1
  else
    docker "$1" ls -q --filter label=prb-nas-verify=1
  fi
}
for kind in container network volume; do
  [[ -z "$(resource_ids "$kind")" ]] || { echo 'EXISTING_ACCEPTANCE_RESOURCES' >&2; exit 5; }
done
output="/mnt/Storage1/prb-acceptance/evidence/prb-nas-${sha:0:7}-gha-$run_id-$attempt"
mkdir "$output"
launcher="$(mktemp /tmp/prb-dispatch.XXXXXXXX)"
git show "$sha:v3/scripts/prb-nas-verify.sh" > "$launcher"
printf 'source_sha=%s\nrun_id=%s\nattempt=%s\n' "$sha" "$run_id" "$attempt" > "$output/dispatch.txt"
# A lost SSH session must not trigger the actual benchmark's EXIT cleanup.
setsid nohup bash -c '
  bash "$1" "$2" "$3" > "$3/runner.log" 2>&1
  status=$?
  printf "%s\n" "$status" > "$3/runner-exit.txt"
  rm -f "$1"
' prb-dispatch "$launcher" "$sha" "$output" >/dev/null 2>&1 &
printf 'Evidence retained on NAS: %s\n' "$output" >&2
done_running=false
for ((poll=0;poll<240;poll++)); do
  if [[ -f "$output/runner-exit.txt" ]]; then done_running=true; break; fi
  sleep 5
done
[[ "$done_running" == true ]] || { echo 'RUN_STILL_PENDING; detached run and evidence preserved' >&2; exit 6; }
clean=true
for kind in container network volume; do
  if [[ -n "$(resource_ids "$kind")" ]]; then
    printf '%s=REMAINS\n' "$kind" >> "$output/cleanup-check.txt"
    clean=false
  else
    printf '%s=0\n' "$kind" >> "$output/cleanup-check.txt"
  fi
done
printf '%s\n' "$clean" > "$output/cleanup-ok.txt"
cd "$output"
find . -maxdepth 1 -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
tar -czf - .
