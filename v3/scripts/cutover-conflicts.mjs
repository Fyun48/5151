#!/usr/bin/env node
// 切換前衝突處置：只處理「有可靠規則」的內容衝突，其餘一律列出交給 Owner。
//
// 為什麼不自動全解：95 筆衝突裡有 16 筆兩邊時間戳相同、狀態卻不同（會員的收藏／隱藏）或
// 是沒有更新時間的站台內容設定。那些用規則猜會直接改到會員資料與站台文案，所以本腳本
// **只**產生三種可辯護的處置，其餘只回報。
//
// 規則：
//   R1 listing_groups：只有「SQLite 的確認等級高於 PG」才升級（suspected < auto < admin）。
//      絕不降級，所以 PG 已是 admin_confirmed 時一定不動。primary_post_id／updated_at
//      是 watcher 每輪重算的衍生欄位，不覆寫。
//   R2 有可靠時間戳的鍵：SQLite 最新快照的時間戳比 PG 新才更新（反之不動）。
//   R3 其餘（無時間戳、或時間戳相同但內容不同）→ 只列進報告，不產生 SQL。
//
// 用法：
//   node cutover-conflicts.mjs --pg-values <psql TSV> --conflicts <dir> \
//        --snapshot <db> [--snapshot <db>…] [--out conflicts.sql] [--report r.json]
//
// --pg-values 由 psql 產生（-At -F'\t'），每個表一段，段首為 `## <table>`，欄位順序見 COLS。
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";

// PG 值檔的欄位順序（與產出它的 psql 指令一致）。
const COLS = {
  settings: ["key", "value"],
  user_settings: ["user_id", "key", "value"],
  user_listing_flags: ["user_id", "post_id", "viewed", "watched", "hidden", "watch_note",
    "viewed_at", "watched_at", "hidden_at", "watch_group_id"],
  listing_groups: ["group_id", "primary_post_id", "confirmation_level", "confirmed_by", "updated_at"],
};
// 每個表的主鍵欄位數（用來切出鍵與值）。
const KEYLEN = { settings: 1, user_settings: 2, user_listing_flags: 2, listing_groups: 1 };

// 確認等級的排序：只升不降。
const LEVEL_RANK = { suspected: 1, auto_confirmed: 2, admin_confirmed: 3 };

// 有可靠時間戳的鍵（可用 R2）；其餘一律列 Owner。
const TS_RULES = {
  settings: { timestampOf: (row) => row.value, keys: ["siteCatalogStats", "lastCoveringAt", "lastSystemCoveringAt"] },
  user_settings: { timestampOf: (row) => row.value, keys: ["memberFetchDueAt"] },
  user_listing_flags: {
    timestampOf: (row) => [row.hidden_at, row.watched_at, row.viewed_at].filter(Boolean).sort().pop() || "",
    keys: "*",
  },
};

function parseArgs(argv) {
  const out = { snapshot: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (!t.startsWith("--")) continue;
    const name = t.slice(2);
    const next = argv[i + 1];
    const value = next && !next.startsWith("--") ? next : true;
    if (value !== true) i += 1;
    if (name === "snapshot") out.snapshot.push(value);
    else out[name] = value;
  }
  return out;
}

const args = parseArgs(process.argv);
if (!args["pg-values"] || !args.conflicts || !args.snapshot.length) {
  console.error("usage: cutover-conflicts.mjs --pg-values <file> --conflicts <dir> --snapshot <db> [--snapshot <db>…] [--out sql] [--report json]");
  process.exit(2);
}

function loadPgValues(file) {
  const byTable = {};
  let cur = null;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("## ")) {
      cur = line.slice(3).trim();
      byTable[cur] = new Map();
      continue;
    }
    if (!line || !cur) continue;
    const parts = line.split("\t");
    const n = KEYLEN[cur];
    if (!n) continue;
    const cols = COLS[cur];
    const row = {};
    cols.forEach((c, idx) => { row[c] = parts[idx] ?? ""; });
    byTable[cur].set(parts.slice(0, n).join("\t"), row);
  }
  return byTable;
}

