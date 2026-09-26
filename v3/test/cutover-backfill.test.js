// 切換補遷腳本的回歸（v3/scripts/cutover-backfill.mjs）。
//
// 這支腳本會對正式 PG 產生 INSERT，所以行為必須被釘住：
//   - dry-run 不產生任何 SQL
//   - 只針對「PG 缺少的鍵」產生 INSERT ... ON CONFLICT DO NOTHING（不覆蓋既有列）
//   - 不出現 UPDATE／DELETE／DROP／ALTER
//   - 同一個鍵出現在多份快照時，用 freshness 欄位挑較新的那一份
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(os.tmpdir(), "v3-cutover-backfill-"));
after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows keeps the file locked
  }
});

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "cutover-backfill.mjs");

function snapshot(name, { flags = [], members = [] } = {}) {
  const file = path.join(dir, `${name}.db`);
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE user_settings (user_id INTEGER, key TEXT, value TEXT, PRIMARY KEY (user_id, key));
    CREATE TABLE user_listing_flags (user_id INTEGER, post_id INTEGER, viewed INTEGER, watched INTEGER,
      hidden INTEGER, watch_note TEXT, viewed_at TEXT, watched_at TEXT, hidden_at TEXT, watch_group_id TEXT,
      PRIMARY KEY (user_id, post_id));
    CREATE TABLE listing_groups (group_id TEXT PRIMARY KEY, primary_post_id INTEGER, created_at TEXT,
      updated_at TEXT, confirmation_level TEXT, confirmed_by INTEGER, confirmed_at TEXT);
    CREATE TABLE listing_group_members (post_id INTEGER PRIMARY KEY, group_id TEXT, source TEXT,
      match_confidence REAL, match_evidence TEXT, joined_at TEXT);
  `);
  db.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").run("rentalCatalog", '{"a":1}');
  const flag = db.prepare(
    `INSERT INTO user_listing_flags(user_id, post_id, viewed, watched, hidden, watch_note,
      viewed_at, watched_at, hidden_at, watch_group_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const f of flags) flag.run(f.user_id, f.post_id, f.viewed ?? 0, f.watched ?? 0, f.hidden ?? 0, f.watch_note ?? "", f.viewed_at ?? null, f.watched_at ?? null, f.hidden_at ?? null, f.watch_group_id ?? "");
  const member = db.prepare(
    "INSERT INTO listing_group_members(post_id, group_id, source, match_confidence, match_evidence, joined_at) VALUES (?,?,?,?,?,?)",
  );
  for (const m of members) member.run(m.post_id, m.group_id, m.source ?? "591", m.match_confidence ?? 0.9, "{}", m.joined_at);
  db.close();
  return file;
}

// 腳本讀的是「每張表一個檔案」<table>.keys（一行一個主鍵，TAB 分隔）；沒給的表要留空檔，
// 否則腳本會把該表當成「沒有 PG 鍵檔」而跳過。
function pgKeys(slot, perTable = {}) {
  const d = path.join(dir, `pgkeys-${slot}`);
  mkdirSync(d, { recursive: true });
  for (const table of ["settings", "user_settings", "user_listing_flags", "listing_groups", "listing_group_members"]) {
    const keys = perTable[table] || [];
    writeFileSync(path.join(d, `${table}.keys`), keys.map((k) => `${k}\n`).join(""));
  }
  return d;
}

test("dry-run：不產生 SQL，只回報缺少的列數", () => {
  const snap = snapshot("dry", { flags: [{ user_id: 1, post_id: 9001, watched: 1 }] });
  const keys = pgKeys("dry");
  const out = path.join(dir, "should-not-exist.sql");
  const stdout = execFileSync("node", [SCRIPT, "--snapshot", snap, "--pg-keys", keys, "--report", path.join(dir, "dry.json")], { encoding: "utf8" });
  assert.doesNotMatch(stdout, /INSERT INTO/, "dry-run 不得印出 INSERT");
  assert.throws(() => readFileSync(out, "utf8"), "dry-run 不得寫出 SQL 檔");
  const report = JSON.parse(readFileSync(path.join(dir, "dry.json"), "utf8"));
  assert.equal(report.dryRun, true);
  assert.equal(report.totals.missing, 2, "settings 1 列 ＋ flags 1 列");
});

