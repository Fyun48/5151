import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyFacilities,
  classifyRentalFloor,
  evaluateHpPrep,
  FIELD_NOT_PROVIDED,
  FIELD_PARSE_FAILED,
  FIELD_PROVIDED,
  mergeHpListingFields,
  PREP_READY,
  PREP_SOURCE_LIMITED,
} from "../src/listingPrep.js";
import {
  claimEnrichJobs,
  enqueueListingEnrich,
  ensureListingPrepSchema,
  listingPrepAdminStats,
  processOneEnrichJob,
  reclaimStaleEnrichJobs,
  requestClickRefresh,
} from "../src/listingEnrichQueue.js";
import { inspectHpDetailResponse, parseHpDetailJson } from "../src/houseprice.js";
import { PROBE_ALIVE, PROBE_GONE, PROBE_INCONCLUSIVE } from "../src/probeOutcomes.js";
import { shouldNotify } from "../src/notify.js";
import { passesGeoFilters } from "../src/floors.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

function hpListing(overrides = {}) {
  return {
    post_id: 2400000888,
    source: "houseprice",
    source_id: "16470110",
    title: "天玉街套房",
    url: "https://rent.houseprice.tw/house/16470110",
    price: "28000",
    price_num: 28000,
    address: "台北市士林區天玉街9巷3號",
    floor_name: "4/4",
    lat: 25.1105,
    lng: 121.529,
    geo_source: "houseprice",
    tags: '["冰箱"]',
    has_natural_gas: 1,
    has_balcony: 0,
    furnish_items: '["冰箱"]',
    first_seen_at: "2026-09-14T00:00:00.000Z",
    ...overrides,
  };
}

function memoryQueue() {
  const conn = new DatabaseSync(":memory:");
  ensureListingPrepSchema(conn);
  return conn;
}

function storeHelpers(store) {
  return {
    loadListing: (id) => store.get(Number(id)) || null,
    persistHpListingFields: (id, next) => {
      store.set(Number(id), { ...store.get(Number(id)), ...next });
      return next;
    },
    invalidateLocation: () => {},
    markGone: (id) => {
      const row = store.get(Number(id));
      if (row) store.set(Number(id), { ...row, offline: 1 });
    },
    markAlive: (id) => {
      const row = store.get(Number(id));
      if (row) store.set(Number(id), { ...row, offline: 0, last_checked_at: new Date().toISOString() });
    },
    isSourceEnabled: () => true,
    onFirstReady: () => {},
  };
}

test("mergeHpListingFields writes floor and facilities when address is unchanged", () => {
  const current = hpListing({ floor_name: "", furnish_items: "[]", has_natural_gas: 0, tags: "[]" });
  const incoming = hpListing({ floor_name: "3/7", furnish_items: '["洗衣機"]', has_natural_gas: 1, tags: '["洗衣機"]' });
  const merged = mergeHpListingFields(current, incoming);
  assert.equal(merged.listing.address, current.address);
  assert.equal(merged.listing.floor_name, "3/7");
  assert.equal(merged.addressChanged, false);
  assert.ok(merged.changes.includes("floor_name"));
  assert.ok(merged.changes.includes("has_natural_gas") || merged.changes.includes("furnish_items") || merged.changes.includes("tags"));
});

test("mergeHpListingFields keeps existing complete fields when incoming is empty or parse-failed", () => {
  const current = hpListing();
  const merged = mergeHpListingFields(current, { address: "", floor_name: "", lat: null, lng: null, title: "" });
  assert.equal(merged.listing.address, current.address);
  assert.equal(merged.listing.floor_name, current.floor_name);
  assert.equal(merged.listing.lat, current.lat);
  assert.equal(merged.changes.length, 0);
});

test("mergeHpListingFields accepts a source floor correction and a more precise address", () => {
  const current = hpListing({ floor_name: "12", address: "台北市士林區天玉街" });
  const incoming = hpListing({ floor_name: "3/7", address: "台北市士林區天玉街9巷3號" });
  const merged = mergeHpListingFields(current, incoming);
  assert.equal(merged.listing.floor_name, "3/7");
  assert.equal(merged.listing.address, "台北市士林區天玉街9巷3號");
  assert.equal(merged.addressChanged, true);
});

