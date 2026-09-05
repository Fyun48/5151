import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

test("watcher classify/geo paths skip same-house decorate", () => {
  const src = readFileSync(path.join(dir, "../src/watcher.js"), "utf8");
  assert.match(src, /function listingForWatch\(/);
  assert.match(src, /getListing\(postId, userId, \{ sameHouse: false \}\)/);
  assert.doesNotMatch(src.replace(/function listingForWatch[\s\S]*?\n\}/, ""), /getListing\(/);
});

test("startup tick no longer starts geo backfill in parallel", () => {
  const src = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  const listen = src.slice(src.indexOf("app.listen"));
  const jobsThen = listen.slice(listen.indexOf("if (!jobs.length)"), listen.indexOf(".catch((error)"));
  assert.match(jobsThen, /return tick\("startup"\)/);
  assert.ok(jobsThen.indexOf('tick("startup")') < jobsThen.lastIndexOf("queueGeoBackfill()"));
  assert.match(src, /if \(reason !== "startup"\) queueGeoBackfill\(\)/);
});

test("listListings attaches same-house only on the returned page", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-unhang-"));
  const script = `
    import { listListings, upsertListing, setListingMatch } from ${JSON.stringify(path.join(dir, "../src/db.js"))};
    const stamp = "2026-09-05T00:00:00.000Z";
    for (let i = 1; i <= 80; i += 1) {
      upsertListing({
        post_id: 900000 + i,
        source_key: "1|1",
        search_key: "https://example.test",
        title: "士林整層 " + i,
        url: "https://rent.591.com.tw/" + (900000 + i),
        price: "20000元",
        price_num: 20000,
        extra_fees: [],
        address: "台北市士林區中山北路六段" + i + "號",
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
      });
    }
    setListingMatch(900080, { match_post_id: 900079, match_level: "high", match_detail: "同屋源" });
    setListingMatch(900079, { match_post_id: 900080, match_level: "high", match_detail: "同屋源" });
    const t0 = Date.now();
    const listed = listListings({ filter: "guest", sort: "newest", limit: 5 });
    const ms = Date.now() - t0;
    const page = listed.listings || [];
    const withHouse = page.filter((row) => row.same_house);
    console.log(JSON.stringify({
      totalMatched: listed.totalMatched,
      returned: page.length,
      withHouse: withHouse.length,
      firstHasPeer: Boolean(page[0]?.match_peer || page[0]?.same_house),
      ms,
    }));
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const line = result.stdout.trim().split("\n").filter((row) => row.startsWith("{")).at(-1);
    const out = JSON.parse(line);
    assert.ok(out.totalMatched >= 79, JSON.stringify(out));
    assert.ok(out.totalMatched <= 80, JSON.stringify(out));
    assert.equal(out.returned, 5);
    assert.ok(out.withHouse >= 1, JSON.stringify(out));
    assert.ok(out.ms < 1500, `listListings took ${out.ms}ms`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("index and login HTML are sent from memory and list APIs yield first", () => {
  const src = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  assert.match(src, /const INDEX_HTML = readFileSync/);
  assert.match(src, /const LOGIN_HTML = readFileSync/);
  assert.match(src, /function sendHtmlBuffer/);
  assert.match(src, /function yieldEventLoop/);
  assert.match(src, /sendHtmlBuffer\(res, INDEX_HTML\)/);
  assert.match(src, /sendHtmlBuffer\(res, LOGIN_HTML\)/);
  assert.match(src, /app.get\("\/api\/demo", async \(req, res\) => \{\s*await yieldEventLoop\(\);/s);
  assert.match(src, /app.get\("\/api\/state", async \(req, res\) => \{\s*await yieldEventLoop\(\);/s);
  assert.match(src, /app.get\("\/api\/listings", async \(req, res\) => \{\s*await yieldEventLoop\(\);/s);
  const root = src.slice(src.indexOf('app.get("/",'), src.indexOf('app.get("/api/demo"'));
  assert.doesNotMatch(root, /sendFile/);
});

test("commute list plus stats stay under 1.5s on a 2000-row route cache", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-unhang-commute-"));
  const script = `
    import {
      defaultUserId,
      listListings,
      setCachedRoute,
      stats,
      upsertListing,
    } from ${JSON.stringify(path.join(dir, "../src/db.js"))};
    import { applyDemoCommute, DEMO_COMMUTE_MODE, DEMO_WORK_LAT, DEMO_WORK_LNG } from ${JSON.stringify(path.join(dir, "../src/demo.js"))};
    const stamp = "2026-09-05T00:00:00.000Z";
    const settings = applyDemoCommute({});
    for (let i = 1; i <= 2000; i += 1) {
      const lat = 25.03 + (i % 80) * 0.001;
      const lng = 121.52 + Math.floor(i / 80) * 0.001;
      upsertListing({
        post_id: 800000 + i,
        source_key: "1|1",
        search_key: "https://example.test",
        title: "通勤測試 " + i,
        url: "https://rent.591.com.tw/" + (800000 + i),
        price: "22000元",
        price_num: 22000,
        extra_fees: [],
        address: "台北市士林區中山北路六段" + i + "號",
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
        lat,
        lng,
        geo_source: "591",
      });
      setCachedRoute(lat, lng, DEMO_WORK_LAT, DEMO_WORK_LNG, [6 + (i % 8)], null, DEMO_COMMUTE_MODE);
    }
    const t0 = Date.now();
    const listed = listListings({
      filter: "guest",
      sort: "newest",
      limit: 30,
      settings,
      matchVoteUserId: 0,
    });
    const firstStats = stats(undefined, defaultUserId(), settings);
    const ms = Date.now() - t0;
    const t1 = Date.now();
    const secondStats = stats(undefined, defaultUserId(), settings);
    const cachedMs = Date.now() - t1;
    console.log(JSON.stringify({
      totalMatched: listed.totalMatched,
      returned: (listed.listings || []).length,
      stored: firstStats.stored,
      cachedStored: secondStats.stored,
      hasCommute: Number.isFinite(Number(listed.listings?.[0]?.commute_km)),
      ms,
      cachedMs,
    }));
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const line = result.stdout.trim().split("\n").filter((row) => row.startsWith("{")).at(-1);
    const out = JSON.parse(line);
    assert.equal(out.totalMatched, 2000, JSON.stringify(out));
    assert.equal(out.returned, 30);
    assert.equal(out.stored, 2000);
    assert.equal(out.cachedStored, 2000);
    assert.equal(out.hasCommute, true);
    assert.ok(out.ms < 1500, `list+stats took ${out.ms}ms`);
    assert.ok(out.cachedMs < 50, `cached stats took ${out.cachedMs}ms`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

