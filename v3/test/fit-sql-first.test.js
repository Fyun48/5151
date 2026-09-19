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
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-fit-sqlfirst-"));
  const script = `
    import assert from "node:assert/strict";
    import * as app from ${dbUrl};
    const uid = app.defaultUserId();
    function seed(post_id, overrides = {}) {
      const stamp = overrides.stamp || "2026-09-01T00:00:00.000Z";
      app.upsertListing({
        post_id, source: "591", source_id: String(post_id),
        source_key: "1|8|" + post_id, search_key: "https://example.test/search",
        title: "住宅 " + post_id, url: "https://example.test/listing/" + post_id,
        price: "20000元", price_num: 20000, extra_fee: 0, extra_fees: [],
        address: "台北市士林區中山北路六段" + post_id + "號", area_name: "20坪",
        layout: "2房1廳1衛", floor_name: "3F/5F", kind_name: "整層住家/電梯大樓",
        role_name: "", cover: "https://example.test/c.png", tags: "[]",
        refresh_time: stamp, first_seen_at: stamp, last_seen_at: stamp, last_event: "new",
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

test("fit_desc SQL-first matches the Node path across elevator/whole-floor/extra combos", () => {
  const out = runIsolated(`
    // fit_score (narrow envelope) = 58 + 4*elevator + 4*wholeFloor - 4*extraFlag
    const stamp = (i) => new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString();
    seed(1, { kind_name: "整層住家/電梯大樓", stamp: stamp(1) });                    // 66
    seed(2, { kind_name: "整層住家/公寓", title: "無電梯", stamp: stamp(2) });        // 62
    seed(3, { kind_name: "套房", title: "有電梯", stamp: stamp(3) });                 // 62
    seed(4, { kind_name: "套房", title: "無電梯", stamp: stamp(4) });                 // 58
    seed(5, { kind_name: "套房", title: "無電梯", extra_fee: 2000, stamp: stamp(5) });// 54

    const settings = {
      ...app.getSettings(uid), searchUrls: [], watchDistricts: ["1-8"],
      priceMin: 0, priceMax: 0, priceMaxIncludesExtras: true, commuteKm: 0,
      wholeFloorOnly: false, excludeLowFloors: false, excludeRooftop: false, hasParking: false,
      excludeKeywords: [], excludeAgents: [], excludeAgentIds: [], excludeBoxes: [],
      areaMax: 0, minBuildingFloors: 0,
    };

    const base = { userId: uid, searchKeys: [], settings, sort: "fit_desc", limit: 50 };
    const js = app.listListings(base).listings.map((r) => r.post_id);
    const sql = app.listListingsFitSqlFirst(base);
    assert.ok(sql, "fit sql-first should be supported");
    console.log(JSON.stringify({
      js,
      sql: sql.listings.map((r) => r.post_id),
      ok: JSON.stringify(js) === JSON.stringify(sql.listings.map((r) => r.post_id)),
    }));
  `);
  assert.equal(out.ok, true, JSON.stringify(out));
  // fit_score desc: 66 (1) > 62 (2,3) > 58 (4) > 54 (5); tie broken by updated_at desc.
  assert.deepEqual(out.js, [1, 3, 2, 4, 5]);
});

test("fit_desc SQL-first returns null outside its envelope", () => {
  const out = runIsolated(`
    seed(1);
    const base = { userId: uid, searchKeys: [], settings: {
      ...app.getSettings(uid), searchUrls: [], watchDistricts: ["1-8"],
      priceMin: 0, priceMax: 0, commuteKm: 0, wholeFloorOnly: false,
      excludeLowFloors: false, excludeRooftop: false, hasParking: false,
      excludeKeywords: [], excludeAgents: [], excludeAgentIds: [], excludeBoxes: [],
      areaMax: 0, minBuildingFloors: 0,
    }, sort: "fit_desc" };
    console.log(JSON.stringify({
      commute: app.listListingsFitSqlFirst({ ...base, settings: { ...base.settings, commuteKm: 5 } }),
      priceMax: app.listListingsFitSqlFirst({ ...base, settings: { ...base.settings, priceMax: 20000 } }),
      wholeFloor: app.listListingsFitSqlFirst({ ...base, settings: { ...base.settings, wholeFloorOnly: true } }),
      keyword: app.listListingsFitSqlFirst({ ...base, settings: { ...base.settings, excludeKeywords: ["電梯"] } }),
      wrongSort: app.listListingsFitSqlFirst({ ...base, sort: "newest" }),
    }));
  `);
  assert.equal(out.commute, null);
  assert.equal(out.priceMax, null);
  assert.equal(out.wholeFloor, null);
  assert.equal(out.keyword, null);
  assert.equal(out.wrongSort, null);
});