test("evaluateHpPrep is ready for street+coords+rental floor+checked facilities; inferred tags are not enough", () => {
  const ready = evaluateHpPrep(hpListing({ address: "台北市士林區天玉街9巷", tags: "[]" }), {
    fetched: true,
    detailRecognized: true,
    facilityBlock: true,
  });
  assert.equal(ready.status, PREP_READY);
  assert.equal(ready.displayReady, true);
  assert.match(ready.locationLabel, /概略位置/);
  const inferred = evaluateHpPrep(hpListing({ tags: '["家俱"]', has_natural_gas: 0, furnish_items: "[]" }), {
    fetched: true,
    detailRecognized: true,
  });
  assert.equal(inferred.displayReady, false);
  assert.ok(inferred.missing.includes("facility"));
});

test("evaluateHpPrep withholds when rental floor is missing or only building height", () => {
  const missing = evaluateHpPrep(hpListing({ floor_name: "" }), { fetched: true, detailRecognized: true, facilityBlock: true });
  assert.equal(missing.displayReady, false);
  assert.equal(missing.status, PREP_SOURCE_LIMITED);
  const building = classifyRentalFloor("", { fetched: true, buildingOnly: true });
  assert.equal(building.status, FIELD_NOT_PROVIDED);
  const whole = classifyRentalFloor("整棟出租", { fetched: true });
  assert.equal(whole.status, FIELD_PROVIDED);
});

test("facility states distinguish provided, absent, not provided, and parse failed", () => {
  assert.equal(classifyFacilities(hpListing(), { fetched: true, sourceBlock: true }).status, FIELD_PROVIDED);
  assert.equal(classifyFacilities(hpListing({ tags: '["無設備"]', has_natural_gas: 0, furnish_items: "[]" }), { fetched: true }).status, "absent");
  assert.equal(classifyFacilities(hpListing({ tags: "[]", has_natural_gas: 0, furnish_items: "[]" }), { fetched: true, sourceBlock: true }).status, FIELD_NOT_PROVIDED);
  assert.equal(classifyFacilities({}, { fetched: true, parseFailed: true }).status, FIELD_PARSE_FAILED);
});

test("inspectHpDetailResponse uses fixtures and does not treat empty JSON or 400 as gone", () => {
  const live = JSON.parse(readFileSync(path.join(dir, "fixtures/houseprice-detail-16470110.json"), "utf8"));
  const ok = inspectHpDetailResponse({ status: 200, json: live });
  assert.equal(ok.outcome, PROBE_ALIVE);
  assert.equal(parseHpDetailJson(live).floorName, "4/4");
  assert.equal(inspectHpDetailResponse({ status: 400, json: {} }).outcome, PROBE_INCONCLUSIVE);
  assert.equal(inspectHpDetailResponse({ status: 200, json: {} }).outcome, PROBE_INCONCLUSIVE);
  assert.equal(inspectHpDetailResponse({ status: 404 }).outcome, PROBE_GONE);
  assert.equal(inspectHpDetailResponse({ timeout: true }).outcome, PROBE_INCONCLUSIVE);
  assert.equal(inspectHpDetailResponse({ status: 429 }).outcome, PROBE_INCONCLUSIVE);
  assert.equal(inspectHpDetailResponse({ status: 200, json: { msg: "物件已下架" } }).outcome, PROBE_GONE);
});

test("click refresh merges into one job and status cooldown does not block enrich", async () => {
  const conn = memoryQueue();
  const listing = hpListing({ last_checked_at: new Date().toISOString() });
  const first = requestClickRefresh(conn, listing, "click");
  const second = requestClickRefresh(conn, listing, "notify");
  const third = requestClickRefresh(conn, { ...listing, source: "591" }, "click");
  assert.equal(first.queued, true);
  assert.equal(second.queued, true);
  assert.equal(first.jobId, second.jobId);
  assert.ok(second.requestSeq > first.requestSeq);
  assert.equal(first.statusCooldown, true);
  assert.equal(third.queued, false);
  const jobs = conn.prepare("SELECT COUNT(*) AS n FROM listing_enrich_jobs").get();
  assert.equal(jobs.n, 1);
  const claimed = claimEnrichJobs(conn, { limit: 4 });
  assert.equal(claimed.length, 1);
  const store = new Map([[listing.post_id, { ...listing, offline: 1 }]]);
  const result = await processOneEnrichJob(conn, storeHelpers(store), claimed[0], {
    fetchDetail: async () => ({ outcome: PROBE_INCONCLUSIVE, reason: "timeout", errorClass: "transient" }),
  });
  assert.equal(result.outcome, PROBE_INCONCLUSIVE);
  assert.equal(store.get(listing.post_id).offline, 1);
});

