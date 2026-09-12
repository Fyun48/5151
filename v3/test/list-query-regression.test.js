import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

function runIsolated(body) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-list-query-regression-"));
  const script = `
    import assert from "node:assert/strict";
    import path from "node:path";
    import { DatabaseSync } from "node:sqlite";
    import * as app from ${JSON.stringify(path.join(dir, "../src/db.js"))};
    const uid = app.defaultUserId();
    const settings = {
      ...app.getSettings(uid), searchUrls: [], watchDistricts: ["1-8"],
      priceMin: 0, priceMax: 0, priceMaxIncludesExtras: true,
      commuteKm: 0, wholeFloorOnly: false,
      excludeLowFloors: false, excludeRooftop: false,
      excludeKeywords: [], excludeAgents: [], excludeAgentIds: [], excludeBoxes: [],
    };
    function seed(post_id, overrides = {}) {
      app.upsertListing({
        post_id, source: "591", source_id: String(post_id),
        source_key: "1|8|" + post_id, search_key: "https://example.test/search",
        title: "合成住宅 " + post_id, url: "https://example.test/listing/" + post_id,
        price: "20000元", price_num: 20000, extra_fees: [],
        address: "台北市士林區測試路" + post_id + "號", area_name: "20坪",
        layout: "2房1廳1衛", floor_name: "5/12", kind_name: "整層住家/電梯大樓",
        role_name: "", cover: "https://example.test/cover.png", tags: "[]",
        refresh_time: "2026-09-01T00:00:00.000Z",
        first_seen_at: "2026-09-01T00:00:00.000Z",
        last_seen_at: "2026-09-01T00:00:00.000Z", last_event: "new",
        ...overrides,
      });
    }
    const query = (extra = {}) => app.listListings({
      userId: uid, settings, searchKeys: [], filter: "all", sort: "newest",
      limit: 50, ...extra,
    });
    const ids = (result) => result.listings.map(row => row.post_id);
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

test("same-source primary uses source identity before and after page hydration", () => {
  runIsolated(`
    seed(710001, { source_id: "zz-property", title: "候選副卡" });
    seed(710002, { source_id: "z-property", title: "候選主卡" });
    app.setListingMatch(710001, { match_post_id: 710002, match_level: "high" });
    app.setListingMatch(710002, { match_post_id: 710001, match_level: "high" });
    const all = query();
    assert.deepEqual(ids(all), [710002]);
    assert.equal(all.totalMatched, 1);
    assert.equal(all.listings[0].source_id, "z-property");
    assert.equal(all.listings[0].same_house_role, "primary");
    assert.equal(all.listings[0].same_house.primary_id, 710002);
    assert.equal(all.listings[0].same_house.is_primary, true);
    // The peer is now outside the initial SQL candidates; its tie-break fields
    // must still agree with a request that included both cards.
    const searched = query({ q: "候選主卡" });
    assert.deepEqual(ids(searched), [710002]);
    assert.equal(searched.listings[0].same_house.primary_id, 710002);
  `);
});

test("every sorted page uses the complete filtered set and preserves fees and detail fields", () => {
  runIsolated(`
    // More than the legacy cap precedes the requested district in storage.
    for (let i = 1; i <= 505; i++) {
      seed(i, { source_key: "3|38|" + i, price: "5000元", price_num: 5000,
        address: "新北市新店區測試路" + i + "號" });
    }
    const stamp = day => "2026-09-0" + day + "T00:00:00.000Z";
    const dated = day => ({ refresh_time: stamp(day), first_seen_at: stamp(day), last_seen_at: stamp(day) });
    seed(720001, { ...dated(1), extra_fee: 5000,
      extra_fees: [{ name: "管理費", value: "另計 5000 元/月", amount: 5000 }] });
    seed(720002, { ...dated(2), price: "22000元", price_num: 22000,
      extra_fees: [{ name: "管理費", value: "租金已含", amount: 2000 }] });
    seed(720003, { ...dated(3), price: "21000元", price_num: 21000,
      extra_fee_text: "管理費另計 1000 元/月" });
    seed(720004, { ...dated(4), price: "18000元", price_num: 18000,
      extra_fees: [{ name: "管理費", value: "另計 3000 元/月", amount: 3000 }] });
    seed(720005, { ...dated(5), price: "面議", price_num: 0 });
    seed(720006, { ...dated(6), price: "30000元", price_num: 30000 });
    const external = new DatabaseSync(path.join(process.env.DATA_DIR, "v3.db"));
    external.prepare("UPDATE listings SET self_body = ?, mobile = ?, has_natural_gas = 1, has_balcony = 1, furnish_items = ? WHERE post_id = ?")
      .run("合成設備說明", "0900000000", JSON.stringify(["冰箱", "洗衣機"]), 720001);
    external.close();
    const priced = { ...settings, priceMax: 27000 };
    const expected = {
      newest: [720005, 720004, 720003, 720002, 720001],
      price_asc: [720004, 720003, 720002, 720001, 720005],
      price_desc: [720001, 720003, 720002, 720004, 720005],
      fit_desc: [720002, 720004, 720003, 720001, 720005],
    };
    for (const [sort, wanted] of Object.entries(expected)) {
      const full = query({ sort, settings: priced });
      assert.deepEqual(ids(full), wanted, sort);
      assert.equal(full.totalMatched, 5, sort);
      const paged = [];
      for (let offset = 0; offset < 5; offset += 2) {
        const page = query({ sort, settings: priced, limit: 2, offset });
        assert.equal(page.totalMatched, 5, sort);
        assert.equal(page.hasMore, offset < 4, sort);
        assert.equal(page.nextOffset, offset + 2, sort);
        paged.push(...ids(page));
        for (const row of page.listings) {
          assert.equal(row.fit_score, full.listings.find(item => item.post_id === row.post_id).fit_score);
        }
      }
      assert.deepEqual(paged, wanted, sort);
      assert.equal(new Set(paged).size, 5, sort);
    }
    const detailed = query({ settings: priced }).listings.find(row => row.post_id === 720001);
    assert.equal(detailed.self_body, "合成設備說明");
    assert.equal(detailed.mobile, "0900000000");
    assert.equal(detailed.has_natural_gas, true);
    assert.equal(detailed.has_balcony, true);
    assert.deepEqual(detailed.furnish_items, ["冰箱", "洗衣機"]);
    assert.equal(detailed.extra_fees[0].amount, 5000);
    assert.equal(detailed.cover, "https://example.test/cover.png");
    assert.equal(app.stats([], uid, priced).total, 5);
  `);
});

test("personal merge, flags and notes stay isolated across alternating list requests", () => {
  runIsolated(`
    const alice = app.ensureUser("alice-query@example.test");
    const bob = app.ensureUser("bob-query@example.test");
    for (let i = 1; i <= 4; i++) seed(730000 + i, { price: String(20000 + i * 1000), price_num: 20000 + i * 1000 });
    assert.equal(app.mergeSameHouseForUser(alice, [730001, 730002]).ok, true);
    app.setFlags(730003, { watched: true, watch_note: "Alice private fixture note" }, alice);
    app.setFlags(730004, { viewed: true, watch_note: "Alice viewed fixture" }, alice);
    app.setFlags(730004, { hidden: true, watch_note: "Bob private fixture note" }, bob);
    for (let repeat = 0; repeat < 2; repeat++) {
      const a = query({ userId: alice, filter: "guest" });
      const b = query({ userId: bob, filter: "guest" });
      assert.deepEqual(ids(a).sort(), [730001, 730003, 730004]);
      assert.deepEqual(ids(b).sort(), [730001, 730002, 730003]);
      const aHouse = a.listings.find(row => row.post_id === 730001);
      assert.equal(aHouse.same_house_personal, true);
      assert.equal(aHouse.same_house.personal_only, true);
      assert.ok(b.listings.every(row => !row.same_house_personal && !row.same_house));
      assert.equal(a.listings.find(row => row.post_id === 730003).watch_note, "Alice private fixture note");
      assert.equal(b.listings.find(row => row.post_id === 730003).watch_note, "");
      assert.equal(b.listings.find(row => row.post_id === 730003).watched, 0);
      assert.ok(!JSON.stringify(a).includes("Bob private fixture note"));
      assert.ok(!JSON.stringify(b).includes("Alice private fixture note"));
      assert.deepEqual(ids(query({ userId: alice, q: "Alice private fixture note", filter: "watched" })), [730003]);
      assert.deepEqual(ids(query({ userId: bob, q: "Alice private fixture note", filter: "guest" })), []);
    }
    const shared = new DatabaseSync(path.join(process.env.DATA_DIR, "v3.db"));
    const stored = shared.prepare("SELECT viewed, watched, hidden, watch_note FROM listings WHERE post_id IN (730003, 730004)").all();
    assert.ok(stored.every(row => !row.viewed && !row.watched && !row.hidden && !row.watch_note));
    shared.close();
  `);
});

test("stats cache keys include profile overrides and invalidate for both database writers", () => {
  runIsolated(`
    const alice = app.ensureUser("alice-stats@example.test");
    const bob = app.ensureUser("bob-stats@example.test");
    seed(740001, { price: "10000元", price_num: 10000 });
    seed(740002, { price: "20000元", price_num: 20000 });
    const narrow = { ...settings, priceMax: 12000 };
    const wide = { ...settings, priceMax: 25000 };
    app.holdStatsCache(20000);
    assert.equal(app.stats([], alice, narrow).total, 1);
    assert.equal(app.stats([], alice, wide).total, 2);
    assert.equal(app.stats([], alice, narrow).total, 1);
    app.setFlags(740002, { watched: true }, alice);
    const a = app.stats([], alice, wide);
    const b = app.stats([], bob, wide);
    assert.equal(a.total, 1);
    assert.equal(a.watched, 1);
    assert.equal(b.total, 2);
    assert.equal(b.watched, 0);
    assert.equal(app.stats([], alice, wide).watched, 1);
    // A separate connection models the operational repair/import writer.
    const external = new DatabaseSync(path.join(process.env.DATA_DIR, "v3.db"));
    external.prepare("UPDATE listings SET price_num = 30000, price = '30000元' WHERE post_id = ?").run(740001);
    assert.equal(app.stats([], alice, wide).total, 0);
    assert.equal(app.stats([], bob, wide).total, 1);
    external.close();
  `);
});

test("list and stats remain read-only under another writer's lock and exclude expired self listings", () => {
  runIsolated(`
    seed(750001);
    seed(2100000001, { source: "self", title: "Expired self fixture" });
    seed(2100000002, { source: "self", title: "Open self fixture" });
    const external = new DatabaseSync(path.join(process.env.DATA_DIR, "v3.db"));
    const updateSelf = external.prepare("UPDATE listings SET listed_by_user_id = ?, self_status = 'open', self_expires_at = ? WHERE post_id = ?");
    updateSelf.run(uid, new Date(Date.now() - 86400000).toISOString(), 2100000001);
    updateSelf.run(uid, new Date(Date.now() + 86400000).toISOString(), 2100000002);
    const versionBefore = external.prepare("PRAGMA data_version").get().data_version;
    external.exec("BEGIN IMMEDIATE");
    try {
      external.prepare("UPDATE listings SET title = 'Uncommitted writer title' WHERE post_id = ?").run(750001);
      const started = performance.now();
      const listed = query();
      const counted = app.stats([], uid, settings);
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 1000, "list + stats waited for writer lock: " + elapsed + "ms");
      assert.deepEqual(ids(listed).sort((a, b) => a - b), [750001, 2100000002]);
      assert.equal(listed.totalMatched, 2);
      assert.equal(counted.total, 2);
      assert.equal(listed.listings.find(row => row.post_id === 750001).title, "合成住宅 750001");
    } finally {
      external.exec("ROLLBACK");
    }
    assert.equal(external.prepare("PRAGMA data_version").get().data_version, versionBefore);
    assert.equal(external.prepare("SELECT self_status FROM listings WHERE post_id = ?").get(2100000001).self_status, "open");
    external.close();
  `);
});

test("district candidates preserve legacy keys, address fallback, and explicit district selection", () => {
  runIsolated(`
    seed(760001, { source_key: "3|34|foreign", address: "台北市士林區測試路1號" });
    seed(760002, { source_key: "", address: "士林中正路2號" });
    seed(760003, { source_key: "01|8", address: "地址待補" });
    seed(760004, { source_key: "1|8", address: "地址待補" });
    seed(760005, { source_key: "legacy", address: "新北市新店區測試路5號" });
    assert.deepEqual(ids(query()).sort(), [760002, 760003, 760004]);
    assert.equal(app.stats([], uid, settings).total, 3);
    assert.deepEqual(ids(query({ districts: ["新店區"] })).sort(), [760001, 760005]);
    assert.equal(query({ settings: { ...settings, watchDistricts: [], searchUrls: [] } }).totalMatched, 5);
  `);
});

test("district narrowing preserves shared-pool offline counters", () => {
  runIsolated(`
    seed(770001);
    seed(770002, { source_key: "3|34|foreign", address: "新北市新店區測試路2號" });
    seed(770003, { source_key: "3|34|foreign2", address: "新北市新店區測試路3號" });
    const external = new DatabaseSync(path.join(process.env.DATA_DIR, "v3.db"));
    external.exec("UPDATE listings SET offline = 1 WHERE post_id IN (770002, 770003)");
    external.exec("UPDATE listings SET offline_confirmed = 1 WHERE post_id = 770003");
    external.close();
    const counted = app.stats([], uid, settings);
    assert.equal(counted.total, 1);
    assert.equal(counted.offline, 1);
    assert.equal(counted.offlineConfirmed, 1);
  `);
});

test("a one-sided match in another district still assigns the local affiliate role", () => {
  runIsolated(`
    seed(780001, { source_id: "zz-property" });
    seed(780002, { source_id: "z-property", source_key: "3|34|foreign",
      address: "新北市新店區測試路2號" });
    app.setListingMatch(780002, { match_post_id: 780001, match_level: "high" });
    assert.equal(query().totalMatched, 0);
    assert.deepEqual(ids(query({ districts: ["新店區"] })), [780002]);
  `);
});

test("cross-district personal ranking keeps viewer flags while excluding unrelated match pairs", () => {
  runIsolated(`
    const alice = app.ensureUser("alice-related@example.test");
    const bob = app.ensureUser("bob-related@example.test");
    seed(790001, { price: "30000元", price_num: 30000 });
    seed(790002, { price: "20000元", price_num: 20000, source_key: "3|34|foreign",
      address: "新北市新店區測試路2號" });
    seed(790003, { source_key: "3|34|unrelated", address: "新北市新店區測試路3號" });
    seed(790004, { source_key: "3|34|unrelated", address: "新北市新店區測試路4號" });
    app.setListingMatch(790003, { match_post_id: 790004, match_level: "high" });
    app.setListingMatch(790004, { match_post_id: 790003, match_level: "high" });
    assert.equal(app.mergeSameHouseForUser(alice, [790001, 790002]).ok, true);
    // A foreign primary still suppresses its local affiliate for Alice only.
    const merged = query({ userId: alice });
    assert.deepEqual(ids(merged), []);
    assert.equal(merged.queryDetails.candidates, 2);
    const independent = query({ userId: bob });
    assert.deepEqual(ids(independent), [790001]);
    assert.equal(independent.queryDetails.candidates, 1);
    for (const [key, value] of Object.entries(independent.queryDetails)) {
      assert.ok(Number.isFinite(value) && value >= 0, key);
    }
    app.setFlags(790002, { hidden: true, watch_note: "Alice only" }, alice);
    // An excluded peer is resolved using the same existing primary rules;
    // its private note must never become Bob's card data.
    assert.deepEqual(ids(query({ userId: alice, filter: "hidden", districts: ["新店區"] })), [790002]);
    assert.ok(!JSON.stringify(query({ userId: bob })).includes("Alice only"));
  `);
});
