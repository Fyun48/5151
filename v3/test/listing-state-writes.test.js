// Listing state writes: the background loops must store their results where the site reads them.
//
// db.js markListingOffline() / restoreListingOnline() / markListingAlive() / touchListingChecked()
// and invalidateListingLocation() are synchronous SQLite statements. The loops already read their
// work from the driver-aware entry points, so a probe result has to land in the same store -
// otherwise "this listing went offline" (or came back) never reaches PostgreSQL.
// crawlerWrites.js gives them one async entry point; the SQLite driver delegates to db.js, so
// production behaviour is unchanged.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { importStore } from "../src/pgSchema.js";
import { ensureDataRevisionTable } from "../src/dataRevision.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-state-writes-"));
process.env.DATA_DIR = dataDir;
after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite file locked while the process holds it.
  }
});

const PG_TEST_URL = (process.env.PG_TEST_URL || "").trim();
const skip = PG_TEST_URL ? false : "PG_TEST_URL is not set (live PostgreSQL state writes)";

// Everything the state write touches plus what the decorated read of it needs.
const TABLES = [
  "settings",
  "listings",
  "listing_search_projection",
  "data_revision",
  "user_listing_flags",
  "user_same_house_members",
  "user_match_votes",
  "listing_group_members",
  "listing_prep",
  "route_cache",
  "mrt_cache",
  "route_jobs",
];

const PG_ID = 940001;
const SQLITE_ID = 940002;
// The local test uses its own listing, so the live comparison starts from a pristine twin.
const LOCAL_ID = 940003;

let fixture = null;

// ⚠️ 「回到起點」必須**每次**都跑（`loadFixture()` 第一次之後會回快取的 fixture）：
// `upsertListing()` 是 upsert，前一條測試留下的 `offline`／`offline_confirmed`／`offline_at`
// 會跟著進來，讓後面依賴「兩列起點相同」的 live 子測試紅掉（CI 實測踩過）。
function resetListingState(db) {
  db.prepare(`UPDATE listings SET offline = 0, offline_confirmed = 0, offline_at = NULL,
      alive_checked_at = NULL, last_checked_at = NULL, last_event = 'new' WHERE post_id > 0`).run();
}

async function loadFixture() {
  if (fixture) {
    resetListingState(fixture.app.sqliteHandle());
    return fixture;
  }
  const app = await import("../src/db.js");
  const uid = app.defaultUserId();
  const stamp = "2026-09-07T00:00:00.000Z";
  const seed = (postId) => app.upsertListing({
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
    cover: "https://example.test/cover.png",
    tags: "[]",
    address: "台北市士林區測試路",
    area_name: "20坪",
    layout: "2房1廳1衛",
    floor_name: "5/12",
    kind_name: "整層住家/電梯大樓",
    role_name: "",
    refresh_time: stamp,
    first_seen_at: stamp,
    last_seen_at: stamp,
    last_event: "new",
    lat: 25.11,
    lng: 121.52,
  });
  seed(PG_ID);
  seed(SQLITE_ID);
  seed(LOCAL_ID);
  const db = app.sqliteHandle();
  db.prepare("UPDATE listings SET geo_source = 'geocode', content_seq = 3 WHERE post_id > 0").run();
  resetListingState(db);
  const jobKey = (postId) => `${postId}|to_work|distance|scooter|25.033,121.5654`;
  const insertJob = db.prepare("INSERT INTO route_jobs (job_key, post_id, direction, kind, commute_mode, job_state, updated_at) VALUES (?, ?, 'to_work', 'distance', 'scooter', 'failed', ?)");
  // One job per listing: the local test invalidates its own, so the mirrored (live) one survives.
  insertJob.run(jobKey(PG_ID), PG_ID, stamp);
  insertJob.run(jobKey(LOCAL_ID), LOCAL_ID, stamp);
  ensureDataRevisionTable(db);
  fixture = { app, uid };
  return fixture;
}

