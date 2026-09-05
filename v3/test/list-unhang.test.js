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
    assert.ok(out.totalMatched >= 80, JSON.stringify(out));
    assert.equal(out.returned, 5);
    assert.ok(out.withHouse >= 1, JSON.stringify(out));
    assert.ok(out.ms < 1500, `listListings took ${out.ms}ms`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

