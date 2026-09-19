import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = JSON.stringify(pathToFileURL(path.join(dir, "../src/db.js")).href);

test("api/listings wires the SQL-first paths with a listListings fallback", () => {
  const server = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  const handler = server.slice(
    server.indexOf('app.get("/api/listings"'),
    server.indexOf('app.post("/api/listings/hide-many"'),
  );
  assert.match(handler, /const args = \{/);
  assert.match(handler, /matchVoteUserId: uid/);
  assert.match(handler, /listListingsSqlFirst\(args\) \|\|/);
  assert.match(handler, /listListingsCommuteSqlFirst\(args\) \|\|/);
  assert.match(handler, /listListingsFitSqlFirst\(args\) \|\|/);
  assert.match(handler, /listListings\(args\)/);
});

test("SQL-first paths honor matchVoteUserId like listListings does", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-wiring-"));
  const script = `
    import assert from "node:assert/strict";
    import * as app from ${dbUrl};
    const uid = app.defaultUserId();
    const settings = {
      ...app.getSettings(uid), searchUrls: [], watchDistricts: ["1-8"],
      priceMin: 0, priceMax: 0, priceMaxIncludesExtras: true, commuteKm: 0,
      wholeFloorOnly: false, excludeLowFloors: false, excludeRooftop: false, hasParking: false,
      excludeKeywords: [], excludeAgents: [], excludeAgentIds: [], excludeBoxes: [],
      areaMax: 0, minBuildingFloors: 0,
    };
    for (let i = 1; i <= 30; i++) {
      const stamp = new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString();
      app.upsertListing({
        post_id: i, source: "591", source_id: String(i),
        source_key: "1|8|" + i, search_key: "https://example.test/search",
        title: "住宅 " + i, url: "https://example.test/listing/" + i,
        price: (12000 + i * 500) + "元", price_num: 12000 + i * 500, extra_fee: 0, extra_fees: [],
        address: "台北市士林區測試路" + i + "號", area_name: "20坪",
        layout: "2房1廳1衛", floor_name: "5/12", kind_name: "整層住家/電梯大樓",
        role_name: "", cover: "https://example.test/c.png", tags: "[]",
        refresh_time: stamp, first_seen_at: stamp, last_seen_at: stamp, last_event: "new",
      });
    }
    // The server always passes matchVoteUserId = uid; both paths must decorate identically.
    const base = { userId: uid, searchKeys: [], settings, sort: "newest", limit: 20, matchVoteUserId: uid, sameHouse: true };
    const js = app.listListings(base).listings.map((r) => ({ id: r.post_id, mine: r.mine }));
    const sql = app.listListingsSqlFirst(base);
    assert.ok(sql, "sql-first should be supported");
    const sqlIds = sql.listings.map((r) => ({ id: r.post_id, mine: r.mine }));
    console.log(JSON.stringify({ idsOk: JSON.stringify(js) === JSON.stringify(sqlIds) }));
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const line = result.stdout.trim().split("\n").filter((row) => row.startsWith("{")).at(-1);
    assert.equal(JSON.parse(line).idsOk, true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
