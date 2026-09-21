// PostgreSQL EXPLAIN evidence for the listings hot path, against real production data.
//
// Runs the exact statements the PostgreSQL hot path sends (captured by wrapping the driver's
// query) for every supported sort, then re-runs each one as EXPLAIN (ANALYZE, BUFFERS) and
// reports the plan shape plus timings. The builder's envelope is checked for every sort so the
// "outside the SQL-first envelope" cases are named instead of silently skipped. Read-only.
//
// Usage (inside a container that has the app image and this source tree):
//   DATA_DIR=/tmp/pg-explain PG_URL=postgres://… node v3/evidence/pg-explain-20260921/pg-explain.mjs
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = process.env.DATA_DIR || mkdtempSync(path.join(os.tmpdir(), "pg-explain-"));
const { listingSearchBuildContext, getSettings } = await import("../../src/db.js");
const { createPostgresDriver } = await import("../../src/dbDriverPostgres.js");
const { createListingsRepository } = await import("../../src/repository/listings.js");
const { buildListingSearchSql } = await import("../../src/listingSearchSql.js");

const connectionString = process.env.PG_URL;
if (!connectionString) {
  console.error("PG_URL is required");
  process.exit(2);
}

const pgDriver = await createPostgresDriver({ connectionString });
const recorded = [];
const wrapped = {
  ...pgDriver,
  query(sql, params = []) {
    recorded.push({ sql, params });
    return pgDriver.query(sql, params);
  },
};

const deps = listingSearchBuildContext();
const repository = createListingsRepository({ driver: "postgres", pgDriver: wrapped, deps });

// The SQL-first envelope only accepts a narrow settings shape, so the probe uses an
// unfiltered profile (no rent/area/keyword/commute constraints) plus one real district.
const base = getSettings(deps.resolveUserId(0));
const settings = {
  ...base,
  priceMin: 0,
  priceMax: 0,
  areaMax: 0,
  minBuildingFloors: 0,
  wholeFloorOnly: false,
  excludeLowFloors: false,
  excludeRooftop: false,
  commuteKm: 0,
  excludeKeywords: [],
  excludeAgents: [],
  excludeAgentIds: [],
  excludeBoxes: [],
};
const district = (deps.memberRegionDistrictNames(settings) || [])[0] || "士林區";

const SORTS = ["newest", "price_asc", "price_desc", "commute_asc", "commute_desc", "fit_desc"];
const baseArgs = {
  filter: "all",
  kind: "",
  sources: "",
  q: "",
  sort: "newest",
  limit: 50,
  offset: 0,
  cursor: null,
  districts: [district],
  userId: 0,
  matchVoteUserId: 0,
  settings,
  sameHouse: true,
};

const summary = [];
for (const sort of SORTS) {
  const args = { ...baseArgs, sort };
  const built = buildListingSearchSql(args, deps);
  if (!built.ok) {
    summary.push({ sort, envelope: "outside", reason: built.reason });
    continue;
  }
  recorded.length = 0;
  const started = Date.now();
  const page = await repository.searchPage(args);
  const pageMs = Date.now() - started;
  const plans = [];
  for (const statement of recorded.slice()) {
    const res = await pgDriver.query(`EXPLAIN (ANALYZE, BUFFERS) ${statement.sql}`, statement.params);
    const lines = res.rows.map((row) => row["QUERY PLAN"]);
    plans.push({
      plan: lines.filter((line) => !/^(Planning|Execution) Time/.test(line)).slice(0, 8).join("\n"),
      planning: lines.find((line) => line.startsWith("Planning Time")) || "",
      execution: lines.find((line) => line.startsWith("Execution Time")) || "",
      seqScanListings: lines.some((line) => /Seq Scan on listings/.test(line)),
    });
  }
  summary.push({
    sort,
    envelope: "sql-first",
    matched: page.totalMatched,
    pageIds: page.ids.length,
    searchPageMs: pageMs,
    statements: recorded.length,
    plans,
  });
}

console.log(JSON.stringify({ district, sorts: summary }, null, 2));
await pgDriver.close();
