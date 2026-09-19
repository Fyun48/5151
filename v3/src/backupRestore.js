// Backup / restore primitives (runtime-modernization HA). SQLite uses VACUUM
// INTO for a consistent, self-contained snapshot and verifies parity via a
// table-hash digest. PostgreSQL wraps pg_dump / pg_basebackup / pg_restore /
// psql as pure argv builders so the shadow-cluster drill is a one-liner and
// the command shape is unit-testable without a live server.
import { createHash } from "node:crypto";
import { snapshotTables, tableHash, copyTable } from "./sqliteToPostgres.js";

// --- SQLite ---------------------------------------------------------------

function digestOf(db, tables) {
  const h = createHash("sha256");
  for (const name of tables) h.update(`${name}:${tableHash(db, name)};`);
  return h.digest("hex");
}

export function manifestOf(db) {
  const snapshot = snapshotTables(db);
  const names = snapshot.map((t) => t.name);
  return {
    tables: snapshot.map((t) => ({ name: t.name, rowCount: t.rowCount })),
    digest: digestOf(db, names),
  };
}

// Consistent snapshot via VACUUM INTO (SQLite >= 3.27). Returns a manifest of
// the source at backup time for later verification.
export function backupSqlite(db, destPath) {
  const quoted = String(destPath).replace(/'/g, "''");
  db.exec(`VACUUM INTO '${quoted}'`);
  return { destPath, manifest: manifestOf(db) };
}

// Verify a SQLite backup file against the live source: table coverage + a
// whole-database digest built from per-table hashes.
export function verifySqliteBackup(sourceDb, backupDb) {
  const sourceNames = snapshotTables(sourceDb).map((t) => t.name);
  const backupNames = new Set(snapshotTables(backupDb).map((t) => t.name));
  const sourceManifest = manifestOf(sourceDb);
  const backupManifest = manifestOf(backupDb);
  const missing = sourceNames.filter((name) => !backupNames.has(name));
  const tables = sourceNames.map((name) => ({
    table: name,
    ok: backupNames.has(name) && tableHash(sourceDb, name) === tableHash(backupDb, name),
  }));
  return {
    ok: missing.length === 0 && sourceManifest.digest === backupManifest.digest,
    sourceDigest: sourceManifest.digest,
    backupDigest: backupManifest.digest,
    missing,
    tables,
  };
}

// Restore a SQLite backup into a (empty) target, then verify parity.
export function restoreSqlite(backupDb, targetDb, { tables = [] } = {}) {
  const names = snapshotTables(backupDb)
    .map((t) => t.name)
    .filter((name) => (tables.length ? tables.includes(name) : true));
  const restored = names.map((name) => ({ table: name, copied: copyTable(backupDb, targetDb, name) }));
  return { restored, verify: verifySqliteBackup(backupDb, targetDb) };
}

// --- PostgreSQL (shadow cluster drill) -------------------------------------

export function pgDumpArgv({ host, port = 5432, user, database, file, format = "custom" } = {}) {
  const argv = ["pg_dump", "--host", host, "--port", String(port), "--username", user, "--no-owner", "--no-acl"];
  if (format === "plain") argv.push("--format=plain");
  else argv.push("--format=custom", "--file", file);
  argv.push(database);
  return argv;
}

export function pgRestoreArgv({ host, port = 5432, user, database, file } = {}) {
  return [
    "pg_restore", "--host", host, "--port", String(port), "--username", user,
    "--dbname", database, "--no-owner", "--exit-on-error", file,
  ];
}

export function pgBasebackupArgv({ host, port = 5432, user, targetDir } = {}) {
  return [
    "pg_basebackup", "--host", host, "--port", String(port), "--username", user,
    "--pgdata", targetDir, "--format=plain", "--wal-method=stream", "--checkpoint=fast",
  ];
}

export function pgVerifyArgv({ host, port = 5432, user, database } = {}) {
  return [
    "psql", "--host", host, "--port", String(port), "--username", user,
    "--dbname", database, "--tuples-only", "--no-align", "--command", "SELECT 'restore_ok';",
  ];
}
