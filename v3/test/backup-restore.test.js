import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  backupSqlite,
  manifestOf,
  verifySqliteBackup,
  restoreSqlite,
  pgDumpArgv,
  pgRestoreArgv,
  pgBasebackupArgv,
  pgVerifyArgv,
} from "../src/backupRestore.js";

function seededDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE listings (post_id INTEGER PRIMARY KEY, title TEXT NOT NULL);`);
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  db.prepare("INSERT INTO listings (post_id, title) VALUES (?, ?)").run(1, "甲");
  db.prepare("INSERT INTO listings (post_id, title) VALUES (?, ?)").run(2, "乙");
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("siteName", "吉比租房");
  return db;
}

test("sqlite backup produces a consistent snapshot and verifies parity", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "v3-backup-"));
  try {
    const source = seededDb();
    const dest = path.join(tmp, "snapshot.db").replace(/\\/g, "/");
    const { destPath, manifest } = backupSqlite(source, dest);

    assert.equal(destPath, dest);
    assert.equal(manifest.tables.length, 2);

    const backup = new DatabaseSync(destPath);
    const result = verifySqliteBackup(source, backup);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.missing.length, 0);
    assert.equal(result.tables.every((t) => t.ok), true);
    assert.equal(result.sourceDigest, result.backupDigest);

    // Mutate the source; the backup must no longer match.
    source.prepare("INSERT INTO listings (post_id, title) VALUES (?, ?)").run(3, "丙");
    const after = verifySqliteBackup(source, backup);
    assert.equal(after.ok, false);

    source.close();
    backup.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("restoreSqlite copies data into a schema'd target and verifies", () => {
  const source = seededDb();
  const target = new DatabaseSync(":memory:");
  target.exec(`CREATE TABLE listings (post_id INTEGER PRIMARY KEY, title TEXT NOT NULL);`);
  target.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);

  const { restored, verify } = restoreSqlite(source, target);
  assert.deepEqual(restored.map((r) => r.table).sort(), ["listings", "settings"]);
  assert.equal(verify.ok, true, JSON.stringify(verify));
  assert.equal(target.prepare("SELECT COUNT(*) AS n FROM listings").get().n, 2);

  source.close();
  target.close();
});

test("manifestOf digest changes when any table row changes", () => {
  const source = seededDb();
  const before = manifestOf(source).digest;
  source.prepare("UPDATE settings SET value = ? WHERE key = ?").run("改名", "siteName");
  const after = manifestOf(source).digest;
  assert.notEqual(before, after);
  source.close();
});

test("postgres backup/restore argv builders are explicit and injection-safe", () => {
  const dump = pgDumpArgv({ host: "192.168.0.140", port: 15432, user: "postgres", database: "5151_shadow", file: "/backup/5151.dump" });
  assert.deepEqual(dump, [
    "pg_dump", "--host", "192.168.0.140", "--port", "15432", "--username", "postgres",
    "--no-owner", "--no-acl", "--format=custom", "--file", "/backup/5151.dump", "5151_shadow",
  ]);

  const plain = pgDumpArgv({ host: "h", user: "u", database: "d", format: "plain" });
  assert.ok(plain.includes("--format=plain"));
  assert.ok(!plain.includes("--file"));

  const restore = pgRestoreArgv({ host: "192.168.0.220", port: 15432, user: "postgres", database: "5151_shadow", file: "/backup/5151.dump" });
  assert.deepEqual(restore, [
    "pg_restore", "--host", "192.168.0.220", "--port", "15432", "--username", "postgres",
    "--dbname", "5151_shadow", "--no-owner", "--exit-on-error", "/backup/5151.dump",
  ]);

  const basebackup = pgBasebackupArgv({ host: "192.168.0.140", user: "postgres", targetDir: "/backup/base" });
  assert.deepEqual(basebackup, [
    "pg_basebackup", "--host", "192.168.0.140", "--port", "5432", "--username", "postgres",
    "--pgdata", "/backup/base", "--format=plain", "--wal-method=stream", "--checkpoint=fast",
  ]);

  const verify = pgVerifyArgv({ host: "192.168.0.220", port: 15432, user: "postgres", database: "5151_shadow" });
  assert.ok(verify.includes("SELECT 'restore_ok';"));
});
