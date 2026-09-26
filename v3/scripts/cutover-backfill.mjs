#!/usr/bin/env node
// 切換前補遷：把「只存在於本機 SQLite」的業務列補進 PostgreSQL。
//
// 為什麼是「產生 SQL」而不是直接連 PG：這樣不需要在目標機器上裝 pg 模組，也不需要把
// PG 連線字串交給腳本；實際套用由 psql 執行，dry-run 與套用走完全同一份 SQL 文字。
//
// 用法：
//   node cutover-backfill.mjs --snapshot <sqlite snapshot> --pg-keys <dir> [--out backfill.sql] [--report r.json]
//
//   --pg-keys 目錄內放每個表的 `<table>.keys`（PG 現有主鍵，一行一鍵，欄位以 TAB 分隔）。
//   不給 --out 就是 dry-run：只印摘要，不產生任何 SQL。
//
// 安全性：
//   - 只 INSERT PG 缺少的列，且用 ON CONFLICT DO NOTHING（重跑不會重複、不會覆蓋既有列）。
//   - **不刪除、不更新、不 DROP**；PG 較新的列不會被舊 SQLite 覆蓋。
//   - 只讀 SQLite 快照（readOnly），不碰執行中的正式 SQLite。
//   - 群組必須先於成員寫入（listing_group_members 對 listing_groups 有 FK）。
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// 每張表：主鍵欄位、要複製的欄位、寫入順序（先父表）、以及同一個鍵出現在多份快照時
// 用來挑「較新」的欄位（ISO 時間字串可直接比大小）。沒有 freshness 欄位的表就取第一份，
// 並在報告中標記 chosen_without_freshness。
const TABLES = [
  { name: "settings", key: ["key"], cols: ["key", "value"] },
  { name: "user_settings", key: ["user_id", "key"], cols: ["user_id", "key", "value"] },
  {
    name: "user_listing_flags",
    key: ["user_id", "post_id"],
    cols: ["user_id", "post_id", "viewed", "watched", "hidden", "watch_note",
      "viewed_at", "watched_at", "hidden_at", "watch_group_id"],
    fresh: ["hidden_at", "watched_at", "viewed_at"],
  },
  {
    name: "listing_groups",
    key: ["group_id"],
    cols: ["group_id", "primary_post_id", "created_at", "updated_at",
      "confirmation_level", "confirmed_by", "confirmed_at"],
    fresh: ["updated_at"],
  },
  {
    name: "listing_group_members",
    key: ["post_id"],
    cols: ["post_id", "group_id", "source", "match_confidence", "match_evidence", "joined_at"],
    fresh: ["joined_at"],
  },
];

function parseArgs(argv) {
  const out = { snapshot: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    const value = next && !next.startsWith("--") ? next : true;
    if (value !== true) i += 1;
    if (name === "snapshot") out.snapshot.push(value);
    else out[name] = value;
  }
  return out;
}

const args = parseArgs(process.argv);
if (!args.snapshot.length || !args["pg-keys"]) {
  console.error("usage: cutover-backfill.mjs --snapshot <db> [--snapshot <db>…] --pg-keys <dir> [--out file.sql] [--report file.json]");
  process.exit(2);
}

function loadPgKeys(dir, table) {
  try {
    const text = readFileSync(path.join(dir, `${table}.keys`), "utf8");
    const set = new Set();
    for (const line of text.split("\n")) {
      const trimmed = line.replace(/\r$/, "");
      if (trimmed) set.add(trimmed);
    }
    return set;
  } catch {
    return null;
  }
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

const connections = args.snapshot.map((file) => ({ file, db: new DatabaseSync(file, { readOnly: true }) }));
const statements = [];
const report = {
  snapshots: args.snapshot,
  dryRun: !args.out,
  tables: [],
  totals: { missing: 0, chosenAcrossSnapshots: 0, chosenWithoutFreshness: 0, skippedNoPgKeys: 0 },
};

for (const table of TABLES) {
  const pgKeys = loadPgKeys(args["pg-keys"], table.name);
  if (!pgKeys) {
    report.tables.push({ table: table.name, note: "no PG key file; skipped" });
    report.totals.skippedNoPgKeys += 1;
    continue;
  }
  // 同一個主鍵可能出現在多份快照；用 freshness 欄位挑較新的一份，並記錄挑選次數。
  const candidates = new Map();
  let sqliteRows = 0;
  for (const conn of connections) {
    const rows = conn.db.prepare(`SELECT ${table.cols.join(", ")} FROM "${table.name}"`).all();
    sqliteRows += rows.length;
    for (const row of rows) {
      const key = table.key.map((c) => String(row[c])).join("\t");
      if (pgKeys.has(key)) continue;
      const prev = candidates.get(key);
      if (!prev) {
        candidates.set(key, { row, source: conn.file, chosenAcrossSnapshots: false });
        continue;
      }
      prev.chosenAcrossSnapshots = true;
      const stamp = (entry) => (table.fresh || [])
        .map((c) => String(entry.row[c] || ""))
        .sort()
        .pop() || "";
      if (!table.fresh) {
        prev.chosenWithoutFreshness = true;
        continue;
      }
      if (stamp({ row }) > stamp(prev)) Object.assign(prev, { row, source: conn.file });
    }
  }

  const entries = [...candidates.values()];
  report.totals.missing += entries.length;
  report.totals.chosenAcrossSnapshots += entries.filter((e) => e.chosenAcrossSnapshots).length;
  report.totals.chosenWithoutFreshness += entries.filter((e) => e.chosenWithoutFreshness).length;
  report.tables.push({
    table: table.name,
    sqliteRows,
    pgRows: pgKeys.size,
    missing: entries.length,
    chosenAcrossSnapshots: entries.filter((e) => e.chosenAcrossSnapshots).length,
  });
  if (entries.length && args.out) {
    const colList = table.cols.join(", ");
    statements.push(`-- ${table.name}: ${entries.length} 列只存在於 SQLite，補進 PG（不覆蓋既有列）`);
    for (const { row } of entries) {
      const values = table.cols.map((c) => sqlLiteral(row[c])).join(", ");
      statements.push(
        `INSERT INTO ${table.name} (${colList}) VALUES (${values}) ON CONFLICT DO NOTHING;`,
      );
    }
    statements.push("");
  }
}

for (const conn of connections) conn.db.close();

if (args.out) {
  const header = [
    "-- 由 v3/scripts/cutover-backfill.mjs 產生（dry-run 與套用同一份文字）",
    `-- snapshot: ${args.snapshot}`,
    "-- 只做 INSERT ... ON CONFLICT DO NOTHING；不含 UPDATE／DELETE／DDL",
    "",
  ];
  writeFileSync(args.out, [...header, ...statements].join("\n"));
}
if (args.report) writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);

console.log(JSON.stringify(report, null, 2));