test("產生 SQL：只 INSERT 缺少的鍵，且不含 UPDATE／DELETE／DDL", () => {
  const snap = snapshot("emit", { flags: [{ user_id: 1, post_id: 9001, watched: 1 }, { user_id: 1, post_id: 9002 }] });
  const keys = pgKeys("emit", { user_listing_flags: ["1\t9001"] });
  const out = path.join(dir, "emit.sql");
  execFileSync("node", [SCRIPT, "--snapshot", snap, "--pg-keys", keys, "--out", out], { encoding: "utf8" });
  const sql = readFileSync(out, "utf8");
  assert.match(sql, /INSERT INTO user_listing_flags .*ON CONFLICT DO NOTHING;/);
  assert.match(sql, /INSERT INTO settings .*ON CONFLICT DO NOTHING;/);
  assert.doesNotMatch(sql, /INSERT INTO user_listing_flags[^;]*9001/, "PG 已有的鍵不得再 INSERT");
  assert.match(sql, /9002/, "PG 缺少的鍵要 INSERT");
  for (const forbidden of ["UPDATE ", "DELETE ", "DROP ", "ALTER ", "TRUNCATE "]) {
    assert.equal(sql.includes(forbidden), false, `不得出現 ${forbidden}`);
  }
  // 群組必須排在成員之前（FK）
  assert.ok(sql.indexOf("INSERT INTO listing_groups") < sql.indexOf("INSERT INTO listing_group_members") || !sql.includes("listing_group_members"));
});

test("多份快照：同一個鍵用 freshness 欄位挑較新的那一份", () => {
  const older = snapshot("older", { members: [{ post_id: 17085729, group_id: "lg_old", joined_at: "2026-09-01T00:00:00.000Z" }] });
  const newer = snapshot("newer", { members: [{ post_id: 17085729, group_id: "lg_new", joined_at: "2026-09-26T00:00:00.000Z" }] });
  const keys = pgKeys("emit2");
  const out = path.join(dir, "merge.sql");
  const stdout = execFileSync("node", [SCRIPT, "--snapshot", older, "--snapshot", newer, "--pg-keys", keys, "--out", out], { encoding: "utf8" });
  const sql = readFileSync(out, "utf8");
  const memberInserts = sql.split("\n").filter((l) => l.startsWith("INSERT INTO listing_group_members"));
  assert.equal(memberInserts.length, 1, "同一個主鍵只能產生一筆");
  assert.match(memberInserts[0], /lg_new/, "要挑 joined_at 較新的那一份");
  assert.match(stdout, /"chosenAcrossSnapshots": 1/);
});

test("群組先於成員寫入（FK 順序）", () => {
  const snap = snapshot("order", {
    members: [{ post_id: 5, group_id: "lg_x", joined_at: "2026-09-26T00:00:00.000Z" }],
  });
  const db = new DatabaseSync(snap);
  db.prepare("INSERT INTO listing_groups(group_id, primary_post_id, created_at, updated_at, confirmation_level) VALUES (?,?,?,?,?)")
    .run("lg_x", 5, "2026-09-01T00:00:00.000Z", "2026-09-26T00:00:00.000Z", "auto_confirmed");
  db.close();
  const out = path.join(dir, "order.sql");
  execFileSync("node", [SCRIPT, "--snapshot", snap, "--pg-keys", pgKeys("order"), "--out", out], { encoding: "utf8" });
  const sql = readFileSync(out, "utf8");
  assert.ok(sql.indexOf("INSERT INTO listing_groups") < sql.indexOf("INSERT INTO listing_group_members"), "群組要先寫");
});
