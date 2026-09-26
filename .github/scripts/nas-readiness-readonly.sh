#!/usr/bin/env bash
# Whitelisted observations only. Never source environment files or print secrets.
set -euo pipefail
role="${1:?expected casa or syn}"
case "$role" in
  casa) docker_bin=/usr/bin/docker; expected_host=ubuntucasaos ;;
  syn) docker_bin=/usr/local/bin/docker; expected_host=TORI_NAS01 ;;
  *) exit 2 ;;
esac
observed_host="$(hostname)"
printf 'host=%s expected=%s utc=%s\n' "$observed_host" "$expected_host" "$(date -u +%FT%TZ)"
[[ "$observed_host" == "$expected_host" ]] || exit 3
"$docker_bin" version --format 'docker_server={{.Server.Version}}'
for container in 591-tracker-v3 5151-web-A 5151-web-B 5151-crawler 5151-worker 5151-postgres-A 5151-postgres-B; do
  if ! "$docker_bin" inspect --format 'container={{.Name}} image={{.Image}} status={{.State.Status}} started={{.State.StartedAt}}' "$container" 2>/dev/null; then
    printf 'container=%s status=absent\n' "$container"
    continue
  fi
  case "$container" in
    5151-postgres-*)
      # psql -w never asks for a password. Failure stays NOT_RUN, not fake PASS.
      if ! "$docker_bin" exec "$container" psql -X -w -U postgres -d 5151_shadow -At -v ON_ERROR_STOP=1 -c "
        BEGIN READ ONLY;
        SET LOCAL statement_timeout = '5s';
        SELECT json_build_object('pg_version', current_setting('server_version'),
          'recovery', pg_is_in_recovery(), 'archive_mode', current_setting('archive_mode'),
          'synchronous_commit', current_setting('synchronous_commit'),
          'synchronous_standby_names', current_setting('synchronous_standby_names'));
        SELECT json_build_object('replication_state', state, 'sync_state', sync_state,
          'write_lag', write_lag, 'flush_lag', flush_lag, 'replay_lag', replay_lag)
          FROM pg_stat_replication;
        SELECT json_build_object('receiver_status', status) FROM pg_stat_wal_receiver;
        SELECT json_build_object('archived_count', archived_count, 'failed_count', failed_count,
          'last_archived_time', last_archived_time, 'last_failed_time', last_failed_time)
          FROM pg_stat_archiver;
        COMMIT;" 2>/dev/null; then
        printf 'pg_observation=%s NOT_RUN\n' "$container"
      fi
      ;;
    *)
      # Only explicitly selected process settings and source hashes leave the host.
      if ! "$docker_bin" exec "$container" node -e '
        const fs = require("node:fs"), crypto = require("node:crypto");
        const out = { DB_DRIVER: process.env.DB_DRIVER || "unset", sourceHashes: {} };
        for (const root of ["/app/src", "/app/v3/src"]) {
          for (const file of ["server.js", "watcher.js", "crawlWatchdog.js", "crawlPolicy.js", "db.js", "coveringBookkeepingAsync.js"]) {
            const path = root + "/" + file;
            if (fs.existsSync(path)) out.sourceHashes[path] = crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
          }
        }
        console.log(JSON.stringify(out));
      ' 2>/dev/null; then
        printf 'app_observation=%s NOT_RUN\n' "$container"
      fi
      ;;
  esac
done
printf 'scope=read_only_inventory; NOT_A_BACKUP_RESTORE_OR_FAILOVER_TEST\n'
