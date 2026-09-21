// Notification queue parity: the flush loop has to drain the queue the site reads.
//
// watcher.flushPendingNotifications() reads its batch with db.js pendingNotifyEvents() and writes
// every channel outcome back with updateEventNotify() / markEventNotified() - synchronous SQLite
// statements. With DB_DRIVER=postgres the events live in PostgreSQL, so the loop would find an empty
// queue and (when it did find rows) record the outcome in the wrong store. notifyQueueAsync.js gives
// those three calls one async entry point; this suite pins them to the SQLite answers on both
// drivers, including the ordering contract of the pending page.
//
// Still SQLite-shaped (POSTGRES_SWITCH_PLAN ③): enqueueListingEvent()'s decision chain decides what
// enters the queue and has not been ported yet.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { importStore } from "../src/pgSchema.js";
import { ensurePersonalSchema } from "../src/personalSchema.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-notify-queue-"));
process.env.DATA_DIR = dataDir;
after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite file locked while the process holds it.
  }
});

const PG_TEST_URL = (process.env.PG_TEST_URL || "").trim();
const skip = PG_TEST_URL ? false : "PG_TEST_URL is not set (live PostgreSQL notification queue)";

// The queue only needs the events and the listing they point at.
const TABLES = ["listings", "user_listing_flags", "user_events"];

// One fixed clock: "notify_next_at is in the future" must not depend on when the test runs.
const NOW = Date.parse("2026-09-21T00:00:00.000Z");
// Ranks of the pending page's ORDER BY: ready, a retrying channel, a located listing, everything else.
const RANK = { ready: 950011, retry: 950012, located: 950013, plain: 950014, plainLater: 950015 };
const EXCLUDED = { notified: 950016, cancelled: 950017, future: 950018 };
// The twin rows the write subtests mutate: PostgreSQL on one, SQLite on the other.
const WRITE_PG = 950021;
const WRITE_SQLITE = 950022;
// markEventNotified is observed once per driver (a pending row, so it leaves the page).
const MARK_LOCAL = 950023;
const MARK_PG = 950024;

let fixture = null;

async function loadFixture() {
  if (fixture) return fixture;
  const app = await import("../src/db.js");
  const uid = app.defaultUserId();
  seedListing(app, 950001, { lat: 25.11, lng: 121.52 });
  seedListing(app, 950002, { lat: null, lng: null });
  const db = app.sqliteHandle();
  ensurePersonalSchema(db);
  db.prepare("UPDATE listings SET geo_source = 'geocode', location_class = 'street' WHERE post_id = 950001").run();
  db.prepare("UPDATE listings SET geo_source = '', location_class = '' WHERE post_id = 950002").run();

  // addEvent() returns the row id, which is *not* the post_id - the page is ordered by the id, so
  // the fixture tracks both.
  const EVENT = {};
  const event = (postId, patch = {}) => {
    const id = app.addEvent({
      post_id: postId,
      type: "new",
      title: `通知 ${postId}`,
      detail: "",
      source_key: `1|8|${postId}`,
      created_at: "2026-09-20T00:00:00.000Z",
    }, uid);
    const columns = {
      notify_decide: "",
      notify_reason: "",
      notify_next_at: null,
      dock_job_state: "",
      line_job_state: "",
      email_job_state: "",
      push_job_state: "",
      notified: 0,
      ...patch,
    };
    db.prepare(`
      UPDATE user_events
         SET notify_decide = ?, notify_reason = ?, notify_next_at = ?,
             dock_job_state = ?, line_job_state = ?, email_job_state = ?, push_job_state = ?, notified = ?
       WHERE id = ?
    `).run(
      columns.notify_decide,
      columns.notify_reason,
      columns.notify_next_at,
      columns.dock_job_state,
      columns.line_job_state,
      columns.email_job_state,
      columns.push_job_state,
      columns.notified,
      id,
    );
    EVENT[postId] = id;
    return id;
  };

  event(RANK.ready, { notify_decide: "ready" });
  event(RANK.retry, { line_job_state: "retry" });
  event(RANK.located, { notify_decide: "wait_route" });
  event(RANK.plain, { notify_decide: "wait_precision", notify_next_at: null });
  event(RANK.plainLater, { notify_decide: "wait_precision", notify_next_at: 7 });
  event(EXCLUDED.notified, { notified: 1 });
  event(EXCLUDED.cancelled, { notify_decide: "cancelled" });
  event(EXCLUDED.future, { notify_next_at: NOW + 60 * 60 * 1000 });
  // Twin rows for the write subtests. They start already notified, so they never enter the pending
  // page above - the page assertions stay independent of the write subtests.
  event(WRITE_PG, { notify_decide: "send", notified: 1 });
  event(WRITE_SQLITE, { notify_decide: "send", notified: 1 });
  event(MARK_LOCAL, { notify_decide: "wait_route" });
  event(MARK_PG, { notify_decide: "wait_route" });

  fixture = { app, uid, eventIds: EVENT };
  return fixture;
}

