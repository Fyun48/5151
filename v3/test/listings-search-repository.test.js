import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const ISOLATED_TIMEOUT_MS = Math.max(30_000, Number(process.env.V3_ISOLATED_TEST_TIMEOUT_MS) || 180_000);
const dbUrl = JSON.stringify(pathToFileURL(path.join(dir, "../src/db.js")).href);
const repoUrl = JSON.stringify(pathToFileURL(path.join(dir, "../src/repository/listings.js")).href);

// The SQLite adapter must reproduce the existing fast path exactly: same ids,
// same order, same total, same hasMore/nextOffset/nextCursor. The PostgreSQL
// adapter runs the same statement text, so this is the contract they share.
function runIsolated(body) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-listings-repo-"));
  const script = `
    import assert from "node:assert/strict";
    import * as app from ${dbUrl};
    import { createListingsRepository } from ${repoUrl};
    const uid = app.defaultUserId();
    const settings = {
      ...app.getSettings(uid), searchUrls: [], watchDistricts: ["1-8"],
      priceMin: 0, priceMax: 0, priceMaxIncludesExtras: true,
      commuteKm: 0, wholeFloorOnly: false,
      excludeLowFloors: false, excludeRooftop: false, hasParking: false,
      excludeKeywords: [], excludeAgents: [], excludeAgentIds: [], excludeBoxes: [],
      areaMax: 0, minBuildingFloors: 0,
    };
    function seed(post_id, overrides = {}) {
      app.upsertListing({
        post_id, source: "591", source_id: String(post_id),
        source_key: "1|8|" + post_id, search_key: "https://example.test/search",
        title: "合成住宅 " + post_id, url: "https://example.test/listing/" + post_id,
        price: "20000元", price_num: 20000, extra_fee: 0, extra_fees: [],
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
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8", timeout: ISOLATED_TIMEOUT_MS, env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
    const line = result.stdout.trim().split("\n").filter((row) => row.startsWith("{")).at(-1);
    return line ? JSON.parse(line) : null;
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const FIXTURE = `
  for (let i = 1; i <= 140; i++) {
    const inScope = i % 3 !== 0;
    const stamp = new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString();
    seed(i, {
      source_key: (inScope ? "1|8|" : "1|9|") + i,
      address: (inScope ? "台北市士林區" : "台北市北投區") + "測試路" + i + "號",
      price_num: 9000 + (i * 173) % 51000,
      price: (9000 + (i * 173) % 51000) + "元",
      extra_fee: i % 4 === 0 ? 1500 : 0,
      floor_name: i % 7 === 0 ? "1/5" : "5/12",
      first_seen_at: stamp, last_seen_at: stamp, refresh_time: stamp,
    });
  }
  const repo = createListingsRepository({ driver: "sqlite", sqliteDb: app.sqliteHandle(), deps: app.listingSearchBuildContext() });
`;

test("listings repository (sqlite) matches the SQL-first chain for ids/order/paging/cursor", () => {
  const summary = runIsolated(`
    ${FIXTURE}
    const checked = [];
    for (const sort of ["newest", "price_asc", "price_desc"]) {
      const base = { userId: uid, searchKeys: [], settings, sort, limit: 25, districts: ["士林區", "北投區"] };
      const legacy = app.listListingsSqlFirst(base);
      assert.ok(legacy, "sql-first should be supported for " + sort);
      const page = await repo.searchPage(base);
      assert.ok(page, "repository should support " + sort);
      assert.equal(page.driver, "sqlite");
      assert.deepEqual(page.ids, legacy.listings.map((row) => row.post_id));
      assert.equal(page.totalMatched, legacy.totalMatched);
      assert.equal(page.hasMore, legacy.hasMore);
      assert.equal(page.nextOffset, legacy.nextOffset);
      assert.deepEqual(page.nextCursor, legacy.nextCursor);
      assert.equal(page.queryVersion, legacy.queryVersion);

      const offsetPage = await repo.searchPage({ ...base, offset: 25 });
      const legacyOffset = app.listListingsSqlFirst({ ...base, offset: 25 });
      assert.deepEqual(offsetPage.ids, legacyOffset.listings.map((row) => row.post_id));
      assert.deepEqual(offsetPage.nextCursor, legacyOffset.nextCursor);

      const cursorPage = await repo.searchPage({ ...base, cursor: page.nextCursor });
      const legacyCursor = app.listListingsSqlFirst({ ...base, cursor: page.nextCursor });
      assert.deepEqual(cursorPage.ids, legacyCursor.listings.map((row) => row.post_id));
      assert.equal(cursorPage.useCursor, true);
      assert.deepEqual(cursorPage.nextCursor, legacyCursor.nextCursor);
      assert.equal(page.ids.filter((id) => cursorPage.ids.includes(id)).length, 0);

      const rows = await repo.hydrate(page.ids);
      assert.deepEqual(rows.map((row) => Number(row.post_id)), page.ids);
      assert.ok(rows.every((row) => typeof row.title === "string" && row.title.length > 0));
      checked.push({ sort, ids: page.ids.length, total: page.totalMatched });
    }
    assert.equal(await repo.searchPage({ userId: uid, searchKeys: [], settings, sort: "newest", filter: "watched" }), null);
    assert.equal(await repo.searchPage({ userId: uid, searchKeys: [], settings, sort: "newest", q: "abc" }), null);
    assert.equal(await repo.searchPage({ userId: uid, searchKeys: [], settings: { ...settings, priceMax: 25000 }, sort: "newest" }), null);
    assert.deepEqual(await repo.hydrate([]), []);
    console.log(JSON.stringify({ ok: true, checked }));
  `);
  assert.equal(summary.ok, true);
  assert.equal(summary.checked.length, 3);
  for (const row of summary.checked) assert.ok(row.ids > 0, `${row.sort} returned no ids`);
});

test("createListingsRepository validates its driver handles", async () => {
  const { createListingsRepository } = await import("../src/repository/listings.js");
  assert.throws(() => createListingsRepository({ driver: "postgres" }), /requires pgDriver/);
  assert.throws(() => createListingsRepository({ driver: "sqlite" }), /requires sqliteDb/);
});

test("listingSearchSql rejects incomplete dependency bundles", async () => {
  const { buildListingSearchSql, assertListingSearchDeps } = await import("../src/listingSearchSql.js");
  assert.throws(() => buildListingSearchSql({}, {}), /requires deps\.resolveUserId/);
  assert.equal(assertListingSearchDeps({
    resolveUserId: () => 1,
    getSettings: () => ({}),
    searchWhere: () => {},
    listingVisibilityClauses: () => {},
    appendDistrictCandidates: () => {},
    appendPriceCeilingCandidates: () => {},
    memberRegionDistrictNames: () => [],
  }), true);
});

test("the async hot path keeps the SQLite chain unless postgres is opted into", async () => {
  const { searchListingsAsync } = await import("../src/listingSearchAsync.js");
  const source = readFileSync(path.join(dir, "../src/listingSearchAsync.js"), "utf8");
  assert.match(source, /listListingsSqlFirst\(args\) \|\|/);
  assert.match(source, /listListingsCommuteSqlFirst\(args\) \|\|/);
  assert.match(source, /listListingsFitSqlFirst\(args\) \|\|/);
  assert.match(source, /listListings\(args\)/);
  assert.match(source, /if \(!options\.allowUndecorated\) return searchListingsSqlite\(args\)/);
  assert.equal(typeof searchListingsAsync, "function");
  const server = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  assert.match(server, /await searchListingsAsync\(args, \{/);
  assert.match(server, /PG_LISTINGS_UNDECORATED/);
});