function loadKeys(dir, table) {
  try {
    return readFileSync(`${dir}/${table}.conflicts`, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

const iso = (s) => {
  const m = String(s || "").match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/);
  return m ? m[0] : "";
};
const sqlText = (v) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);

const pgValues = loadPgValues(args["pg-values"]);
const connections = args.snapshot.map((f) => ({ f, db: new DatabaseSync(f, { readOnly: true }) }));
const statements = [];
// 三個分桶：applied = 這次會寫入；no_action = 規則判定保留 PG（不需要人決定）；
// owner = 規則涵蓋不到、必須由 Owner 決定。把 no_action 併進 owner 會讓待決清單看起來
// 比實際大很多（例如 72 筆群組只是衍生欄位不覆寫）。
const report = { applied: [], no_action: [], owner: [] };

// R1：群組確認等級只升不降。
const groupKeys = loadKeys(args.conflicts, "listing_groups");
if (groupKeys.length && pgValues.listing_groups) {
  for (const key of groupKeys) {
    const pgRow = pgValues.listing_groups.get(key);
    if (!pgRow) continue;
    const where = COLS.listing_groups.map((c) => `${c} = ?`).join(" AND ");
    let best = null;
    for (const conn of connections) {
      const row = conn.db.prepare(`SELECT confirmation_level, confirmed_by FROM listing_groups WHERE group_id = ?`).get(key);
      if (row && (LEVEL_RANK[row.confirmation_level] || 0) > (LEVEL_RANK[pgRow.confirmation_level] || 0)) {
        if (!best || LEVEL_RANK[row.confirmation_level] > LEVEL_RANK[best.confirmation_level]) best = row;
      }
    }
    if (best) {
      const set = [`confirmation_level = ${sqlText(best.confirmation_level)}`];
      if (best.confirmation_level === "admin_confirmed" && best.confirmed_by != null) {
        set.push(`confirmed_by = ${Number(best.confirmed_by) || "NULL"}`);
      }
      statements.push(`UPDATE listing_groups SET ${set.join(", ")} WHERE group_id = ${sqlText(key)} AND confirmation_level = ${sqlText(pgRow.confirmation_level)};`);
      report.applied.push({ table: "listing_groups", key, rule: "R1_upgrade_only", from: pgRow.confirmation_level, to: best.confirmation_level });
    } else {
      report.no_action.push({ table: "listing_groups", key, note: "確認等級未提高；primary_post_id／updated_at 為 watcher 會重算的衍生欄位，不覆寫" });
    }
  }
}

// R2：有可靠時間戳的鍵，只有 SQLite 較新才更新。
for (const [table, rule] of Object.entries(TS_RULES)) {
  const keys = loadKeys(args.conflicts, table);
  if (!keys.length || !pgValues[table]) continue;
  for (const key of keys) {
    const parts = key.split("\t");
    const keyCols = COLS[table].slice(0, KEYLEN[table]);
    if (rule.keys !== "*" && !rule.keys.includes(parts[parts.length - 1])) {
      // 沒有可靠時間戳可判的鍵（站台內容、會員通知設定）→ 交給 Owner，不套規則。
      report.owner.push({ table, key, note: "沒有可靠時間戳，需 Owner 決定" });
      continue;
    }
    const pgRow = pgValues[table].get(key);
    if (!pgRow) continue;
    const where = keyCols.map((c) => `${c} = ?`).join(" AND ");
    let newest = null;
    for (const conn of connections) {
      const row = conn.db.prepare(`SELECT * FROM ${table} WHERE ${where}`).get(...parts);
      if (!row) continue;
      const t = iso(rule.timestampOf(row));
      if (!newest || (t && t > newest.t)) newest = { t, row };
    }
    const pgT = iso(rule.timestampOf(pgRow));
    // 時間戳相同、內容卻不同 → 無法判斷哪一邊是最後動作（會員的收藏／隱藏就屬這類），
    // 這種不能套規則，交給 Owner。
    if (newest && newest.t && pgT && newest.t === pgT) {
      report.owner.push({ table, key, note: `兩邊時間戳相同（${pgT}）但內容不同，需 Owner 決定` });
      continue;
    }
    if (newest && newest.t && pgT && newest.t > pgT) {
      const setCols = table === "user_listing_flags"
        ? ["viewed", "watched", "hidden", "watch_note", "viewed_at", "watched_at", "hidden_at"]
        : ["value"];
      const set = setCols.map((c) => `${c} = ${sqlText(newest.row[c])}`).join(", ");
      const params = parts.map((p, i) => (Number.isFinite(Number(p)) && ["user_id", "post_id"].includes(keyCols[i]) ? p : sqlText(p)));
      statements.push(`UPDATE ${table} SET ${set} WHERE ${keyCols.map((c, i) => `${c} = ${params[i]}`).join(" AND ")};`);
      report.applied.push({ table, key, rule: "R2_sqlite_newer", pg: pgT, sqlite: newest.t });
    } else {
      report.no_action.push({ table, key, note: `PG 未較舊（PG=${pgT || "無"}），保留 PG` });
    }
  }
}

// 規則沒有涵蓋的表（例如 listing_group_members：同一組房源在兩邊屬於不同 group_id）
// 一律列 Owner，不自行選版本。
const HANDLED = new Set(["listing_groups", ...Object.keys(TS_RULES)]);
for (const table of ["settings", "user_settings", "user_listing_flags", "listing_groups", "listing_group_members"]) {
  if (HANDLED.has(table)) continue;
  for (const key of loadKeys(args.conflicts, table)) {
    report.owner.push({ table, key, note: "沒有可靠規則可判（需 Owner 決定）" });
  }
}

for (const conn of connections) conn.db.close();

if (args.out) {
  writeFileSync(args.out, [
    "-- 由 v3/scripts/cutover-conflicts.mjs 產生",
    "-- 只有 UPDATE；不含 INSERT／DELETE／DDL，且群組確認等級只升不降",
    "",
    ...statements,
  ].join("\n") + "\n");
}
// 報告檔與 stdout 用同一份摘要（含計數），呼叫端不必自己算。
const summary = {
  appliedCount: report.applied.length,
  noActionCount: report.no_action.length,
  ownerCount: report.owner.length,
  applied: report.applied,
  countsByTable: {
    no_action: report.no_action.reduce((a, r) => ({ ...a, [r.table]: (a[r.table] || 0) + 1 }), {}),
    owner: report.owner.reduce((a, r) => ({ ...a, [r.table]: (a[r.table] || 0) + 1 }), {}),
  },
  no_action: report.no_action,
  owner: report.owner,
};
if (args.report) writeFileSync(args.report, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
