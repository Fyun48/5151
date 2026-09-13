import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dbPath = JSON.stringify(path.join(dir, "../src/db.js"));
const watcherPath = JSON.stringify(path.join(dir, "../src/watcher.js"));
const routePath = JSON.stringify(path.join(dir, "../src/route.js"));
const demoPath = JSON.stringify(path.join(dir, "../src/demo.js"));

function runIsolated(script) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-commute-live-"));
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const line = result.stdout.trim().split("\n").filter((row) => row.startsWith("{")).at(-1);
    return JSON.parse(line);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const seedPrelude = `
  import { getCachedRoute, listingCommutePatch, listingsNeedingRoute, setCachedRoute, upsertListing, upsertRouteJob, db } from ${dbPath};
  import { backfillListingRoutes } from ${watcherPath};
  import { makeRouteKey } from ${routePath};
  import { DEMO_COMMUTE_MODE, DEMO_WORK_LAT, DEMO_WORK_LNG } from ${demoPath};
  const stamp = "2026-09-11T00:00:00.000Z";
  function seed(id, extra = {}) {
    upsertListing({
      post_id: id,
      source_key: "1|1",
      search_key: "https://example.test",
      title: "通勤測試 " + id,
      url: "https://rent.591.com.tw/" + id,
      price: "22000元",
      price_num: 22000,
      extra_fees: [],
      address: "台北市士林區中山北路六段" + id + "號",
      area_name: "20坪",
      layout: "2房1廳",
      floor_name: "5/12",
      kind_name: "整層住家",
      role_name: "",
      cover: "",
      tags: '["有電梯"]',
      refresh_time: "",
      first_seen_at: stamp,
      last_seen_at: stamp,
      last_event: "new",
      source: "591",
      ...extra,
    });
  }
  const settings = {
    commuteKm: 25,
    workLat: DEMO_WORK_LAT,
    workLng: DEMO_WORK_LNG,
    commuteMode: DEMO_COMMUTE_MODE,
    workAddress: "臺北市南港區經貿一路170號",
  };
`;

test("same listing ids pick up kilometers after cache write", () => {
  const out = runIsolated(`
    ${seedPrelude}
    seed(910001, { lat: 25.093, lng: 121.525, geo_source: "591" });
    const before = listingCommutePatch(910001, 0, settings);
    setCachedRoute(25.093, 121.525, DEMO_WORK_LAT, DEMO_WORK_LNG, [4.6], null, DEMO_COMMUTE_MODE, "to_work");
    const after = listingCommutePatch(910001, 0, settings);
    console.log(JSON.stringify({
      beforeKm: before.commute_km,
      beforeState: before.commute_state,
      afterKm: after.commute_km,
      afterState: after.commute_state,
      sameId: before.post_id === after.post_id,
    }));
  `);
  assert.equal(out.sameId, true);
  assert.equal(out.beforeKm, null);
  assert.equal(out.beforeState, "wait_route");
  assert.equal(out.afterKm, 4.6);
  assert.equal(out.afterState, "done");
});

test("listings gain route work immediately after coordinates appear", () => {
  const out = runIsolated(`
    ${seedPrelude}
    seed(910002, { lat: null, lng: null, geo_source: "" });
    const missing = listingsNeedingRoute(20).some((row) => row.post_id === 910002);
    db.prepare("UPDATE listings SET lat = ?, lng = ?, geo_source = ? WHERE post_id = ?").run(25.11, 121.53, "591", 910002);
    const ready = listingsNeedingRoute(20).filter((row) => row.post_id === 910002);
    console.log(JSON.stringify({ missing, ready: ready.length, needBasic: ready[0]?.needBasic }));
  `);
  assert.equal(out.missing, false);
  assert.ok(out.ready > 0);
  assert.equal(out.needBasic, true);
});

test("failed front items release the queue so later listings still run", () => {
  const out = runIsolated(`
    ${seedPrelude}
    for (let i = 1; i <= 6; i += 1) {
      seed(920000 + i, { lat: 25.04 + i * 0.001, lng: 121.52 + i * 0.001, geo_source: "591" });
    }
    for (let i = 1; i <= 3; i += 1) {
      upsertRouteJob({
        post_id: 920000 + i,
        direction: "to_work",
        kind: "distance",
        commuteMode: DEMO_COMMUTE_MODE,
        workLat: DEMO_WORK_LAT,
        workLng: DEMO_WORK_LNG,
        job_state: "failed",
        fail_reason: "no_route",
        attempts: 2,
      });
    }
    const need = listingsNeedingRoute(10);
    console.log(JSON.stringify({
      ids: need.map((row) => row.post_id),
      blocked: need.some((row) => row.post_id <= 920003),
      later: need.some((row) => row.post_id >= 920004),
    }));
  `);
  assert.equal(out.blocked, false);
  assert.equal(out.later, true);
});

