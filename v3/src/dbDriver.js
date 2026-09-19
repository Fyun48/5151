// DB driver selection + interface (Phase 5). Lets domain code target either
// SQLite (node:sqlite, synchronous — current default) or PostgreSQL (pg,
// asynchronous — the target) without hard-coding a driver.
//
// The synchronous interface mirrors node:sqlite DatabaseSync so the SQLite
// path is a drop-in:
//   exec(sql) / prepare(sql).run|get|all(...) / close()
// PostgreSQL is asynchronous and will be wired once domain code migrates off
// the synchronous hot path (the SQL is already portable in most modules).

export function resolveDbDriver(env = process.env) {
  const raw = String(env.DB_DRIVER || "sqlite").trim().toLowerCase();
  if (raw === "postgres" || raw === "postgresql" || raw === "pg") return "postgres";
  return "sqlite";
}

// Synchronous driver factory. For postgres, returns a clearly-labelled stub
// (pg is async; do not silently fall back).
export async function createDb({ driver = resolveDbDriver(), dataDir, connectionString } = {}) {
  if (driver === "postgres") {
    const { createPostgresDriver } = await import("./dbDriverPostgres.js");
    return createPostgresDriver({ connectionString });
  }
  const { DatabaseSync } = await import("node:sqlite");
  if (!dataDir) throw new Error("createDb(sqlite) requires dataDir");
  return new DatabaseSync(dataDir);
}

// SQL dialect helpers so queries stay driver-portable.
export function dialectOf(driver = resolveDbDriver()) {
  return driver === "postgres" ? "postgres" : "sqlite";
}

export function nowExpr(dialect = "sqlite") {
  return dialect === "postgres" ? "now()" : "datetime('now')";
}

export function upsertClause(dialect = "sqlite") {
  return dialect === "postgres" ? "ON CONFLICT DO NOTHING" : "ON CONFLICT DO NOTHING";
}
