import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = JSON.stringify(pathToFileURL(path.join(dir, "../src/db.js")).href);

const WORK_LAT = 25.05781;
const WORK_LNG = 121.6184;
const MODE = "scooter";

function runIsolated(body) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-commute-sqlfirst-"));
  const script = `
    import assert from "node:assert/strict";
    import * as app from ${dbUrl};
    const uid = app.defaultUserId();
    const WORK_LAT = ${WORK_LAT};
    const WORK_LNG = ${WORK_LNG};
    const settings = {
      ...app.getSettings(uid), searchUrls: [], watchDistricts: ["1-8"],
      priceMin: 0, priceMax: 0, priceMaxIncludesExtras: true,
      commuteKm: 25, wholeFloorOnly: false,
      excludeLowFloors: false, excludeRooftop: false, hasParking: false,
      excludeKeywords: [], excludeAgents: [], excludeAgentIds: [], excludeBoxes: [],
      areaMax: 0, minBuildingFloors: 0,
      workLat: WORK_LAT, workLng: WORK_LNG, commuteMode: "${MODE}",
    };
    function seed(post_id, overrides = {}) {
      app.upsertListing({
        post_id, source: "591", source_id: String(post_id),
        source_key: "1|8|" + post_id, search_key: "https://example.test/search",
        title: "通勤 " + post_id, url: "https://example.test/listing/" + post_id,
        price: "20000元", price_num: 20000, extra_fee: 0, extra_fees: [],
        address: "台北市士林區中山北路六段" + post_id + "號", area_name: "20坪",
        layout: "2房1廳1衛", floor_name: "5/12", kind_name: "整層住家/電梯大樓",
        role_name: "", cover: "https://example.test/cover.png", tags: "[]",
        refresh_time: "2026-09-01T00:00:00.000Z",
        first_seen_at: "2026-09-01T00:00:00.000Z",
        last_seen_at: "2026-09-01T00:00:00.000Z", last_event: "new",
        lat: 25.08, lng: 121.52, geo_source: "591",
        ...overrides,
      });
    }
    ${body}
  `;
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

test("commute SQL-first matches the Node path for commute_asc and commute_desc", () => {
  const out = runIsolated(`
    const coords = {
      1001: { lat: 25.081, lng: 121.521, km: 3.5 },
      1002: { lat: 25.082, lng: 121.522, km: 9.2 },
      1003: { lat: 25.083, lng: 121.523, km: 40.0 }, // beyond 25km budget
      1004: { lat: 25.084, lng: 121.524, km: null }, // no route -> filtered out
      1005: { lat: 25.085, lng: 121.525, km: 1.1 },
      1006: { lat: 25.086, lng: 121.526, km: 7.7 },
    };
    for (const [id, c] of Object.entries(coords)) {
      seed(Number(id), { lat: c.lat, lng: c.lng });
      if (c.km != null) app.setCachedRoute(c.lat, c.lng, WORK_LAT, WORK_LNG, [c.km], null, "${MODE}", "to_work");
    }
    const results = {};
    for (const sort of ["commute_asc", "commute_desc"]) {
      const base = { userId: uid, searchKeys: [], settings, sort, limit: 50 };
      const js = app.listListings(base).listings.map((r) => r.post_id);
      const sql = app.listListingsCommuteSqlFirst(base);
      assert.ok(sql, "commute sql-first should be supported for " + sort);
      results[sort] = { js, sql: sql.listings.map((r) => r.post_id), totalJs: app.listListings(base).totalMatched, totalSql: sql.totalMatched };
    }
    console.log(JSON.stringify({
      ascOk: JSON.stringify(results.commute_asc.js) === JSON.stringify(results.commute_asc.sql),
      descOk: JSON.stringify(results.commute_desc.js) === JSON.stringify(results.commute_desc.sql),
      asc: results.commute_asc,
      desc: results.commute_desc,
    }));
  `);
  assert.equal(out.ascOk, true, JSON.stringify(out));
  assert.equal(out.descOk, true, JSON.stringify(out));
  assert.equal(out.asc.totalJs, out.asc.totalSql);
  assert.equal(out.desc.totalJs, out.desc.totalSql);
});

test("commute SQL-first returns null outside its envelope", () => {
  const out = runIsolated(`
    seed(2001, { lat: 25.081, lng: 121.521 });
    app.setCachedRoute(25.081, 121.521, WORK_LAT, WORK_LNG, [3.5], null, "${MODE}", "to_work");
    const base = { userId: uid, searchKeys: [], settings, sort: "commute_asc" };
    const off = { ...settings, commuteKm: 0 };
    console.log(JSON.stringify({
      noWorkPoint: app.listListingsCommuteSqlFirst({ ...base, settings: { ...settings, workLat: null, workLng: null } }),
      noCommute: app.listListingsCommuteSqlFirst({ ...base, settings: off }),
      wrongSort: app.listListingsCommuteSqlFirst({ ...base, sort: "newest" }),
      filterWatched: app.listListingsCommuteSqlFirst({ ...base, filter: "watched" }),
      priceMax: app.listListingsCommuteSqlFirst({ ...base, settings: { ...settings, priceMax: 20000 } }),
    }));
  `);
  assert.equal(out.noWorkPoint, null);
  assert.equal(out.noCommute, null);
  assert.equal(out.wrongSort, null);
  assert.equal(out.filterWatched, null);
  assert.equal(out.priceMax, null);
});
