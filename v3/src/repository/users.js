// Users repository (Phase 5). Extracts the member accounts domain into a
// driver-agnostic async interface. Unlike the key-value stores, this one is
// auth/CRUD shaped: lookup by email or id, create, and password-hash update.
// Password hashing/verification stays in the domain (password.js / members.js);
// the repository only stores the hash.
//
//   Domain  ->  UsersRepository (interface)  ->  SQLite | PostgreSQL
//
// Interface (async):
//   findByEmail(email) -> user | null
//   findById(userId) -> user | null
//   create({ email, passwordHash, role, plan }) -> user
//   setPasswordHash(userId, hash) -> void
//   list() -> Array<user>
import { resolveDbDriver } from "../dbDriver.js";

const USERS_TABLE = "users";
const USER_COLS = `id, email, password_hash, role, plan, created_at`;

export function createSqliteUsersRepository(db) {
  return {
    name: "sqlite",
    async findByEmail(email) {
      const row = db.prepare(`SELECT ${USER_COLS} FROM ${USERS_TABLE} WHERE email = ?`)
        .get(String(email || "").trim().toLowerCase());
      return row || null;
    },
    async findById(userId) {
      const row = db.prepare(`SELECT ${USER_COLS} FROM ${USERS_TABLE} WHERE id = ?`)
        .get(Number(userId) || 0);
      return row || null;
    },
    async create({ email, passwordHash = "", role = "member", plan = "free" } = {}) {
      const row = db.prepare(
        `INSERT INTO ${USERS_TABLE} (email, password_hash, role, plan, created_at)
         VALUES (?, ?, ?, ?, ?)
         RETURNING ${USER_COLS}`,
      ).get(
        String(email || "").trim().toLowerCase(),
        String(passwordHash),
        role === "admin" ? "admin" : "member",
        plan === "sponsor" ? "sponsor" : "free",
        new Date().toISOString(),
      );
      return row || null;
    },
    async setPasswordHash(userId, hash) {
      db.prepare(`UPDATE ${USERS_TABLE} SET password_hash = ? WHERE id = ?`)
        .run(String(hash), Number(userId) || 0);
    },
    async list() {
      return db.prepare(`SELECT ${USER_COLS} FROM ${USERS_TABLE} ORDER BY id`).all();
    },
  };
}

export function createPostgresUsersRepository(pool) {
  return {
    name: "postgres",
    async findByEmail(email) {
      const { rows } = await pool.query(`SELECT ${USER_COLS} FROM ${USERS_TABLE} WHERE email = $1`, [
        String(email || "").trim().toLowerCase(),
      ]);
      return rows[0] || null;
    },
    async findById(userId) {
      const { rows } = await pool.query(`SELECT ${USER_COLS} FROM ${USERS_TABLE} WHERE id = $1`, [Number(userId) || 0]);
      return rows[0] || null;
    },
    async create({ email, passwordHash = "", role = "member", plan = "free" } = {}) {
      const { rows } = await pool.query(
        `INSERT INTO ${USERS_TABLE} (email, password_hash, role, plan, created_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${USER_COLS}`,
        [
          String(email || "").trim().toLowerCase(),
          String(passwordHash),
          role === "admin" ? "admin" : "member",
          plan === "sponsor" ? "sponsor" : "free",
          new Date().toISOString(),
        ],
      );
      return rows[0] || null;
    },
    async setPasswordHash(userId, hash) {
      await pool.query(`UPDATE ${USERS_TABLE} SET password_hash = $1 WHERE id = $2`, [String(hash), Number(userId) || 0]);
    },
    async list() {
      const { rows } = await pool.query(`SELECT ${USER_COLS} FROM ${USERS_TABLE} ORDER BY id`);
      return rows;
    },
  };
}

export function createUsersRepository({ driver = resolveDbDriver(), sqliteDb = null, pgPool = null } = {}) {
  if (driver === "postgres") {
    if (!pgPool) throw new Error("createUsersRepository(postgres) requires pgPool");
    return createPostgresUsersRepository(pgPool);
  }
  if (!sqliteDb) throw new Error("createUsersRepository(sqlite) requires sqliteDb");
  return createSqliteUsersRepository(sqliteDb);
}
