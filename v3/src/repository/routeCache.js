// Route cache repository (Phase 5). Extracts the route distance cache into a
// driver-agnostic async interface, like settings but with a wider column set
// (rush-hour minutes, meters, location class, route version).
//
//   Domain  ->  RouteCacheRepository (interface)  ->  SQLite | PostgreSQL
//
// Interface (async):
//   get(routeKey) -> row | null
//   set(routeKey, route) -> void   (upsert)
//   delete(routeKey) -> boolean
import { resolveDbDriver } from "../dbDriver.js";

const ROUTE_TABLE = "route_cache";

const ROUTE_COLS = `distances, min_km, min_m, rush_am_min, rush_pm_min, rush_updated_at, updated_at, location_class, route_version`;

function bindRoute(route = {}) {
  return {
    distances: String(route.distances ?? "[]"),
    minKm: Number.isFinite(Number(route.minKm)) ? Number(route.minKm) : 0,
    minM: Number.isFinite(Number(route.minM)) ? Number(route.minM) : null,
    rushAmMin: Number.isFinite(Number(route.rushAmMin)) ? Number(route.rushAmMin) : null,
    rushPmMin: Number.isFinite(Number(route.rushPmMin)) ? Number(route.rushPmMin) : null,
    rushUpdatedAt: route.rushUpdatedAt ?? null,
    updatedAt: String(route.updatedAt ?? new Date().toISOString()),
    locationClass: route.locationClass ?? null,
    routeVersion: Number.isFinite(Number(route.routeVersion)) ? Number(route.routeVersion) : null,
  };
}

export function createSqliteRouteCacheRepository(db) {
  return {
    name: "sqlite",
    async get(routeKey) {
      const row = db.prepare(`SELECT ${ROUTE_COLS} FROM ${ROUTE_TABLE} WHERE route_key = ?`).get(String(routeKey));
      return row || null;
    },
    async set(routeKey, route = {}) {
      const b = bindRoute(route);
      db.prepare(
        `INSERT INTO ${ROUTE_TABLE} (route_key, distances, min_km, min_m, rush_am_min, rush_pm_min, rush_updated_at, updated_at, location_class, route_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(route_key) DO UPDATE SET
           distances = excluded.distances,
           min_km = excluded.min_km,
           min_m = excluded.min_m,
           rush_am_min = excluded.rush_am_min,
           rush_pm_min = excluded.rush_pm_min,
           rush_updated_at = excluded.rush_updated_at,
           updated_at = excluded.updated_at,
           location_class = excluded.location_class,
           route_version = excluded.route_version`,
      ).run(
        String(routeKey),
        b.distances,
        b.minKm,
        b.minM,
        b.rushAmMin,
        b.rushPmMin,
        b.rushUpdatedAt,
        b.updatedAt,
        b.locationClass,
        b.routeVersion,
      );
    },
    async delete(routeKey) {
      const result = db.prepare(`DELETE FROM ${ROUTE_TABLE} WHERE route_key = ?`).run(String(routeKey));
      return Number(result.changes) > 0;
    },
  };
}

export function createPostgresRouteCacheRepository(pool) {
  return {
    name: "postgres",
    async get(routeKey) {
      const { rows } = await pool.query(`SELECT ${ROUTE_COLS} FROM ${ROUTE_TABLE} WHERE route_key = $1`, [String(routeKey)]);
      return rows[0] || null;
    },
    async set(routeKey, route = {}) {
      const b = bindRoute(route);
      await pool.query(
        `INSERT INTO ${ROUTE_TABLE} (route_key, distances, min_km, min_m, rush_am_min, rush_pm_min, rush_updated_at, updated_at, location_class, route_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (route_key) DO UPDATE SET
           distances = EXCLUDED.distances,
           min_km = EXCLUDED.min_km,
           min_m = EXCLUDED.min_m,
           rush_am_min = EXCLUDED.rush_am_min,
           rush_pm_min = EXCLUDED.rush_pm_min,
           rush_updated_at = EXCLUDED.rush_updated_at,
           updated_at = EXCLUDED.updated_at,
           location_class = EXCLUDED.location_class,
           route_version = EXCLUDED.route_version`,
        [
          String(routeKey),
          b.distances,
          b.minKm,
          b.minM,
          b.rushAmMin,
          b.rushPmMin,
          b.rushUpdatedAt,
          b.updatedAt,
          b.locationClass,
          b.routeVersion,
        ],
      );
    },
    async delete(routeKey) {
      const result = await pool.query(`DELETE FROM ${ROUTE_TABLE} WHERE route_key = $1`, [String(routeKey)]);
      return result.rowCount === 1;
    },
  };
}

export function createRouteCacheRepository({ driver = resolveDbDriver(), sqliteDb = null, pgPool = null } = {}) {
  if (driver === "postgres") {
    if (!pgPool) throw new Error("createRouteCacheRepository(postgres) requires pgPool");
    return createPostgresRouteCacheRepository(pgPool);
  }
  if (!sqliteDb) throw new Error("createRouteCacheRepository(sqlite) requires sqliteDb");
  return createSqliteRouteCacheRepository(sqliteDb);
}
