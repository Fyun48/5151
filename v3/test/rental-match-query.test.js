import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createDemandPost, ensureDemandSchema, setRentalCatalogCache, setRentalMarketplaceFlags, syncDemandMatchDistricts } from "../src/demand.js";
import { defaultCatalog, deleteOrDisableCondition, upsertCondition } from "../src/rentalCatalog.js";
import {
  aggregateDemand,
  attachOwnerMatchSummaries,
  clearRentalMatchCache,
  computeListingMatches,
  explainAggregatePlan,
  explainMatchCandidatePlan,
  ownerListingMatches,
  ownerListingMatchSummary,
  setRentalMatchHydrate,
} from "../src/rentalMatchQuery.js";
import {
  createSelfListing,
  ensureSelfListingSchema,
  listMineSelfListings,
  setSelfListingCatalog,
} from "../src/selfListings.js";

const FLAGS_ON = {
  rental_catalog_v2: { enabled: true },
  wish: { lifecycle_enabled: true, owner_matching_enabled: true },
};

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      nickname TEXT,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE TABLE user_listing_flags (
      user_id INTEGER NOT NULL,
      post_id INTEGER NOT NULL,
      viewed INTEGER NOT NULL DEFAULT 0,
      viewed_at TEXT,
      watched INTEGER NOT NULL DEFAULT 0,
      watched_at TEXT,
      hidden INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, post_id)
    );
    CREATE TABLE listings (
      post_id INTEGER PRIMARY KEY,
      source_key TEXT NOT NULL DEFAULT '',
      search_key TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      price TEXT,
      price_num INTEGER,
      extra_fee INTEGER NOT NULL DEFAULT 0,
      extra_fee_text TEXT,
      price_contain_text TEXT,
      extra_fees TEXT,
      extra_fees_fetched INTEGER NOT NULL DEFAULT 0,
      address TEXT,
      area_name TEXT,
      layout TEXT,
      floor_name TEXT,
      kind_name TEXT,
      role_name TEXT,
      cover TEXT,
      tags TEXT,
      refresh_time TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_event TEXT NOT NULL DEFAULT 'new',
      viewed INTEGER NOT NULL DEFAULT 0,
      watched INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      hidden_at TEXT,
      match_post_id INTEGER,
      match_level TEXT,
      match_detail TEXT,
      match_rejected INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT '591',
      source_id TEXT,
      model_score REAL,
      listed_by_user_id INTEGER,
      self_status TEXT,
      self_expires_at TEXT,
      self_body TEXT,
      contact_name TEXT,
      contact_role TEXT,
      mobile TEXT,
      phone TEXT,
      line_url TEXT,
      contact_fetched INTEGER NOT NULL DEFAULT 0
    );
  `);
  ensureDemandSchema(db);
  ensureSelfListingSchema(db);
  db.prepare("INSERT INTO users(id, email, nickname, created_at) VALUES (1, 'owner@example.com', '屋主', '2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO users(id, email, nickname, created_at) VALUES (2, 'tenant@example.com', '阿花', '2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO users(id, email, nickname, created_at) VALUES (3, 'other@example.com', '路人', '2026-01-01T00:00:00.000Z')").run();
  hydrate(defaultCatalog());
  return db;
}

function hydrate(catalog, flags = FLAGS_ON) {
  setRentalMarketplaceFlags(flags);
  setRentalCatalogCache(catalog);
  setSelfListingCatalog(catalog, flags);
  setRentalMatchHydrate(catalog, flags);
  clearRentalMatchCache();
}

function listingInput(extra = {}) {
  return {
    district: "1-8",
    rent: 22000,
    ping: 18,
    kind: "whole",
    role: "owner",
    floor: 3,
    total_floors: 5,
    rooms: 2,
    living: 1,
    bath: 1,
    contact_name: "林先生",
    address: "中正路100號",
    phone: "0912345678",
    title: "士林整層可看屋",
    body: "近捷運、可入住、有洗衣機。",
    accept_pledge: true,
    traits: ["pet", "cook", "elevator"],
    listing_values: { need_pet: "allowed", need_cook: "allowed", elevator: "present" },
    ...extra,
  };
}

function wishInput(extra = {}) {
  return {
    districts: ["1-8"],
    rent_max: 28000,
    housing_type: "whole",
    layout: "2",
    ping_min: 10,
    body: "士林兩房可開伙找屋",
    choices: { need_pet: "want", need_cook: "want", elevator: "want" },
    ...extra,
  };
}

function addTenant(db, id, email) {
  db.prepare("INSERT INTO users(id, email, nickname, created_at) VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')").run(id, email, `租客${id}`);
}

test("owner listing summary and matches only count eligible active wishes", () => {
  const db = open();
  const listing = createSelfListing(db, 1, listingInput());
  const active = createDemandPost(db, 2, wishInput());
  addTenant(db, 4, "paused@example.com");
  const paused = createDemandPost(db, 4, wishInput({ body: "先暫停的需求" }));
  db.prepare("UPDATE demand_posts SET status='closed', lifecycle='paused' WHERE id=?").run(paused.id);
  addTenant(db, 5, "done@example.com");
  const done = createDemandPost(db, 5, wishInput({ body: "已找到房" }));
  db.prepare("UPDATE demand_posts SET status='closed', lifecycle='completed' WHERE id=?").run(done.id);
  const summary = ownerListingMatchSummary(db, listing.post_id, 1);
  assert.equal(summary.count, 1);
  assert.match(summary.label, /1 個活躍需求/);
  const detail = ownerListingMatches(db, listing.post_id, 1, { limit: 20 });
  assert.equal(detail.total, 1);
  assert.equal(detail.items[0].wish_ref, active.public_token);
  assert.equal("user_id" in detail.items[0], false);
  assert.equal("phone" in detail.items[0], false);
  assert.doesNotMatch(JSON.stringify(detail.items), /0912345678|tenant@example.com|阿花/);
  assert.doesNotMatch(JSON.stringify(detail), /"rank_score"|"freshness_score"|"activity_score"|"wish_id"/);
  db.close();
});

test("other user cannot read owner matches", () => {
  const db = open();
  const listing = createSelfListing(db, 1, listingInput());
  createDemandPost(db, 2, wishInput());
  assert.throws(() => ownerListingMatchSummary(db, listing.post_id, 3), /找不到/);
  assert.throws(() => ownerListingMatches(db, listing.post_id, 3), /找不到/);
  db.close();
});

test("closed listing is not an owner matching source", () => {
  const db = open();
  const listing = createSelfListing(db, 1, listingInput());
  createDemandPost(db, 2, wishInput());
  db.prepare("UPDATE listings SET self_status='closed' WHERE post_id=?").run(listing.post_id);
  clearRentalMatchCache();
  assert.throws(() => ownerListingMatchSummary(db, listing.post_id, 1), /不能配對/);
  db.close();
});

test("paused wish is excluded at query time even if it was a candidate", () => {
  const db = open();
  const listing = createSelfListing(db, 1, listingInput());
  const post = createDemandPost(db, 2, wishInput());
  const first = ownerListingMatchSummary(db, listing.post_id, 1);
  assert.equal(first.count, 1);
  db.prepare("UPDATE demand_posts SET status='closed', lifecycle='paused', updated_at=? WHERE id=?")
    .run(new Date().toISOString(), post.id);
  clearRentalMatchCache();
  const after = ownerListingMatches(db, listing.post_id, 1, { limit: 20 });
  assert.equal(after.total, 0);
  assert.equal(after.items.length, 0);
  db.close();
});

test("needs_confirmation remains matchable; expired/blocked/completed are not", () => {
  const db = open();
  const listing = createSelfListing(db, 1, listingInput());
  const confirm = createDemandPost(db, 2, wishInput());
  db.prepare("UPDATE demand_posts SET lifecycle='needs_confirmation' WHERE id=?").run(confirm.id);
  addTenant(db, 6, "exp@example.com");
  const expired = createDemandPost(db, 6, wishInput({ body: "過期需求" }));
  db.prepare("UPDATE demand_posts SET status='expired', lifecycle='expired' WHERE id=?").run(expired.id);
  addTenant(db, 7, "block@example.com");
  const blocked = createDemandPost(db, 7, wishInput({ body: "封鎖需求" }));
  db.prepare("UPDATE demand_posts SET status='hidden', lifecycle='blocked' WHERE id=?").run(blocked.id);
  clearRentalMatchCache();
  const detail = ownerListingMatches(db, listing.post_id, 1);
  assert.equal(detail.total, 1);
  assert.equal(detail.items[0].wish_ref, confirm.public_token);
  db.close();
});

test("count and paginated detail share one snapshot", () => {
  const db = open();
  const listing = createSelfListing(db, 1, listingInput());
  for (let i = 0; i < 5; i += 1) {
    addTenant(db, 20 + i, `t${i}@example.com`);
    createDemandPost(db, 20 + i, wishInput({ body: `需求 ${i} 找士林兩房` }));
  }
  const summary = ownerListingMatchSummary(db, listing.post_id, 1);
  const page1 = ownerListingMatches(db, listing.post_id, 1, { limit: 2 });
  const page2 = ownerListingMatches(db, listing.post_id, 1, { limit: 2, cursor: page1.next_cursor });
  const page3 = ownerListingMatches(db, listing.post_id, 1, { limit: 2, cursor: page2.next_cursor });
  assert.equal(summary.count, 5);
  assert.equal(page1.total, 5);
  assert.equal(page1.items.length + page2.items.length + page3.items.length, 5);
  const refs = [...page1.items, ...page2.items, ...page3.items].map((row) => row.wish_ref);
  assert.equal(new Set(refs).size, 5);
  db.close();
});

test("disabled catalog condition does not create a new conflict", () => {
  const db = open();
  let catalog = upsertCondition(defaultCatalog(), { label: "烘衣機", category_id: "appliance" });
  const dryer = catalog.conditions.find((row) => row.label === "烘衣機");
  hydrate(catalog);
  const listing = createSelfListing(db, 1, listingInput({
    listing_values: { need_pet: "allowed", need_cook: "allowed", elevator: "present", [dryer.id]: "absent" },
  }));
  createDemandPost(db, 2, wishInput({ choices: { need_pet: "want", [dryer.id]: "want" } }));
  assert.equal(ownerListingMatchSummary(db, listing.post_id, 1).count, 0);
  catalog = deleteOrDisableCondition(catalog, dryer.id, { wish: 1 }).catalog;
  hydrate(catalog);
  assert.equal(ownerListingMatchSummary(db, listing.post_id, 1).count, 1);
  db.close();
});

test("flag off blocks owner matching and aggregate", () => {
  const db = open();
  const listing = createSelfListing(db, 1, listingInput());
  createDemandPost(db, 2, wishInput());
  hydrate(defaultCatalog(), { rental_catalog_v2: { enabled: true }, wish: { owner_matching_enabled: false } });
  assert.throws(() => ownerListingMatchSummary(db, listing.post_id, 1), /尚未開放/);
  assert.throws(() => aggregateDemand(db, {}), /尚未開放/);
  db.close();
});

test("aggregate hides low-sample groups and never returns PII", () => {
  const db = open();
  for (let i = 0; i < 4; i += 1) {
    addTenant(db, 30 + i, `agg${i}@example.com`);
    createDemandPost(db, 30 + i, wishInput({
      districts: i === 3 ? ["1-9"] : ["1-8"],
      body: `統計用需求 ${i}`,
      phone: "0988777666",
      contact_name: "秘密",
    }));
  }
  const agg = aggregateDemand(db, {});
  assert.equal(agg.suppressed, false);
  assert.ok(agg.districts.some((row) => row.id === "1-8" && row.count >= 3));
  assert.ok(!agg.districts.some((row) => row.id === "1-9"));
  assert.doesNotMatch(JSON.stringify(agg), /0988777666|秘密|agg0@example.com/);
  const low = aggregateDemand(db, { districts: ["1-9"] });
  assert.equal(low.suppressed, true);
  assert.match(low.message, /樣本不足/);
  db.close();
});

test("aggregate rejects oversized filter combinations", () => {
  const db = open();
  assert.throws(() => aggregateDemand(db, { districts: ["1-8", "1-9", "3-47", "3-50", "1-1", "1-2", "1-3", "1-4", "1-5"] }), /最多/);
  assert.throws(() => aggregateDemand(db, { drill: "tenant" }), /不支援/);
  db.close();
});

test("owner list summaries use the same matching contract", () => {
  const db = open();
  createSelfListing(db, 1, listingInput());
  createDemandPost(db, 2, wishInput());
  const rows = attachOwnerMatchSummaries(db, listMineSelfListings(db, 1), 1);
  assert.equal(rows[0].match_summary.count, 1);
  db.close();
});

test("candidate query uses match indexes and stays bounded", () => {
  const db = open();
  const listing = createSelfListing(db, 1, listingInput());
  for (let i = 0; i < 80; i += 1) {
    addTenant(db, 100 + i, `bench${i}@example.com`);
    createDemandPost(db, 100 + i, wishInput({
      districts: i % 4 === 0 ? ["3-50"] : ["1-8"],
      body: `大量需求 ${i} 找房條件寫清楚`,
    }));
  }
  const started = Date.now();
  const snap = computeListingMatches(db, {
    id: listing.post_id,
    owner_id: 1,
    status: "open",
    source: "self",
    rent: 22000,
    districts: ["1-8"],
    rooms: 2,
    ping: 18,
    housing_type: "whole",
    listing_values: { need_pet: "allowed", need_cook: "allowed", elevator: "present" },
  });
  const elapsed = Date.now() - started;
  assert.ok(snap.total >= 50);
  assert.ok(elapsed < 1500, `match query took ${elapsed}ms`);
  const plan = explainMatchCandidatePlan(db, { rent: 22000, districts: ["1-8"] });
  const text = JSON.stringify(plan);
  assert.match(text, /idx_demand_match_districts_district|sqlite_autoindex_demand_match_districts/);
  const aggPlan = explainAggregatePlan(db, { districts: ["1-8"] });
  assert.match(JSON.stringify(aggPlan), /idx_demand_match_districts_district|sqlite_autoindex_demand_match_districts/);
  db.close();
});

function bulkWish(db, userId, extra = {}) {
  addTenant(db, userId, `bulk${userId}@example.com`);
  const districts = extra.districts || ["1-8"];
  const token = String(extra.public_token || `tok${userId}`).padEnd(32, "x").slice(0, 32);
  const stamp = extra.last_confirmed_at || "2026-08-01T00:00:00.000Z";
  const result = db.prepare(`
    INSERT INTO demand_posts (
      user_id, districts, rent_max, housing_type, body, status, created_at, expires_at,
      layout, ping_min, lifecycle, public_token, last_confirmed_at, last_active_at,
      updated_at, published_at, condition_choices, must_have
    ) VALUES (?, ?, ?, 'whole', ?, 'open', ?, '9999-12-31T00:00:00.000Z', ?, 10, 'active', ?, ?, ?, ?, ?, ?, '[]')
  `).run(
    userId,
    JSON.stringify(districts),
    extra.rent_max || 28000,
    extra.body || `大量需求 ${userId} 找房條件寫清楚`,
    stamp,
    extra.layout || "2",
    token,
    stamp,
    stamp,
    stamp,
    stamp,
    JSON.stringify(extra.choices || { need_pet: "want", need_cook: "want", elevator: "want" }),
  );
  syncDemandMatchDistricts(db, Number(result.lastInsertRowid));
  return { id: Number(result.lastInsertRowid), public_token: token };
}

test("more than 800 coarse candidates still count all and keep highest rank first", () => {
  const db = open();
  const listing = createSelfListing(db, 1, listingInput());
  let late = null;
  for (let i = 0; i < 801; i += 1) {
    const row = bulkWish(db, 400 + i, {
      last_confirmed_at: i === 800 ? "2026-09-16T07:00:00.000Z" : "2026-07-01T00:00:00.000Z",
      public_token: i === 800 ? "latehighrankwishxxxxxxxxxxxxxx" : undefined,
    });
    if (i === 800) late = row;
  }
  const started = Date.now();
  const summary = ownerListingMatchSummary(db, listing.post_id, 1);
  const page = ownerListingMatches(db, listing.post_id, 1, { limit: 5 });
  const elapsed = Date.now() - started;
  assert.equal(summary.count, 801);
  assert.equal(page.total, 801);
  assert.equal(page.items[0].wish_ref, late.public_token);
  assert.doesNotMatch(JSON.stringify(page), /"rank_score"|"freshness_score"|"activity_score"/);
  assert.ok(elapsed < 5000, `>800 match query took ${elapsed}ms`);
  db.close();
});

test("aggregate scans past 2000 and does not false-suppress later districts", () => {
  const db = open();
  for (let i = 0; i < 2000; i += 1) {
    bulkWish(db, 2000 + i, { districts: ["1-8"], layout: "2" });
  }
  for (let i = 0; i < 5; i += 1) {
    bulkWish(db, 5000 + i, { districts: ["1-9"], layout: "3" });
  }
  const started = Date.now();
  const all = aggregateDemand(db, {});
  const beitou = aggregateDemand(db, { districts: ["1-9"], layout: "3" });
  const elapsed = Date.now() - started;
  assert.equal(all.total, 2005);
  assert.ok(all.districts.some((row) => row.id === "1-9" && row.count === 5));
  assert.equal(beitou.suppressed, false);
  assert.equal(beitou.total, 5);
  assert.ok(beitou.layouts.some((row) => row.id === "3" && row.count === 5));
  assert.ok(elapsed < 8000, `>2000 aggregate took ${elapsed}ms`);
  db.close();
});

test("owner matching uses login view and watch activity signals", () => {
  const db = open();
  const listing = createSelfListing(db, 1, listingInput());
  const quiet = createDemandPost(db, 2, wishInput({ body: "安靜需求找士林兩房" }));
  addTenant(db, 8, "busy@example.com");
  const busy = createDemandPost(db, 8, wishInput({ body: "活躍需求找士林兩房" }));
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = 8").run("2026-09-16T07:30:00.000Z");
  db.prepare("INSERT INTO user_listing_flags(user_id, post_id, viewed, viewed_at, watched, watched_at) VALUES (8, ?, 1, ?, 1, ?)")
    .run(listing.post_id, "2026-09-16T07:10:00.000Z", "2026-09-16T07:20:00.000Z");
  db.prepare("UPDATE demand_posts SET last_confirmed_at = ?, updated_at = ? WHERE id IN (?, ?)")
    .run("2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z", quiet.id, busy.id);
  clearRentalMatchCache();
  const page = ownerListingMatches(db, listing.post_id, 1, { limit: 20 });
  assert.equal(page.total, 2);
  assert.equal(page.items[0].wish_ref, busy.public_token);
  assert.equal(page.items[0].match_score, page.items[1].match_score);
  assert.doesNotMatch(JSON.stringify(page), /"rank_score"|"freshness_score"|"activity_score"|"wish_id"/);
  db.close();
});

test("disabled matching condition is rejected from aggregate filter and distribution", () => {
  const db = open();
  let catalog = upsertCondition(defaultCatalog(), { label: "烘衣機", category_id: "appliance" });
  const dryer = catalog.conditions.find((row) => row.label === "烘衣機");
  hydrate(catalog);
  for (let i = 0; i < 3; i += 1) {
    addTenant(db, 70 + i, `dry${i}@example.com`);
    createDemandPost(db, 70 + i, wishInput({
      body: `烘衣機需求 ${i} 找士林`,
      choices: { need_pet: "want", [dryer.id]: "want" },
    }));
  }
  const before = aggregateDemand(db, { conditions: [dryer.id] });
  assert.equal(before.total, 3);
  assert.ok(before.conditions.some((row) => row.id === dryer.id));
  catalog = deleteOrDisableCondition(catalog, dryer.id, { wish: 3 }).catalog;
  hydrate(catalog);
  assert.throws(() => aggregateDemand(db, { conditions: [dryer.id] }), /不可用於統計/);
  const after = aggregateDemand(db, {});
  assert.ok(!after.conditions.some((row) => row.id === dryer.id));
  db.close();
});

test("matching failure is not disguised as zero demand", () => {
  const db = open();
  const rows = attachOwnerMatchSummaries(db, [{ post_id: 999999, status: "open", title: "幽靈刊登" }], 1);
  assert.equal(rows[0].match_summary.unavailable, true);
  assert.equal(rows[0].match_summary.count, null);
  assert.match(rows[0].match_summary.label, /暫時無法取得/);
  db.close();
});

test("multiple owner listings share one candidate scan", () => {
  const db = open();
  createSelfListing(db, 1, listingInput({ title: "士林 A 可看屋" }));
  createSelfListing(db, 1, listingInput({
    title: "士林 B 可看屋",
    address: "中正路200號",
    idempotency_key: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  }));
  for (let i = 0; i < 30; i += 1) {
    bulkWish(db, 800 + i);
  }
  const started = Date.now();
  const rows = attachOwnerMatchSummaries(db, listMineSelfListings(db, 1), 1);
  const elapsed = Date.now() - started;
  assert.equal(rows.filter((row) => row.status === "open").length, 2);
  assert.ok(rows.every((row) => row.status !== "open" || row.match_summary.count === 30));
  assert.ok(elapsed < 3000, `multi listing summary took ${elapsed}ms`);
  db.close();
});
