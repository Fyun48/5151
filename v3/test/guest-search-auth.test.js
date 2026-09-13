import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publicPath } from "../src/auth.js";
import {
  assertPublicListingsReadable,
  PUBLIC_LIST_RATE,
  resetPublicListingsRateLimit,
} from "../src/rateLimit.js";
import { getCachedPublicListings, resetPublicListingsCache } from "../src/publicListings.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

test("I: guest sessionStorage survives a refresh-shaped read", () => {
  const src = readFileSync(path.join(dir, "../public/guest-search-state.js"), "utf8");
  const run = new Function("exports", `${src}; return globalThis.GuestSearchState;`);
  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  };
  const api = run({});
  api.write({ districts: ["士林區"], priceMax: 25000, kinds: ["whole"], sort: "price_asc" }, storage);
  const again = api.read(storage);
  assert.deepEqual(again.districts, ["士林區"]);
  assert.equal(again.priceMax, 25000);
  assert.equal(again.sort, "price_asc");
  assert.equal(api.KEY, "591_v3_guest_search");
});

test("guest boot does not prefetch /api/settings before knowing the session", () => {
  const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");
  const load = html.slice(html.indexOf("async function loadState"), html.indexOf("function collectSettings"));
  const guestReturn = load.indexOf("maybeStartGuestTour()");
  const firstSettings = load.indexOf('fetch("/api/settings"');
  assert.ok(guestReturn > 0 && firstSettings > guestReturn, "member settings fetch must stay after the guest return");
});

