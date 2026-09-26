// Decoration data loaders: SQLite fixture + (when PG_TEST_URL is set) PostgreSQL parity.
//
// The point of this test is that the SAME statement text produces the same values on both
// drivers, because that is what lets the PostgreSQL hot path reuse the existing pure
// decorators instead of forking the listing response.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  createDecorationDataLoader,
  loadAnyoneFlagMap,
  loadGroupIds,
  loadGroupMemberRows,
  loadListingExtras,
  loadListingPrepMap,
  loadMrtCacheEntries,
  loadPeerRows,
  loadPersonalFlagMap,
  loadPersonalSameHouseIndex,
  loadRouteCacheEntries,
  loadRouteJobs,
  loadUserSplitPairSet,
} from "../src/repository/decorationData.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { ensurePgSchema, importTable } from "../src/pgSchema.js";

const TABLES = [
  "user_listing_flags",
  "user_same_house_members",
  "listing_group_members",
  "listing_prep",
  "listings",
  "user_match_votes",
  "mrt_cache",
  "route_cache",
  "route_jobs",
];

const LISTING_COLUMNS = [
  "post_id", "source_id", "title", "url", "price", "price_num", "extra_fee", "extra_fees",
  "extra_fee_text", "price_contain_text", "floor_name", "area_name", "layout", "source",
  "offline", "offline_confirmed", "hidden", "match_post_id", "match_level", "match_verdict",
  "match_detail", "cost_changed_at", "cost_change_detail", "cost_change_type", "last_seen_at",
  "refresh_time",
];

const INT_COLUMNS = new Set(["price_num", "offline", "offline_confirmed", "hidden", "match_post_id"]);

function columnDdl(name) {
  if (name === "post_id") return "post_id INTEGER PRIMARY KEY";
  return `${name} ${INT_COLUMNS.has(name) ? "INTEGER" : "TEXT"}`;
}

function createFixtureDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE user_listing_flags (
      user_id INTEGER NOT NULL, post_id INTEGER NOT NULL,
      viewed INTEGER NOT NULL DEFAULT 0, watched INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0, watch_note TEXT NOT NULL DEFAULT '',
      viewed_at TEXT, watched_at TEXT, hidden_at TEXT,
      PRIMARY KEY (user_id, post_id)
    );
    CREATE TABLE user_same_house_members (
      user_id INTEGER NOT NULL, post_id INTEGER NOT NULL, group_key TEXT NOT NULL,
      system_agrees INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE listing_group_members (group_id TEXT NOT NULL, post_id INTEGER NOT NULL);
    CREATE TABLE listing_prep (post_id INTEGER PRIMARY KEY, display_ready INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE listings (${LISTING_COLUMNS.map(columnDdl).join(", ")});
    CREATE TABLE user_match_votes (user_id INTEGER NOT NULL, post_id INTEGER NOT NULL, peer_id INTEGER NOT NULL, vote TEXT NOT NULL);
    CREATE TABLE mrt_cache (geo_key TEXT PRIMARY KEY, station TEXT, walk_km REAL, walk_min REAL, ride_km REAL, ride_min REAL);
    CREATE TABLE route_cache (route_key TEXT PRIMARY KEY, distances TEXT, min_km REAL, min_m REAL, rush_am_min INTEGER, rush_pm_min INTEGER, rush_updated_at TEXT);
    CREATE TABLE route_jobs (job_key TEXT PRIMARY KEY, post_id INTEGER, direction TEXT, kind TEXT, job_state TEXT, attempts INTEGER);
  `);
  const flag = db.prepare(
    "INSERT INTO user_listing_flags(user_id, post_id, viewed, watched, hidden, watch_note) VALUES (?,?,?,?,?,?)",
  );
  flag.run(7, 101, 1, 0, 0, "");
  flag.run(7, 102, 0, 1, 0, "看過三次");
  flag.run(8, 101, 0, 0, 1, "");
  const member = db.prepare(
    "INSERT INTO user_same_house_members(user_id, post_id, group_key, system_agrees) VALUES (?,?,?,?)",
  );
  member.run(7, 101, "g1", 1);
  member.run(7, 103, "g1", 0);
  member.run(7, 102, "g2", 1);
  member.run(8, 101, "h1", 1);
  const group = db.prepare("INSERT INTO listing_group_members(group_id, post_id) VALUES (?,?)");
  group.run("G-9", 101);
  group.run("G-9", 103);
  db.prepare("INSERT INTO listing_prep(post_id, display_ready) VALUES (?,?)").run(101, 1);
  const vote = db.prepare("INSERT INTO user_match_votes(user_id, post_id, peer_id, vote) VALUES (?,?,?,?)");
  vote.run(7, 101, 103, "split");
  vote.run(7, 102, 101, "same");
  vote.run(8, 101, 103, "split");
  db.prepare(
    "INSERT INTO mrt_cache(geo_key, station, walk_km, walk_min, ride_km, ride_min) VALUES (?,?,?,?,?,?)",
  ).run("geo|101", "中山", 0.4, 6, 2.1, 9);
  db.prepare(
    "INSERT INTO route_cache(route_key, distances, min_km, min_m, rush_am_min, rush_pm_min, rush_updated_at) VALUES (?,?,?,?,?,?,?)",
  ).run("rk|101", "[1.2,1.5]", 1.2, 1200, 12, 15, "2026-09-21T00:00:00Z");
  db.prepare(
    "INSERT INTO route_jobs(job_key, post_id, direction, kind, job_state, attempts) VALUES (?,?,?,?,?,?)",
  ).run("job|101", 101, "to_work", "distance", "pending", 2);
  const listing = db.prepare(
    `INSERT INTO listings(${LISTING_COLUMNS.join(",")}) VALUES (${LISTING_COLUMNS.map(() => "?").join(",")})`,
  );
  const row = (postId, matchPostId, title) => {
    listing.run(
      ...LISTING_COLUMNS.map((c) => {
        if (c === "post_id") return postId;
        if (c === "match_post_id") return matchPostId;
        if (INT_COLUMNS.has(c)) return 0;
        if (c === "title") return title;
        if (c === "source") return "591";
        return "";
      }),
    );
  };
  row(101, 103, "主卡");
  row(102, 0, "獨立卡");
  row(103, 101, "同屋源副卡");
  row(104, 0, "無關卡");
  return db;
}

function sqliteExec(db) {
  return async (sql, params = [], { one = false } = {}) => {
    const statement = db.prepare(sql);
    return one ? statement.get(...params) : statement.all(...params);
  };
}

function pgExec(pgDriver) {
  return async (sql, params = [], { one = false } = {}) => {
    const res = await pgDriver.query(toPostgresSql(sql), params);
    return one ? res.rows[0] ?? null : res.rows;
  };
}

async function collect(exec, driver) {
  const flagMap = await loadPersonalFlagMap(exec, 7);
  const anyone = await loadAnyoneFlagMap(exec);
  const index = await loadPersonalSameHouseIndex(exec, 7);
  const groupIds = await loadGroupIds(exec, [101, 103, 104], driver);
  const peers = await loadPeerRows(exec, [101, 102], driver);
  const members = await loadGroupMemberRows(exec, "G-9");
  const prep = await loadListingPrepMap(exec, [101, 104], driver);
  const splits = await loadUserSplitPairSet(exec, 7);
  const extras = await loadListingExtras(exec, [101, 104], driver);
  const routeCache = await loadRouteCacheEntries(exec, ["rk|101", "rk|missing"], driver);
  const mrtCache = await loadMrtCacheEntries(exec, ["geo|101"], driver);
  const routeJobs = await loadRouteJobs(exec, ["job|101"], driver);
  return {
    flags: [...flagMap.entries()].map(([id, r]) => [id, Number(r.viewed), Number(r.watched), String(r.watch_note)]).sort(),
    anyone: [...anyone.entries()].map(([id, r]) => [id, Number(r.viewed), Number(r.watched), Number(r.hidden)]).sort(),
    index: {
      size: index.size,
      key101: index.groupKey(101),
      key104: index.groupKey(104),
      peers101: index.peers(101).map(Number).sort((a, b) => a - b),
      agreesG1: index.agrees(index.groupKey(101)),
    },
    groupIds: [...groupIds.entries()].map(([id, gid]) => [Number(id), gid]).sort((a, b) => a[0] - b[0]),
    peers: peers.map((r) => Number(r.post_id)).sort((a, b) => a - b),
    members: members.map((r) => Number(r.post_id)).sort((a, b) => a - b),
    prep: [...prep.entries()].map(([id, r]) => [Number(id), r ? Number(r.display_ready) : null]).sort((a, b) => a[0] - b[0]),
    splits: [...splits].sort(),
    extras: [...extras.entries()]
      .map(([id, r]) => [Number(id), String(r?.source || ""), Number(r?.offline)])
      .sort((a, b) => a[0] - b[0]),
    routeCache: [...routeCache.entries()].map(([key, r]) => [key, Number(r?.min_km), Number(r?.rush_am_min)]).sort(),
    mrtCache: [...mrtCache.entries()].map(([key, r]) => [key, String(r?.station || ""), Number(r?.walk_min)]).sort(),
    routeJobs: [...routeJobs.entries()].map(([key, r]) => [key, String(r?.job_state || ""), Number(r?.attempts)]).sort(),
  };
}

const EXPECTED = {
  flags: [[101, 1, 0, ""], [102, 0, 1, "看過三次"]],
  anyone: [[101, 1, 0, 1], [102, 0, 1, 0]],
  index: { size: 3, key101: "g1", key104: "", peers101: [103], agreesG1: false },
  // Raw loaders only return rows that exist (createDecorationDataLoader fills the gaps).
  groupIds: [[101, "G-9"], [103, "G-9"]],
  peers: [101, 102, 103],
  members: [101, 103],
  prep: [[101, 1]],
  splits: ["101:103"],
  extras: [[101, "591", 0], [104, "591", 0]],
  routeCache: [["rk|101", 1.2, 12]],
  mrtCache: [["geo|101", "中山", 6]],
  routeJobs: [["job|101", "pending", 2]],
};

test("decoration data loaders read the SQLite fixture", async () => {
  const db = createFixtureDb();
  const result = await collect(sqliteExec(db), "sqlite");
  assert.deepEqual(result, EXPECTED);
  db.close();
});

test("the loader memoises one read per user and per id set", async () => {
  const db = createFixtureDb();
  const base = sqliteExec(db);
  let calls = 0;
  const counting = async (sql, params, options) => {
    calls += 1;
    return base(sql, params, options);
  };
  const loaders = createDecorationDataLoader({ exec: counting, driver: "sqlite" });
  const posts = [101, 102, 103];
  await Promise.all(posts.map(() => loaders.personalFlagMap(7)));
  await Promise.all(posts.map(() => loaders.personalIndex(7)));
  await loaders.groupIdsFor(posts);
  await loaders.groupIdsFor(posts);
  assert.equal(calls, 3, "one flags read, one personal-group read, one group-id read");
  db.close();
});

test("PostgreSQL returns the same decoration data as SQLite", async (t) => {
  if (!process.env.PG_TEST_URL) return t.skip("PG_TEST_URL not set");
  const db = createFixtureDb();
  const schema = `decoration_parity_${process.pid}`;
  const driver = await createPostgresDriver({
    connectionString: process.env.PG_TEST_URL,
    poolOptions: { options: `-c search_path=${schema}` },
  });
  try {
    await driver.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await driver.exec(`CREATE SCHEMA ${schema}`);
    await ensurePgSchema(driver, db, { schema, tables: TABLES, indexes: false });
    for (const table of TABLES) await importTable(driver, db, table, { schema });

    const viaPg = await collect(pgExec(driver), "postgres");
    assert.deepEqual(viaPg, EXPECTED, "PostgreSQL decoration data matches SQLite");

    // Commute can generate two route keys per candidate; 36k candidates can
    // exceed PostgreSQL's bind-parameter count even though ID queries are safe.
    const manyKeys=Array.from({length:70000},(_,i)=>`missing-${i}`);
    const batchCalls=[];
    const batchExec=(sql,params)=>{batchCalls.push({sql,params:params.length});return pgExec(driver)(sql,params);};
    const routes=await loadRouteCacheEntries(batchExec,[...manyKeys,'rk|101'],'postgres');
    const mrt=await loadMrtCacheEntries(batchExec,[...manyKeys,'geo|101'],'postgres');
    const jobs=await loadRouteJobs(batchExec,[...manyKeys,'job|101'],'postgres');
    assert.deepEqual([...routes.keys()],['rk|101']);
    assert.deepEqual([...mrt.keys()],['geo|101']);
    assert.deepEqual([...jobs.keys()],['job|101']);
    assert.ok(batchCalls.every(call=>call.params===1&&call.sql.includes('ANY(?::text[])')));

    // The memoising loader must behave the same way through the pg executor.
    const loaders = createDecorationDataLoader({ exec: pgExec(driver), driver: "postgres" });
    assert.equal((await loaders.personalFlagMap(7)).size, 2);
    const peerIds = (await loaders.peerRowsFor([101])).map((r) => Number(r.post_id)).sort((a, b) => a - b);
    assert.deepEqual(peerIds, [101, 103]);
    assert.equal((await loaders.prepMap([101])).get(101).display_ready, 1);
    assert.equal([...(await loaders.groupIdsFor([101, 103, 104])).values()].join(","), "G-9,G-9,");
  } finally {
    await driver.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await driver.close();
    db.close();
  }
});
