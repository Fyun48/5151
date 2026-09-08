import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  assertSafeSelect,
  inspectDemandPosts,
  integrityCheck,
  openReadOnly,
} from "../../.github/scripts/sqlite-readonly-inspect.mjs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { backupApiAvailable } from "../../.github/scripts/sqlite-online-backup.mjs";

test("predeploy inspect is read-only and reports duplicate-open rows", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "predeploy-ro-"));
  const file = path.join(dir, "v3.db");
  const seed = new DatabaseSync(file);
  seed.exec(`
    CREATE TABLE demand_posts (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      status TEXT NOT NULL
    );
    INSERT INTO demand_posts (id, user_id, status) VALUES
      (1, 10, 'open'),
      (2, 10, 'open'),
      (3, 11, 'open'),
      (4, 10, 'closed');
  `);
  seed.close();

  const report = inspectDemandPosts(file);
  assert.equal(report.demand_posts, "PRESENT");
  assert.equal(report.total_posts, 4);
  assert.equal(report.total_open, 3);
  assert.equal(report.duplicate_open_users, 1);
  assert.equal(report.affected_posts, 2);
  assert.deepEqual(report.affected_ids, [1, 2]);
  assert.match(report.migration_classification, /DATA CHANGE WILL OCCUR/);
  assert.equal(integrityCheck(file), "ok");

  const ro = openReadOnly(file);
  assert.throws(() => ro.exec("CREATE INDEX idx_x ON demand_posts(user_id)"), /readonly|read-only|SQLITE/i);
  ro.close();

  const after = new DatabaseSync(file, { readOnly: true });
  const indexes = after.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_x'",
  ).all();
  assert.equal(indexes.length, 0);
  after.close();
  rmSync(dir, { recursive: true, force: true });
});

test("predeploy inspect reports no duplicate-open rows", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "predeploy-ro-"));
  const file = path.join(dir, "v3.db");
  const seed = new DatabaseSync(file);
  seed.exec(`
    CREATE TABLE demand_posts (id INTEGER PRIMARY KEY, user_id INTEGER, status TEXT);
    INSERT INTO demand_posts VALUES (1, 1, 'open'), (2, 2, 'closed');
  `);
  seed.close();
  const report = inspectDemandPosts(file);
  assert.equal(report.duplicate_open_users, 0);
  assert.equal(report.migration_classification, "WISH_ROOM_DATA_MIGRATION: NO CURRENT DUPLICATE-OPEN ROWS");
  rmSync(dir, { recursive: true, force: true });
});

test("predeploy inspect refuses mutating SQL helpers", () => {
  assert.throws(() => assertSafeSelect("UPDATE demand_posts SET status = 'closed'"), /refusing/);
  assert.doesNotThrow(() => assertSafeSelect("SELECT COUNT(*) FROM demand_posts WHERE status = 'open'"));
});

test("capability-detects node:sqlite backup() and uses Python online backup API", () => {
  assert.equal(typeof backupApiAvailable(), "boolean");
  const dir = mkdtempSync(path.join(tmpdir(), "predeploy-bk-"));
  const src = path.join(dir, "v3.db");
  const dest = path.join(dir, "backup.db");
  const seed = new DatabaseSync(src);
  seed.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('keep');");
  seed.close();
  const py = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../.github/scripts/sqlite-online-backup.py");
  const out = execFileSync("python3", [py, src, dest], { encoding: "utf8" });
  assert.match(out, /python3 sqlite3.Connection.backup/);
  const srcCheck = new DatabaseSync(src, { readOnly: true });
  assert.equal(srcCheck.prepare("SELECT COUNT(*) AS n FROM t").get().n, 1);
  srcCheck.close();
  const destCheck = new DatabaseSync(dest, { readOnly: true });
  assert.equal(destCheck.prepare("SELECT v FROM t").get().v, "keep");
  assert.equal(destCheck.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  destCheck.close();
  rmSync(dir, { recursive: true, force: true });
});
