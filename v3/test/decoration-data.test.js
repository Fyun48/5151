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
  loadListingPrepMap,
  loadPeerRows,
  loadPersonalFlagMap,
  loadPersonalSameHouseIndex,
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
