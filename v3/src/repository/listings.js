// Listings search repository (PostgreSQL hot path).
//
// One interface, two drivers:
//
//   Domain (server.js / listingSearchAsync.js)
//     ↓
//   createListingsRepository({ driver })
//     ↓
//   SQLite adapter (node:sqlite, synchronous internally)  |  PostgreSQL adapter (pg, awaited)
//
// Both adapters execute the SAME statement text, produced by
// listingSearchSql.js, so ordering / envelope / cursor behaviour cannot drift
// between them. Only the placeholder style (`?` → `$n`) and the BIGINT-as-string
// normalisation differ, and both are handled here.
import { buildListingSearchSql } from "../listingSearchSql.js";
import { toPostgresSql } from "../sqlDialect.js";
import { numberFromPg } from "../dbDriverPostgres.js";
import { ensureListingSearchProjection, PROJECTION_TABLE } from "../listingSearchProjection.js";
import { ensurePgSchema } from "../pgSchema.js";

// PostgreSQL mirror of listingSearchProjection.js's SQLite DDL, used when no
// SQLite handle is available to derive the types from (the parity tests pass the
// SQLite handle and go through pgSchema instead, so both paths stay equivalent).
const PG_PROJECTION_DDL = `
CREATE TABLE IF NOT EXISTS ${PROJECTION_TABLE} (
  post_id BIGINT PRIMARY KEY,
  district TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  kind_keys TEXT NOT NULL DEFAULT '',
  rent BIGINT NOT NULL DEFAULT 0,
  total_monthly_cost BIGINT NOT NULL DEFAULT 0,
  area DOUBLE PRECISION,
  floor BIGINT,
  total_floors BIGINT,
  elevator BIGINT NOT NULL DEFAULT 0,
  parking BIGINT NOT NULL DEFAULT 0,
  rooftop BIGINT NOT NULL DEFAULT 0,
  low_floor BIGINT NOT NULL DEFAULT 0,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  location_class TEXT NOT NULL DEFAULT '',
  primary_listing_id BIGINT NOT NULL DEFAULT 0,
  offline_state BIGINT NOT NULL DEFAULT 0,
  commute_km DOUBLE PRECISION,
  updated_at BIGINT NOT NULL DEFAULT 0
)`;