test("J: member load path does not apply guest sessionStorage", () => {
  const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");
  const guestBranch = html.slice(html.indexOf("if (!me.ok)"), html.indexOf("setGuestMode(false)"));
  const memberBranch = html.slice(html.indexOf("setGuestMode(false)"));
  assert.match(guestBranch, /GuestSearchState\?\.read/);
  assert.match(guestBranch, /applyGuestSearch/);
  assert.doesNotMatch(memberBranch, /GuestSearchState\?\.read\(/);
  assert.match(html, /會員 active profile 優先/);
});

test("H: write member routes require session.userId and never actorUserId", () => {
  const src = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  for (const route of [
    'app.post("/api/settings"',
    'app.post("/api/profiles"',
    'app.post("/api/listings/:id/flags"',
    'app.post("/api/listings/hide-many"',
    'app.post("/api/watch"',
    'app.post("/api/member-mail"',
  ]) {
    const start = src.indexOf(route);
    assert.ok(start > 0, route);
    const slice = src.slice(start, start + 500);
    assert.match(slice, /requireMember|session\?\.userId/);
    assert.doesNotMatch(slice, /actorUserId\(req\)/);
  }
  assert.match(src, /async function persistSettings[\s\S]*if \(!uid\)/);
});

test("L: this change does not enable rakuya", () => {
  const src = [
    readFileSync(path.join(dir, "../src/publicListings.js"), "utf8"),
    readFileSync(path.join(dir, "../src/sameHouseReconcile.js"), "utf8"),
    readFileSync(path.join(dir, "../public/guest-search-state.js"), "utf8"),
  ].join("\n");
  assert.doesNotMatch(src, /rakuya/i);
  const server = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  const pubRoute = server.slice(server.indexOf('app.get("/api/public/listings"'), server.indexOf("function actorUserId"));
  assert.doesNotMatch(pubRoute, /saveCrawlSources/);
  assert.doesNotMatch(pubRoute, /rakuya/i);
});

test("public listings path is guest-readable and member listings are not", () => {
  assert.equal(publicPath({ path: "/api/public/listings" }), true);
  assert.equal(publicPath({ path: "/api/listings" }), false);
  assert.equal(publicPath({ path: "/api/settings" }), false);
});

test("public rate limit allows a burst without the demo 40/10min cliff", () => {
  resetPublicListingsRateLimit();
  for (let i = 0; i < PUBLIC_LIST_RATE.burstLimit; i += 1) {
    assert.doesNotThrow(() => assertPublicListingsReadable("9.9.9.9", 1_000));
  }
  assert.throws(() => assertPublicListingsReadable("9.9.9.9", 1_000), /搜尋稍快/);
  assert.doesNotThrow(() => assertPublicListingsReadable("8.8.8.8", 1_000));
});

function runIsolated(body) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-guest-auth-"));
  const script = `
    import assert from "node:assert/strict";
    import * as app from ${JSON.stringify(path.join(dir, "../src/db.js"))};
    import { getCachedPublicListings, resetPublicListingsCache } from ${JSON.stringify(path.join(dir, "../src/publicListings.js"))};
    const uid = app.defaultUserId();
    const beforeSettings = JSON.stringify(app.getSettings(uid));
    function seed(post_id, overrides = {}) {
      app.upsertListing({
        post_id, source: "591", source_id: String(post_id),
        source_key: "1|8|" + post_id, search_key: "https://example.test/search",
        title: "合成住宅 " + post_id, url: "https://example.test/" + post_id,
        price: "20000元", price_num: 20000, extra_fees: [],
        address: "台北市士林區測試路" + post_id + "號", area_name: "20坪",
        layout: "2房1廳1衛", floor_name: "5/12", kind_name: "整層住家/電梯大樓",
        role_name: "", cover: "https://example.test/cover.png", tags: "[]",
        refresh_time: "2026-09-01T00:00:00.000Z",
        first_seen_at: "2026-09-01T00:00:00.000Z",
        last_seen_at: "2026-09-01T00:00:00.000Z", last_event: "new",
        ...overrides,
      });
    }
    ${body}
    assert.equal(JSON.stringify(app.getSettings(uid)), beforeSettings);
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("G/M/N: guest public search is read-only, caches, and does not touch member settings", () => {
  runIsolated(`
    seed(601);
    seed(602, { price: "18000元", price_num: 18000 });
    const eventsBefore = app.db.prepare("SELECT COUNT(*) AS n FROM user_events").get().n;
    const flagsBefore = app.db.prepare("SELECT COUNT(*) AS n FROM user_listing_flags").get().n;
    app.resetPublicListingsDecorateCount();
    resetPublicListingsCache();
    const query = { districts: ["士林區"], sort: "newest", limit: 40, offset: 0 };
    const load = () => app.listPublicListings({
      ...query,
      settings: app.publicSearchSettings(query),
    });
    const cold = getCachedPublicListings(query, load);
    assert.equal(cold.cache_hit, false);
    assert.ok(cold.listings.length >= 1);
    assert.equal(cold.guest, true);
    const hot = getCachedPublicListings(query, load);
    assert.equal(hot.cache_hit, true);
    assert.equal(app.publicListingsDecorateCount(), 1);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM user_events").get().n, eventsBefore);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM user_listing_flags").get().n, flagsBefore);
  `);
});

test("M: public listing query never queues geo, routes, or crawlers", () => {
  const src = readFileSync(path.join(dir, "../src/db.js"), "utf8");
  const fn = src.slice(src.indexOf("export function listPublicListings"), src.indexOf("export function runSameHouseBackfill"));
  assert.doesNotMatch(fn, /queueGeo|upsertRouteJob|coveringJobs|saveSettings|defaultUserId\(/);
  assert.doesNotMatch(fn, /geocodeAddress|warmRouteCache/);
});

test("guest sessionStorage keeps work address and four districts", () => {
  const src = readFileSync(path.join(dir, "../public/guest-search-state.js"), "utf8");
  const run = new Function("exports", `${src}; return globalThis.GuestSearchState;`);
  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  };
  const api = run({});
  api.write({
    districts: ["士林區", "北投區", "大同區", "中山區", "松山區"],
    watchDistricts: ["1-8", "1-9", "1-10", "1-11", "1-12"],
    workAddress: "臺北市南港區經貿一路170號",
    commuteKm: 8,
  }, storage);
  const again = api.read(storage);
  const query = api.toQuery(again);
  assert.deepEqual(query.districts, ["士林區", "北投區", "大同區", "中山區"]);
  assert.deepEqual(query.watchDistricts, ["1-8", "1-9", "1-10", "1-11"]);
  assert.equal(query.workAddress, "臺北市南港區經貿一路170號");
  assert.equal(query.commuteKm, 8);
});

test("guest UI unlocks district picker and commute, and drops street-estimate checkbox", () => {
  const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");
  assert.match(html, /GUEST_MAX_DISTRICTS = 4/);
  assert.match(html, /return isGuest \? GUEST_MAX_DISTRICTS : MEMBER_MAX_DISTRICTS/);
  assert.match(html, /#districtPicker"\) && !el\.closest\("\[data-city-hide\]"\)/);
  assert.match(html, /#workAddress, #commuteKm/);
  assert.match(html, /params\.set\("workAddress"/);
  assert.doesNotMatch(html, /id="notifyIncludeStreetEstimate"/);
  assert.match(html, /可填上班地址與距離上限/);
  assert.doesNotMatch(html, /公司地址、機車或汽車路徑也無法/);
});

test("guest public search filters by straight-line commute and keeps member commuteKm off", () => {
  runIsolated(`
    seed(701, { lat: 25.093, lng: 121.525, geo_source: "591", address: "台北市士林區測試路701號" });
    seed(702, { lat: 24.147, lng: 120.673, geo_source: "591", address: "台中市西區測試路702號" });
    const query = { commuteKm: 5, workLat: 25.093, workLng: 121.525 };
    const settings = app.publicSearchSettings(query);
    assert.equal(settings.commuteKm, 0);
    assert.equal(settings.guestCommuteKm, 5);
    assert.equal(settings.workLat, null);
    const listed = app.listPublicListings({ ...query, settings });
    const ids = listed.listings.map((row) => Number(row.post_id));
    assert.equal(ids.includes(701), true);
    assert.equal(ids.includes(702), false);
    const near = listed.listings.find((row) => Number(row.post_id) === 701);
    assert.ok(Number(near.commute_km) <= 5);
    assert.match(String(near.commute_hint || ""), /直線距離/);
  `);
});

test("public listings route rejects more than four guest districts", () => {
  const src = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  const route = src.slice(src.indexOf('app.get("/api/public/listings"'), src.indexOf("function actorUserId"));
  assert.match(route, /GUEST_MAX_DISTRICTS/);
  assert.match(route, /訪客最多同時選/);
  assert.match(route, /resolveGuestWorkPoint/);
  assert.match(route, /geocodeAddress/);
  assert.match(route, /setCachedGeo/);
  assert.doesNotMatch(route, /upsertRouteJob|saveCrawlSources|runWatch/);
});
