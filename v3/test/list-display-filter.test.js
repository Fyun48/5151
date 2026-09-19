import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = JSON.stringify(pathToFileURL(path.join(dir, "../src/db.js")).href);

function runIsolated(body) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-display-filter-"));
  const script = `
    import assert from "node:assert/strict";
    import * as app from ${dbUrl};
    const uid = app.defaultUserId();
    function seed(post_id, overrides = {}) {
      app.upsertListing({
        post_id, source: "591", source_id: String(post_id),
        source_key: "1|8|" + post_id, search_key: "https://example.test/search",
        title: "住宅 " + post_id, url: "https://example.test/listing/" + post_id,
        price: "20000元", price_num: 20000, extra_fee: 0, extra_fees: [],
        address: "台北市士林區中山北路六段" + post_id + "號", area_name: "20坪",
        layout: "2房1廳1衛", floor_name: "5/12", kind_name: "整層住家/電梯大樓",
        role_name: "", cover: "https://example.test/c.png", tags: "[]",
        refresh_time: "2026-09-01T00:00:00.000Z",
        first_seen_at: "2026-09-01T00:00:00.000Z",
        last_seen_at: "2026-09-01T00:00:00.000Z", last_event: "new",
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

test("SQL-first honors excludeLowFloors/excludeRooftop/hasParking like the Node path", () => {
  const out = runIsolated(`
    // 1 = low floor, 2 = ok, 3 = rooftop, 4 = no parking, 5 = suite, 6 = ok
    seed(1, { floor_name: "1F/5F", title: "近站附平面車位" });
    seed(2, { floor_name: "3F/5F", title: "近站附平面車位" });
    seed(3, { floor_name: "頂樓加蓋", title: "近站附平面車位" });
    seed(4, { floor_name: "3F/5F", title: "採光佳無車位" });
    seed(5, { floor_name: "3F/5F", kind_name: "套房", title: "近站附平面車位" });
    seed(6, { floor_name: "3F/5F", title: "近站附平面車位" });

    const settings = {
      ...app.getSettings(uid), searchUrls: [], watchDistricts: ["1-8"],
      priceMin: 0, priceMax: 0, priceMaxIncludesExtras: true, commuteKm: 0,
      wholeFloorOnly: false, excludeLowFloors: true, excludeRooftop: true, hasParking: true,
      excludeKeywords: [], excludeAgents: [], excludeAgentIds: [], excludeBoxes: [],
      areaMax: 0, minBuildingFloors: 0,
    };

    const results = {};
    for (const sort of ["newest", "price_asc", "price_desc"]) {
      const base = { userId: uid, searchKeys: [], settings, sort, limit: 50 };
      const js = app.listListings(base).listings.map((r) => r.post_id);
      const sql = app.listListingsSqlFirst(base);
      assert.ok(sql, "sql-first should be supported for " + sort);
      results[sort] = { js, sql: sql.listings.map((r) => r.post_id) };
    }
    console.log(JSON.stringify({
      newestOk: JSON.stringify(results.newest.js) === JSON.stringify(results.newest.sql),
      priceOk: JSON.stringify(results.price_asc.js) === JSON.stringify(results.price_asc.sql),
      newest: results.newest,
    }));
  `);
  assert.equal(out.newestOk, true, JSON.stringify(out));
  assert.equal(out.priceOk, true, JSON.stringify(out));
  // The low-floor (1), rooftop (3) and no-parking (4) listings must be filtered.
  assert.deepEqual(out.newest.js.sort((a, b) => a - b), [2, 5, 6]);
});