// The state these writes touch, read back through the crawler's own entry point.
async function stateOf(app, uid, postId, options = {}) {
  const { listingForWatchAsync } = await import("../src/crawlerReads.js");
  const row = await listingForWatchAsync(postId, uid, { sameHouse: false, ...options });
  if (!row) return null;
  return {
    offline: Number(row.offline) || 0,
    offline_confirmed: Number(row.offline_confirmed) || 0,
    last_event: String(row.last_event || ""),
    offline_at_set: Boolean(row.offline_at),
    last_checked_at_set: Boolean(row.last_checked_at),
    alive_checked_at_set: Boolean(row.alive_checked_at),
    content_seq: Number(row.content_seq) || 0,
  };
}

function existingTables(sqliteDb, tables) {
  const have = new Set(
    sqliteDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
  );
  return tables.filter((name) => have.has(name));
}

async function withMirroredSchema(app, fn) {
  const sqliteDb = app.sqliteHandle();
  const schema = `pgstate_${Date.now().toString(36)}_${Math.floor(Math.random() * 100000)}`;
  const pgDriver = await createPostgresDriver({
    connectionString: PG_TEST_URL,
    poolOptions: { max: 3, options: `-c search_path=${schema}`, application_name: "5151-state-writes" },
  });
  try {
    await importStore(pgDriver, sqliteDb, { schema, tables: existingTables(sqliteDb, TABLES) });
    return await fn(pgDriver);
  } finally {
    await pgDriver.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pgDriver.close();
  }
}