test("cursor walks past the old 2000-row candidate cap", () => {
  const out = runIsolated(`
    ${seedPrelude}
    for (let i = 1; i <= 2105; i += 1) {
      seed(800000 + i, { lat: 25.03 + (i % 80) * 0.001, lng: 121.52 + Math.floor(i / 80) * 0.001, geo_source: "591" });
    }
    const later = listingsNeedingRoute(8, { cursor: 802000 });
    console.log(JSON.stringify({
      count: later.length,
      minId: later[0]?.post_id || 0,
      allAfter: later.every((row) => row.post_id > 802000),
    }));
  `);
  assert.ok(out.count > 0);
  assert.equal(out.allAfter, true);
  assert.ok(out.minId > 802000);
});

test("cache hit skips the external router and opposite directions stay apart", () => {
  const out = runIsolated(`
    ${seedPrelude}
    seed(930001, { lat: 25.093, lng: 121.525, geo_source: "591" });
    setCachedRoute(25.093, 121.525, DEMO_WORK_LAT, DEMO_WORK_LNG, [5.1], null, DEMO_COMMUTE_MODE, "to_work");
    setCachedRoute(DEMO_WORK_LAT, DEMO_WORK_LNG, 25.093, 121.525, [7.7], null, DEMO_COMMUTE_MODE, "from_work");
    const urls = [];
    const orig = globalThis.fetch;
    globalThis.fetch = async (input) => {
      urls.push(String(input));
      return { ok: true, status: 200, json: async () => ({ code: "Ok", distances: [[9999]] }) };
    };
    const result = await backfillListingRoutes(settings, { limit: 20, priorityIds: [930001] });
    globalThis.fetch = orig;
    const row = listingCommutePatch(930001, 0, settings);
    const oldKey = getCachedRoute(25.093, 121.525, DEMO_WORK_LAT, DEMO_WORK_LNG, DEMO_COMMUTE_MODE, "to_work");
    db.prepare("INSERT OR IGNORE INTO route_cache(route_key, distances, min_km, updated_at) VALUES (?, ?, ?, ?)").run(
      "25.093,121.525>25.05781,121.6184",
      JSON.stringify([1.1]),
      1.1,
      stamp,
    );
    console.log(JSON.stringify({
      urls: urls.length,
      attempted: result.attempted,
      km: row?.commute_km,
      ret: row?.commute_return_km,
      toKey: makeRouteKey(25.093, 121.525, DEMO_WORK_LAT, DEMO_WORK_LNG, DEMO_COMMUTE_MODE, "to_work"),
      fromKey: makeRouteKey(DEMO_WORK_LAT, DEMO_WORK_LNG, 25.093, 121.525, DEMO_COMMUTE_MODE, "from_work"),
      cachedMin: oldKey?.min_km,
    }));
  `);
  assert.equal(out.urls, 0);
  assert.equal(out.attempted, 0);
  assert.equal(out.km, 5.1);
  assert.equal(out.ret, 7.7);
  assert.match(out.toKey, /v2:to_work:/);
  assert.match(out.fromKey, /v2:from_work:/);
  assert.notEqual(out.toKey, out.fromKey);
  assert.equal(out.cachedMin, 5.1);
});

