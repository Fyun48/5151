// Notification enqueue parity: what fills the queue has to be the same on both drivers.
//
// enqueueListingEvent() decides which members get an event and writes their `user_events` rows - all
// synchronous SQLite. With DB_DRIVER=postgres the site reads PostgreSQL, so the queue the flush loop
// drains (notifyQueueAsync.js) would stay empty and a change would never reach a member. This suite
// pins the driver-aware entry point (notifyEnqueueAsync.js -> repository/notifyEnqueue.js) to the
// SQLite answers.
//
// Two layers:
//   • the PostgreSQL path runs end to end on a SQLite fixture through an exec that behaves like the
//     PostgreSQL executor (it answers the $n placeholders the decoration loader emits and the
//     RETURNING id the insert needs), so the member loop, the settings assembly, the decoration and
//     the decision are all exercised without a server - this is what always runs.
//   • the live section repeats it over the shadow cluster when PG_TEST_URL is set, where the rows
//     really land in a second store and the two enqueues can be compared row for row.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { importStore } from "../src/pgSchema.js";
import { ensurePersonalSchema } from "../src/personalSchema.js";
import { ensureListingGroupSchema } from "../src/listingGroups.js";
import { toPostgresSql } from "../src/sqlDialect.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-notify-enqueue-"));
process.env.DATA_DIR = dataDir;
after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite file locked while the process holds it.
  }
});

const PG_TEST_URL = (process.env.PG_TEST_URL || "").trim();
const skip = PG_TEST_URL ? false : "PG_TEST_URL is not set (live PostgreSQL notification enqueue)";

// Everything the enqueue reads: members and their settings/profile/flags, the listings, the group and
// the events. The decoration preload also consults listing_prep / route_cache / mrt_cache / route_jobs
// / user_same_house_members, so the live mirror carries them too.
const TABLES = [
  "users", "settings", "user_settings", "user_search_profiles", "user_listing_flags", "listings",
  "user_events", "listing_groups", "listing_group_members", "listing_prep", "route_cache", "mrt_cache",
  "route_jobs", "user_same_house_members", "user_match_votes",
];

const STAMP = "2026-09-20T00:00:00.000Z";
// Four members, so every branch has an owner: delivered by a watch, delivered by the search profile's
// cover, skipped because the account paused notifications, skipped because the listing is out of scope.
const MEMBERS = {
  watcher: 1,
  inScope: 960011,
  paused: 960012,
  stranger: 960013,
};
const LISTING = 960001; // section 8: inside `inScope`'s cover, watched by `watcher`
const LISTING_DEDUPE = 960002; // section 9: `watcher` already has this price-drop detail and a "new"
const LISTING_GROUPED = 960003; // section 10: `watcher` watches it, its group already notified "new"
const GROUP = "g-enqueue-960003";
const PROFILE_IN_SCOPE = "prof-enqueue-960011";
const PROFILE_PAUSED = "prof-enqueue-960012";
const SAME_DETAIL = "價格 25000元 → 24000元";
const OFFLINE_DETAIL = "591 詳情已不存在或已關閉";
const POSTS = [LISTING, LISTING_DEDUPE, LISTING_GROUPED];

// The event sites the watcher drives, in order. Between them they cover every way the chain can end:
// delivered twice, out of scope, paused, same detail, same group ("new" is once ever), and the group
// dedupe's detail branch.
const CASES = [
  [LISTING, { type: "new", detail: "全新物件", created_at: STAMP }],
  [LISTING_DEDUPE, { type: "price_drop", detail: SAME_DETAIL, created_at: STAMP }],
  [LISTING_DEDUPE, { type: "new", detail: "全新物件", created_at: STAMP }],
  [LISTING_GROUPED, { type: "new", detail: "群組已通知過", created_at: STAMP }],
  [LISTING_GROUPED, { type: "offline", detail: OFFLINE_DETAIL, created_at: STAMP }],
];

