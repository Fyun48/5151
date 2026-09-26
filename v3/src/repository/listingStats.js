// Listing-stats repository (PostgreSQL hot path, the cutover blocker of the switch plan).
//
// db.js `stats()` answers the list-page counters by scanning the member's candidate rows
// through SQLite. With DB_DRIVER=postgres that produced a page with items and counters that
// said zero, because the counters still described the (empty) SQLite store
// (v3/evidence/pg-rw-drill-20260921/README.md, gap 1). The counters therefore have to be read
// from the same store the list itself reads.
//
// This module restates the reads that make up those counters against an injected
// `exec(sql, params, { one })` executor (which translates `?` -> `$n`, exactly like the
// listings repository does). Every statement fragment comes from the dependency bundle
// db.js publishes as `listingStatsBuildContext()`: the clause builders are the ones the
// search path already uses and the row pipeline is the pure half of `stats()`, so a filter
// or a counter can never drift between the list and its counters.
import { numberFromPg } from "../dbDriverPostgres.js";
import { toPostgresSql } from "../sqlDialect.js";
import { buildListRequestContextFromPg } from "../db.js";
import { WATCHED_COUNT_SQL } from "../watchLimits.js";
import { loadPersonalFlagMap } from "./decorationData.js";

// SQLite hands these back as numbers, node-postgres as strings (int8). The stats pipeline
// compares them numerically or truthily (`!row.viewed`, `row.offline`, `row.hidden`), so they
// are normalised at the boundary - the same treatment repository/decorationData.js gives cards.
export const STATS_CANDIDATE_NUMERIC_KEYS = [
  "post_id",
  "price_num",
  "extra_fee",
  "hidden",
  "offline",
  "offline_confirmed",
  "match_post_id",
  "match_rejected",
  "contact_uid",
  "listed_by_user_id",
];

const REQUIRED_DEPS = [
  "resolveUserId",
  "getSettings",
  "searchWhere",
  "listingVisibilityClauses",
  "appendDistrictCandidates",
  "appendPriceCeilingCandidates",
  "memberRegionDistrictNames",
  "candidateColumns",
  "buildListingStatsRows",
  "summarizeListingStats",
];

export function assertListingStatsDeps(deps = {}) {
  for (const name of REQUIRED_DEPS) {
    if (deps[name] == null || deps[name] === "") {
      throw new Error(`createListingStatsRepository requires deps.${name}`);
    }
  }
  return true;
}

export function normalizeStatsCandidateRow(row) {
  if (!row) return row;
  for (const key of STATS_CANDIDATE_NUMERIC_KEYS) {
    if (Object.prototype.hasOwnProperty.call(row, key)) row[key] = numberFromPg(row[key]);
  }
  return row;
}

// watchLimits.countWatched() through the executor (the `IFNULL` is translated for PostgreSQL).
async function countWatchedListings(runOne, uid) {
  const id = Number(uid) || 0;
  if (!id) return 0;
  const row = await runOne(WATCHED_COUNT_SQL, [id]);
  return Number(row?.n) || 0;
}

// db.js productListingCount() (P1-18: member-visible totals never reveal a Stage 1 fixture).
async function countProductListings(runOne, requestContext) {
  const isolation = requestContext?.isolation;
  if (!isolation) throw new Error("PG stats require isolation context");
  const row = await runOne(`SELECT COUNT(*) AS n FROM listings WHERE ${isolation.sql}`, isolation.params);
  return Number(row?.n) || 0;
}

export function createListingStatsRepository({
  driver = "postgres",
  pgDriver = null,
  exec = null,
  deps = null,
} = {}) {
  assertListingStatsDeps(deps || {});
  const context = deps;
  const run = exec || (async (sql, params = [], { one = false } = {}) => {
    if (!pgDriver) throw new Error("createListingStatsRepository(postgres) requires pgDriver or exec");
    const res = await pgDriver.query(toPostgresSql(sql), params);
    return one ? res.rows[0] ?? null : res.rows;
  });
  // An injected `exec` follows the convention of the other repositories (it resolves to the row
  // array), so a single-row read has to unwrap here rather than relying on the third argument.
  const runOne = async (sql, params = []) => {
    const res = await run(sql, params, { one: true });
    return Array.isArray(res) ? res[0] ?? null : res ?? null;
  };

  return {
    driver,
    /**
     * Reads every input `summarizeListingStats()` needs: the candidate rows (with the personal
     * flag map they get overlaid with), the offline counters, the watch quota, the
     * product-visible total and the failed route jobs.
     */
    async loadInputs({ searchKeys, userId, settings: settingsOverride, diagnostics, requestContext: providedContext = null, asOf = null } = {}) {
      const requestContext = providedContext || await buildListRequestContextFromPg(run, {asOf});
      const uid = Number(userId) || 0;
      const settings = settingsOverride || requestContext.settingsForUser(uid);
      const clauses = [];
      const params = [];
      context.searchWhere(searchKeys, clauses, params, requestContext);
      context.listingVisibilityClauses(clauses, params, requestContext, {sqliteDb:null});
      // Same order and the same statements as db.js stats(): the offline counters describe the
      // shared search pool (districts/price not narrowed yet), the candidates get everything.
      const statusWhere = `WHERE ${[...clauses, "COALESCE(offline, 0) != 0"].join(" AND ")}`;
      const statusRow = await runOne(
        `SELECT
    SUM(CASE WHEN COALESCE(offline, 0) != 0 AND COALESCE(offline_confirmed, 0) = 0 THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN COALESCE(offline, 0) != 0 AND COALESCE(offline_confirmed, 0) != 0 THEN 1 ELSE 0 END) AS confirmed
    FROM listings ${statusWhere}`,
        params,
      );
      context.appendDistrictCandidates(context.memberRegionDistrictNames(settings), clauses, params);
      context.appendPriceCeilingCandidates(settings, clauses, params, {driver:"postgres"});
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const raw = await run(`SELECT ${context.candidateColumns} FROM listings ${where}`, params);
      const rows = (raw || []).map(normalizeStatsCandidateRow);
      const flagMap = await loadPersonalFlagMap(run, uid);
      const watchedTotal = await countWatchedListings(runOne, uid);
      const dbTotal = await countProductListings(runOne, requestContext);
      const failedRouteJobs = new Set(
        (await run("SELECT job_key FROM route_jobs WHERE job_state = 'failed'")).map((row) => row.job_key),
      );
      if (diagnostics) {
        diagnostics.driver = "postgres";
        diagnostics.candidates = rows.length;
      }
      return { uid, settings, rows, flagMap, requestContext, statusCounts: statusRow || {}, watchedTotal, dbTotal, failedRouteJobs };
    },
  };
}

