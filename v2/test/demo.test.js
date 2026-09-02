import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publicPath } from "../src/auth.js";
import {
  buildDemoState,
  DEMO_COMMUTE_KM,
  DEMO_COMMUTE_MODE,
  DEMO_WORK_ADDRESS,
  demoSourceUserId,
  GUEST_LIST_LIMIT,
  publicDemoSettings,
} from "../src/demo.js";
import { assertDemoReadable, resetAuthRateLimits } from "../src/rateLimit.js";

test("demo source prefers a member who has commute and districts", () => {
  const settings = {
    1: { watchDistricts: ["1-8"], commuteKm: 13, workLat: 25.1, workLng: 121.5 },
    2: { watchDistricts: ["1-5"] },
  };
  assert.equal(
    demoSourceUserId({
      listUserIds: () => [2, 1],
      getSettings: (id) => settings[id],
      defaultUserId: () => 99,
    }),
    1,
  );
  assert.equal(
    demoSourceUserId({
      listUserIds: () => [2],
      getSettings: (id) => settings[id],
      defaultUserId: () => 99,
    }),
    2,
  );
  assert.equal(
    demoSourceUserId({
      listUserIds: () => [],
      getSettings: () => ({}),
      defaultUserId: () => 99,
    }),
    99,
  );
});

test("public demo settings strip webhooks and exclusion lists", () => {
  const pub = publicDemoSettings({
    watchDistricts: ["1-8", "1-5"],
    priceMax: 28000,
    commuteKm: 13,
    commuteMode: "car",
    workAddress: "台北市士林區德行西路7號",
    workLat: 25.1,
    workLng: 121.5,
    discordWebhook: "https://discord.com/api/webhooks/secret",
    excludeKeywords: ["頂加"],
    excludeAgents: ["某房仲"],
    excludeBoxes: [{ north: 1, south: 0, east: 1, west: 0 }],
    settingProfiles: [{ id: "p-1", name: "上班", data: { discordWebhook: "x" } }],
    activeProfileId: "p-1",
  });
  assert.deepEqual(pub.watchDistricts, ["1-8", "1-5"]);
  assert.equal(pub.workAddress, DEMO_WORK_ADDRESS);
  assert.equal(pub.commuteKm, DEMO_COMMUTE_KM);
  assert.equal(pub.commuteMode, DEMO_COMMUTE_MODE);
  assert.equal(pub.showMrt, true);
  assert.deepEqual(pub.excludeKeywords, []);
  assert.deepEqual(pub.excludeAgents, []);
  assert.deepEqual(pub.excludeBoxes, []);
  assert.equal(pub.discordWebhook, "");
  assert.deepEqual(pub.settingProfiles, []);
  assert.equal(pub.activeProfileId, "");
  assert.equal(JSON.stringify(pub).includes("webhook/secret"), false);
});

test("buildDemoState is read-only and caps the guest list", () => {
  const listed = {
    listings: Array.from({ length: 3 }, (_, i) => ({ post_id: i + 1, title: `demo ${i + 1}` })),
    totalMatched: 80,
  };
  const calls = [];
  const state = buildDemoState({
    listUserIds: () => [7],
    getSettings: (id) => {
      calls.push(["settings", id]);
      return { watchDistricts: ["1-8"], commuteKm: 10, workLat: 25, workLng: 121, discordWebhook: "secret" };
    },
    defaultUserId: () => 1,
    listListings: (query) => {
      calls.push(["list", query]);
      return listed;
    },
    stats: (scope, uid) => {
      calls.push(["stats", scope, uid]);
      return { total: 80 };
    },
  });
  assert.equal(state.guest, true);
  assert.equal(state.listings.length, 3);
  assert.equal(state.stats.matched, 80);
  assert.equal(state.stats.shown, 3);
  assert.equal(state.settings.discordWebhook, "");
  assert.equal(calls.some((row) => row[0] === "list" && row[1].filter === "guest" && row[1].limit === GUEST_LIST_LIMIT && row[1].userId === 7 && Array.isArray(row[1].searchKeys) && row[1].searchKeys.length === 0), true);
  assert.deepEqual(calls.find((row) => row[0] === "list")[1].districts, ["士林區"]);
  assert.equal(calls.some((row) => row[0] === "stats" && row[2] === 7), true);
  const listQuery = calls.find((row) => row[0] === "list")[1];
  assert.equal(listQuery.settings.workAddress, DEMO_WORK_ADDRESS);
  assert.equal(listQuery.settings.commuteKm, DEMO_COMMUTE_KM);
  assert.equal(listQuery.settings.commuteMode, DEMO_COMMUTE_MODE);
});

test("guest commute template ignores the source member work address", () => {
  const member = {
    watchDistricts: ["1-8"],
    workAddress: "台北市士林區德行西路7號",
    commuteKm: 13,
    commuteMode: "car",
    workLat: 25.106,
    workLng: 121.524,
    settingProfiles: [{ id: "p-1", name: "士林北投" }],
    activeProfileId: "p-1",
  };
  const pub = publicDemoSettings(member);
  assert.equal(pub.workAddress, DEMO_WORK_ADDRESS);
  assert.equal(pub.commuteKm, DEMO_COMMUTE_KM);
  assert.equal(pub.commuteMode, DEMO_COMMUTE_MODE);
  assert.deepEqual(pub.settingProfiles, []);
  const listed = [];
  const state = buildDemoState({
    listUserIds: () => [1],
    getSettings: () => member,
    defaultUserId: () => 1,
    listListings: (query) => {
      listed.push(query);
      return { listings: [], totalMatched: 0 };
    },
  });
  assert.equal(state.settings.workAddress, DEMO_WORK_ADDRESS);
  assert.equal(state.settings.commuteKm, DEMO_COMMUTE_KM);
  assert.equal(listed[0].settings.workAddress, DEMO_WORK_ADDRESS);
  assert.notEqual(listed[0].settings.workAddress, member.workAddress);
  assert.equal(listed[0].settings.commuteKm, DEMO_COMMUTE_KM);
  assert.notEqual(listed[0].settings.commuteKm, member.commuteKm);
});

test("demo API is a public path and is rate-limited per IP", () => {
  assert.equal(publicPath({ path: "/api/demo" }), true);
  assert.equal(publicPath({ path: "/" }), true);
  assert.equal(publicPath({ path: "/api/listings" }), false);
  assert.equal(publicPath({ path: "/api/settings" }), false);
  resetAuthRateLimits();
  for (let i = 0; i < 40; i++) assertDemoReadable("1.2.3.4", 5_000);
  assert.throws(() => assertDemoReadable("1.2.3.4", 5_001), /示範列表讀太多次/);
  assert.doesNotThrow(() => assertDemoReadable("8.8.8.8", 5_001));
});

test("guest listing links do not mark viewed on /go", () => {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/server.js"), "utf8");
  const go = src.slice(src.indexOf('app.get("/go/:id"'), src.indexOf("app.use(\"/vendor\""));
  assert.match(go, /readSession\(req\)/);
  assert.match(go, /session\?\.userId/);
  assert.doesNotMatch(go, /actorUserId\(req\)/);
  assert.match(src, /app.get\("\/api\/demo"/);
  assert.match(src, /assertDemoReadable/);
  assert.match(src, /buildDemoState/);
});