test("enrich job writes floor without address change and ignores a stale late response", async () => {
  const conn = memoryQueue();
  const listing = hpListing({ floor_name: "", furnish_items: "[]", has_natural_gas: 0, tags: "[]" });
  enqueueListingEnrich(conn, listing, { via: "scheduler" });
  const [job] = claimEnrichJobs(conn, { limit: 1 });
  const store = new Map([[listing.post_id, listing]]);
  const detail = parseHpDetailJson(JSON.parse(readFileSync(path.join(dir, "fixtures/houseprice-detail-16470110.json"), "utf8")));
  const result = await processOneEnrichJob(conn, storeHelpers(store), job, {
    fetchDetail: async () => ({
      outcome: PROBE_ALIVE,
      detail,
      facilityBlock: true,
      parse_ms: 4,
    }),
  });
  assert.equal(result.outcome, PROBE_ALIVE);
  assert.equal(store.get(listing.post_id).floor_name, "4/4");
  assert.equal(store.get(listing.post_id).address, listing.address);

  enqueueListingEnrich(conn, listing, { via: "click" });
  const late = claimEnrichJobs(conn, { limit: 1 })[0];
  conn.prepare("UPDATE listing_enrich_jobs SET request_seq = request_seq + 1 WHERE id = ?").run(late.id);
  const stale = await processOneEnrichJob(conn, storeHelpers(store), late, {
    fetchDetail: async () => ({
      outcome: PROBE_ALIVE,
      detail: { ...detail, address: "不該寫入的舊地址1號", floorName: "1/99" },
      facilityBlock: true,
    }),
  });
  assert.equal(stale.superseded || stale.stale, true);
  assert.notEqual(store.get(listing.post_id).floor_name, "1/99");
});

test("source-limited listings get a later retry and do not consume every claim slot", () => {
  const conn = memoryQueue();
  for (let i = 0; i < 6; i += 1) {
    enqueueListingEnrich(conn, hpListing({ post_id: 2400000700 + i }), { via: "scheduler" });
  }
  enqueueListingEnrich(conn, hpListing({ post_id: 2400000799 }), { via: "click" });
  conn.prepare(`
    UPDATE listing_enrich_jobs
       SET status = 'source_limited',
           next_retry_at = ?,
           last_error_class = 'source_limited'
     WHERE post_id = 2400000700
  `).run(new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString());
  const claimed = claimEnrichJobs(conn, { limit: 4 });
  assert.equal(claimed.some((row) => row.post_id === 2400000799), true);
  assert.equal(claimed.some((row) => row.post_id === 2400000700), false);
  const stats = listingPrepAdminStats(conn);
  assert.ok(stats.waitingJobs >= 1);
  assert.ok(stats.errors.some((row) => row.reason === "source_limited"));
});

test("reclaim overdue running jobs after restart", () => {
  const conn = memoryQueue();
  enqueueListingEnrich(conn, hpListing(), { via: "scheduler" });
  const [job] = claimEnrichJobs(conn, { limit: 1 });
  conn.prepare("UPDATE listing_enrich_jobs SET lease_until = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", job.id);
  assert.equal(reclaimStaleEnrichJobs(conn), 1);
  assert.equal(conn.prepare("SELECT status FROM listing_enrich_jobs WHERE id = ?").get(job.id).status, "queued");
});

test("houseprice new notify waits for display_ready; commute incomplete is not a match", () => {
  const listing = hpListing({ display_ready: false });
  assert.equal(shouldNotify({ notificationsPaused: false }, listing, { type: "new" }), false);
  assert.equal(shouldNotify({ notificationsPaused: false }, { ...listing, display_ready: true }, { type: "new" }), true);
  const commute = { commuteKm: 8, workLat: 25.1, workLng: 121.52 };
  assert.equal(passesGeoFilters({ lat: 25.11, lng: 121.53, geo_source: "houseprice" }, commute, { strict: true }), false);
  assert.equal(passesGeoFilters({
    lat: 25.11, lng: 121.53, geo_source: "houseprice", location_class: "door",
    route_km: 3, route_min_m: 3000,
  }, commute, { strict: true }), true);
});