const PG_PROJECTION_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_proj_updated_at ON ${PROJECTION_TABLE}(updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_proj_total_cost ON ${PROJECTION_TABLE}(total_monthly_cost)`,
  `CREATE INDEX IF NOT EXISTS idx_proj_district ON ${PROJECTION_TABLE}(district)`,
  `CREATE INDEX IF NOT EXISTS idx_proj_commute ON ${PROJECTION_TABLE}(commute_km)`,
];

// F3：CREATE TABLE IF NOT EXISTS 不會替既有表補欄位（pgSchema.js 只做 CREATE，沒有 ALTER），
// 所以在同一個迴圈裡補 idempotent 遷移，否則新欄位會讓 upsert 多送一個值而整批失敗。
const PG_PROJECTION_MIGRATIONS = [
  // 用 `ALTER TABLE IF EXISTS` 是刻意的：ensureProjection() 會用
  // /(TABLE IF NOT EXISTS |EXISTS |ON )<table>/ 改寫成帶 schema 的形式，
  // 這個寫法才會被正確加上 schema（在帶 schema 的環境才不會打錯表）。
  `ALTER TABLE IF EXISTS ${PROJECTION_TABLE} ADD COLUMN IF NOT EXISTS kind_keys TEXT NOT NULL DEFAULT ''`,
];

export const LISTINGS_REPOSITORY_TABLES = ["listings", "user_listing_flags", PROJECTION_TABLE];

export function createListingsRepository({
  driver = "sqlite",
  sqliteDb = null,
  pgDriver = null,
  deps = null,
  schema = "",
  buildSql = buildListingSearchSql,
} = {}) {
  if (driver === "postgres") {
    if (!pgDriver) throw new Error("createListingsRepository(postgres) requires pgDriver");
    return createPostgresListingsRepository({ pgDriver, deps, schema, buildSql });
  }
  if (!sqliteDb) throw new Error("createListingsRepository(sqlite) requires sqliteDb");
  return createSqliteListingsRepository({ sqliteDb, deps, buildSql });
}

function pageEnvelope(built, plan, rows, totalMatched, driver) {
  const last = rows.length ? rows[rows.length - 1] : null;
  return {
    driver,
    ids: rows.map((row) => numberFromPg(row.post_id)).map(Number),
    totalMatched,
    pageSize: plan.pageSize,
    start: plan.start,
    useCursor: plan.useCursor,
    hasMore: plan.useCursor ? rows.length === plan.pageSize : plan.start + plan.pageSize < totalMatched,
    nextOffset: plan.start + plan.pageSize,
    nextCursor: last ? built.cursorOf(last) : null,
    queryVersion: 3,
  };
}

async function searchWith({ execute, buildSql, deps, args, driver }) {
  const built = buildSql(args || {}, deps);
  if (!built.ok) return null;
  const countRow = await execute(built.countQuery.sql, built.countQuery.params, { one: true });
  const totalMatched = Number(countRow?.n) || 0;
  const plan = built.pageQuery({
    limit: args?.limit,
    offset: args?.offset,
    cursor: args?.cursor ?? null,
  });
  const rows = await execute(plan.sql, plan.params);
  return pageEnvelope(built, plan, rows, totalMatched, driver);
}

function idPlaceholders(ids, driver) {
  return ids.map((_, i) => (driver === "postgres" ? `$${i + 1}` : "?")).join(", ");
}

function createSqliteListingsRepository({ sqliteDb, deps, buildSql }) {
  const execute = async (sql, params = [], { one = false } = {}) => {
    const statement = sqliteDb.prepare(sql);
    return one ? statement.get(...params) : statement.all(...params);
  };
  return {
    driver: "sqlite",
    async searchPage(args) {
      return searchWith({ execute, buildSql, deps, args, driver: "sqlite" });
    },
    async hydrate(ids) {
      if (!ids.length) return [];
      const rows = sqliteDb
        .prepare(`SELECT * FROM listings WHERE post_id IN (${idPlaceholders(ids, "sqlite")})`)
        .all(...ids);
      const byId = new Map(rows.map((row) => [Number(row.post_id), row]));
      return ids.map((id) => byId.get(Number(id))).filter(Boolean);
    },
    async ensureProjection() {
      ensureListingSearchProjection(sqliteDb);
      return [PROJECTION_TABLE];
    },
  };
}

function createPostgresListingsRepository({ pgDriver, deps, schema = "", buildSql }) {
  // Table names are NOT rewritten here: the SQL from the shared builder also
  // references tables this module does not know about (listing_prep, and any
  // table a future visibility clause adds), so the connection's search_path is
  // the only place schema scoping belongs. Callers pass a driver configured with
  // `poolOptions: { options: "-c search_path=<schema>" }` when they need
  // isolation; the default (public/search_path of the server) works unchanged.
  const execute = async (sql, params = [], { one = false } = {}) => {
    const res = await pgDriver.query(toPostgresSql(sql), params);
    return one ? res.rows[0] ?? null : res.rows;
  };
  return {
    driver: "postgres",
    async searchPage(args) {
      return searchWith({ execute, buildSql, deps, args, driver: "postgres" });
    },
    async hydrate(ids) {
      if (!ids.length) return [];
      const res = await pgDriver.query(
        `SELECT * FROM listings WHERE post_id IN (${idPlaceholders(ids, "postgres")})`,
        ids,
      );
      const byId = new Map(res.rows.map((row) => [Number(row.post_id), row]));
      return ids.map((id) => byId.get(Number(id))).filter(Boolean);
    },
    async ensureProjection() {
      if (deps?.sqliteDb) {
        return ensurePgSchema(pgDriver, deps.sqliteDb, { schema, tables: [PROJECTION_TABLE] });
      }
      await pgDriver.exec(schema ? `CREATE SCHEMA IF NOT EXISTS ${schema}` : "SELECT 1");
      for (const statement of [PG_PROJECTION_DDL, ...PG_PROJECTION_INDEXES, ...PG_PROJECTION_MIGRATIONS]) {
        await pgDriver.exec(statement.replace(
          new RegExp(`(TABLE IF NOT EXISTS |EXISTS |ON )${PROJECTION_TABLE}`, "g"),
          `$1${schema ? `${schema}.` : ""}${PROJECTION_TABLE}`,
        ));
      }
      return [schema ? `${schema}.${PROJECTION_TABLE}` : PROJECTION_TABLE];
    },
  };
}
