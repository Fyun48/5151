// Flags repository (Phase 5). Extracts the per-user listing flags domain
// (viewed / watched / hidden / watch_note) into a driver-agnostic async
// interface, mirroring the settings repository: domain code depends on the
// interface, not on node:sqlite or SQL dialect.
//
//   Domain  ->  FlagsRepository (interface)  ->  SQLite | PostgreSQL
//
// Interface (async):
//   get(userId, postId) -> row | null
//   set(userId, postId, flags) -> void
//   map(userId) -> Array<{ post_id, viewed, watched, hidden, watch_note }>
//   delete(userId, postId) -> boolean
import { resolveDbDriver } from "../dbDriver.js";

const FLAGS_TABLE = "user_listing_flags";

const FLAG_COLS = `viewed, watched, hidden, watch_note, viewed_at, watched_at, hidden_at`;

export function createSqliteFlagsRepository(db) {
  return {
    name: "sqlite",
    async get(userId, postId) {
      const row = db.prepare(`SELECT ${FLAG_COLS} FROM ${FLAGS_TABLE} WHERE user_id = ? AND post_id = ?`)
        .get(Number(userId) || 0, Number(postId) || 0);
      return row || null;
    },
    async set(userId, postId, flags = {}) {
      db.prepare(
        `INSERT INTO ${FLAGS_TABLE} (user_id, post_id, viewed, watched, hidden, watch_note, viewed_at, watched_at, hidden_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, post_id) DO UPDATE SET
           viewed = excluded.viewed,
           watched = excluded.watched,
           hidden = excluded.hidden,
           watch_note = excluded.watch_note,
           viewed_at = excluded.viewed_at,
           watched_at = excluded.watched_at,
           hidden_at = excluded.hidden_at`,
      ).run(
        Number(userId) || 0,
        Number(postId) || 0,
        Number(flags.viewed) || 0,
        Number(flags.watched) || 0,
        Number(flags.hidden) || 0,
        String(flags.watch_note ?? ""),
        flags.viewed_at ?? null,
        flags.watched_at ?? null,
        flags.hidden_at ?? null,
      );
    },
    async map(userId) {
      return db.prepare(
        `SELECT post_id, viewed, watched, hidden, watch_note FROM ${FLAGS_TABLE} WHERE user_id = ? ORDER BY post_id`,
      ).all(Number(userId) || 0);
    },
    async delete(userId, postId) {
      const result = db.prepare(`DELETE FROM ${FLAGS_TABLE} WHERE user_id = ? AND post_id = ?`)
        .run(Number(userId) || 0, Number(postId) || 0);
      return Number(result.changes) > 0;
    },
  };
}

export function createPostgresFlagsRepository(pool) {
  return {
    name: "postgres",
    async get(userId, postId) {
      const { rows } = await pool.query(
        `SELECT ${FLAG_COLS} FROM ${FLAGS_TABLE} WHERE user_id = $1 AND post_id = $2`,
        [Number(userId) || 0, Number(postId) || 0],
      );
      return rows[0] || null;
    },
    async set(userId, postId, flags = {}) {
      await pool.query(
        `INSERT INTO ${FLAGS_TABLE} (user_id, post_id, viewed, watched, hidden, watch_note, viewed_at, watched_at, hidden_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (user_id, post_id) DO UPDATE SET
           viewed = EXCLUDED.viewed,
           watched = EXCLUDED.watched,
           hidden = EXCLUDED.hidden,
           watch_note = EXCLUDED.watch_note,
           viewed_at = EXCLUDED.viewed_at,
           watched_at = EXCLUDED.watched_at,
           hidden_at = EXCLUDED.hidden_at`,
        [
          Number(userId) || 0,
          Number(postId) || 0,
          Number(flags.viewed) || 0,
          Number(flags.watched) || 0,
          Number(flags.hidden) || 0,
          String(flags.watch_note ?? ""),
          flags.viewed_at ?? null,
          flags.watched_at ?? null,
          flags.hidden_at ?? null,
        ],
      );
    },
    async map(userId) {
      const { rows } = await pool.query(
        `SELECT post_id, viewed, watched, hidden, watch_note FROM ${FLAGS_TABLE} WHERE user_id = $1 ORDER BY post_id`,
        [Number(userId) || 0],
      );
      return rows;
    },
    async delete(userId, postId) {
      const result = await pool.query(
        `DELETE FROM ${FLAGS_TABLE} WHERE user_id = $1 AND post_id = $2`,
        [Number(userId) || 0, Number(postId) || 0],
      );
      return result.rowCount === 1;
    },
  };
}

export function createFlagsRepository({ driver = resolveDbDriver(), sqliteDb = null, pgPool = null } = {}) {
  if (driver === "postgres") {
    if (!pgPool) throw new Error("createFlagsRepository(postgres) requires pgPool");
    return createPostgresFlagsRepository(pgPool);
  }
  if (!sqliteDb) throw new Error("createFlagsRepository(sqlite) requires sqliteDb");
  return createSqliteFlagsRepository(sqliteDb);
}