// [post_id, [[user_id, type], ...]] - what the fixture must end up with, whatever the driver.
const EXPECTED = [
  [LISTING, [[MEMBERS.watcher, "new"], [MEMBERS.inScope, "new"]]],
  [LISTING_DEDUPE, []],
  [LISTING_GROUPED, [[MEMBERS.watcher, "offline"]]],
];

let fixture = null;

async function loadFixture() {
  if (fixture) return fixture;
  const app = await import("../src/db.js");
  const db = app.sqliteHandle();
  ensurePersonalSchema(db);
  ensureListingGroupSchema(db);

  seedUser(db, { id: MEMBERS.watcher, email: "owner@example.test", role: "admin" });
  seedUser(db, { id: MEMBERS.inScope, email: "in-scope@example.test" });
  seedUser(db, { id: MEMBERS.paused, email: "paused@example.test" });
  seedUser(db, { id: MEMBERS.stranger, email: "stranger@example.test" });
  db.prepare("INSERT OR REPLACE INTO user_settings(user_id, key, value) VALUES (?, 'notificationsPaused', ?)")
    .run(MEMBERS.paused, JSON.stringify(true));
  // The active search profile is the member's scope: db.js merges its data over their settings.
  for (const [id, userId] of [[PROFILE_IN_SCOPE, MEMBERS.inScope], [PROFILE_PAUSED, MEMBERS.paused]]) {
    db.prepare(`INSERT OR REPLACE INTO user_search_profiles
        (id, user_id, name, data_json, active, version, last_used_at, created_at, updated_at)
        VALUES (?, ?, '找房條件', ?, 1, 3, ?, ?, ?)`)
      .run(id, userId, JSON.stringify({ watchDistricts: ["1-8"] }), STAMP, STAMP, STAMP);
  }

  seedListing(app, LISTING, "8");
  seedListing(app, LISTING_DEDUPE, "9");
  seedListing(app, LISTING_GROUPED, "10");
  for (const postId of POSTS) watchListing(db, MEMBERS.watcher, postId);
  db.prepare("INSERT OR REPLACE INTO listing_groups (group_id, primary_post_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(GROUP, LISTING_GROUPED, STAMP, STAMP);
  db.prepare("INSERT OR REPLACE INTO listing_group_members (post_id, group_id, joined_at) VALUES (?, ?, ?)")
    .run(LISTING_GROUPED, GROUP, STAMP);
  // What the two paths have to agree to skip: the same price-drop detail, a "new" already queued, and a
  // group that already notified "new".
  insertEvent(db, { user_id: MEMBERS.watcher, post_id: LISTING_DEDUPE, type: "price_drop", detail: SAME_DETAIL });
  insertEvent(db, { user_id: MEMBERS.watcher, post_id: LISTING_DEDUPE, type: "new", detail: "全新物件" });
  insertEvent(db, { user_id: MEMBERS.watcher, post_id: LISTING_GROUPED, type: "new", detail: "群組首發", group_id: GROUP });

  const seedMaxId = Number(db.prepare("SELECT MAX(id) AS id FROM user_events").get()?.id) || 0;
  fixture = { app, db, seedMaxId };
  return fixture;
}

function seedUser(db, { id, email, role = "member", plan = "free" }) {
  db.prepare(`INSERT INTO users (id, email, password_hash, role, plan, created_at)
              VALUES (?, ?, '', ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET email = excluded.email, role = excluded.role, plan = excluded.plan`)
    .run(id, email, role, plan, STAMP);
}

function watchListing(db, userId, postId) {
  db.prepare(`INSERT OR REPLACE INTO user_listing_flags
      (user_id, post_id, viewed, watched, hidden, watch_note) VALUES (?, ?, 0, 1, 0, '')`)
    .run(userId, postId);
}

function insertEvent(db, row) {
  db.prepare(`INSERT INTO user_events (user_id, post_id, type, title, detail, source_key, created_at, notified, group_id)
              VALUES (?, ?, ?, ?, ?, '', ?, 0, ?)`)
    .run(
      row.user_id,
      row.post_id,
      row.type,
      row.title || `通知 ${row.post_id}`,
      row.detail || "",
      row.created_at || STAMP,
      row.group_id || "",
    );
}

function seedListing(app, postId, section) {
  return app.upsertListing({
    post_id: postId,
    source: "591",
    source_id: String(postId),
    source_key: `1|${section}|${postId}`,
    search_key: "https://example.test/search",
    title: `合成住宅 ${postId}`,
    url: `https://example.test/listing/${postId}`,
    price: "25000元",
    price_num: 25000,
    extra_fee: 0,
    extra_fees: [],
    cover: "",
    tags: "[]",
    address: "台北市士林區測試路",
    area_name: "20坪",
    layout: "2房1廳1衛",
    floor_name: "5/12",
    kind_name: "整層住家/電梯大樓",
    role_name: "",
    refresh_time: STAMP,
    first_seen_at: STAMP,
    last_seen_at: STAMP,
    last_event: "new",
    lat: 25.11,
    lng: 121.52,
  });
}

// The columns both drivers own: what a member is told must not depend on the store. `afterId` narrows
// the read to what the enqueue wrote this time (the fixture's pre-seeded dedupe rows sit below it).
function eventRows(db, { postIds = POSTS, afterId = 0 } = {}) {
  const list = [];
  for (const postId of postIds) {
    const rows = db.prepare(`SELECT user_id, post_id, type, title, detail, source_key, created_at, notified,
                                    group_id, notify_profile_id, notify_profile_version
                               FROM user_events WHERE post_id = ? AND id > ? ORDER BY user_id, id`)
      .all(postId, Number(afterId) || 0)
      .map((row) => ({ ...row }));
    list.push(...rows);
  }
  return list;
}

// Only what the enqueue wrote this time: the fixture's pre-seeded dedupe rows stay.
function clearEvents(db, seedMaxId) {
  db.prepare("DELETE FROM user_events WHERE id > ?").run(seedMaxId);
}

function listingRow(db, postId) {
  return { ...db.prepare("SELECT * FROM listings WHERE post_id = ?").get(postId) };
}

// [post_id, [[user_id, type], ...]] - the pairs the enqueue queued this time, whatever the driver.
function deliveredPairs(db, afterId) {
  return EXPECTED.map(([postId, pairs]) => [
    postId,
    eventRows(db, { postIds: [postId], afterId }).map((row) => [Number(row.user_id), row.type]),
    pairs,
  ]);
}

// The PostgreSQL executor, answered by the SQLite fixture: the decoration loader emits $n, the enqueue's
// builders emit ? and its insert asks for RETURNING - the real driver handles all three.
//
// astra 2026-09-25 §3.6：正式碼新增了 **PG 陣列綁定**（`= ANY($n::bigint[])`，見
// repository/decorationData.js 的 idFilter）⇒ 這個模擬 executor 必須支援它：
// 展開成 SQLite 的 `IN (?,?,…)` 並移除型別轉換。用**單次左到右掃描**，確保展開後的參數順序
// 與 placeholder 出現順序一致（分兩趟會把參數順序弄反）。
function sqliteExecutor(db) {
  return (sql, params = []) => {
    const raw = String(sql);
    const args = [];
    let cursor = 0;
    const takePositional = () => { const value = params[cursor]; cursor += 1; return value; };
    // 單次左到右掃描（含 `?` 形式的 ANY：這個 executor 收到的是**尚未轉成 $n** 的 SQL）。
    const text = raw.replace(
      /=\s*ANY\(\s*(\$\d+|\?)(?:::[A-Za-z_]+(?:\[\])?)?\s*\)|::[A-Za-z_]+(?:\[\])?|(\$\d+)|(\?)/gi,
      (match, anyRef, dollarRef, qmark) => {
        if (anyRef) {
          const value = anyRef.startsWith("$")
            ? params[Number(anyRef.slice(1)) - 1]
            : takePositional();
          const values = value == null ? [] : (Array.isArray(value) ? value : [value]);
          // PG 的空陣列（= ANY('{}')）不匹配任何列 ⇒ 以 IN (NULL) 表達同一語意。
          if (!values.length) return "IN (NULL)";
          return `IN (${values.map((v) => { args.push(v); return "?"; }).join(", ")})`;
        }
        if (dollarRef) {
          args.push(params[Number(dollarRef.slice(1)) - 1]);
          return "?";
        }
        if (qmark !== undefined) {
          args.push(takePositional());
          return "?";
        }
        return "";   // 型別轉換：SQLite 不需要
      },
    );
    const bind = args.length ? args : (params || []).slice();
    if (/returning\s+id/i.test(text) || /^\s*select/i.test(text)) {
      return db.prepare(text).all(...bind).map((row) => ({ ...row }));
    }
    const info = db.prepare(text).run(...bind);
    return [{ id: Number(info.lastInsertRowid) || 0, changes: Number(info.changes) || 0 }];
  };
}

test("the decision chain answers with the reasons the SQLite path acts on", async () => {
  const { notifyEnqueueDecision, notifyEventPayload, notifyEventRow } = await import("../src/db.js");
  const delivering = { notifyMatrix: { new: { dock: true } } };
  const base = { event: { type: "new" }, payload: { type: "new", detail: "d" }, scoped: delivering };

  // Unwatched and outside the member's cover: the listing never reaches them.
  assert.equal(notifyEnqueueDecision({ ...base, row: {} }).reason, "out_of_scope");
  // Watched: the scope check is skipped and the default dock channel carries it.
  assert.equal(notifyEnqueueDecision({ ...base, row: { watched: 1 } }).enqueue, true);
  // In scope through the search profile's cover, without a watch.
  assert.equal(
    notifyEnqueueDecision({
      ...base,
      row: { regionid: 1, sectionid: 8 },
      scoped: { ...delivering, watchDistricts: ["1-8"] },
    }).enqueue,
    true,
  );
  assert.equal(notifyEnqueueDecision({ ...base, row: { watched: 1 }, scoped: { notificationsPaused: true } }).reason, "channel");
  assert.equal(notifyEnqueueDecision({ ...base, row: { watched: 1 }, groupId: "g", alreadyNotified: true }).reason, "group_dedupe");
  assert.equal(notifyEnqueueDecision({ ...base, row: { watched: 1 }, newExists: { id: 7 } }).reason, "new_dedupe");
  assert.equal(notifyEnqueueDecision({ ...base, row: { watched: 1 }, lastDetail: "d" }).reason, "detail_dedupe");
  // Only whitespace apart is the same notification (isSameNotifyDetail).
  assert.equal(
    notifyEnqueueDecision({ ...base, payload: { type: "new", detail: "a b" }, row: { watched: 1 }, lastDetail: "a  b" }).reason,
    "detail_dedupe",
  );
  // No previous event of this type is not a skip.
  assert.equal(notifyEnqueueDecision({ ...base, row: { watched: 1 }, lastDetail: null }).enqueue, true);

  const payload = notifyEventPayload({ post_id: 5, title: "T" }, { type: "new", detail: "D", created_at: STAMP });
  assert.deepEqual(payload, {
    post_id: 5,
    source_key: "",
    type: "new",
    title: "T",
    detail: "D",
    created_at: STAMP,
    notified: 0,
  });
  assert.deepEqual(
    notifyEventRow(payload, { userId: 9, groupId: "g", snap: { notify_profile_id: "p", notify_profile_version: 4 } }),
    { ...payload, user_id: 9, group_id: "g", notify_profile_id: "p", notify_profile_version: 4 },
  );
});

test("the PostgreSQL enqueue answers the SQLite rows through its own executor", async () => {
  const { app, db, seedMaxId } = await loadFixture();
  const { enqueueListingEventAsync } = await import("../src/notifyEnqueueAsync.js");

  for (const [postId, event] of CASES) app.enqueueListingEvent(listingRow(db, postId), event);
  const sqliteRows = eventRows(db, { afterId: seedMaxId });
  const sqlitePairs = deliveredPairs(db, seedMaxId);
  clearEvents(db, seedMaxId);

  const exec = sqliteExecutor(db);
  const ids = [];
  for (const [postId, event] of CASES) {
    const written = await enqueueListingEventAsync(listingRow(db, postId), event, { driver: "postgres", exec, strict: true });
    ids.push(...written);
  }
  const pgRows = eventRows(db, { afterId: seedMaxId });

  // The fixture has to hit both endings, or the comparison would prove nothing.
  assert.deepEqual(sqlitePairs, [
    [LISTING, [[MEMBERS.watcher, "new"], [MEMBERS.inScope, "new"]], [[MEMBERS.watcher, "new"], [MEMBERS.inScope, "new"]]],
    [LISTING_DEDUPE, [], []],
    [LISTING_GROUPED, [[MEMBERS.watcher, "offline"]], [[MEMBERS.watcher, "offline"]]],
  ]);
  assert.deepEqual(pgRows, sqliteRows);
  assert.equal(ids.filter(Boolean).length, pgRows.length);
  // The profile columns are the active search profile's, recorded the same way on both drivers.
  const inScopeRows = pgRows.filter((row) => Number(row.user_id) === MEMBERS.inScope);
  assert.equal(inScopeRows.length, 1);
  assert.equal(inScopeRows[0].notify_profile_id, PROFILE_IN_SCOPE);
  assert.equal(Number(inScopeRows[0].notify_profile_version), 3);
  for (const row of pgRows) assert.equal(row.created_at, STAMP);
  // Leave the fixture as it was found: the live section mirrors it into PostgreSQL.
  clearEvents(db, seedMaxId);
});

test("every event site goes through the driver-aware entry point", async () => {
  const read = (name) => readFileSync(path.join(dir, "../src", name), "utf8");
  const watcher = read("watcher.js");
  assert.match(watcher, /import \{ enqueueListingEventAsync \} from "\.\/notifyEnqueueAsync\.js";/);
  assert.equal((watcher.match(/\benqueueListingEvent\(/g) || []).length, 0, "no synchronous enqueue left");
  assert.match(watcher, /await enqueueListingEventAsync\(listing, \{[\s\S]{0,120}type: "offline"/);
  assert.match(watcher, /await enqueueListingEventAsync\(saved, evt\);/);
  assert.match(watcher, /await enqueueListingEventAsync\(\{ \.\.\.listing, display_ready: true \}, \{/);

  const enrich = read("listingEnrichQueue.js");
  assert.match(enrich, /await helpers\.onFirstReady\?\.\(stored, readyInfo\);/);

  const writes = read("crawlerWrites.js");
  assert.match(writes, /import \{ enqueueListingEventAsync \} from "\.\/notifyEnqueueAsync\.js";/);
  assert.match(writes, /await enqueueListingEventAsync\(saved, \{[\s\S]{0,80}type: "fee_update"/);

  // One statement text: the PostgreSQL insert is the SQLite one plus the RETURNING clause it needs.
  const { notifyEnqueueQueries } = await import("../src/db.js");
  const queries = notifyEnqueueQueries();
  const row = { user_id: 1, post_id: 2, type: "new", title: "t", detail: "d", source_key: "", created_at: STAMP, notified: 0 };
  const plain = queries.insertUserEvent(row);
  const returning = queries.insertUserEvent(row, { returning: true });
  assert.ok(plain.sql.includes("INSERT INTO user_events (user_id, post_id, type, title, detail, source_key, created_at, notified)"));
  assert.deepEqual(returning.params, plain.params);
  assert.equal(returning.sql, `${plain.sql} RETURNING id`);
  assert.match(queries.watchedInGroup(1, "g").sql, /watch_group_id/);
  assert.match(queries.groupNotifiedDetails(1, "g", "new").sql, /ORDER BY id DESC/);
  assert.equal(queries.newEventExists(1, 2).params.length, 2);
});

function existingTables(sqliteDb, tables) {
  const have = new Set(
    sqliteDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
  );
  return tables.filter((name) => have.has(name));
}

async function withMirroredSchema(app, fn) {
  const sqliteDb = app.sqliteHandle();
  const schema = `pgenq_${Date.now().toString(36)}_${Math.floor(Math.random() * 100000)}`;
  const pgDriver = await createPostgresDriver({
    connectionString: PG_TEST_URL,
    poolOptions: { max: 3, options: `-c search_path=${schema}`, application_name: "5151-notify-enqueue" },
  });
  try {
    await importStore(pgDriver, sqliteDb, { schema, tables: existingTables(sqliteDb, TABLES) });
    return await fn(pgDriver, schema);
  } finally {
    await pgDriver.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pgDriver.close();
  }
}

// Both drivers have to answer the same values, not the same types (BIGINT arrives as a number here,
// which is what pgSchema's importer and dbDriverPostgres already agree on).
function normalizeEventRow(row) {
  return {
    user_id: Number(row.user_id) || 0,
    post_id: Number(row.post_id) || 0,
    type: String(row.type || ""),
    title: String(row.title ?? ""),
    detail: String(row.detail ?? ""),
    source_key: String(row.source_key ?? ""),
    created_at: String(row.created_at ?? ""),
    notified: Number(row.notified) || 0,
    group_id: String(row.group_id ?? ""),
    notify_profile_id: String(row.notify_profile_id ?? ""),
    notify_profile_version: Number(row.notify_profile_version) || 0,
  };
}

test("live PostgreSQL: the enqueue writes the queue the site reads", { skip }, async (t) => {
  const { app, db, seedMaxId } = await loadFixture();

  await t.test("the same members are queued with the same columns", async () => {
    const { enqueueListingEventAsync } = await import("../src/notifyEnqueueAsync.js");
    // The mirror carries whatever the SQLite fixture holds, so start from the seeded state.
    clearEvents(db, seedMaxId);
    await withMirroredSchema(app, async (pgDriver) => {
      const exec = (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
      const written = [];
      for (const [postId, event] of CASES) {
        const ids = await enqueueListingEventAsync(listingRow(db, postId), event, {
          driver: "postgres",
          exec,
          strict: true,
        });
        written.push(...ids);
      }
      const columns = `user_id, post_id, type, title, detail, source_key, created_at, notified,
                       group_id, notify_profile_id, notify_profile_version`;
      // The rows this run wrote, named by the ids the enqueue reported.
      const pgRows = await pgDriver.query(
        `SELECT ${columns} FROM user_events WHERE id = ANY($1) ORDER BY user_id, id`,
        [written.filter(Boolean)],
      );

      // The SQLite twin writes the same five events, from the same fixture.
      clearEvents(db, seedMaxId);
      for (const [postId, event] of CASES) app.enqueueListingEvent(listingRow(db, postId), event);

      // eventRows() walks POSTS while the query above answers in id order - compare row content, not
      // the order the two stores happen to return it in.
      const byPostThenUser = (a, b) => a.post_id - b.post_id || a.user_id - b.user_id;
      assert.deepEqual(
        pgRows.rows.map(normalizeEventRow).sort(byPostThenUser),
        eventRows(db, { afterId: seedMaxId }).map(normalizeEventRow).sort(byPostThenUser),
      );
      assert.equal(written.filter(Boolean).length, pgRows.rows.length);
      // ...and those rows are the ones the flush loop drains (notifyQueueAsync.js, ③ first half).
      const pending = await pgDriver.query(
        "SELECT id FROM user_events WHERE id = ANY($1) AND notified = 0",
        [written.filter(Boolean)],
      );
      assert.equal(pending.rows.length, pgRows.rows.length);
    });
  });
});
