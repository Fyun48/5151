// Repository layer demonstration (Phase 5). Domain code depends on a small
// async repository interface, not on a specific driver or SQL dialect. SQLite
// works today; PostgreSQL is the target and is swapped in via DB_DRIVER.
//
//   Domain  ->  SettingsRepository (interface)  ->  SQLite | PostgreSQL
//
// Interface (async):
//   get(key) -> string | null
//   set(key, value) -> void
//   delete(key) -> void
//   all() -> Array<{ key, value }>
import { resolveDbDriver } from "../dbDriver.js";

const SETTINGS_TABLE = "settings";

export function createSqliteSettingsRepository(db) {
  return {
    name: "sqlite",
    async get(key) {
      const row = db.prepare(`SELECT value FROM ${SETTINGS_TABLE} WHERE key = ?`).get(key);
      return row ? String(row.value) : null;
    },
    async set(key, value) {
      db.prepare(
        `INSERT INTO ${SETTINGS_TABLE} (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(key, String(value));
    },
    async delete(key) {
      db.prepare(`DELETE FROM ${SETTINGS_TABLE} WHERE key = ?`).run(key);
    },
    async all() {
      return db.prepare(`SELECT key, value FROM ${SETTINGS_TABLE} ORDER BY key`).all()
        .map((row) => ({ key: row.key, value: row.value }));
    },
  };
}

export function createPostgresSettingsRepository(pool) {
  return {
    name: "postgres",
    async get(key) {
      const { rows } = await pool.query(`SELECT value FROM ${SETTINGS_TABLE} WHERE key = $1`, [key]);
      return rows.length ? String(rows[0].value) : null;
    },
    async set(key, value) {
      await pool.query(
        `INSERT INTO ${SETTINGS_TABLE} (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, String(value)],
      );
    },
    async delete(key) {
      await pool.query(`DELETE FROM ${SETTINGS_TABLE} WHERE key = $1`, [key]);
    },
    async all() {
      const { rows } = await pool.query(`SELECT key, value FROM ${SETTINGS_TABLE} ORDER BY key`);
      return rows.map((row) => ({ key: row.key, value: row.value }));
    },
  };
}

export function createSettingsRepository({ driver = resolveDbDriver(), sqliteDb = null, pgPool = null } = {}) {
  if (driver === "postgres") {
    if (!pgPool) throw new Error("createSettingsRepository(postgres) requires pgPool");
    return createPostgresSettingsRepository(pgPool);
  }
  if (!sqliteDb) throw new Error("createSettingsRepository(sqlite) requires sqliteDb");
  return createSqliteSettingsRepository(sqliteDb);
}
