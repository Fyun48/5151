#!/usr/bin/env bash
# Verify the shadow standby is in recovery, sees replicated data, and rejects writes.
set -u
echo "=== pg_is_in_recovery (should be t) ==="
/usr/local/bin/docker exec 5151-postgres-B psql -U postgres -tAc "SELECT pg_is_in_recovery();"
echo "=== standby count (should match primary = 1) ==="
/usr/local/bin/docker exec 5151-postgres-B psql -U postgres -d 5151_shadow -tAc "SELECT count(*) FROM repl_test;"
echo "=== write on standby (should be rejected) ==="
/usr/local/bin/docker exec 5151-postgres-B psql -U postgres -d 5151_shadow -c "INSERT INTO repl_test VALUES (2, 'write to standby');" 2>&1 | head -2
