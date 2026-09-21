// PG read+write drill (shadow): with DB_DRIVER=postgres, exercise the real write -> list -> decorate
// flow against a dedicated schema and record which parts still depend on SQLite.
//
// Run inside the app image with the source mounted:
//   DATA_DIR=/tmp/pg-rw-drill PG_URL=postgres://… DRILL_SCHEMA=drill_rw node v3/evidence/pg-rw-drill-20260921/pg-rw-drill.mjs
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.DATA_DIR = process.env.DATA_DIR || mkdtempSync(path.join(os.tmpdir(), "pg-rw-drill-"));
process.env.DB_DRIVER = "postgres";

const { createPostgresDriver } = await import("../../src/dbDriverPostgres.js");
const { ensurePgSchema } = await import("../../src/pgSchema.js");
const { db, defaultUserId, getSettings, persistListing, stats } = await import("../../src/db.js");
const { searchListingsAsync } = await import("../../src/listingSearchAsync.js");
const { createWritePath } = await import("../../src/repository/writePath.js");
const { ensureListingPrepSchema } = await import("../../src/listingEnrichQueue.js");

const connectionString = process.env.PG_URL;
if (!connectionString) {
  console.error("PG_URL is required");
  process.exit(2);
}
const schema = process.env.DRILL_SCHEMA || `drill_rw_${process.pid}`;
const stamp = "2026-09-21T10:00:00.000Z";
const district = "士林區";

const pgDriver = await createPostgresDriver({
  connectionString,
  poolOptions: { options: `-c search_path=${schema}` },
});

const envelopeSettings = () => ({
  ...getSettings(defaultUserId()),
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
});

const listArgs = (userId) => ({
  filter: "all", kind: "", sources: "", q: "", sort: "newest", limit: 50, offset: 0, cursor: null,
  districts: [district], userId, matchVoteUserId: userId, sameHouse: true, settings: envelopeSettings(),
});

const report = { schema, steps: [], gaps: [] };
try {
  await pgDriver.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pgDriver.exec(`CREATE SCHEMA ${schema}`);
  // A cutover has to create the PostgreSQL schema first, and it must be mirrored from a FULLY
  // initialised store - the production snapshot, not a fresh temp database (several tables are
  // created lazily on first use, e.g. data_revision).
  const schemaSourcePath = process.env.SCHEMA_SOURCE_DB || path.join(process.env.DATA_DIR, "v3.db");
  const schemaSource = new DatabaseSync(schemaSourcePath, { readOnly: true });
  ensureListingPrepSchema(db);
  const mirrored = await ensurePgSchema(pgDriver, schemaSource, { schema, indexes: false });
  report.steps.push({
    step: "schema mirror (production schema -> PostgreSQL)",
    ok: true,
    source: path.basename(schemaSourcePath),
    tables: mirrored.tables.length,
  });
  schemaSource.close();

  const uid = defaultUserId();
  const postId = 593001;
  const row = {
    post_id: postId, source: "591", source_id: "593001", source_key: "g-drill",
    search_key: "https://example.test", url: "https://rent.591.com.tw/593001",
    title: "演練物件", price: "2.5萬", price_num: 25000, extra_fee: 0, extra_fee_text: "",
    extra_fees: [], address: "台北市士林區天玉街9巷3號", area_name: "15坪", layout: "1房1廳1衛",
    floor_name: "3/5", kind_name: "整層住家", role_name: "屋主", cover: "", tags: "[]",
    lat: 25.1105, lng: 121.529, geo_source: "591",
    refresh_time: stamp, first_seen_at: stamp, last_seen_at: stamp, last_event: "new",
  };

  // 1. Write through the wiring facade (the crawler's ingest path in postgres mode).
  const written = await persistListing(row, { driver: "postgres", pgDriver });
  const rowInPg = (
    await pgDriver.query("SELECT post_id, title, source FROM listings WHERE post_id = $1", [postId])
  ).rows[0];
  const projectionInPg = (
    await pgDriver.query("SELECT post_id, district, rent FROM listing_search_projection WHERE post_id = $1", [postId])
  ).rows[0];
  report.steps.push({
    step: "persistListing -> listings + projection",
    ok: Boolean(rowInPg && projectionInPg),
    changeEvent: written.changeEvent,
    district: projectionInPg?.district ?? null,
    rent: projectionInPg?.rent ?? null,
  });

  // 2. The app's own list path in postgres mode: repository page + decoration preload + decorators.
  const listed = await searchListingsAsync(listArgs(uid), { driver: "postgres", pgDriver });
  const card = listed?.listings?.find((item) => Number(item.post_id) === postId) || null;
  report.steps.push({
    step: "searchListingsAsync -> decorated card",
    ok: Boolean(card),
    matched: listed?.totalMatched ?? null,
    decoration: listed?.queryDetails?.decoration ?? null,
    decoratedFields: card
      ? ["district", "commute_state", "prep_status", "source_label"].filter((key) => card[key] !== undefined)
      : [],
    viewed: card ? Number(card.viewed) : null,
  });

  // 3. A member-interaction write in the same store, then the list again: the flags overlay has to
  // come from PostgreSQL, otherwise the two stores would disagree.
  await createWritePath({ driver: "postgres", pgDriver }).upsertPersonalFlags({
    userId: uid, postId, viewed: 1, watched: 0, hidden: 0, watchNote: "演練", viewedAt: stamp,
  });
  const listed2 = await searchListingsAsync(listArgs(uid), { driver: "postgres", pgDriver });
  const card2 = listed2?.listings?.find((item) => Number(item.post_id) === postId) || null;
  report.steps.push({
    step: "member flags visible on the PostgreSQL list",
    ok: Number(card2?.viewed) === 1,
    viewed: card2 ? Number(card2.viewed) : null,
    note: card2 ? String(card2.watch_note || "") : null,
  });

  // 4. Gap scan: the parts the app still computes from the SQLite store in postgres mode.
  try {
    const snapshot = stats(undefined, uid, undefined, {});
    report.gaps.push({ area: "stats() (list header counters)", verdict: "runs, reads the SQLite store", matched: snapshot?.total ?? null });
  } catch (error) {
    report.gaps.push({ area: "stats() (list header counters)", verdict: "throws", error: String(error?.message || error) });
  }
  report.gaps.push({ area: "getSettings() / flags / route cache outside the list path", verdict: "SQLite only" });
  report.gaps.push({ area: "enqueueSimilaritySafe (pHash queue)", verdict: "not executed in postgres mode" });
  report.gaps.push({ area: "listing_prep writes + notify / CRM queues", verdict: "SQLite only" });

  report.ok = report.steps.every((step) => step.ok);
  console.log(JSON.stringify(report, null, 2));
} finally {
  try {
    await pgDriver.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } catch {
    // best effort
  }
  await pgDriver.close();
  db.close();
}