test("unready 5168 stays off the list until prep is ready; persist writes floor without address change", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-hp-prep-"));
  const script = `
    import assert from "node:assert/strict";
    import { upsertListing, listListings, persistHpListingFields, listingsNeedingAddressEnrich, getListing, db, defaultUserId, getSettings, saveCrawlSources } from ${JSON.stringify(path.join(dir, "../src/db.js"))};
    import { upsertListingPrep, listingPrepAdminStats } from ${JSON.stringify(path.join(dir, "../src/listingEnrichQueue.js"))};
    import { evaluateHpPrep } from ${JSON.stringify(path.join(dir, "../src/listingPrep.js"))};
    saveCrawlSources({ items: [{ id: "houseprice", enabled: true }, { id: "591", enabled: true }] });
    const uid = defaultUserId();
    const settings = {
      ...getSettings(uid), searchUrls: [], watchDistricts: ["1-8"],
      priceMin: 0, priceMax: 0, commuteKm: 0, wholeFloorOnly: false,
      excludeLowFloors: false, excludeRooftop: false,
      excludeKeywords: [], excludeAgents: [], excludeAgentIds: [], excludeBoxes: [],
    };
    const stamp = "2026-09-14T00:00:00.000Z";
    const row = {
      post_id: 2400000881, source: "houseprice", source_id: "16470110", source_key: "1|8||台北市士林區天玉街9巷3號|4|19|1房",
      search_key: "https://example.test", url: "https://rent.houseprice.tw/house/16470110",
      title: "天玉街套房", price: "28000", price_num: 28000, extra_fees: [],
      address: "台北市士林區天玉街9巷3號", area_name: "19坪", layout: "1房1廳1衛",
      floor_name: "", kind_name: "整層住家", role_name: "5168", cover: "", tags: "[]",
      lat: 25.1105, lng: 121.529, geo_source: "houseprice",
      refresh_time: stamp, first_seen_at: stamp, last_seen_at: stamp, last_event: "new",
    };
    upsertListing(row);
    const query = () => listListings({ userId: uid, settings, searchKeys: [], filter: "all", sort: "newest", limit: 50 });
    assert.equal(query().listings.some((item) => item.post_id === 2400000881), false);
    assert.equal(listingsNeedingAddressEnrich(20).some((item) => item.post_id === 2400000881), false);
    persistHpListingFields(2400000881, { ...row, floor_name: "4/4", has_natural_gas: 1, furnish_items: ["冰箱"], tags: '["冰箱"]' });
    const saved = getListing(2400000881);
    assert.equal(saved.floor_name, "4/4");
    assert.equal(saved.address, row.address);
    const evalResult = evaluateHpPrep(saved, { fetched: true, detailRecognized: true, facilityBlock: true });
    assert.equal(evalResult.displayReady, true, JSON.stringify(evalResult));
    upsertListingPrep(db, 2400000881, saved, evalResult);
    assert.equal(query().listings.some((item) => item.post_id === 2400000881), true);
    const stats = listingPrepAdminStats(db);
    assert.ok(stats.readyPrep >= 1);
    console.log("ok");
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("server and UI keep click-open non-blocking and expose prep admin stats", () => {
  const server = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  const recheck = server.slice(server.indexOf('"/api/listings/:id/recheck"'), server.indexOf('"/api/listings/:id/report-gone"'));
  assert.match(recheck, /requestClickRefresh/);
  assert.match(recheck, /queued: true/);
  assert.match(recheck, /PROBE_INCONCLUSIVE|inconclusive/);
  assert.match(server, /app\.get\("\/go\/:id"/);
  assert.match(server, /requestClickRefresh\(db, listing, "go"\)/);
  const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");
  assert.match(html, /window\.open\(listingUrl/);
  assert.match(html, /\/recheck`/);
  assert.match(html, /data\.gone\) loadList\(\{ keep: true/);
  assert.match(html, /location_label/);
  assert.match(html, /來源未提供設備資訊/);
  assert.match(html, /href="\/go\/\$\{esc\(item\.post_id\)\}"/);
  const admin = readFileSync(path.join(dir, "../public/admin.html"), "utf8");
  assert.match(admin, /overviewListingPrep/);
  assert.match(admin, /5168 資料準備/);
});
