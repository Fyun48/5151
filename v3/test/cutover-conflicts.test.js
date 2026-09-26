// 切換衝突處置腳本的回歸（v3/scripts/cutover-conflicts.mjs）。
//
// 這支腳本會對正式 PG 產生 UPDATE，所以必須釘住三件事：
//   ① 群組確認等級只升不降（PG 已是 admin_confirmed 時絕不覆寫）
//   ② 只有 SQLite 時間戳真的較新才更新；PG 較新不動作；時間戳相同 → 交 Owner 不猜
//   ③ 規則沒涵蓋的表（listing_group_members）一律交 Owner
// 另外輸出不得含 INSERT／DELETE／DDL。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(os.tmpdir(), "v3-cutover-conflicts-"));
after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows keeps the file locked
  }
});

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "cutover-conflicts.mjs");

function snapshot(name, rows) {
  const file = path.join(dir, `${name}.db`);
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE user_settings (user_id INTEGER, key TEXT, value TEXT, PRIMARY KEY (user_id, key));
    CREATE TABLE user_listing_flags (user_id INTEGER, post_id INTEGER, viewed INTEGER, watched INTEGER,
      hidden INTEGER, watch_note TEXT, viewed_at TEXT, watched_at TEXT, hidden_at TEXT, watch_group_id TEXT,
      PRIMARY KEY (user_id, post_id));
    CREATE TABLE listing_groups (group_id TEXT PRIMARY KEY, primary_post_id INTEGER, confirmation_level TEXT,
      confirmed_by INTEGER, updated_at TEXT);
    CREATE TABLE listing_group_members (post_id INTEGER PRIMARY KEY, group_id TEXT, source TEXT, joined_at TEXT);
  `);
  for (const r of rows.settings || []) db.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").run(r[0], r[1]);
  for (const r of rows.flags || []) {
    db.prepare(`INSERT INTO user_listing_flags(user_id, post_id, viewed, watched, hidden, watch_note, viewed_at, watched_at, hidden_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(r.user_id, r.post_id, r.viewed ?? 0, r.watched ?? 0, r.hidden ?? 0, r.watch_note ?? "", r.viewed_at ?? null, r.watched_at ?? null, r.hidden_at ?? null);
  }
  for (const r of rows.groups || []) {
    db.prepare("INSERT INTO listing_groups(group_id, primary_post_id, confirmation_level, confirmed_by, updated_at) VALUES (?,?,?,?,?)")
      .run(r.group_id, r.primary_post_id ?? 1, r.confirmation_level, r.confirmed_by ?? null, r.updated_at);
  }
  for (const r of rows.members || []) {
    db.prepare("INSERT INTO listing_group_members(post_id, group_id, source, joined_at) VALUES (?,?,?,?)").run(r.post_id, r.group_id, "591", r.joined_at);
  }
  db.close();
  return file;
}

function conflictsDir(slot, perTable) {
  const d = path.join(dir, `conf-${slot}`);
  mkdirSync(d, { recursive: true });
  for (const t of ["settings", "user_settings", "user_listing_flags", "listing_groups", "listing_group_members"]) {
    writeFileSync(path.join(d, `${t}.conflicts`), (perTable[t] || []).map((k) => `${k}\n`).join(""));
  }
  return d;
}

// PG 值檔：`## <table>` 分段，欄位順序與腳本的 COLS 相同。
function pgValues(slot, sections) {
  const lines = [];
  for (const [table, rows] of Object.entries(sections)) {
    lines.push(`## ${table}`);
    for (const r of rows) lines.push(r.join("\t"));
  }
  const f = path.join(dir, `pgvalues-${slot}.out`);
  writeFileSync(f, `${lines.join("\n")}\n`);
  return f;
}

// 只看真正的語句行，忽略檔頭註解（註解裡本來就會提到 UPDATE／INSERT 這些字）。
function statementsOf(sql) {
  return sql.split("\n").filter((l) => l.trim() && !l.trim().startsWith("--")).join("\n");
}

function run(slot, { snapshots, conflicts, pgv }) {
  const out = path.join(dir, `${slot}.sql`);
  const report = path.join(dir, `${slot}.json`);
  execFileSync("node", [SCRIPT, "--pg-values", pgv, "--conflicts", conflicts,
    ...snapshots.flatMap((s) => ["--snapshot", s]), "--out", out, "--report", report], { encoding: "utf8" });
  return { sql: readFileSync(out, "utf8"), report: JSON.parse(readFileSync(report, "utf8")) };
}

test("群組確認等級只升不降：SQLite 較高才升級，且 UPDATE 帶護欄", () => {
  const snap = snapshot("g1", { groups: [{ group_id: "lg_up", confirmation_level: "auto_confirmed", updated_at: "2026-09-26T00:00:00.000Z" }] });
  const { sql, report } = run("g1", {
    snapshots: [snap],
    conflicts: conflictsDir("g1", { listing_groups: ["lg_up"] }),
    pgv: pgValues("g1", { listing_groups: [["lg_up", 1, "suspected", "", "2026-09-20T00:00:00.000Z"]] }),
  });
  assert.equal(report.appliedCount, 1);
  assert.match(sql, /UPDATE listing_groups SET confirmation_level = 'auto_confirmed' WHERE group_id = 'lg_up' AND confirmation_level = 'suspected';/);
});

