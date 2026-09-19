// PostgreSQL driver adapter (Phase 5). Asynchronous — the synchronous hot path
// is SQLite-only for now. Wired once domain code migrates off node:sqlite and
// `pg` is added as a dependency.
export async function createPostgresDriver({ connectionString } = {}) {
  if (!connectionString) throw new Error("createPostgresDriver requires a connectionString");
  let pg;
  try {
    pg = await import("pg");
  } catch {
    throw new Error("pg package is not installed; run `npm install pg` to enable DB_DRIVER=postgres");
  }
  const pool = new pg.Pool({ connectionString });
  return {
    dialect: "postgres",
    async query(text, params) { return pool.query(text, params); },
    async exec(sql) { await pool.query(sql); },
    async close() { await pool.end(); },
  };
}
