import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  jobStillOwnsRun,
  listingPrepAdminStats,
  getListingPrep,
  processOneEnrichJob,
  reclaimStaleEnrichJobs,
  recordEnrichMetric,
  requestClickRefresh,
  seedHousepriceEnrichJobs,
  summarizeEnrichMetrics,
  wakeListingEnrichWorker,
  resetListingEnrichWorkerForTests,
} from "../src/listingEnrichQueue.js";
import {
  applyHpFacilityEvidence,
  enrichHpListingFromDetail,
  inspectHpDetailResponse,
  parseHpDetailJson,
  parseRetryAfterMs,
} from "../src/houseprice.js";
import { PROBE_ALIVE, PROBE_GONE, PROBE_INCONCLUSIVE, classifyListingProbeWrite } from "../src/probeOutcomes.js";
import { shouldNotify } from "../src/notify.js";
import { passesGeoFilters } from "../src/floors.js";
import { keptListShouldRerender, listingContentKey, listRefreshLimit } from "../src/listKeep.js";
import { compareHouseGroup, sameHouseBundle } from "../src/listingCompare.js";
import { listingIsDisplayable } from "../src/listingPrep.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

// 隔離子程序在 CI（Gitea runner：CPU 較慢且 node --test 會並行多個檔案）上可能遠超過 30s；
// 這是環境時序而非程式錯誤，因此只保留防卡死的寬鬆上限，可用 V3_ISOLATED_TEST_TIMEOUT_MS 覆寫。
const ISOLATED_TIMEOUT_MS = Math.max(30_000, Number(process.env.V3_ISOLATED_TEST_TIMEOUT_MS) || 180_000);

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
      const prev = store.get(Number(id)) || {};
      store.set(Number(id), { ...prev, ...next, content_seq: (Number(prev.content_seq) || 0) + 1 });
      return store.get(Number(id));
    },
    invalidateLocation: () => {},
    markGone: (id) => {
      const row = store.get(Number(id));
      if (row) {
        store.set(Number(id), { ...row, offline: 1, content_seq: (Number(row.content_seq) || 0) + 1 });
      }
    },
    markAlive: (id) => {
      const row = store.get(Number(id));
      if (row) {
        store.set(Number(id), {
          ...row,
          offline: 0,
          last_checked_at: new Date().toISOString(),
          content_seq: (Number(row.content_seq) || 0) + 1,
        });
      }
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

test("the enrich worker reads through the async loader when the bundle provides one", async () => {
  const conn = memoryQueue();
  const listing = hpListing({ floor_name: "", furnish_items: "[]", has_natural_gas: 0, tags: "[]" });
  enqueueListingEnrich(conn, listing, { via: "scheduler" });
  const [job] = claimEnrichJobs(conn, { limit: 1 });
  const store = new Map([[listing.post_id, listing]]);
  let asyncCalls = 0;
  const helpers = {
    ...storeHelpers(store),
    // The PostgreSQL-mode bundle: watcher's listingEnrichHelpers() exposes loadListingAsync and
    // crawlerReads.js decides which store answers. The worker must use the async loader - the
    // synchronous one is here only to fail loudly if it is ever picked.
    loadListing: () => { throw new Error("sync loader must not be used when loadListingAsync exists"); },
    loadListingAsync: async (id) => {
      asyncCalls += 1;
      return store.get(Number(id)) || null;
    },
  };
  const detail = parseHpDetailJson(JSON.parse(readFileSync(path.join(dir, "fixtures/houseprice-detail-16470110.json"), "utf8")));
  const result = await processOneEnrichJob(conn, helpers, job, {
    fetchDetail: async () => ({
      outcome: PROBE_ALIVE,
      detail,
      facilityBlock: true,
      parse_ms: 4,
    }),
  });
  assert.equal(result.outcome, PROBE_ALIVE);
  assert.ok(asyncCalls >= 1, "the worker read the row through loadListingAsync");
  assert.equal(store.get(listing.post_id).floor_name, "4/4");
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
    import { upsertListing, listListings, persistHpListingFields, listingsNeedingAddressEnrich, getListing, db, defaultUserId, getSettings, saveCrawlSources } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/db.js")).href)};
    import { upsertListingPrep, listingPrepAdminStats } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/listingEnrichQueue.js")).href)};
    import { evaluateHpPrep } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/listingPrep.js")).href)};
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
      timeout: ISOLATED_TIMEOUT_MS,
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
  assert.match(recheck, /queued: Boolean\(queued\.queued\)/);
  assert.match(recheck, /wakeWorker/);
  assert.match(recheck, /PROBE_INCONCLUSIVE|inconclusive/);
  assert.match(server, /app\.get\("\/go\/:id"/);
  assert.match(server, /requestClickRefreshAsync\(db, listing, "go"\)/);
  assert.match(server, /listing_updated/);
  assert.match(server, /classifyListingProbeWrite/);
  const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");
  assert.match(html, /window\.open\(listingUrl/);
  assert.match(html, /\/recheck\?fresh=1`/);
  assert.match(html, /refreshCards: true/);
  assert.match(html, /listingContentKey/);
  assert.match(html, /listing_updated/);
  assert.match(html, /location_label/);
  assert.match(html, /來源未提供設備資訊/);
  assert.match(html, /href="\/go\/\$\{esc\(item\.post_id\)\}"/);
  const admin = readFileSync(path.join(dir, "../public/admin.html"), "utf8");
  assert.match(admin, /overviewListingPrep/);
  assert.match(admin, /5168 資料準備/);
  assert.match(admin, /尚未量測/);
});

function liveDetail(overrides = {}) {
  const raw = JSON.parse(readFileSync(path.join(dir, "fixtures/houseprice-detail-16470110.json"), "utf8"));
  Object.assign(raw.webRentCaseGroupingDetail, overrides);
  return raw;
}

test("R1 source_limited is not claimed before retry, then completes after expiry", async () => {
  const conn = memoryQueue();
  const listing = hpListing({ floor_name: "" });
  enqueueListingEnrich(conn, listing, { via: "scheduler" });
  const [job] = claimEnrichJobs(conn, { limit: 1 });
  const store = new Map([[listing.post_id, listing]]);
  const limited = await processOneEnrichJob(conn, storeHelpers(store), job, {
    fetchDetail: async () => inspectHpDetailResponse({
      status: 200,
      expectedId: "16470110",
      json: liveDetail({ fromFloor: "", toFloor: "", upFloor: 8, floor: "" }),
    }),
  });
  assert.equal(limited.evalResult?.status, "source_limited");
  const pending = conn.prepare("SELECT * FROM listing_enrich_jobs WHERE post_id = ?").get(listing.post_id);
  assert.equal(pending.status, "source_limited");
  assert.ok(Date.parse(pending.next_retry_at) > Date.now());
  assert.equal(claimEnrichJobs(conn, { limit: 4 }).length, 0);

  conn.prepare("UPDATE listing_enrich_jobs SET next_retry_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), pending.id);
  const [again] = claimEnrichJobs(conn, { limit: 1 });
  assert.equal(again.post_id, listing.post_id);
  store.set(listing.post_id, { ...listing, floor_name: "" });
  const done = await processOneEnrichJob(conn, storeHelpers(store), again, {
    fetchDetail: async () => inspectHpDetailResponse({
      status: 200,
      expectedId: "16470110",
      json: liveDetail({ fromFloor: "4", toFloor: "4", upFloor: 4, conditionTags: ["冰箱"] }),
    }),
  });
  assert.equal(done.outcome, PROBE_ALIVE);
  assert.equal(done.evalResult.displayReady, true);
});

test("R2 timeout does not hide an already display-ready listing", async () => {
  const conn = memoryQueue();
  const listing = hpListing();
  enqueueListingEnrich(conn, listing, { via: "scheduler" });
  const store = new Map([[listing.post_id, listing]]);
  const [job] = claimEnrichJobs(conn, { limit: 1 });
  await processOneEnrichJob(conn, storeHelpers(store), job, {
    fetchDetail: async () => inspectHpDetailResponse({
      status: 200,
      expectedId: "16470110",
      json: liveDetail({ conditionTags: ["冰箱"] }),
    }),
  });
  const ready = conn.prepare("SELECT display_ready, prep_status FROM listing_prep WHERE post_id = ?").get(listing.post_id);
  assert.equal(ready.display_ready, 1);
  enqueueListingEnrich(conn, listing, { via: "scheduler", missing: ["floor"] });
  conn.prepare("UPDATE listing_enrich_jobs SET status = 'queued', next_retry_at = NULL WHERE post_id = ?").run(listing.post_id);
  const [retry] = claimEnrichJobs(conn, { limit: 1 });
  await processOneEnrichJob(conn, storeHelpers(store), retry, {
    fetchDetail: async () => ({ outcome: PROBE_INCONCLUSIVE, reason: "timeout", errorClass: "transient" }),
  });
  const kept = conn.prepare("SELECT display_ready, prep_status, ready_at, withhold_reason FROM listing_prep WHERE post_id = ?").get(listing.post_id);
  assert.equal(kept.display_ready, 1);
  assert.equal(kept.prep_status, "ready");
  assert.ok(kept.ready_at);
  assert.equal(kept.withhold_reason, "timeout");
  const failed = conn.prepare("SELECT last_error, last_error_class, next_retry_at FROM listing_enrich_jobs WHERE post_id = ?").get(listing.post_id);
  assert.equal(failed.last_error, "timeout");
  assert.equal(failed.last_error_class, "transient");
  assert.ok(Date.parse(failed.next_retry_at) > Date.now());
});

test("R3 unready 5168 cannot become group primary or hide a ready 591", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-hp-group-"));
  const script = `
    import assert from "node:assert/strict";
    import { upsertListing, listListings, mergeSameHouseForUser, db, defaultUserId, getSettings, saveCrawlSources } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/db.js")).href)};
    saveCrawlSources({ items: [{ id: "houseprice", enabled: true }, { id: "591", enabled: true }] });
    const uid = defaultUserId();
    const settings = {
      ...getSettings(uid), searchUrls: [], watchDistricts: ["1-8"],
      priceMin: 0, priceMax: 0, commuteKm: 0, wholeFloorOnly: false,
      excludeLowFloors: false, excludeRooftop: false,
      excludeKeywords: [], excludeAgents: [], excludeAgentIds: [], excludeBoxes: [],
    };
    const stamp = "2026-09-14T00:00:00.000Z";
    const row591 = {
      post_id: 591001, source: "591", source_id: "1", source_key: "g-unready",
      search_key: "https://example.test", url: "https://rent.591.com.tw/1",
      title: "天玉街 591", price: "28000", price_num: 28000, extra_fees: [],
      address: "台北市士林區天玉街9巷3號", area_name: "19坪", layout: "1房1廳1衛",
      floor_name: "4/4", kind_name: "整層住家", role_name: "屋主", cover: "", tags: "[]",
      lat: 25.1105, lng: 121.529, geo_source: "591",
      refresh_time: stamp, first_seen_at: stamp, last_seen_at: stamp, last_event: "new",
    };
    const rowHp = {
      post_id: 2400000882, source: "houseprice", source_id: "16470110", source_key: "g-unready",
      search_key: "https://example.test", url: "https://rent.houseprice.tw/house/16470110",
      title: "天玉街 5168", price: "24000", price_num: 24000, extra_fees: [],
      address: "台北市士林區天玉街9巷3號", area_name: "19坪", layout: "1房1廳1衛",
      floor_name: "", kind_name: "整層住家", role_name: "5168", cover: "", tags: "[]",
      lat: 25.1105, lng: 121.529, geo_source: "houseprice",
      refresh_time: stamp, first_seen_at: stamp, last_seen_at: stamp, last_event: "new",
    };
    upsertListing(row591);
    upsertListing(rowHp);
    const query = () => listListings({ userId: uid, settings, searchKeys: [], filter: "all", sort: "newest", limit: 50 });
    const before = query();
    assert.deepEqual(before.listings.map((row) => row.post_id), [591001]);
    const merged = mergeSameHouseForUser(uid, [591001, 2400000882]);
    assert.equal(merged.ok, true);
    const after = query();
    assert.equal(after.listings.some((row) => row.post_id === 591001), true, JSON.stringify(after.listings.map((row) => row.post_id)));
    assert.equal(after.totalMatched > 0, true);
    const card = after.listings.find((row) => row.post_id === 591001);
    assert.notEqual(card.same_house_role, "affiliate");
    assert.notEqual(Number(card.match_peer?.post_id), 2400000882);
    if (card.same_house?.peers) {
      assert.equal(card.same_house.peers.some((row) => row.post_id === 2400000882), false);
    }
    console.log("ok");
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: ISOLATED_TIMEOUT_MS,
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("R3 automatic compare and bundle drop unready houseprice members", () => {
  const ready591 = { ...hpListing({ post_id: 591001, source: "591", source_id: "1", price_num: 28000, display_ready: true }), source: "591" };
  const cheapHp = hpListing({ post_id: 2400000883, price_num: 24000, floor_name: "", display_ready: false });
  assert.equal(listingIsDisplayable(cheapHp), false);
  const bundle = sameHouseBundle(ready591, [cheapHp]);
  assert.equal(bundle, null);
  const compare = compareHouseGroup([ready591, cheapHp]);
  assert.equal(compare, null);
});

test("R4 click does not clear 429 backoff and worker fetch is counted", async () => {
  resetListingEnrichWorkerForTests();
  const conn = memoryQueue();
  const listing = hpListing();
  let fetches = 0;
  const store = new Map([[listing.post_id, listing]]);
  enqueueListingEnrich(conn, listing, { via: "scheduler" });
  const [job] = claimEnrichJobs(conn, { limit: 1 });
  await processOneEnrichJob(conn, storeHelpers(store), job, {
    fetchDetail: async () => {
      fetches += 1;
      return { outcome: PROBE_INCONCLUSIVE, reason: "http_429", errorClass: "transient" };
    },
  });
  const paused = conn.prepare("SELECT * FROM listing_enrich_jobs WHERE post_id = ?").get(listing.post_id);
  assert.ok(Date.parse(paused.next_retry_at) > Date.now());
  const click = requestClickRefresh(conn, { ...listing, last_checked_at: new Date().toISOString() }, "click");
  assert.equal(click.sourcePaused, true);
  assert.equal(click.queued, false);
  const afterClick = conn.prepare("SELECT next_retry_at, status FROM listing_enrich_jobs WHERE post_id = ?").get(listing.post_id);
  assert.ok(Date.parse(afterClick.next_retry_at) > Date.now());
  assert.notEqual(afterClick.status, "queued");
  const claimed = claimEnrichJobs(conn, { limit: 4 });
  assert.equal(claimed.length, 0);
  assert.equal(fetches, 1);

  const listingReady = hpListing({ last_checked_at: new Date().toISOString() });
  const store2 = new Map([[listingReady.post_id, listingReady]]);
  const conn2 = memoryQueue();
  enqueueListingEnrich(conn2, listingReady, { via: "click" });
  const [okJob] = claimEnrichJobs(conn2, { limit: 1 });
  await processOneEnrichJob(conn2, storeHelpers(store2), okJob, {
    fetchDetail: async () => {
      fetches += 1;
      return inspectHpDetailResponse({ status: 200, expectedId: "16470110", json: liveDetail({ conditionTags: ["冰箱"] }) });
    },
  });
  const again = requestClickRefresh(conn2, listingReady, "click");
  assert.equal(again.statusCooldown, true);
  assert.equal(again.queued, false);
  assert.equal(claimEnrichJobs(conn2, { limit: 2 }).length, 0);
});

test("R4 concurrent wakes share one worker", async () => {
  resetListingEnrichWorkerForTests();
  let running = 0;
  let max = 0;
  let batches = 0;
  const run = async () => {
    running += 1;
    max = Math.max(max, running);
    batches += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    running -= 1;
  };
  const a = wakeListingEnrichWorker(run);
  const b = wakeListingEnrichWorker(run);
  assert.equal(a, b);
  await a;
  assert.equal(max, 1);
  assert.ok(batches >= 1);
});

test("R5 raw detail payload updates title, rent, same-precision address and floor", async () => {
  const conn = memoryQueue();
  const listing = hpListing({
    title: "舊標題",
    price_num: 28000,
    price: "28000",
    address: "台北市士林區天玉街9巷3號",
    floor_name: "4/4",
  });
  enqueueListingEnrich(conn, listing, { via: "scheduler" });
  const [job] = claimEnrichJobs(conn, { limit: 1 });
  const store = new Map([[listing.post_id, listing]]);
  const json = liveDetail({
    caseName: "新標題景觀大露台",
    rentPrice: 32000,
    simpAddress: "台北市士林區天玉街9巷5號",
    address: "台北市士林區天玉街9巷5號",
    fromFloor: "6",
    toFloor: "6",
    upFloor: 8,
    conditionTags: ["冰箱"],
  });
  const inspected = inspectHpDetailResponse({ status: 200, json, expectedId: "16470110" });
  const result = await processOneEnrichJob(conn, storeHelpers(store), job, {
    fetchDetail: async () => inspected,
  });
  assert.equal(result.outcome, PROBE_ALIVE);
  const saved = store.get(listing.post_id);
  assert.equal(saved.title, "新標題景觀大露台");
  assert.equal(saved.price_num, 32000);
  assert.equal(saved.address, "台北市士林區天玉街9巷5號");
  assert.equal(saved.floor_name, "6/8");
});

test("R5 persist writes title/rent/address and source_key through SQLite", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-hp-r5-"));
  const fixture = path.join(dir, "fixtures/houseprice-detail-16470110.json");
  const script = `
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    import { upsertListing, persistHpListingFields, getListing, invalidateListingLocation, db, saveCrawlSources } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/db.js")).href)};
    import { ensureListingPrepSchema, enqueueListingEnrich, claimEnrichJobs, processOneEnrichJob } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/listingEnrichQueue.js")).href)};
    import { inspectHpDetailResponse } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/houseprice.js")).href)};
    saveCrawlSources({ items: [{ id: "houseprice", enabled: true }] });
    ensureListingPrepSchema(db);
    const stamp = "2026-09-14T00:00:00.000Z";
    const row = {
      post_id: 2400000884, source: "houseprice", source_id: "16470110", source_key: "1|8||台北市士林區天玉街9巷3號|4|19|1房1廳1衛",
      search_key: "https://example.test", url: "https://rent.houseprice.tw/house/16470110",
      title: "舊標題", price: "28000", price_num: 28000, extra_fees: [],
      address: "台北市士林區天玉街9巷3號", area_name: "19坪", layout: "1房1廳1衛",
      floor_name: "4/4", kind_name: "整層住家", role_name: "5168", cover: "", tags: '["冰箱"]',
      lat: 25.1105, lng: 121.529, geo_source: "houseprice",
      refresh_time: stamp, first_seen_at: stamp, last_seen_at: stamp, last_event: "new",
    };
    upsertListing(row);
    enqueueListingEnrich(db, row, { via: "scheduler" });
    const [job] = claimEnrichJobs(db, { limit: 1 });
    const json = JSON.parse(readFileSync(${JSON.stringify(fixture)}, "utf8"));
    Object.assign(json.webRentCaseGroupingDetail, {
      caseName: "新標題景觀大露台", rentPrice: 32000,
      simpAddress: "台北市士林區天玉街9巷5號", address: "台北市士林區天玉街9巷5號",
      fromFloor: "6", toFloor: "6", upFloor: 8, conditionTags: ["冰箱"],
    });
    await processOneEnrichJob(db, {
      loadListing: (id) => getListing(id),
      persistHpListingFields,
      invalidateLocation: invalidateListingLocation,
      markGone: () => {},
      markAlive: () => {},
      isSourceEnabled: () => true,
    }, job, {
      fetchDetail: async () => inspectHpDetailResponse({ status: 200, json, expectedId: "16470110" }),
    });
    const saved = getListing(2400000884);
    assert.equal(saved.title, "新標題景觀大露台");
    assert.equal(saved.price_num, 32000);
    assert.equal(saved.address, "台北市士林區天玉街9巷5號");
    assert.equal(saved.floor_name, "6/8");
    assert.notEqual(saved.source_key, row.source_key);
    console.log("ok");
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: ISOLATED_TIMEOUT_MS,
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("R6 empty conditionTags plus no parking is not explicit facility-absent", async () => {
  const conn = memoryQueue();
  const listing = hpListing();
  enqueueListingEnrich(conn, listing, { via: "scheduler" });
  const [job] = claimEnrichJobs(conn, { limit: 1 });
  const store = new Map([[listing.post_id, listing]]);
  const json = liveDetail({ conditionTags: [], parkingYN: "N" });
  const inspected = inspectHpDetailResponse({ status: 200, json, expectedId: "16470110" });
  assert.equal(inspected.facilityAbsent, false);
  assert.equal(inspected.facilityBlock, false);
  await processOneEnrichJob(conn, storeHelpers(store), job, {
    fetchDetail: async () => inspected,
  });
  const saved = store.get(listing.post_id);
  assert.match(String(saved.tags), /冰箱/);
  assert.equal(Number(saved.has_natural_gas), 1);
  const prep = conn.prepare("SELECT facility_status FROM listing_prep WHERE post_id = ?").get(listing.post_id);
  assert.notEqual(prep.facility_status, "absent");
});

test("R6 confirmed cancelled facilities can replace stored kit", async () => {
  const conn = memoryQueue();
  const listing = hpListing();
  enqueueListingEnrich(conn, listing, { via: "scheduler" });
  const [job] = claimEnrichJobs(conn, { limit: 1 });
  const store = new Map([[listing.post_id, listing]]);
  const json = liveDetail({ conditionTags: [], parkingYN: "N", noFacility: true, facilityRemark: "無設備" });
  const inspected = inspectHpDetailResponse({ status: 200, json, expectedId: "16470110" });
  assert.equal(inspected.facilityAbsent, true);
  await processOneEnrichJob(conn, storeHelpers(store), job, {
    fetchDetail: async () => inspected,
  });
  const prep = conn.prepare("SELECT facility_status FROM listing_prep WHERE post_id = ?").get(listing.post_id);
  assert.equal(prep.facility_status, "absent");
  const saved = store.get(listing.post_id);
  assert.doesNotMatch(String(saved.tags), /冰箱/);
  assert.equal(Number(saved.has_natural_gas), 0);
  assert.deepEqual(saved.furnish_items, []);
});

test("R7 reclaimed worker cannot overwrite a newer run", async () => {
  const conn = memoryQueue();
  const listing = hpListing({ floor_name: "" });
  enqueueListingEnrich(conn, listing, { via: "scheduler" });
  const [first] = claimEnrichJobs(conn, { limit: 1 });
  assert.ok(first.run_seq >= 1);
  conn.prepare("UPDATE listing_enrich_jobs SET lease_until = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", first.id);
  assert.equal(reclaimStaleEnrichJobs(conn), 1);
  const [second] = claimEnrichJobs(conn, { limit: 1 });
  assert.ok(second.run_seq > first.run_seq);
  const store = new Map([[listing.post_id, listing]]);
  const newer = await processOneEnrichJob(conn, storeHelpers(store), second, {
    fetchDetail: async () => inspectHpDetailResponse({
      status: 200,
      expectedId: "16470110",
      json: liveDetail({ fromFloor: "6", toFloor: "6", upFloor: 8, conditionTags: ["冰箱"] }),
    }),
  });
  assert.equal(newer.outcome, PROBE_ALIVE);
  assert.equal(store.get(listing.post_id).floor_name, "6/8");
  const stale = await processOneEnrichJob(conn, storeHelpers(store), first, {
    fetchDetail: async () => inspectHpDetailResponse({
      status: 200,
      expectedId: "16470110",
      json: liveDetail({ fromFloor: "2", toFloor: "2", upFloor: 8, conditionTags: ["冰箱"] }),
    }),
  });
  assert.equal(stale.stale || stale.superseded, true);
  assert.equal(store.get(listing.post_id).floor_name, "6/8");
  assert.equal(jobStillOwnsRun(conn, first), false);
});

test("R8 mismatched source id is inconclusive and does not write fields", async () => {
  const conn = memoryQueue();
  const listing = hpListing({ source_id: "16470110", floor_name: "4/4", offline: 1 });
  enqueueListingEnrich(conn, listing, { via: "scheduler" });
  const [job] = claimEnrichJobs(conn, { limit: 1 });
  const store = new Map([[listing.post_id, listing]]);
  const other = liveDetail({ sid: 16692013, fromFloor: "3", toFloor: "3", upFloor: 4 });
  const inspected = inspectHpDetailResponse({ status: 200, json: other, expectedId: "16470110" });
  assert.equal(inspected.outcome, PROBE_INCONCLUSIVE);
  assert.equal(inspected.reason, "id_mismatch");
  const result = await processOneEnrichJob(conn, storeHelpers(store), job, {
    fetchDetail: async () => inspected,
  });
  assert.equal(result.outcome, PROBE_INCONCLUSIVE);
  assert.equal(store.get(listing.post_id).floor_name, "4/4");
  assert.equal(store.get(listing.post_id).offline, 1);
});

test("R9 recommend gone text does not take a live listing down", () => {
  const json = liveDetail({ conditionTags: ["冰箱"] });
  json.recommend = { recommends: [{ caseName: "此物件已出租，另有其他推薦" }] };
  const inspected = inspectHpDetailResponse({ status: 200, json, expectedId: "16470110" });
  assert.equal(inspected.outcome, PROBE_ALIVE);
});

test("R10 report-gone keeps inconclusive off markListingAlive", () => {
  const server = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  const start = server.indexOf('app.post("/api/listings/:id/report-gone"');
  const end = server.indexOf('app.post("/api/listings/:id/reject-match"');
  const body = server.slice(start, end);
  assert.match(body, /classifyListingProbeWrite/);
  assert.match(body, /inconclusive: true/);
  const watcher = readFileSync(path.join(dir, "../src/watcher.js"), "utf8");
  assert.match(watcher, /classifyListingProbeWrite/);
  assert.equal(classifyListingProbeWrite({ outcome: PROBE_INCONCLUSIVE, alive: null }).write, "none");
  assert.equal(classifyListingProbeWrite({ outcome: PROBE_INCONCLUSIVE, alive: true }).write, "none");
  assert.equal(classifyListingProbeWrite({ outcome: PROBE_ALIVE, alive: true }).write, "alive");
  assert.equal(classifyListingProbeWrite({ outcome: PROBE_GONE, alive: false }).write, "gone");
});

test("R11 kept list rerenders when same IDs change content, go offline, or a ready card appears", () => {
  const a = { post_id: 1, price_num: 28000, floor_name: "4/4", tags: '["冰箱"]', offline: 0, display_ready: true, title: "A" };
  const updated = { ...a, floor_name: "3/4", tags: '["洗衣機"]' };
  assert.notEqual(listingContentKey(a), listingContentKey(updated));
  assert.equal(keptListShouldRerender([a], [updated]), true);
  assert.equal(keptListShouldRerender([a], [a]), false);
  assert.equal(keptListShouldRerender([a], [{ ...a, offline: 1 }]), true);
  assert.equal(keptListShouldRerender([a], [a, { post_id: 2, display_ready: true }]), true);
  assert.equal(keptListShouldRerender([a], [updated], { refreshCards: true }), true);
  assert.equal(keptListShouldRerender([a], [a], { append: true }), true);
});

test("R12 metrics ignore null stages and split first-ready from unmeasured routes", () => {
  const conn = memoryQueue();
  recordEnrichMetric(conn, { post_id: 1, id: 1 }, {
    queued_ms: 80,
    start_ms: 4,
    fetch_ms: 200,
    parse_ms: 12,
    locate_ms: 3,
    route_ms: null,
    ready_ms: null,
    first_ready_ms: null,
    attempt_wait_ms: 80,
    outcome: "failed",
  });
  const summary = summarizeEnrichMetrics(conn);
  assert.equal(summary.stages.route_ms.n, 0);
  assert.equal(summary.stages.route_ms.p50, null);
  assert.equal(summary.stages.first_ready_ms.n, 0);
  assert.equal(summary.stages.first_ready_ms.p50, null);
  assert.equal(summary.stages.parse_ms.n, 1);
  assert.equal(summary.stages.parse_ms.p50, 12);
  assert.equal(summary.byOutcome.failed.samples, 1);
  assert.equal(summary.byOutcome.succeeded.samples, 0);
});

function pageFn(name) {
  const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `index.html missing ${name}`);
  let depth = 0;
  let end = start;
  for (let i = start; i < html.length; i += 1) {
    if (html[i] === "{") depth += 1;
    if (html[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  return html.slice(start, end);
}

function pageListingFns() {
  const src = [
    pageFn("listingGroupContentKey"),
    pageFn("listingContentKey"),
    pageFn("listingsContentKey"),
    pageFn("listingIdKey"),
  ].join("\n");
  return new Function(`${src}; return { listingContentKey, listingsContentKey, listingIdKey, listingGroupContentKey };`)();
}

test("S1 disabled 5168 does not hide a cheaper-ready 591 or linger as match_peer", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-hp-s1-"));
  const script = `
    import assert from "node:assert/strict";
    import { upsertListing, listListings, mergeSameHouseForUser, db, defaultUserId, getSettings, saveCrawlSources } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/db.js")).href)};
    import { ensureListingPrepSchema, upsertListingPrep } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/listingEnrichQueue.js")).href)};
    import { evaluateHpPrep } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/listingPrep.js")).href)};
    saveCrawlSources({ items: [{ id: "houseprice", enabled: true }, { id: "591", enabled: true }] });
    ensureListingPrepSchema(db);
    const uid = defaultUserId();
    const settings = {
      ...getSettings(uid), searchUrls: [], watchDistricts: ["1-8"],
      priceMin: 0, priceMax: 0, commuteKm: 0, wholeFloorOnly: false,
      excludeLowFloors: false, excludeRooftop: false,
      excludeKeywords: [], excludeAgents: [], excludeAgentIds: [], excludeBoxes: [],
    };
    const stamp = "2026-09-14T00:00:00.000Z";
    const row591 = {
      post_id: 591101, source: "591", source_id: "1", source_key: "g-s1-cheap",
      search_key: "https://example.test", url: "https://rent.591.com.tw/1",
      title: "天玉街 591", price: "28000", price_num: 28000, extra_fees: [],
      address: "台北市士林區天玉街9巷3號", area_name: "19坪", layout: "1房1廳1衛",
      floor_name: "4/4", kind_name: "整層住家", role_name: "屋主", cover: "", tags: "[]",
      lat: 25.1105, lng: 121.529, geo_source: "591",
      refresh_time: stamp, first_seen_at: stamp, last_seen_at: stamp, last_event: "new",
    };
    const rowHp = {
      post_id: 2400001882, source: "houseprice", source_id: "16470110", source_key: "g-s1-cheap",
      search_key: "https://example.test", url: "https://rent.houseprice.tw/house/16470110",
      title: "天玉街 5168", price: "24000", price_num: 24000, extra_fees: [],
      address: "台北市士林區天玉街9巷3號", area_name: "19坪", layout: "1房1廳1衛",
      floor_name: "4/4", kind_name: "整層住家", role_name: "5168", cover: "", tags: '["冰箱"]',
      lat: 25.1105, lng: 121.529, geo_source: "houseprice", has_natural_gas: 1, furnish_items: '["冰箱"]',
      refresh_time: stamp, first_seen_at: stamp, last_seen_at: stamp, last_event: "new",
    };
    upsertListing(row591);
    upsertListing(rowHp);
    const ready = evaluateHpPrep(rowHp, { fetched: true, detailRecognized: true, facilityBlock: true });
    upsertListingPrep(db, rowHp.post_id, rowHp, ready);
    mergeSameHouseForUser(uid, [591101, 2400001882]);
    const query = () => listListings({ userId: uid, settings, searchKeys: [], filter: "all", sort: "newest", limit: 50 });
    saveCrawlSources({ items: [{ id: "houseprice", enabled: false }, { id: "591", enabled: true }] });
    const after = query();
    assert.equal(after.listings.length > 0, true, JSON.stringify(after.listings.map((row) => row.post_id)));
    assert.equal(after.listings.some((row) => row.post_id === 591101), true);
    assert.equal(after.listings.some((row) => row.post_id === 2400001882), false);
    const card = after.listings.find((row) => row.post_id === 591101);
    assert.notEqual(card.same_house_role, "affiliate");
    assert.notEqual(Number(card.match_peer?.post_id), 2400001882);
    assert.equal(card.same_house?.peers?.some((row) => row.post_id === 2400001882) || false, false);
    console.log("ok");
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: ISOLATED_TIMEOUT_MS,
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("S1 expensive disabled 5168 leaves peers and match_peer", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-hp-s1b-"));
  const script = `
    import assert from "node:assert/strict";
    import { upsertListing, listListings, mergeSameHouseForUser, db, defaultUserId, getSettings, saveCrawlSources } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/db.js")).href)};
    import { ensureListingPrepSchema, upsertListingPrep } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/listingEnrichQueue.js")).href)};
    import { evaluateHpPrep } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/listingPrep.js")).href)};
    saveCrawlSources({ items: [{ id: "houseprice", enabled: true }, { id: "591", enabled: true }] });
    ensureListingPrepSchema(db);
    const uid = defaultUserId();
    const settings = {
      ...getSettings(uid), searchUrls: [], watchDistricts: ["1-8"],
      priceMin: 0, priceMax: 0, commuteKm: 0, wholeFloorOnly: false,
      excludeLowFloors: false, excludeRooftop: false,
      excludeKeywords: [], excludeAgents: [], excludeAgentIds: [], excludeBoxes: [],
    };
    const stamp = "2026-09-14T00:00:00.000Z";
    const row591 = {
      post_id: 591102, source: "591", source_id: "2", source_key: "g-s1-dear",
      search_key: "https://example.test", url: "https://rent.591.com.tw/2",
      title: "天玉街 591", price: "24000", price_num: 24000, extra_fees: [],
      address: "台北市士林區天玉街9巷3號", area_name: "19坪", layout: "1房1廳1衛",
      floor_name: "4/4", kind_name: "整層住家", role_name: "屋主", cover: "", tags: "[]",
      lat: 25.1105, lng: 121.529, geo_source: "591",
      refresh_time: stamp, first_seen_at: stamp, last_seen_at: stamp, last_event: "new",
    };
    const rowHp = {
      post_id: 2400001883, source: "houseprice", source_id: "16470110", source_key: "g-s1-dear",
      search_key: "https://example.test", url: "https://rent.houseprice.tw/house/16470110",
      title: "天玉街 5168", price: "28000", price_num: 28000, extra_fees: [],
      address: "台北市士林區天玉街9巷3號", area_name: "19坪", layout: "1房1廳1衛",
      floor_name: "4/4", kind_name: "整層住家", role_name: "5168", cover: "", tags: '["冰箱"]',
      lat: 25.1105, lng: 121.529, geo_source: "houseprice", has_natural_gas: 1, furnish_items: '["冰箱"]',
      refresh_time: stamp, first_seen_at: stamp, last_seen_at: stamp, last_event: "new",
    };
    upsertListing(row591);
    upsertListing(rowHp);
    upsertListingPrep(db, rowHp.post_id, rowHp, evaluateHpPrep(rowHp, { fetched: true, detailRecognized: true, facilityBlock: true }));
    mergeSameHouseForUser(uid, [591102, 2400001883]);
    saveCrawlSources({ items: [{ id: "houseprice", enabled: false }, { id: "591", enabled: true }] });
    const after = listListings({ userId: uid, settings, searchKeys: [], filter: "all", sort: "newest", limit: 50 });
    const card = after.listings.find((row) => row.post_id === 591102);
    assert.ok(card);
    assert.notEqual(Number(card.match_peer?.post_id), 2400001883);
    assert.equal(card.same_house?.peers?.some((row) => row.post_id === 2400001883) || false, false);
    console.log("ok");
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: ISOLATED_TIMEOUT_MS,
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("S2 seed and click keep 429 backoff; running is not reclaimed; Retry-After 3600 waits an hour", async () => {
  const conn = memoryQueue();
  const listing = hpListing();
  const store = new Map([[listing.post_id, listing]]);
  enqueueListingEnrich(conn, listing, { via: "scheduler" });
  const [job] = claimEnrichJobs(conn, { limit: 1 });
  await processOneEnrichJob(conn, storeHelpers(store), job, {
    fetchDetail: async () => inspectHpDetailResponse({ status: 429, retryAfter: "3600" }),
  });
  const paused = conn.prepare("SELECT * FROM listing_enrich_jobs WHERE post_id = ?").get(listing.post_id);
  assert.equal(paused.status, "failed");
  assert.ok(Date.parse(paused.next_retry_at) >= Date.now() + 50 * 60 * 1000, paused.next_retry_at);
  const retryAt = paused.next_retry_at;
  enqueueListingEnrich(conn, listing, { via: "scheduler" });
  const afterSeed = conn.prepare("SELECT status, next_retry_at FROM listing_enrich_jobs WHERE post_id = ?").get(listing.post_id);
  assert.equal(afterSeed.status, "failed");
  assert.equal(afterSeed.next_retry_at, retryAt);
  assert.equal(parseRetryAfterMs("3600"), 3600_000);

  const listing2 = hpListing({ post_id: 2400000991 });
  enqueueListingEnrich(conn, listing2, { via: "click" });
  const [running] = claimEnrichJobs(conn, { limit: 1 });
  assert.equal(running.status, "running");
  const click = requestClickRefresh(conn, listing2, "click");
  assert.equal(click.queued, false);
  const still = conn.prepare("SELECT status, next_retry_at, request_seq FROM listing_enrich_jobs WHERE post_id = ?").get(listing2.post_id);
  assert.equal(still.status, "running");
  assert.equal(Number(still.request_seq), Number(running.request_seq));
  assert.equal(claimEnrichJobs(conn, { limit: 4 }).some((row) => row.post_id === listing2.post_id), false);
});

test("S3 single rental floor without building height writes through SQLite", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-hp-s3-"));
  const fixture = path.join(dir, "fixtures/houseprice-detail-16470110.json");
  const script = `
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    import { upsertListing, persistHpListingFields, getListing, invalidateListingLocation, db, saveCrawlSources } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/db.js")).href)};
    import { ensureListingPrepSchema, enqueueListingEnrich, claimEnrichJobs, processOneEnrichJob } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/listingEnrichQueue.js")).href)};
    import { inspectHpDetailResponse } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/houseprice.js")).href)};
    saveCrawlSources({ items: [{ id: "houseprice", enabled: true }] });
    ensureListingPrepSchema(db);
    const stamp = "2026-09-14T00:00:00.000Z";
    const row = {
      post_id: 2400001884, source: "houseprice", source_id: "16470110", source_key: "s3",
      search_key: "https://example.test", url: "https://rent.houseprice.tw/house/16470110",
      title: "天玉街套房", price: "28000", price_num: 28000, extra_fees: [],
      address: "台北市士林區天玉街9巷3號", area_name: "19坪", layout: "1房1廳1衛",
      floor_name: "4/4", kind_name: "整層住家", role_name: "5168", cover: "", tags: '["冰箱"]',
      lat: 25.1105, lng: 121.529, geo_source: "houseprice",
      refresh_time: stamp, first_seen_at: stamp, last_seen_at: stamp, last_event: "new",
    };
    upsertListing(row);
    enqueueListingEnrich(db, row, { via: "scheduler" });
    const [job] = claimEnrichJobs(db, { limit: 1 });
    const json = JSON.parse(readFileSync(${JSON.stringify(fixture)}, "utf8"));
    Object.assign(json.webRentCaseGroupingDetail, {
      fromFloor: "", toFloor: "6", upFloor: "", floor: "6", conditionTags: ["冰箱"],
    });
    await processOneEnrichJob(db, {
      loadListing: (id) => getListing(id),
      persistHpListingFields,
      invalidateLocation: invalidateListingLocation,
      markGone: () => {},
      markAlive: () => {},
      isSourceEnabled: () => true,
    }, job, {
      fetchDetail: async () => inspectHpDetailResponse({ status: 200, json, expectedId: "16470110" }),
    });
    const saved = getListing(2400001884);
    assert.equal(saved.floor_name, "6");
    console.log("ok");
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: ISOLATED_TIMEOUT_MS,
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("S4 source geo correction without local version writes; address change without coords clears pin", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-hp-s4-"));
  const fixture = path.join(dir, "fixtures/houseprice-detail-16470110.json");
  const script = `
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    import { upsertListing, persistHpListingFields, getListing, invalidateListingLocation, db, saveCrawlSources } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/db.js")).href)};
    import { ensureListingPrepSchema, enqueueListingEnrich, claimEnrichJobs, processOneEnrichJob } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/listingEnrichQueue.js")).href)};
    import { inspectHpDetailResponse } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/houseprice.js")).href)};
    import { classifyAddress } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/listingPrep.js")).href)};
    saveCrawlSources({ items: [{ id: "houseprice", enabled: true }] });
    ensureListingPrepSchema(db);
    const stamp = "2026-09-14T00:00:00.000Z";
    const row = {
      post_id: 2400001885, source: "houseprice", source_id: "16470110", source_key: "s4",
      search_key: "https://example.test", url: "https://rent.houseprice.tw/house/16470110",
      title: "天玉街套房", price: "28000", price_num: 28000, extra_fees: [],
      address: "台北市士林區天玉街9巷3號", area_name: "19坪", layout: "1房1廳1衛",
      floor_name: "4/4", kind_name: "整層住家", role_name: "5168", cover: "", tags: '["冰箱"]',
      lat: 25.1105, lng: 121.529, geo_source: "houseprice",
      refresh_time: stamp, first_seen_at: stamp, last_seen_at: stamp, last_event: "new",
    };
    upsertListing(row);
    persistHpListingFields(2400001885, { ...row, lat: 25.111, lng: 121.53 }, { locationChanged: true, previous: row });
    const firstRaw = db.prepare("SELECT coord_version, lat FROM listings WHERE post_id = ?").get(2400001885);
    assert.equal(Number(firstRaw.coord_version) >= 1, true, JSON.stringify(firstRaw));
    const first = getListing(2400001885);
    enqueueListingEnrich(db, first, { via: "scheduler" });
    const [job] = claimEnrichJobs(db, { limit: 1 });
    const json = JSON.parse(readFileSync(${JSON.stringify(fixture)}, "utf8"));
    Object.assign(json.webRentCaseGroupingDetail, {
      lat: 25.12, lng: 121.54, simpAddress: "台北市士林區天玉街9巷3號", address: "台北市士林區天玉街9巷3號",
      fromFloor: "4", toFloor: "4", upFloor: 4, conditionTags: ["冰箱"],
    });
    await processOneEnrichJob(db, {
      loadListing: (id) => getListing(id),
      persistHpListingFields,
      invalidateLocation: invalidateListingLocation,
      markGone: () => {},
      markAlive: () => {},
      isSourceEnabled: () => true,
    }, job, {
      fetchDetail: async () => inspectHpDetailResponse({ status: 200, json, expectedId: "16470110" }),
    });
    const second = getListing(2400001885);
    assert.equal(Number(second.lat), 25.12);
    enqueueListingEnrich(db, second, { via: "click" });
    db.prepare("UPDATE listing_enrich_jobs SET status = 'queued', next_retry_at = NULL WHERE post_id = ?").run(second.post_id);
    const [job2] = claimEnrichJobs(db, { limit: 1 });
    Object.assign(json.webRentCaseGroupingDetail, {
      lat: "", lng: "", simpAddress: "台北市士林區天玉街9巷99號", address: "台北市士林區天玉街9巷99號",
    });
    await processOneEnrichJob(db, {
      loadListing: (id) => getListing(id),
      persistHpListingFields,
      invalidateLocation: invalidateListingLocation,
      markGone: () => {},
      markAlive: () => {},
      isSourceEnabled: () => true,
    }, job2, {
      fetchDetail: async () => inspectHpDetailResponse({ status: 200, json, expectedId: "16470110" }),
    });
    const third = getListing(2400001885);
    assert.equal(third.address, "台北市士林區天玉街9巷99號");
    assert.equal(third.lat == null || Number(third.lat) === 0, true);
    assert.notEqual(classifyAddress(third).mark, "exact");
    console.log("ok");
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: ISOLATED_TIMEOUT_MS,
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("S5 first incomplete facility response still withholds display", () => {
  const first = evaluateHpPrep(hpListing({
    tags: "[]",
    has_natural_gas: 0,
    furnish_items: "[]",
  }), {
    fetched: true,
    detailRecognized: true,
    facilityPartial: true,
  });
  assert.equal(first.displayReady, false);
  assert.equal(first.missing.includes("facility"), true);
});

test("S5 ready listing keeps confirmed facilities after a partial response then a full one", async () => {
  const conn = memoryQueue();
  const listing = hpListing({
    tags: "[]",
    has_natural_gas: 0,
    furnish_items: "[]",
    content_seq: 0,
  });
  enqueueListingEnrich(conn, listing, { via: "scheduler" });
  const [job1] = claimEnrichJobs(conn, { limit: 1 });
  const store = new Map([[listing.post_id, { ...listing }]]);
  const full = liveDetail({
    conditionTags: ["冰箱", "洗衣機", "天然瓦斯"],
    facilities: [{ name: "冰箱" }, { name: "洗衣機" }],
    equipments: [],
    devices: [],
    parkingYN: "N",
  });
  const first = await processOneEnrichJob(conn, storeHelpers(store), job1, {
    fetchDetail: async () => inspectHpDetailResponse({ status: 200, json: full, expectedId: "16470110" }),
  });
  assert.equal(first.evalResult.displayReady, true);
  const ready = store.get(listing.post_id);
  assert.match(String(ready.tags), /冰箱/);
  assert.match(String(ready.tags), /洗衣機/);
  assert.equal(Number(ready.has_natural_gas), 1);
  assert.equal(Number(getListingPrep(conn, listing.post_id).display_ready), 1);

  enqueueListingEnrich(conn, store.get(listing.post_id), { via: "click" });
  const [job2] = claimEnrichJobs(conn, { limit: 1 });
  const partialJson = liveDetail({
    conditionTags: ["可開伙"],
    facilities: [],
    equipments: [],
    devices: [],
    parkingYN: "N",
  });
  const partialInspected = inspectHpDetailResponse({ status: 200, json: partialJson, expectedId: "16470110" });
  assert.equal(partialInspected.facilityPartial, true);
  assert.equal(partialInspected.facilityBlock, false);
  assert.equal(partialInspected.facilityEvidence.replace, false);
  const evidence = applyHpFacilityEvidence(ready, parseHpDetailJson(partialJson));
  assert.equal(evidence.replace, false);
  const second = await processOneEnrichJob(conn, storeHelpers(store), job2, {
    fetchDetail: async () => partialInspected,
  });
  assert.equal(second.evalResult.displayReady, true);
  assert.equal(second.evalResult.status, PREP_SOURCE_LIMITED);
  const afterPartial = store.get(listing.post_id);
  assert.match(String(afterPartial.tags), /冰箱/);
  assert.match(String(afterPartial.tags), /洗衣機/);
  assert.equal(Number(afterPartial.has_natural_gas), 1);
  const prep = getListingPrep(conn, listing.post_id);
  assert.equal(Number(prep.display_ready), 1);
  assert.match(String(prep.missing_fields), /facility/);

  conn.prepare("UPDATE listing_enrich_jobs SET next_retry_at = ? WHERE post_id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), listing.post_id);
  enqueueListingEnrich(conn, afterPartial, { via: "click" });
  const [job3] = claimEnrichJobs(conn, { limit: 1 });
  assert.ok(job3, "third enrich job should be claimable after partial-facility backoff expires");
  const third = await processOneEnrichJob(conn, storeHelpers(store), job3, {
    fetchDetail: async () => inspectHpDetailResponse({ status: 200, json: full, expectedId: "16470110" }),
  });
  assert.equal(third.evalResult.displayReady, true);
  assert.equal(third.evalResult.status, PREP_READY);
  const afterFull = store.get(listing.post_id);
  assert.match(String(afterFull.tags), /冰箱/);
  assert.equal(Number(afterFull.has_natural_gas), 1);
});

test("S5 source evidence cancels fridge and gas while keeping washer", async () => {
  const conn = memoryQueue();
  const listing = hpListing();
  enqueueListingEnrich(conn, listing, { via: "scheduler" });
  const [job] = claimEnrichJobs(conn, { limit: 1 });
  const store = new Map([[listing.post_id, listing]]);
  const json = liveDetail({
    conditionTags: [],
    facilities: [{ name: "洗衣機" }, { name: "無冰箱" }],
    equipments: [],
    devices: [],
    facilityRemark: "無冰箱、無天然瓦斯、洗衣機",
    noFacility: false,
  });
  const inspected = inspectHpDetailResponse({ status: 200, json, expectedId: "16470110" });
  assert.equal(inspected.facilityPartial, false);
  const result = await processOneEnrichJob(conn, storeHelpers(store), job, {
    fetchDetail: async () => inspected,
  });
  assert.equal(result.outcome, PROBE_ALIVE);
  const saved = store.get(listing.post_id);
  assert.doesNotMatch(String(saved.tags), /冰箱/);
  assert.equal(Number(saved.has_natural_gas), 0);
  const items = Array.isArray(saved.furnish_items) ? saved.furnish_items : JSON.parse(saved.furnish_items || "[]");
  assert.equal(items.includes("洗衣機"), true);
  assert.equal(items.includes("冰箱"), false);
});

test("S6 late alive or gone cannot change a newer offline write", async () => {
  const conn = memoryQueue();
  const listing = hpListing({ offline: 0, content_seq: 1 });
  enqueueListingEnrich(conn, listing, { via: "scheduler" });
  const [aliveJob] = claimEnrichJobs(conn, { limit: 1 });
  const store = new Map([[listing.post_id, { ...listing }]]);
  const helpers = storeHelpers(store);
  const lateAlive = await processOneEnrichJob(conn, helpers, aliveJob, {
    fetchDetail: async () => {
      helpers.markGone(listing.post_id);
      return inspectHpDetailResponse({
        status: 200,
        expectedId: "16470110",
        json: liveDetail({ conditionTags: ["冰箱"] }),
      });
    },
  });
  assert.equal(lateAlive.stale || lateAlive.superseded, true);
  assert.equal(Number(store.get(listing.post_id).offline), 1);

  enqueueListingEnrich(conn, store.get(listing.post_id), { via: "click" });
  const [goneJob] = claimEnrichJobs(conn, { limit: 1 });
  const lateGone = await processOneEnrichJob(conn, helpers, goneJob, {
    fetchDetail: async () => {
      helpers.markAlive(listing.post_id);
      return inspectHpDetailResponse({
        status: 200,
        expectedId: "16470110",
        json: liveDetail({ isOff: 1, caseStatus: "已出租" }),
      });
    },
  });
  assert.equal(lateGone.stale || lateGone.superseded, true);
  assert.equal(Number(store.get(listing.post_id).offline), 0);
});

test("S6 real DB late alive/gone interleave cannot rewrite offline", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-hp-s6-"));
  const script = `
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    import path from "node:path";
    import {
      upsertListing, getListing, markListingOffline, markListingAlive,
      persistHpListingFields, invalidateListingLocation, db,
    } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/db.js")).href)};
    import {
      ensureListingPrepSchema, enqueueListingEnrich, claimEnrichJobs, processOneEnrichJob,
    } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/listingEnrichQueue.js")).href)};
    import { inspectHpDetailResponse } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/houseprice.js")).href)};
    const live = JSON.parse(readFileSync(${JSON.stringify(path.join(dir, "fixtures/houseprice-detail-16470110.json"))}, "utf8"));
    ensureListingPrepSchema(db);
    const stamp = "2026-09-14T00:00:00.000Z";
    const row = {
      post_id: 2400001991, source: "houseprice", source_id: "16470110", source_key: "g-s6",
      search_key: "https://example.test", url: "https://rent.houseprice.tw/house/16470110",
      title: "天玉街 5168", price: "28000", price_num: 28000, extra_fees: [],
      address: "台北市士林區天玉街9巷3號", area_name: "19坪", layout: "1房1廳1衛",
      floor_name: "4/4", kind_name: "整層住家", role_name: "5168", cover: "", tags: '["冰箱"]',
      lat: 25.1105, lng: 121.529, geo_source: "houseprice", has_natural_gas: 1, furnish_items: '["冰箱"]',
      refresh_time: stamp, first_seen_at: stamp, last_seen_at: stamp, last_event: "new",
    };
    upsertListing(row);
    const helpers = {
      loadListing: (id) => getListing(id),
      persistHpListingFields,
      invalidateLocation: invalidateListingLocation,
      markGone: (id) => markListingOffline(id),
      markAlive: (id) => markListingAlive(id),
      isSourceEnabled: () => true,
    };
    enqueueListingEnrich(db, getListing(row.post_id), { via: "scheduler" });
    const [aliveJob] = claimEnrichJobs(db, { limit: 1 });
    const lateAlive = await processOneEnrichJob(db, helpers, aliveJob, {
      fetchDetail: async () => {
        markListingOffline(row.post_id);
        return inspectHpDetailResponse({ status: 200, json: live, expectedId: "16470110" });
      },
    });
    assert.equal(lateAlive.stale || lateAlive.superseded, true);
    assert.equal(Number(getListing(row.post_id).offline), 1);
    enqueueListingEnrich(db, getListing(row.post_id), { via: "click" });
    const [goneJob] = claimEnrichJobs(db, { limit: 1 });
    const lateGone = await processOneEnrichJob(db, helpers, goneJob, {
      fetchDetail: async () => {
        markListingAlive(row.post_id);
        const gone = JSON.parse(JSON.stringify(live));
        gone.webRentCaseGroupingDetail.isOff = 1;
        gone.webRentCaseGroupingDetail.caseStatus = "已出租";
        return inspectHpDetailResponse({ status: 200, json: gone, expectedId: "16470110" });
      },
    });
    assert.equal(lateGone.stale || lateGone.superseded, true);
    assert.equal(Number(getListing(row.post_id).offline), 0);
    console.log("ok");
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: ISOLATED_TIMEOUT_MS,
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("S6 late enrich cannot overwrite a newer crawler floor write", async () => {
  const conn = memoryQueue();
  const listing = hpListing({ floor_name: "2/8", content_seq: 0 });
  enqueueListingEnrich(conn, listing, { via: "scheduler" });
  const [job] = claimEnrichJobs(conn, { limit: 1 });
  const store = new Map([[listing.post_id, { ...listing }]]);
  const helpers = storeHelpers(store);
  const result = await processOneEnrichJob(conn, helpers, job, {
    fetchDetail: async () => {
      helpers.persistHpListingFields(listing.post_id, { ...store.get(listing.post_id), floor_name: "6/8" });
      return inspectHpDetailResponse({
        status: 200,
        expectedId: "16470110",
        json: liveDetail({ fromFloor: "2", toFloor: "2", upFloor: 8, conditionTags: ["冰箱"] }),
      });
    },
  });
  assert.equal(result.stale || result.superseded, true);
  assert.equal(store.get(listing.post_id).floor_name, "6/8");
});

test("S7 other listing gone is not adopted as this listing gone", () => {
  const otherGone = liveDetail({ sid: 16692013, isOff: 1, caseStatus: "已出租" });
  const inspected = inspectHpDetailResponse({ status: 200, json: otherGone, expectedId: "16470110" });
  assert.equal(inspected.outcome, PROBE_INCONCLUSIVE);
  assert.equal(inspected.reason, "id_mismatch");
  const skipped = enrichHpListingFromDetail(hpListing(), parseHpDetailJson(otherGone));
  assert.equal(skipped.floor_name, "4/4");
});

test("S9 same ids still rerender when only a peer floor is corrected", () => {
  const page = pageListingFns();
  const before = {
    post_id: 591001, price_num: 28000, title: "591", floor_name: "4/4", address: "巷3號",
    tags: "[]", offline: 0, display_ready: true, furnish_items: [], has_natural_gas: 0,
    match_peer: { post_id: 2400001886, price_num: 32000, display_ready: true, floor_name: "4/4", offline: 0 },
    same_house: { peers: [{ post_id: 2400001886, price_num: 32000, display_ready: true, offline: 0, floor_name: "4/4" }] },
  };
  const after = {
    ...before,
    match_peer: { ...before.match_peer, floor_name: "3/4" },
    same_house: { peers: [{ ...before.same_house.peers[0], floor_name: "3/4" }] },
  };
  assert.equal(page.listingIdKey([before]), page.listingIdKey([after]));
  assert.notEqual(page.listingGroupContentKey(before), page.listingGroupContentKey(after));
  assert.notEqual(page.listingContentKey(before), page.listingContentKey(after));
  assert.notEqual(listingContentKey(before), listingContentKey(after));
  let renderCalls = 0;
  if (page.listingsContentKey([before]) !== page.listingsContentKey([after])) renderCalls += 1;
  assert.equal(renderCalls, 1);
});

test("S9 page listingContentKey includes group peers so a ready member rerenders", () => {
  const page = pageListingFns();
  const primary = {
    post_id: 591001, price_num: 28000, title: "591", floor_name: "4/4", address: "巷3號",
    tags: "[]", offline: 0, display_ready: true, furnish_items: [], has_natural_gas: 0,
    same_house: { peers: [] }, match_peer: null,
  };
  const next = {
    ...primary,
    match_peer: { post_id: 2400001886, price_num: 32000, display_ready: true },
    same_house: { peers: [{ post_id: 2400001886, price_num: 32000, display_ready: true, offline: 0 }] },
  };
  assert.notEqual(page.listingContentKey(primary), page.listingContentKey(next));
  assert.equal(page.listingIdKey([primary]), page.listingIdKey([next]));
  const sameIds = page.listingIdKey([primary]) === page.listingIdKey([next]);
  const sameContent = page.listingsContentKey([primary]) === page.listingsContentKey([next]);
  assert.equal(sameIds && sameContent, false);
  let renderCalls = 0;
  if (!(sameIds && sameContent)) renderCalls += 1;
  assert.equal(renderCalls, 1);
});

test("S10 two loaded pages then a queued note-edit refresh keep the window", () => {
  const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");
  assert.match(html, /function flushQueuedListRefresh\(\)[\s\S]*?loadList\(\{\s*silent:\s*true,\s*keep:\s*true,\s*refreshCards:\s*true\s*\}\)/);
  const run = new Function(`
    const calls = [];
    let listRefreshQueued = true;
    function watchNoteBusy() { return false; }
    function loadList(options) { calls.push(options); }
    ${pageFn("flushQueuedListRefresh")}
    flushQueuedListRefresh();
    return { queued: listRefreshQueued, calls };
  `);
  const result = run();
  assert.equal(result.queued, false);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].keep, true);
  assert.equal(result.calls[0].silent, true);
  assert.equal(result.calls[0].refreshCards, true);
  assert.notEqual(result.calls[0].force, true);
  const loaded = Array.from({ length: 160 }, (_, i) => ({ post_id: i + 1 }));
  const limit = listRefreshLimit({
    pageSize: 80,
    loadedCount: loaded.length,
    keep: result.calls[0].keep,
    append: false,
  });
  assert.equal(limit, 160);
  const restored = loaded.slice(0, limit);
  assert.equal(restored.length, 160);
  assert.equal(restored[159].post_id, 160);
});

test("S10 refresh of a 100-card list keeps the loaded window", () => {
  assert.equal(listRefreshLimit({ pageSize: 50, loadedCount: 100, keep: true }), 100);
  assert.equal(listRefreshLimit({ pageSize: 80, loadedCount: 0, keep: false }), 80);
  const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");
  assert.match(html, /fetchLimit/);
  assert.match(html, /loadedCount/);
  assert.match(html, /listAnchorId/);
  const loaded = Array.from({ length: 100 }, (_, i) => ({ post_id: i + 1 }));
  const limit = listRefreshLimit({ pageSize: 50, loadedCount: loaded.length, keep: true, append: false });
  const fetched = loaded.slice(0, limit);
  assert.equal(fetched.length, 100);
});

test("S11 reseeding a queued job does not reset last_queued_at", async () => {
  const conn = memoryQueue();
  const listing = hpListing();
  enqueueListingEnrich(conn, listing, { via: "scheduler" });
  conn.prepare("UPDATE listing_enrich_jobs SET last_queued_at = ? WHERE post_id = ?")
    .run("2026-09-01T00:00:00.000Z", listing.post_id);
  enqueueListingEnrich(conn, listing, { via: "scheduler", priority: 20 });
  const row = conn.prepare("SELECT last_queued_at, priority, status FROM listing_enrich_jobs WHERE post_id = ?").get(listing.post_id);
  assert.equal(row.last_queued_at, "2026-09-01T00:00:00.000Z");
  assert.equal(row.status, "queued");
  assert.equal(Number(row.priority), 20);
  conn.exec(`
    CREATE TABLE listings (
      post_id INTEGER PRIMARY KEY, source TEXT, source_id TEXT, url TEXT, title TEXT,
      price_num INTEGER, address TEXT, floor_name TEXT, lat REAL, lng REAL, tags TEXT,
      offline INTEGER DEFAULT 0, first_seen_at TEXT
    )
  `);
  conn.prepare(`
    INSERT INTO listings(post_id, source, source_id, url, title, price_num, address, floor_name, lat, lng, tags, offline, first_seen_at)
    VALUES (?, 'houseprice', '16470110', 'https://x', 't', 28000, 'addr', '4/4', 25, 121, '[]', 0, ?)
  `).run(listing.post_id, "2026-09-01T00:00:00.000Z");
  seedHousepriceEnrichJobs(conn, { limit: 10, isEnabled: () => true });
  const again = conn.prepare("SELECT last_queued_at FROM listing_enrich_jobs WHERE post_id = ?").get(listing.post_id);
  assert.equal(again.last_queued_at, "2026-09-01T00:00:00.000Z");
});