test("群組不得降級：PG 已是 admin_confirmed 時不產生 UPDATE", () => {
  const snap = snapshot("g2", { groups: [{ group_id: "lg_admin", confirmation_level: "auto_confirmed", updated_at: "2026-09-26T00:00:00.000Z" }] });
  const { sql, report } = run("g2", {
    snapshots: [snap],
    conflicts: conflictsDir("g2", { listing_groups: ["lg_admin"] }),
    pgv: pgValues("g2", { listing_groups: [["lg_admin", 1, "admin_confirmed", 7, "2026-09-20T00:00:00.000Z"]] }),
  });
  assert.equal(report.appliedCount, 0);
  assert.equal(/UPDATE/.test(statementsOf(sql)), false, "不得對 admin_confirmed 產生任何 UPDATE");
  assert.equal(report.no_action.length, 1);
});

test("時間戳較新才更新：SQLite 新 → UPDATE；PG 新 → 不動作", () => {
  const snap = snapshot("s1", { settings: [["siteCatalogStats", '{"at":"2026-09-24T00:00:00.000Z"}']] });
  const newer = run("s1", {
    snapshots: [snap],
    conflicts: conflictsDir("s1", { settings: ["siteCatalogStats"] }),
    pgv: pgValues("s1", { settings: [["siteCatalogStats", '{"at":"2026-09-19T00:00:00.000Z"}']] }),
  });
  assert.equal(newer.report.appliedCount, 1);
  assert.match(newer.sql, /UPDATE settings SET value = /);

  const older = run("s2", {
    snapshots: [snap],
    conflicts: conflictsDir("s2", { settings: ["siteCatalogStats"] }),
    pgv: pgValues("s2", { settings: [["siteCatalogStats", '{"at":"2026-09-26T00:00:00.000Z"}']] }),
  });
  assert.equal(older.report.appliedCount, 0);
  assert.match(older.sql, /^-- 由/);
  assert.equal(older.report.no_action.length, 1);
});

test("時間戳相同但內容不同 → 交 Owner，不猜", () => {
  const snap = snapshot("f1", {
    flags: [{ user_id: 1, post_id: 21937940, viewed: 1, watched: 1, watched_at: "2026-09-08T03:52:16.614Z" }],
  });
  const { report, sql } = run("f1", {
    snapshots: [snap],
    conflicts: conflictsDir("f1", { user_listing_flags: ["1\t21937940"] }),
    pgv: pgValues("f1", { user_listing_flags: [["1", "21937940", "1", "1", "0", "", "", "2026-09-08T03:52:16.614Z", ""]] }),
  });
  assert.equal(report.appliedCount, 0);
  assert.equal(report.owner.length, 1);
  assert.equal(/UPDATE user_listing_flags/.test(statementsOf(sql)), false);
});

test("規則沒涵蓋的表（listing_group_members）一律交 Owner", () => {
  const snap = snapshot("m1", { members: [{ post_id: 21974336, group_id: "lg_sq", joined_at: "2026-09-22T03:07:10.605Z" }] });
  const { report, sql } = run("m1", {
    snapshots: [snap],
    conflicts: conflictsDir("m1", { listing_group_members: ["21974336"] }),
    pgv: pgValues("m1", {}),
  });
  assert.equal(report.owner.length, 1);
  assert.equal(report.owner[0].table, "listing_group_members");
  assert.equal(/UPDATE/.test(statementsOf(sql)), false);
});

test("輸出不得含 INSERT／DELETE／DDL", () => {
  const snap = snapshot("x1", {
    settings: [["siteCatalogStats", '{"at":"2026-09-24T00:00:00.000Z"}']],
    groups: [{ group_id: "lg_up", confirmation_level: "auto_confirmed", updated_at: "2026-09-26T00:00:00.000Z" }],
  });
  const { sql } = run("x1", {
    snapshots: [snap],
    conflicts: conflictsDir("x1", { settings: ["siteCatalogStats"], listing_groups: ["lg_up"] }),
    pgv: pgValues("x1", {
      settings: [["siteCatalogStats", '{"at":"2026-09-19T00:00:00.000Z"}']],
      listing_groups: [["lg_up", 1, "suspected", "", "2026-09-20T00:00:00.000Z"]],
    }),
  });
  const stmts = statementsOf(sql);
  for (const forbidden of ["INSERT ", "DELETE ", "DROP ", "ALTER ", "TRUNCATE ", "CREATE "]) {
    assert.equal(stmts.includes(forbidden), false, `不得出現 ${forbidden}`);
  }
});