function seedListing(app, postId, { lat, lng }) {
  return app.upsertListing({
    post_id: postId,
    source: "591",
    source_id: String(postId),
    source_key: `1|8|${postId}`,
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
    refresh_time: "2026-09-20T00:00:00.000Z",
    first_seen_at: "2026-09-20T00:00:00.000Z",
    last_seen_at: "2026-09-20T00:00:00.000Z",
    last_event: "new",
    lat,
    lng,
  });
}

function existingTables(sqliteDb, tables) {
  const have = new Set(
    sqliteDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
  );
  return tables.filter((name) => have.has(name));
}

async function withMirroredSchema(app, fn) {
  const sqliteDb = app.sqliteHandle();
  const schema = `pgnotify_${Date.now().toString(36)}_${Math.floor(Math.random() * 100000)}`;
  const pgDriver = await createPostgresDriver({
    connectionString: PG_TEST_URL,
    poolOptions: { max: 3, options: `-c search_path=${schema}`, application_name: "5151-notify-queue" },
  });
  try {
    await importStore(pgDriver, sqliteDb, { schema, tables: existingTables(sqliteDb, TABLES) });
    return await fn(pgDriver, schema);
  } finally {
    await pgDriver.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pgDriver.close();
  }
}

async function pgEvent(pgDriver, id) {
  const result = await pgDriver.query("SELECT * FROM user_events WHERE id = $1", [Number(id)]);
  return (result.rows || [])[0] || null;
}

function sqliteEvent(app, id) {
  const row = app.sqliteHandle().prepare("SELECT * FROM user_events WHERE id = ?").get(Number(id));
  return row ? { ...row } : null;
}

// The ordering contract, restricted to this fixture's ranked rows (the page may also hold rows a
// neighbouring subtest created).
function rankOrderOf(rows) {
  const wanted = new Set(Object.values(RANK));
  return (rows || []).map((row) => Number(row.post_id)).filter((id) => wanted.has(id));
}

// The columns updateEventNotify() owns: the comparison has to see the same values on both drivers.
function notifyColumns(row) {
  if (!row) return null;
  const text = (value) => String(value ?? "");
  const num = (value) => Number(value) || 0;
  return {
    notify_decide: text(row.notify_decide),
    notify_reason: text(row.notify_reason),
    notify_retry_count: num(row.notify_retry_count),
    notify_last_error: text(row.notify_last_error),
    notify_next_at: row.notify_next_at == null ? null : Number(row.notify_next_at),
    notify_ready_at: row.notify_ready_at == null ? null : Number(row.notify_ready_at),
    notify_coord_version: num(row.notify_coord_version),
    dock_job_state: text(row.dock_job_state),
    line_job_state: text(row.line_job_state),
    email_job_state: text(row.email_job_state),
    push_job_state: text(row.push_job_state),
    notified: num(row.notified),
  };
}

// The flush loop's payload for one event.
const NOTIFY_PATCH = {
  notify_decide: "send",
  notify_reason: "distance_ok",
  notify_coord_version: 3,
  notify_ready_at: NOW,
  dock_job_state: "accepted",
  line_job_state: "retry",
  email_job_state: "skipped",
  push_job_state: "",
  notify_last_error: "timeout",
  notify_retry_count: 2,
};



