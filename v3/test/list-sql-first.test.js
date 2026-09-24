import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

// 隔離子程序在 CI（Gitea runner：CPU 較慢且 node --test 會並行多個檔案）上可能遠超過 30s；
// 這是環境時序而非程式錯誤，因此只保留防卡死的寬鬆上限，可用 V3_ISOLATED_TEST_TIMEOUT_MS 覆寫。
const ISOLATED_TIMEOUT_MS = Math.max(30_000, Number(process.env.V3_ISOLATED_TEST_TIMEOUT_MS) || 180_000);
const dbUrl = JSON.stringify(pathToFileURL(path.join(dir, "../src/db.js")).href);

function runIsolated(body) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-sqlfirst-"));
  const script = `
    import assert from "node:assert/strict";
    import * as app from ${dbUrl};
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
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("sql-first returns identical id set/order to listListings for newest/price sorts", () => {
  runIsolated(`
    for (let i = 1; i <= 120; i++) {
      const inScope = i % 3 !== 0;
      const stamp = new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString();
      seed(i, {
        source_key: (inScope ? "1|8|" : "1|9|") + i,
        address: (inScope ? "台北市士林區" : "台北市北投區") + "測試路" + i + "號",
        price_num: 12000 + (i * 137) % 48000,
        price: (12000 + (i * 137) % 48000) + "元",
        extra_fee: i % 4 === 0 ? 2000 : 0,
        first_seen_at: stamp,
        last_seen_at: stamp,
        refresh_time: stamp,
      });
    }
    for (const sort of ["newest", "price_asc", "price_desc"]) {
      const base = { userId: uid, searchKeys: [], settings, sort, limit: 50 };
      const old = app.listListings(base);
      const neo = app.listListingsSqlFirst(base);
      assert.ok(neo, "sql-first should be supported for " + sort);
      assert.deepEqual(
        neo.listings.map(r => r.post_id),
        old.listings.map(r => r.post_id),
        "order mismatch for " + sort,
      );
      assert.equal(neo.totalMatched, old.totalMatched, "total mismatch for " + sort);
      assert.equal(neo.hasMore, old.hasMore);
    }
    // pagination: offset page must match too
    for (const sort of ["newest", "price_asc"]) {
      const base = { userId: uid, searchKeys: [], settings, sort, limit: 20, offset: 20 };
      assert.deepEqual(
        app.listListingsSqlFirst(base).listings.map(r => r.post_id),
        app.listListings(base).listings.map(r => r.post_id),
      );
    }
  `);
});

test("sql-first falls back (null) outside its envelope", () => {
  runIsolated(`
    seed(1);
    seed(2);
    const base = { userId: uid, searchKeys: [], settings, sort: "newest", limit: 20 };
    // commute sort is not supported by the SQL-first path yet
    assert.equal(app.listListingsSqlFirst({ ...base, sort: "commute_asc" }), null);
    assert.equal(app.listListingsSqlFirst({ ...base, filter: "watched" }), null);
    // q 已於 F3 下推（lower(x) LIKE lower(?) 統一兩 driver 的 LIKE 語意；實測 6 案一致 + 端到端 8 案一致）
    assert.notEqual(app.listListingsSqlFirst({ ...base, q: "某關鍵字" }), null, "q 應已在 envelope 內");
    assert.equal(
      app.listListingsSqlFirst({ ...base, settings: { ...settings, priceMax: 25000 } }),
      null,
    );
  `);
});

test("cursor/keyset pagination pages through all sorts without gaps or overlap", () => {
  runIsolated(`
    for (let i = 1; i <= 55; i++) {
      const stamp = new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString();
      seed(i, {
        first_seen_at: stamp, last_seen_at: stamp, refresh_time: stamp,
        price_num: 12000 + (i * 137) % 48000,
        price: (12000 + (i * 137) % 48000) + "元",
      });
    }
    for (const sort of ["newest", "price_asc", "price_desc"]) {
      const base = { userId: uid, searchKeys: [], settings, sort, limit: 10 };

      // Reference: full ordered ids via offset pagination.
      const full = app.listListingsSqlFirst({ ...base, limit: 500 }).listings.map(r => r.post_id);

      // Page through using nextCursor.
      const collected = [];
      let cursor = null;
      let pages = 0;
      while (true) {
        const result = cursor == null
          ? app.listListingsSqlFirst(base)
          : app.listListingsSqlFirst({ ...base, cursor });
        assert.ok(result, "cursor page should be supported for " + sort);
        collected.push(...result.listings.map(r => r.post_id));
        pages += 1;
        if (!result.hasMore) break;
        assert.ok(result.nextCursor, "hasMore implies a nextCursor for " + sort);
        cursor = result.nextCursor;
        assert.ok(pages < 20, "should not loop forever");
      }

      assert.deepEqual(collected, full, "order/gap mismatch for " + sort);
      assert.equal(collected.length, new Set(collected).size, "no duplicate ids for " + sort);
    }
  `);
});