test("simulated batch: coords-ready, missing-geo, and cache-hit request counts", () => {
  const out = runIsolated(`
    ${seedPrelude}
    const urls = [];
    globalThis.fetch = async (input) => {
      urls.push(String(input));
      const url = String(input);
      if (url.includes("sources=") && url.includes("destinations=0")) {
        return { ok: true, status: 200, json: async () => ({ code: "Ok", distances: Array.from({ length: 20 }, () => [4200]) }) };
      }
      return { ok: true, status: 200, json: async () => ({ code: "Ok", distances: [Array.from({ length: 20 }, () => 5100)] }) };
    };
    for (let i = 1; i <= 20; i += 1) {
      seed(940000 + i, { lat: 25.05 + i * 0.001, lng: 121.52 + i * 0.001, geo_source: "591" });
    }
    const t0 = Date.now();
    const first = await backfillListingRoutes(settings, { limit: 20, priorityIds: [940001, 940002, 940003] });
    const firstMs = Date.now() - t0;
    const firstUrls = urls.length;
    urls.length = 0;
    const t1 = Date.now();
    const second = await backfillListingRoutes(settings, { limit: 20, priorityIds: [940001] });
    const hitMs = Date.now() - t1;
    seed(950001, { lat: null, lng: null, geo_source: "" });
    const missingNeed = listingsNeedingRoute(40).some((row) => row.post_id === 950001);
    console.log(JSON.stringify({
      firstAttempted: first.attempted,
      firstLocated: first.located,
      firstUrls,
      firstMs,
      secondAttempted: second.attempted,
      hitUrls: urls.length,
      hitMs,
      missingNeed,
    }));
  `);
  assert.ok(out.firstAttempted >= 20, JSON.stringify(out));
  assert.ok(out.firstLocated >= 20, JSON.stringify(out));
  assert.ok(out.firstUrls >= 1 && out.firstUrls <= 4, JSON.stringify(out));
  assert.equal(out.secondAttempted, 0);
  assert.equal(out.hitUrls, 0);
  assert.equal(out.missingNeed, false);
});

test("failed route results leave computing and still patch the card", () => {
  const out = runIsolated(`
    ${seedPrelude}
    seed(960001, { lat: 25.093, lng: 121.525, geo_source: "591" });
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ code: "Ok", distances: [[null]] }) });
    const result = await backfillListingRoutes(settings, { limit: 5, priorityIds: [960001] });
    console.log(JSON.stringify({
      attempted: result.attempted,
      located: result.located,
      state: result.listings?.[0]?.commute_state,
      label: result.listings?.[0]?.commute_state_label,
      km: result.listings?.[0]?.commute_km,
    }));
  `);
  assert.ok(out.attempted >= 1);
  assert.equal(out.located, 0);
  assert.equal(out.km, null);
  assert.equal(out.state, "failed");
  assert.equal(out.label, "尚未取得足夠位置資料");
});

test("index keeps local commute patch hooks and reconnect snapshot", () => {
  const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");
  assert.match(html, /data-commute=/);
  assert.match(html, /function applyCommutePatches/);
  assert.match(html, /el\.outerHTML !== html/);
  assert.match(html, /pendingCommuteWork\(\)\) refreshCommuteSnapshot/);
  assert.match(html, /function queueGeoRefresh/);
  assert.match(html, /function refreshCommuteSnapshot/);
  assert.match(html, /\/api\/commute\/snapshot/);
  assert.match(html, /\/api\/commute\/focus/);
  assert.match(html, /es\.onopen/);
  assert.match(html, /visibilitychange/);
  assert.match(html, /等待定位/);
  assert.match(html, /等待計算/);
  assert.match(html, /定位服務暫時忙碌，稍後重試/);
  assert.match(html, /尚未取得足夠位置資料/);
  assert.doesNotMatch(html, /id="notifyIncludeStreetEstimate"/);
  assert.match(html, /訪客可用直線距離先篩/);
  assert.match(html, /汽車路網估算/);
  assert.match(html, /不是專用機車道路/);
  assert.doesNotMatch(html, /路線計算中/);
  assert.doesNotMatch(html, /尚未取得地圖座標/);
  const src = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  const backfillFn = src.slice(src.indexOf("function queueGeoBackfill"), src.indexOf("async function tick"));
  assert.match(backfillFn, /rememberBackfillRequest/);
  assert.match(backfillFn, /finishBackfillRequest/);
  assert.match(backfillFn, /delete routes\.listings/);
  assert.match(backfillFn, /delete routes\.fingerprint/);
  assert.match(backfillFn, /broadcast\(\{ type: "geo", routeBackfill: routes \}\)/);
  assert.ok(backfillFn.indexOf("delete routes.listings") < backfillFn.indexOf("broadcast({ type: \"geo\", routeBackfill: routes })"));
  assert.ok(backfillFn.indexOf("backfillListingRoutes") < backfillFn.indexOf("backfillListingCoords"));
});