test("the notification queue reads and writes through the driver-aware entry point", async () => {
  const { app, eventIds } = await loadFixture();
  const { pendingNotifyEventsAsync, updateEventNotifyAsync, markEventNotifiedAsync } = await import("../src/notifyQueueAsync.js");
  const options = { driver: "sqlite" };

  // The flush loop's batch: same rows, same order as the synchronous scan.
  const viaFacade = await pendingNotifyEventsAsync({ limit: 20, now: NOW }, options);
  const direct = app.pendingNotifyEvents(20, NOW);
  assert.deepEqual(viaFacade, direct);
  assert.deepEqual(rankOrderOf(direct), [RANK.ready, RANK.retry, RANK.located, RANK.plain, RANK.plainLater],
    "ready, retrying channel, located listing, then the rest (notify_next_at before id)");
  for (const postId of Object.values(EXCLUDED)) { const id = eventIds[postId];
    assert.ok(!direct.some((row) => Number(row.id) === id), `event ${id} stays out of the page`);
  }

  // ...and its writes do what the synchronous ones do.
  await updateEventNotifyAsync(eventIds[WRITE_PG], NOTIFY_PATCH, options);
  app.updateEventNotify(eventIds[WRITE_SQLITE], NOTIFY_PATCH);
  assert.deepEqual(notifyColumns(sqliteEvent(app, eventIds[WRITE_PG])), notifyColumns(sqliteEvent(app, eventIds[WRITE_SQLITE])));

  await markEventNotifiedAsync(eventIds[MARK_LOCAL], options);
  assert.equal(Number(sqliteEvent(app, eventIds[MARK_LOCAL]).notified), 1, "markEventNotified sets the flag");
  const afterMark = app.pendingNotifyEvents(20, NOW);
  assert.ok(!afterMark.some((row) => Number(row.id) === eventIds[MARK_LOCAL]), "and takes it out of the page");
  // A missing id is not an error on either side.
  assert.equal(await updateEventNotifyAsync(999999, NOTIFY_PATCH, options), null);

  // Wiring: the flush loop awaits all three (no synchronous call left in watcher.js).
  const watcher = readFileSync(path.join(dir, "../src/watcher.js"), "utf8");
  assert.match(watcher, /import \{ markEventNotifiedAsync, pendingNotifyEventsAsync, updateEventNotifyAsync \} from "\.\/notifyQueueAsync\.js";/);
  assert.match(watcher, /const pending = await pendingNotifyEventsAsync\(\{ limit: 400 \}\);/);
  assert.match(watcher, /const pending = await pendingNotifyEventsAsync\(\{ limit: 40 \}\);/);
  assert.match(watcher, /await updateEventNotifyAsync\(event\.id, \{ notify_decide: "cancelled"/);
  assert.match(watcher, /await markEventNotifiedAsync\(id\);/);
  assert.equal((watcher.match(/(?<!Async\()\bupdateEventNotify\(/g) || []).length, 0);
  assert.equal((watcher.match(/(?<!Async\()\bpendingNotifyEvents\(/g) || []).length, 0);
  assert.equal((watcher.match(/(?<!Async\()\bmarkEventNotified\(/g) || []).length, 0);
});

test("live PostgreSQL: the notification queue drains the same store it writes", { skip }, async (t) => {
  const { app, eventIds } = await loadFixture();
  const { pendingNotifyEventsAsync, updateEventNotifyAsync, markEventNotifiedAsync } = await import("../src/notifyQueueAsync.js");
  const pgOptions = (pgDriver) => ({ driver: "postgres", pgDriver, strict: true });

  await t.test("the pending page matches SQLite (rows and order)", async () => {
    await withMirroredSchema(app, async (pgDriver) => {
      const pgRows = await pendingNotifyEventsAsync({ limit: 20, now: NOW }, pgOptions(pgDriver));
      const sqliteRows = app.pendingNotifyEvents(20, NOW);
      assert.deepEqual(pgRows, sqliteRows);
      assert.deepEqual(rankOrderOf(sqliteRows), [RANK.ready, RANK.retry, RANK.located, RANK.plain, RANK.plainLater]);
    });
  });

  await t.test("updateEventNotify writes the same columns as SQLite", async () => {
    await withMirroredSchema(app, async (pgDriver) => {
      app.updateEventNotify(eventIds[WRITE_SQLITE], NOTIFY_PATCH);
      await updateEventNotifyAsync(eventIds[WRITE_PG], NOTIFY_PATCH, pgOptions(pgDriver));
      assert.deepEqual(
        notifyColumns(await pgEvent(pgDriver, eventIds[WRITE_PG])),
        notifyColumns(sqliteEvent(app, eventIds[WRITE_SQLITE])),
      );
    });
  });

  await t.test("markEventNotified takes the event out of the queue it wrote to", async () => {
    await withMirroredSchema(app, async (pgDriver) => {
      const before = await pendingNotifyEventsAsync({ limit: 20, now: NOW }, pgOptions(pgDriver));
      assert.ok(before.some((row) => Number(row.id) === eventIds[MARK_PG]));
      await markEventNotifiedAsync(eventIds[MARK_PG], pgOptions(pgDriver));
      const after = await pendingNotifyEventsAsync({ limit: 20, now: NOW }, pgOptions(pgDriver));
      assert.ok(!after.some((row) => Number(row.id) === eventIds[MARK_PG]), "gone from the PostgreSQL page");
      assert.equal(Number((await pgEvent(pgDriver, eventIds[MARK_PG])).notified), 1);
      // The SQLite twin is untouched by a PostgreSQL write - the mismatch this slice removes.
      assert.equal(Number(sqliteEvent(app, eventIds[MARK_PG]).notified), 0);
    });
  });
});