test("the state writes go through the driver-aware entry point", async () => {
  const { app, uid } = await loadFixture();
  const {
    invalidateListingLocationAsync,
    markListingAliveAsync,
    markListingOfflineAsync,
    restoreListingOnlineAsync,
    touchListingCheckedAsync,
  } = await import("../src/crawlerWrites.js");

  const before = await stateOf(app, uid, LOCAL_ID);
  // sqlite driver: the db.js behaviour, awaited.
  await markListingOfflineAsync(LOCAL_ID, { driver: "sqlite" });
  const off = await stateOf(app, uid, LOCAL_ID);
  assert.equal(off.offline, 1);
  assert.equal(off.last_event, "offline");
  assert.equal(off.offline_at_set, true);
  assert.ok(off.content_seq > before.content_seq, "the change counter advances");

  await markListingAliveAsync(LOCAL_ID, { driver: "sqlite" });
  const alive = await stateOf(app, uid, LOCAL_ID);
  assert.equal(alive.offline, 0);
  assert.equal(alive.alive_checked_at_set, true);

  await restoreListingOnlineAsync(LOCAL_ID, { driver: "sqlite" });
  const back = await stateOf(app, uid, LOCAL_ID);
  assert.equal(back.offline, 0);
  assert.equal(back.offline_at_set, false);

  await touchListingCheckedAsync(LOCAL_ID, { driver: "sqlite" });
  assert.equal((await stateOf(app, uid, LOCAL_ID)).last_checked_at_set, true);

  const db = app.sqliteHandle();
  const jobCount = (postId) => db.prepare("SELECT COUNT(*) AS n FROM route_jobs WHERE post_id = ?").get(postId).n;
  assert.equal(jobCount(LOCAL_ID), 1);
  await invalidateListingLocationAsync(LOCAL_ID, { driver: "sqlite" });
  assert.equal(jobCount(LOCAL_ID), 0);
  assert.equal(jobCount(PG_ID), 1, "only the invalidated listing's jobs are cleared");

  // Wiring: the loops and the two member handlers await the driver-aware writes.
  const watcher = readFileSync(path.join(dir, "../src/watcher.js"), "utf8");
  assert.match(watcher, /await markListingOfflineAsync\(postId\);/);
  assert.match(watcher, /await markListingAliveAsync\(row\.post_id, \{ wasOffline: Boolean\(listing\.offline\) \}\);/);
  // 第六十六批：bundle 只在 PG 模式提供 async 變體（同步那組是 SQLite 專用），
  // 而且 async 變體要**轉發 options**（測試／探針才能注入 driver）。
  assert.match(watcher, /markGoneAsync: fwd\(markListingOfflineAsync\)/);
  assert.match(watcher, /markAliveAsync: fwd\(markListingAliveAsync\)/);
  assert.match(watcher, /if \(driver === "postgres"\) return base;/);
  const server = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  assert.match(server, /await markListingOfflineAsync\(postId\);/);
  assert.match(server, /await markListingAliveAsync\(postId, \{ wasOffline: Boolean\(listing\.offline\) \}\);/);
  assert.doesNotMatch(server, /(?<![A-Za-z])markListingOffline\(/);
  assert.doesNotMatch(server, /(?<![A-Za-z])markListingAlive\(/);
  const queue = readFileSync(path.join(dir, "../src/listingEnrichQueue.js"), "utf8");
  assert.match(queue, /runHelper\(helpers, "markGone", listing\.post_id\)/);
  assert.match(queue, /runHelper\(helpers, "markAlive", listing\.post_id\)/);
  assert.match(queue, /function runHelper\(helpers, name, \.\.\.args\)/);
});


// ---------------------------------------------------------------------------
// 第六十七批：`confirmExpiredOfflineListings()`（已下線 N 天後自動確認）的 driver-aware 版本。
// 這一支是**讀取路徑**順手跑的掃描（`/api/listings`、`/api/state`），原本只寫本機 SQLite。
// ---------------------------------------------------------------------------

test("逾期下線掃描：PG 分支改的列數與落地狀態都與同步版相同", async () => {
  const writes = await import("../src/crawlerWrites.js");
  const { app } = await loadFixture();
  const db = app.sqliteHandle();
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
  // 三種列：已下線且逾期（要改）、已下線但還新（不改）、已確認過（不改）。
  const seed = (id, offline, confirmed, stamp) => db.prepare(
    "UPDATE listings SET offline = ?, offline_confirmed = ?, offline_at = ?, last_checked_at = ? WHERE post_id = ?",
  ).run(offline, confirmed, stamp, stamp, id);
  seed(LOCAL_ID, 1, 0, old);
  seed(SQLITE_ID, 1, 0, new Date().toISOString());
  seed(PG_ID, 1, 1, old);
  const read = (id) => {
    const row = db.prepare("SELECT offline_confirmed, last_event FROM listings WHERE post_id = ?").get(id);
    return { confirmed: Number(row.offline_confirmed) || 0, event: String(row.last_event || "") };
  };
  const before = { [LOCAL_ID]: read(LOCAL_ID), [SQLITE_ID]: read(SQLITE_ID), [PG_ID]: read(PG_ID) };
  const baseline = { local: before[LOCAL_ID], sqlite: before[SQLITE_ID], pg: before[PG_ID] };

  // 同步版基準（走本機 handle）。
  const syncCount = app.confirmExpiredOfflineListings(7);
  const afterSync = { local: read(LOCAL_ID), sqlite: read(SQLITE_ID), pg: read(PG_ID) };
  assert.equal(syncCount, 1, "同步版：只有逾期那一列被確認");
  assert.deepEqual(afterSync.local, { confirmed: 1, event: "offline" });

  // 回到起點（把三個欄位寫回同步版跑之前的值），改走 PG 分支。
  const restore = (id, confirmed) => db.prepare(
    "UPDATE listings SET offline_confirmed = ?, last_event = ? WHERE post_id = ?",
  ).run(confirmed, before[id].event, id);
  restore(LOCAL_ID, before[LOCAL_ID].confirmed);
  restore(SQLITE_ID, before[SQLITE_ID].confirmed);
  restore(PG_ID, before[PG_ID].confirmed);
  assert.deepEqual({ local: read(LOCAL_ID), sqlite: read(SQLITE_ID), pg: read(PG_ID) }, baseline, "前置條件：已還原");
  const calls = [];
  const shim = async (sql, params = []) => {
    calls.push(sql);
    return db.prepare(String(sql)).all(...params);
  };
  writes.resetExpiredOfflineSweepForTests();
  const pgCount = await writes.confirmExpiredOfflineAsync({ days: 7, now: Date.now() }, { driver: "postgres", exec: shim, strict: true });
  assert.equal(pgCount, syncCount, "PG 分支改的列數必須與同步版相同");
  assert.deepEqual({ local: read(LOCAL_ID), sqlite: read(SQLITE_ID), pg: read(PG_ID) }, afterSync,
    "PG 分支的落地狀態必須與同步版相同");
  assert.match(calls[0], /RETURNING 1/);
  assert.match(calls[0], /IFNULL/, "語句文字要逐字沿用同步版（PG 端由 toPostgresSql 轉 COALESCE）");
});

test("逾期下線掃描：60 秒內第二次不重掃（節流），而且 sqlite 模式回退同步版", async () => {
  const writes = await import("../src/crawlerWrites.js");
  const { app } = await loadFixture();
  let updates = 0;
  const spy = async (sql, params = []) => {
    if (/^\s*UPDATE/i.test(String(sql))) updates += 1;
    return app.sqliteHandle().prepare(String(sql)).all(...params);
  };
  const at = Date.now();
  writes.resetExpiredOfflineSweepForTests();
  await writes.confirmExpiredOfflineAsync({ days: 7, now: at }, { driver: "postgres", exec: spy, strict: true });
  assert.equal(updates, 1, "第一次要真的掃");
  await writes.confirmExpiredOfflineAsync({ days: 7, now: at + 5_000 }, { driver: "postgres", exec: spy, strict: true });
  assert.equal(updates, 1, "同一個 60 秒窗口內不得再掃一次");
  await writes.confirmExpiredOfflineAsync({ days: 7, now: at + 61_000 }, { driver: "postgres", exec: spy, strict: true });
  assert.equal(updates, 2, "超過 60 秒之後可以再掃");

  // sqlite 模式：回退同步版（同一支 db.js 函式），不碰傳入的 exec。
  writes.resetExpiredOfflineSweepForTests();
  const before = app.sqliteHandle().prepare("SELECT COUNT(*) AS n FROM listings WHERE offline_confirmed = 1").get().n;
  const n = await writes.confirmExpiredOfflineAsync({ days: 7 }, { driver: "sqlite", exec: spy });
  const after = app.sqliteHandle().prepare("SELECT COUNT(*) AS n FROM listings WHERE offline_confirmed = 1").get().n;
  assert.equal(typeof n, "number");
  assert.equal(after >= before, true, "sqlite 模式必須寫本機那一份");
});

test("live PostgreSQL: the state writes land where the site reads", { skip }, async (t) => {
  const { app, uid } = await loadFixture();
  const writes = await import("../src/crawlerWrites.js");
  const pgOptions = (pgDriver) => ({ driver: "postgres", pgDriver, strict: true });
  const pgRead = (pgDriver) => ({ driver: "postgres", pgDriver, deps: app.crawlerReadsBuildContext(), strict: true });

  await t.test("offline -> alive -> restored -> checked match SQLite field for field", async () => {
    await withMirroredSchema(app, async (pgDriver) => {
      const start = await stateOf(app, uid, PG_ID, pgRead(pgDriver));
      assert.equal(start.offline, 0);
      const twinStart = await stateOf(app, uid, SQLITE_ID);
      assert.deepEqual(start, twinStart, "both listings start from the same imported state");

      await writes.markListingOfflineAsync(PG_ID, pgOptions(pgDriver));
      app.markListingOffline(SQLITE_ID);
      const offPg = await stateOf(app, uid, PG_ID, pgRead(pgDriver));
      assert.deepEqual(offPg, await stateOf(app, uid, SQLITE_ID));
      assert.equal(offPg.offline, 1);
      assert.ok(offPg.content_seq > start.content_seq, "the PostgreSQL row's counter advanced");

      await writes.markListingAliveAsync(PG_ID, { ...pgOptions(pgDriver), wasOffline: true });
      app.markListingAlive(SQLITE_ID);
      assert.deepEqual(await stateOf(app, uid, PG_ID, pgRead(pgDriver)), await stateOf(app, uid, SQLITE_ID));

      await writes.restoreListingOnlineAsync(PG_ID, pgOptions(pgDriver));
      app.restoreListingOnline(SQLITE_ID);
      assert.deepEqual(await stateOf(app, uid, PG_ID, pgRead(pgDriver)), await stateOf(app, uid, SQLITE_ID));

      await writes.touchListingCheckedAsync(PG_ID, pgOptions(pgDriver));
      app.touchListingChecked(SQLITE_ID);
      assert.deepEqual(await stateOf(app, uid, PG_ID, pgRead(pgDriver)), await stateOf(app, uid, SQLITE_ID));
    });
  });

  await t.test("geo 回填落點改的是 PG 那一列（本機不動）", async () => {
    await withMirroredSchema(app, async (pgDriver) => {
      const db = app.sqliteHandle();
      const address = "台北市士林區測試路";
      const localBefore = db.prepare("SELECT lat, lng, coord_version FROM listings WHERE post_id = ?").get(PG_ID);
      await pgDriver.query("UPDATE listings SET lat = NULL, lng = NULL, location_class = '', coord_version = 0 WHERE post_id = $1", [PG_ID]);
      const n = await writes.updateListingsGeoByAddressAsync(address, 25.4321, 121.8765, {
        geo_source: "geocode", location_class: "address", address_used: address, provider: "photon",
      }, pgOptions(pgDriver));
      assert.equal(n >= 1, true, "同一地址至少一列要被更新（PG 回報列數）");
      const row = (await pgDriver.query("SELECT lat, lng, geo_source, location_class, coord_version FROM listings WHERE post_id = $1", [PG_ID])).rows[0];
      assert.equal(Number(row.lat), 25.4321, "座標要落在 PG 那一列");
      assert.equal(Number(row.lng), 121.8765);
      assert.equal(row.geo_source, "geocode");
      assert.equal(Number(row.coord_version), 1);
      const localAfter = db.prepare("SELECT lat, lng, coord_version FROM listings WHERE post_id = ?").get(PG_ID);
      assert.deepEqual(localAfter, localBefore, "PG 模式不得動到本機那一列（站上讀的是 PG）");
    });
  });

  await t.test("逾期下線掃描在 PG 上真的改到那一列（並回報列數）", async () => {
    await withMirroredSchema(app, async (pgDriver) => {
      const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
      await pgDriver.query(
        "UPDATE listings SET offline = 1, offline_confirmed = 0, offline_at = $1, last_checked_at = $1 WHERE post_id = $2",
        [old, PG_ID],
      );
      writes.resetExpiredOfflineSweepForTests();
      const n = await writes.confirmExpiredOfflineAsync({ days: 7 }, pgOptions(pgDriver));
      assert.equal(n, 1, "PG 分支要回報 1 列（RETURNING 1 的列數，不是空陣列）");
      const row = await pgDriver.query("SELECT offline_confirmed, last_event FROM listings WHERE post_id = $1", [PG_ID]);
      assert.equal(Number(row.rows[0].offline_confirmed), 1);
      assert.equal(String(row.rows[0].last_event), "offline");
    });
  });

  await t.test("invalidateLocation clears the route_jobs rows", async () => {
    await withMirroredSchema(app, async (pgDriver) => {
      const before = await pgDriver.query("SELECT COUNT(*) AS n FROM route_jobs WHERE post_id = $1", [PG_ID]);
      assert.equal(Number(before.rows[0].n), 1);
      await writes.invalidateListingLocationAsync(PG_ID, pgOptions(pgDriver));
      const after = await pgDriver.query("SELECT COUNT(*) AS n FROM route_jobs WHERE post_id = $1", [PG_ID]);
      assert.equal(Number(after.rows[0].n), 0);
    });
  });
});




// ---------------------------------------------------------------------------
// 第六十八批：`updateListingsGeoByAddress()`（geo 回填 worker 的落點）的 driver-aware 版本。
// 原本只寫本機 SQLite ⇒ PG 模式下回填算出來的座標不會出現在站上讀的那一份。
// ---------------------------------------------------------------------------

test("geo 回填落點：PG 分支的語句、列數與落地值都與同步版相同", async () => {
  const writes = await import("../src/crawlerWrites.js");
  const { app } = await loadFixture();
  const db = app.sqliteHandle();
  const address = "台北市士林區測試路";
  // ⚠️ 三筆 fixture 房源共用同一個地址 ⇒ 兩條 driver 都應該改到**三列**（第一版寫 1，
  // 是把「一個地址一列」當成前提；那正是這支函式要處理的情境）。
  const cols = "post_id, lat, lng, geo_source, location_class, coord_version";
  const readAll = () => db.prepare(`SELECT ${cols} FROM listings WHERE post_id > 0 ORDER BY post_id`).all()
    .map((row) => ({ ...row, lat: row.lat == null ? null : Number(row.lat), lng: row.lng == null ? null : Number(row.lng) }));
  const clearCoords = () => db.prepare(
    "UPDATE listings SET lat = NULL, lng = NULL, location_class = '', coord_version = 0 WHERE post_id > 0",
  ).run();
  const seen = [];
  // 注入式 exec：PG 的語句跑在同一顆 SQLite 上（$n → ?），並記錄語句種類。
  const shim = async (sql, params = []) => {
    seen.push(String(sql).trim().split(/\s+/)[0].toUpperCase());
    const text = String(sql).replace(/\$(\d+)/g, "?");
    const stmt = db.prepare(text);
    return /^\s*(select|with)/i.test(text) ? stmt.all(...params) : (stmt.run(...params), []);
  };
  const meta = { geo_source: "geocode", location_class: "address", address_used: address, provider: "photon" };

  clearCoords();
  const viaPg = await writes.updateListingsGeoByAddressAsync(address, 25.1234, 121.5678, meta, { driver: "postgres", exec: shim, strict: true });
  const afterPg = readAll();
  assert.equal(viaPg, 3, "同一個地址的三列都要被更新（PG 分支回報列數）");
  // 語句種類：INSERT＝geo_cache 的 upsert、SELECT＝候選列、UPDATE＝座標與「重新排隊通知」
  //（每一列兩句）。不得出現其他種類。
  assert.deepEqual([...new Set(seen)].sort(), ["INSERT", "SELECT", "UPDATE"], `語句種類不對：${JSON.stringify(seen)}`);
  assert.equal(seen.filter((k) => k === "UPDATE").length, viaPg * 2, "每一列要有座標與通知兩句 UPDATE");
  for (const row of afterPg) {
    assert.equal(row.lat, 25.1234);
    assert.equal(row.lng, 121.5678);
    assert.equal(row.geo_source, "geocode");
    assert.equal(row.location_class, "address");
    assert.equal(row.coord_version, 1, "coord_version 從各列自己的現值往上加");
  }

  // 同步版基準：同一組輸入、同一顆 DB，落地值必須逐欄相同。
  clearCoords();
  const viaSync = app.updateListingsGeoByAddress(address, 25.1234, 121.5678, meta);
  assert.equal(viaSync, viaPg, "同步版改的列數必須相同");
  assert.deepEqual(readAll(), afterPg, "兩條 driver 的落地值必須逐欄相同");

  // 非法輸入：座標不是有限數時兩邊都不落地（也不寫快取）。
  const geoBefore = db.prepare("SELECT COUNT(*) AS n FROM geo_cache").get().n;
  assert.equal(await writes.updateListingsGeoByAddressAsync(address, Number.NaN, 121.5, meta, { driver: "postgres", exec: shim, strict: true }), 0);
  assert.equal(app.updateListingsGeoByAddress(address, Number.NaN, 121.5, meta), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM geo_cache").get().n, geoBefore, "非法座標不得寫入快取");
});

