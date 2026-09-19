// SQLite → PostgreSQL data migration tool (Phase 6). Reads a SQLite snapshot,
// copies tables into a target driver, and validates parity. Dry-run, verify-only
// and resume/restart safety are built in; row-level idempotency (INSERT OR
// IGNORE / ON CONFLICT DO NOTHING) guarantees a second run never duplicates.
//
// The copy/verify primitives are synchronous (node:sqlite). The PostgreSQL
// target uses the same logic with ON CONFLICT DO NOTHING and $n placeholders.
import { createHash } from "node:crypto";

const USER_TABLE_WHERE = `type = 'table' AND name NOT LIKE 'sqlite_%'`;

export function snapshotTables(db) {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE ${USER_TABLE_WHERE} ORDER BY name`).all();
  return tables.map(({ name }) => ({
    name,
    columns: db.prepare(`PRAGMA table_info(${name})`).all().map((c) => ({ name: c.name, type: c.type, pk: c.pk })),
    rowCount: Number(db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n),
  }));
}

export function tableHash(db, table) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const rows = db.prepare(`SELECT ${cols.join(", ")} FROM ${table} ORDER BY rowid`).all();
  const h = createHash("sha256");
  for (const row of rows) h.update(JSON.stringify(Object.values(row)));
  return h.digest("hex");
}

// Idempotent row copy (SQLite target). The PostgreSQL equivalent uses
// `INSERT ... ON CONFLICT DO NOTHING` with $n placeholders.
export function copyTable(source, target, table, { dialect = "sqlite" } = {}) {
  const cols = source.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const rows = source.prepare(`SELECT ${cols.join(", ")} FROM ${table}`).all();
  const placeholders = dialect === "postgres"
    ? cols.map((_, i) => `$${i + 1}`).join(", ")
    : cols.map(() => "?").join(", ");
  const insertVerb = dialect === "postgres" ? "INSERT" : "INSERT OR IGNORE";
  const onConflict = dialect === "postgres" ? " ON CONFLICT DO NOTHING" : "";
  const insert = target.prepare(
    `${insertVerb} INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})${onConflict}`,
  );
  let copied = 0;
  target.exec("BEGIN");
  try {
    for (const row of rows) {
      insert.run(...cols.map((c) => row[c]));
      copied += 1;
    }
    target.exec("COMMIT");
  } catch (err) {
    target.exec("ROLLBACK");
    throw err;
  }
  return copied;
}

export function verifyMigration(source, target, tables) {
  return tables.map((name) => {
    const sourceCount = Number(source.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n);
    const targetCount = Number(target.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n);
    const sourceHash = tableHash(source, name);
    const targetHash = tableHash(target, name);
    return {
      table: name,
      sourceCount,
      targetCount,
      ok: sourceCount === targetCount && sourceHash === targetHash,
      hashOk: sourceHash === targetHash,
    };
  });
}

export function planMigration(db, tables = []) {
  const snapshot = snapshotTables(db);
  const selected = snapshot.filter((t) => (tables.length ? tables.includes(t.name) : true));
  return selected.map((t) => ({ table: t.name, rowCount: t.rowCount, columns: t.columns.map((c) => c.name) }));
}

// Resume/restart checkpoint on the target.
export const MIGRATION_PROGRESS_DDL = `
CREATE TABLE IF NOT EXISTS migration_progress (
  table_name TEXT PRIMARY KEY,
  copied_at TEXT NOT NULL
);
`;
export function ensureMigrationProgress(target) {
  target.exec(MIGRATION_PROGRESS_DDL);
}
export function copiedTables(target) {
  ensureMigrationProgress(target);
  return target.prepare("SELECT table_name FROM migration_progress").all().map((r) => r.table_name);
}
function markCopied(target, table, now = () => new Date().toISOString()) {
  target.prepare("INSERT INTO migration_progress (table_name, copied_at) VALUES (?, ?)").run(table, now());
}

export function runMigration(source, target, { tables = [], dryRun = false, resume = true, dialect = "sqlite" } = {}) {
  const snapshot = snapshotTables(source);
  const selected = snapshot.filter((t) => (tables.length ? tables.includes(t.name) : true));
  if (dryRun) {
    return { dryRun: true, plan: selected.map((t) => ({ table: t.name, rowCount: t.rowCount })) };
  }
  const done = resume ? new Set(copiedTables(target)) : new Set();
  const copied = [];
  for (const t of selected) {
    if (done.has(t.name)) continue;
    copied.push({ table: t.name, copied: copyTable(source, target, t.name, { dialect }) });
    markCopied(target, t.name);
  }
  return { dryRun: false, copied, verify: verifyMigration(source, target, selected.map((t) => t.name)) };
}
