import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

function runIsolated(body) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-admin-house-"));
  const script = `
    import assert from "node:assert/strict";
    import * as app from ${JSON.stringify(path.join(dir, "../src/db.js"))};
    function seed(post_id, overrides = {}) {
      app.upsertListing({
        post_id, source: overrides.source || "591", source_id: String(post_id),
        source_key: "1|8|" + post_id, search_key: "https://example.test/search",
        title: "合成住宅 " + post_id, url: "https://example.test/" + post_id,
        price: "20000元", price_num: 20000, extra_fees: [],
        address: "台北市士林區測試路" + post_id + "號", area_name: "20坪",
        layout: "2房1廳", floor_name: "5/12", kind_name: "整層住家/電梯大樓",
        role_name: "", cover: "", tags: "[]",
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
      timeout: 30_000,
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("E: admin confirm writes a shared group visible to every user", () => {
  runIsolated(`
    const admin = app.defaultUserId();
    const alice = app.ensureUser("alice-admin-house@example.test");
    seed(901);
    seed(902);
    app.setListingMatch(901, { match_post_id: 902, match_level: "medium", match_detail: "嫌疑" });
    const result = app.confirmSuspectedMatch(901, admin, { admin: true });
    assert.equal(result.ok, true);
    assert.equal(result.shared, true);
    assert.equal(result.personal, false);
    assert.equal(result.admin_confirmed, true);
    assert.match(result.group_id, /^lg_/);
    const aliceList = app.listListings({ userId: alice, settings: app.getSettings(alice), searchKeys: [], filter: "all", sort: "newest", limit: 50 });
    const card = aliceList.listings.find((row) => row.post_id === 901 || row.same_house?.primary_id === 901 || row.same_house?.primary_id === 902);
    assert.ok(card, "alice should see the shared grouping");
    const member = app.mergeSameHouseForUser(alice, [901, 902]);
    assert.equal(member.shared, false);
    const status = app.sameHouseBackfillStatus();
    assert.equal(typeof status.cursor, "number");
    assert.equal(status.batch, 50);
  `);
});

test("F: member merge stays personal and does not mark shared", () => {
  runIsolated(`
    const alice = app.ensureUser("alice-personal-house@example.test");
    const bob = app.ensureUser("bob-personal-house@example.test");
    seed(911);
    seed(912);
    const result = app.mergeSameHouseForUser(alice, [911, 912]);
    assert.equal(result.ok, true);
    assert.equal(result.personal, true);
    assert.equal(result.shared, false);
    const bobList = app.listListings({ userId: bob, settings: app.getSettings(bob), searchKeys: [], filter: "all", sort: "newest", limit: 50 });
    assert.ok(bobList.listings.every((row) => !row.same_house_personal));
  `);
});
