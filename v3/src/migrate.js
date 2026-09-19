// Ordered versioned migration framework (Phase 6). Replaces the scattered
// `ALTER TABLE ... try/catch` ad-hoc migrations in db.js.
//
// Each migration is an ordered, transactional, forward step with an optional
// down (rollback) and a safety classification. Applied versions are recorded
// in schema_migrations so re-running never double-applies.
//
// The runner is synchronous (matches node:sqlite); the schema DDL is provided
// for both SQLite and PostgreSQL so the same migrations drive either adapter.

export const SCHEMA_MIGRATIONS_DDL_SQLITE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  safety TEXT NOT NULL DEFAULT 'safe'
);
`;

export const SCHEMA_MIGRATIONS_DDL_PG = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  safety TEXT NOT NULL DEFAULT 'safe'
);
`;

export function ensureSchemaMigrations(db) {
  db.exec(SCHEMA_MIGRATIONS_DDL_SQLITE);
}

export function listAppliedMigrations(db) {
  ensureSchemaMigrations(db);
  return db.prepare("SELECT version, name, applied_at, safety FROM schema_migrations ORDER BY version").all();
}

export function appliedMigrationVersions(db) {
  return new Set(listAppliedMigrations(db).map((row) => Number(row.version)));
}

function normalize(migrations) {
  const sorted = [...(migrations || [])].sort((a, b) => Number(a.version) - Number(b.version));
  const seen = new Set();
  for (const m of sorted) {
    if (seen.has(Number(m.version))) {
      throw new Error(`duplicate migration version ${m.version}`);
    }
    seen.add(Number(m.version));
    if (typeof m.up !== "function") {
      throw new Error(`migration ${m.version} (${m.name}) is missing up()`);
    }
  }
  return sorted;
}

// Applies pending migrations forward, each in its own transaction.
export function runMigrations(db, migrations, { direction = "up", now = () => new Date().toISOString() } = {}) {
  ensureSchemaMigrations(db);
  const applied = appliedMigrationVersions(db);
  const ordered = normalize(migrations);
  const result = { applied: [], skipped: [], failed: null };
  for (const migration of ordered) {
    const version = Number(migration.version);
    if (applied.has(version)) {
      result.skipped.push(version);
      continue;
    }
    const fn = direction === "down" ? migration.down : migration.up;
    if (typeof fn !== "function") {
      throw new Error(`migration ${version} (${migration.name}) has no ${direction}()`);
    }
    db.exec("BEGIN");
    try {
      fn(db);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at, safety) VALUES (?, ?, ?, ?)",
      ).run(version, migration.name, now(), migration.safety || "safe");
      db.exec("COMMIT");
      result.applied.push(version);
    } catch (err) {
      db.exec("ROLLBACK");
      result.failed = { version, name: migration.name, error: String(err?.message || err) };
      throw Object.assign(new Error(`migration ${version} (${migration.name}) failed: ${err?.message || err}`), {
        migration: result.failed,
      });
    }
  }
  return result;
}

// Verifies every expected migration is applied (and reports any extras).
export function verifyMigrations(db, migrations) {
  const expected = new Set(normalize(migrations).map((m) => Number(m.version)));
  const applied = listAppliedMigrations(db);
  const appliedVersions = new Set(applied.map((row) => Number(row.version)));
  const missing = [...expected].filter((v) => !appliedVersions.has(v));
  const extra = [...appliedVersions].filter((v) => !expected.has(v));
  return { ok: missing.length === 0, missing, extra, applied: applied.map((row) => Number(row.version)) };
}
