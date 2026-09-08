#!/usr/bin/env node
/**
 * SQLite Online Backup API via node:sqlite when the runtime exports backup().
 * Node 22.14 (current CI / likely Production image) does not export backup().
 * Callers must capability-detect and fall back to python3 Connection.backup
 * or sqlite3 CLI `.backup` — never raw-copy a live DB.
 */
import * as sqlite from "node:sqlite";

export function backupApiAvailable() {
  return typeof sqlite.backup === "function";
}

export async function onlineBackup(srcPath, destPath) {
  if (!backupApiAvailable()) {
    const err = new Error("node:sqlite backup() is not available");
    err.code = "BACKUP_API_UNAVAILABLE";
    throw err;
  }
  const sourceDb = new sqlite.DatabaseSync(srcPath, { readOnly: true });
  try {
    const pages = await sqlite.backup(sourceDb, destPath);
    return { ok: true, pages, method: "node:sqlite backup()" };
  } finally {
    sourceDb.close();
  }
}

const self = process.argv[1] ? String(process.argv[1]) : "";
if (self.endsWith("sqlite-online-backup.mjs")) {
  const src = process.argv[2];
  const dest = process.argv[3];
  if (!src || !dest) {
    console.error("usage: sqlite-online-backup.mjs <src.db> <dest.db>");
    process.exit(2);
  }
  if (!backupApiAvailable()) {
    console.error("BACKUP_API_UNAVAILABLE");
    process.exit(3);
  }
  const result = await onlineBackup(src, dest);
  console.log(JSON.stringify(result));
}
