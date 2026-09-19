import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  addDemandReply,
  applyWishLifecycleAction,
  collectWishActivitySignals,
  createDemandPost,
  ensureDemandSchema,
  expireOpenPosts,
  getDemandPost,
  listDemandPosts,
  migrateOpenWishesOnActivation,
  publicWishRoomView,
  publishWishRoom,
  setRentalCatalogCache,
  setRentalMarketplaceFlags,
  updateWishRoom,
} from "../src/demand.js";
import { activityScoreFromSignals, ttlExpiresAt } from "../src/wishLifecycle.js";
import { defaultCatalog, deleteOrDisableCondition, upsertCondition } from "../src/rentalCatalog.js";
import { listingFitScore } from "../src/listingScore.js";
import { preferPrimaryListing } from "../src/match.js";
import { publicRentalMarketplaceFlags } from "../src/rentalMarketplaceFlags.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      nickname TEXT,
      created_at TEXT NOT NULL
    );
  `);
  ensureDemandSchema(db);
  db.prepare("INSERT INTO users(id, email, nickname, created_at) VALUES (1, 'a@example.com', '阿花', '2026-01-01T00:00:00.000Z')").run();
  return db;
}

function sample(extra = {}) {
  return {
    districts: ["1-8"],
    rent_max: 28000,
    housing_type: "whole",
    layout: "2",
    body: "士林兩房可開伙找屋",
    must_have: ["need_cook"],
    ...extra,
  };
}

test("public projection drops PII and uses opaque token path", () => {
  const db = open();
  const post = createDemandPost(db, 1, sample({ phone: "0912345678", contact_name: "阿花", line_url: "https://line.me/ti/p/x" }));
  assert.equal(post.contact.phone, "0912345678");
  assert.ok(post.public_token);
  assert.match(post.public_path, /^\/w\/[a-f0-9]{32}$/);
  const pub = listDemandPosts(db)[0];
  assert.equal("author" in pub, false);
  assert.equal("contact" in pub, false);
  assert.doesNotMatch(JSON.stringify(pub), /0912345678|line\.me|阿花@|a@example.com/);
  const byToken = getDemandPost(db, post.public_token, { publicOnly: true });
  assert.equal(byToken.id, post.id);
  assert.equal("contact" in byToken, false);
  db.close();
});

test("lifecycle flag off blocks new actions; on uses real TTL and complete", () => {
  const db = open();
  setRentalMarketplaceFlags({ wish: { lifecycle_enabled: false } });
  const post = createDemandPost(db, 1, { ...sample(), draft: true });
  assert.throws(() => applyWishLifecycleAction(db, 1, post.id, "extend"), /尚未啟用/);
  setRentalMarketplaceFlags({ wish: { lifecycle_enabled: true } });
  const published = publishWishRoom(db, 1, post.id);
  assert.equal(published.id, post.id);
  assert.equal(published.expires_at.startsWith("9999"), false);
  const done = applyWishLifecycleAction(db, 1, published.id, "complete");
  assert.equal(done.lifecycle, "completed");
  assert.throws(() => applyWishLifecycleAction(db, 1, post.id, "resume"), /另開新的/);
  const inactive = getDemandPost(db, post.public_token, { publicOnly: true });
  assert.equal(inactive.inactive, true);
  assert.equal(inactive.noindex, true);
  setRentalMarketplaceFlags({});
  db.close();
});

test("blocked wish cannot self-resume", () => {
  const db = open();
  setRentalMarketplaceFlags({ wish: { lifecycle_enabled: true } });
  const post = createDemandPost(db, 1, sample());
  db.prepare("UPDATE demand_posts SET status='hidden', lifecycle='blocked' WHERE id=?").run(post.id);
  assert.throws(() => applyWishLifecycleAction(db, 1, post.id, "resume"), /封鎖/);
  setRentalMarketplaceFlags({});
  db.close();
});

test("publicWishRoomView never reintroduces contact or author", () => {
  const view = publicWishRoomView({
    id: 1,
    author: "阿花",
    contact: { phone: "0912", contact_name: "x", line_url: "y" },
    city: "台北市",
    districts: [],
    district_labels: ["士林區"],
    must_have: [],
    nice_to_have: [],
    avoid: [],
    replies: [],
    body: "找房",
    status: "open",
  });
  assert.equal("author" in view, false);
  assert.equal("contact" in view, false);
  assert.equal("location_note" in view, false);
  assert.equal("destination_note" in view, false);
  assert.equal("replies" in view, false);
  assert.equal(view.headline, "租屋需求");
  assert.equal(view.label_want, "必須有");
  assert.equal(view.label_nice, "希望有");
});

test("catalog v2 persists choices and does not upgrade leftover nice_to_have", () => {
  const db = open();
  setRentalMarketplaceFlags({ rental_catalog_v2: { enabled: true } });
  setRentalCatalogCache(defaultCatalog());
  const post = createDemandPost(db, 1, sample({
    must_have: ["need_cook"],
    nice_to_have: ["fridge"],
    avoid: ["parking_car"],
    choices: { need_cook: "want", fridge: "unspecified", parking_car: "avoid" },
  }));
  assert.equal(post.choices.need_cook, "want");
  assert.equal(post.choices.fridge, undefined);
  assert.equal(post.choices.parking_car, "avoid");
  assert.ok(post.nice_to_have.includes("fridge") || post.must_have.includes("need_cook"));
  const stored = db.prepare("SELECT condition_choices FROM demand_posts WHERE id = ?").get(post.id);
  assert.match(String(stored.condition_choices || ""), /need_cook/);
  setRentalMarketplaceFlags({});
  setRentalCatalogCache(null);
  db.close();
});

test("new wish public API is token-only; legacy numeric still resolves", () => {
  const db = open();
  const post = createDemandPost(db, 1, sample());
  assert.equal(Number(db.prepare("SELECT legacy_numeric_share FROM demand_posts WHERE id = ?").get(post.id).legacy_numeric_share), 0);
  assert.throws(() => getDemandPost(db, String(post.id), { publicOnly: true }), /找不到/);
  assert.throws(() => getDemandPost(db, String(post.id), { viewerId: 0 }), /找不到/);
  db.prepare("INSERT INTO users(id, email, nickname, created_at) VALUES (2, 'b@example.com', '會員乙', '2026-01-01T00:00:00.000Z')").run();
  assert.throws(() => getDemandPost(db, String(post.id), { viewerId: 2 }), /找不到/);
  const byToken = getDemandPost(db, post.public_token, { publicOnly: true });
  assert.equal(byToken.id, post.id);
  assert.equal("author" in byToken, false);
  const owner = getDemandPost(db, post.id, { viewerId: 1 });
  assert.equal(owner.id, post.id);
  const otherByToken = getDemandPost(db, post.public_token, { viewerId: 2 });
  assert.equal(otherByToken.id, post.id);
  db.prepare("UPDATE demand_posts SET legacy_numeric_share = 1 WHERE id = ?").run(post.id);
  const legacy = getDemandPost(db, String(post.id), { publicOnly: true });
  assert.equal(legacy.id, post.id);
  const flags = publicRentalMarketplaceFlags({
    wish: {
      public_share_v2_enabled: true,
      owner_matching_enabled: true,
      offer_enabled: true,
      owner_notifications_enabled: true,
      notifications_enabled: true,
      digest_enabled: true,
      outbound_mail_enabled: true,
      outbound_push_enabled: true,
    },
  });
  assert.equal(flags.wish.public_share_v2_enabled, false);
  assert.equal(flags.wish.owner_matching_enabled, false);
  assert.equal(flags.wish.offer_enabled, false);
  assert.equal(flags.wish.owner_notifications_enabled, false);
  assert.equal(flags.wish.notifications_enabled, false);
  assert.equal(flags.wish.digest_enabled, false);
  assert.equal(flags.wish.outbound_mail_enabled, false);
  assert.equal(flags.wish.outbound_push_enabled, false);
  db.close();
});

test("existing rows are backfilled as legacy numeric share", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      nickname TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE demand_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      districts TEXT NOT NULL DEFAULT '[]',
      rent_max INTEGER NOT NULL DEFAULT 0,
      housing_type TEXT NOT NULL DEFAULT 'any',
      mrt_walk INTEGER NOT NULL DEFAULT 0,
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      closed_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);
  db.prepare("INSERT INTO users(id, email, nickname, created_at) VALUES (1, 'a@example.com', '阿花', '2026-01-01T00:00:00.000Z')").run();
  db.prepare(
    "INSERT INTO demand_posts(user_id, body, status, created_at, expires_at) VALUES (1, '舊的公開許願房內容夠長', 'open', '2026-01-01T00:00:00.000Z', '9999-12-31T00:00:00.000Z')",
  ).run();
  ensureDemandSchema(db);
  const row = db.prepare("SELECT legacy_numeric_share FROM demand_posts WHERE id = 1").get();
  assert.equal(Number(row.legacy_numeric_share), 1);
  const byId = getDemandPost(db, "1", { publicOnly: true });
  assert.equal(byId.id, 1);
  db.close();
});

test("publish TTL goes to confirmation then expires after grace", () => {
  const db = open();
  setRentalMarketplaceFlags({ wish: { lifecycle_enabled: true } });
  const publishedAt = new Date("2026-09-01T00:00:00.000Z");
  const post = createDemandPost(db, 1, sample(), publishedAt);
  const stored = db.prepare("SELECT * FROM demand_posts WHERE id = ?").get(post.id);
  assert.equal(stored.expires_at, ttlExpiresAt(publishedAt, 14));
  assert.ok(!String(stored.expires_at).startsWith("9999"));

  expireOpenPosts(db, new Date(stored.expires_at));
  const confirming = db.prepare("SELECT status, lifecycle FROM demand_posts WHERE id = ?").get(post.id);
  assert.equal(confirming.lifecycle, "needs_confirmation");
  assert.equal(confirming.status, "open");

  expireOpenPosts(db, new Date(Date.parse(stored.expires_at) + 3 * 86400000));
  const duringGrace = db.prepare("SELECT status, lifecycle FROM demand_posts WHERE id = ?").get(post.id);
  assert.equal(duringGrace.status, "open");
  assert.equal(duringGrace.lifecycle, "needs_confirmation");

  expireOpenPosts(db, new Date(Date.parse(stored.expires_at) + 7 * 86400000));
  const paused = db.prepare("SELECT status, lifecycle, closed_reason FROM demand_posts WHERE id = ?").get(post.id);
  assert.equal(paused.status, "closed");
  assert.equal(paused.lifecycle, "paused");
  assert.equal(paused.closed_reason, "paused");
  setRentalMarketplaceFlags({});
  db.close();
});

test("60-day confirm action completes and resets continuous window", () => {
  const db = open();
  setRentalMarketplaceFlags({ wish: { lifecycle_enabled: true } });
  const started = new Date("2026-09-16T00:00:00.000Z");
  const post = createDemandPost(db, 1, sample(), started);
  db.prepare(
    "UPDATE demand_posts SET continuous_active_from = ?, last_confirmed_at = ?, lifecycle = 'needs_confirmation' WHERE id = ?",
  ).run(started.toISOString(), "2026-11-01T00:00:00.000Z", post.id);
  const now = new Date("2026-11-16T00:00:00.000Z");
  const gated = applyWishLifecycleAction(db, 1, post.id, "extend", now);
  assert.equal(gated.require_reconfirm, true);
  assert.equal(gated.lifecycle, "needs_confirmation");
  const blocked = applyWishLifecycleAction(db, 1, post.id, "confirm", now);
  assert.equal(blocked.require_reconfirm, true);
  assert.equal(blocked.lifecycle, "needs_confirmation");
  const confirmed = applyWishLifecycleAction(db, 1, post.id, "full_reconfirm", now);
  assert.equal(confirmed.lifecycle, "active");
  assert.equal(confirmed.require_reconfirm, false);
  const row = db.prepare("SELECT continuous_active_from, last_confirmed_at, expires_at, lifecycle FROM demand_posts WHERE id = ?").get(post.id);
  assert.equal(row.lifecycle, "active");
  assert.equal(row.continuous_active_from, now.toISOString());
  assert.equal(row.last_confirmed_at, now.toISOString());
  assert.equal(row.expires_at, ttlExpiresAt(now, 14));
  setRentalMarketplaceFlags({});
  db.close();
});

test("14-day confirm does not reset the 60-day continuous window", () => {
  const db = open();
  setRentalMarketplaceFlags({ wish: { lifecycle_enabled: true } });
  const started = new Date("2026-09-16T00:00:00.000Z");
  const post = createDemandPost(db, 1, sample(), started);
  const day14 = new Date("2026-09-30T00:00:00.000Z");
  const stay = applyWishLifecycleAction(db, 1, post.id, "confirm", day14);
  assert.equal(stay.lifecycle, "active");
  const row = db.prepare("SELECT continuous_active_from, last_confirmed_at FROM demand_posts WHERE id = ?").get(post.id);
  assert.equal(row.continuous_active_from, started.toISOString());
  assert.equal(row.last_confirmed_at, day14.toISOString());
  const day60 = new Date("2026-11-16T00:00:00.000Z");
  const gated = applyWishLifecycleAction(db, 1, post.id, "extend", day60);
  assert.equal(gated.require_reconfirm, true);
  setRentalMarketplaceFlags({});
  db.close();
});

test("first lifecycle activation overwrites old open-wish timestamps", () => {
  const db = open();
  const started = new Date("2026-06-18T00:00:00.000Z");
  const post = createDemandPost(db, 1, sample(), started);
  db.prepare(
    `UPDATE demand_posts SET last_confirmed_at = ?, last_active_at = ?, continuous_active_from = ?,
     expires_at = ?, lifecycle = 'active' WHERE id = ?`,
  ).run(started.toISOString(), started.toISOString(), started.toISOString(), "9999-12-31T00:00:00.000Z", post.id);
  const now = new Date("2026-09-16T00:00:00.000Z");
  setRentalMarketplaceFlags({ wish: { lifecycle_enabled: true } });
  const n = migrateOpenWishesOnActivation(db, now);
  assert.ok(n >= 1);
  const row = db.prepare("SELECT last_confirmed_at, last_active_at, continuous_active_from, expires_at, lifecycle, status FROM demand_posts WHERE id = ?").get(post.id);
  assert.equal(row.lifecycle, "active");
  assert.equal(row.status, "open");
  assert.equal(row.last_confirmed_at, now.toISOString());
  assert.equal(row.last_active_at, now.toISOString());
  assert.equal(row.continuous_active_from, now.toISOString());
  assert.equal(row.expires_at, ttlExpiresAt(now, 14));
  expireOpenPosts(db, now);
  const afterTick = db.prepare("SELECT lifecycle, status FROM demand_posts WHERE id = ?").get(post.id);
  assert.equal(afterTick.lifecycle, "active");
  assert.equal(afterTick.status, "open");
  const second = migrateOpenWishesOnActivation(db, new Date("2026-09-20T00:00:00.000Z"));
  assert.equal(second, 0);
  const again = db.prepare("SELECT last_confirmed_at, continuous_active_from, expires_at, lifecycle FROM demand_posts WHERE id = ?").get(post.id);
  assert.equal(again.last_confirmed_at, now.toISOString());
  assert.equal(again.continuous_active_from, now.toISOString());
  assert.equal(again.expires_at, ttlExpiresAt(now, 14));
  db.prepare("UPDATE demand_posts SET lifecycle = 'needs_confirmation' WHERE id = ?").run(post.id);
  assert.equal(migrateOpenWishesOnActivation(db, new Date("2026-09-21T00:00:00.000Z")), 0);
  const confirming = db.prepare("SELECT lifecycle, last_confirmed_at FROM demand_posts WHERE id = ?").get(post.id);
  assert.equal(confirming.lifecycle, "needs_confirmation");
  assert.equal(confirming.last_confirmed_at, now.toISOString());
  setRentalMarketplaceFlags({});
  db.close();
});

test("full_reconfirm before 60 days is rejected and leaves the continuous window", () => {
  const db = open();
  setRentalMarketplaceFlags({ wish: { lifecycle_enabled: true } });
  const started = new Date("2026-09-16T00:00:00.000Z");
  const post = createDemandPost(db, 1, sample(), started);
  const day14 = new Date("2026-09-30T00:00:00.000Z");
  assert.throws(() => applyWishLifecycleAction(db, 1, post.id, "full_reconfirm", day14), (err) => err.status === 400 || err.status === 409);
  const day14Row = db.prepare("SELECT continuous_active_from, lifecycle FROM demand_posts WHERE id = ?").get(post.id);
  assert.equal(day14Row.continuous_active_from, started.toISOString());
  assert.equal(day14Row.lifecycle, "active");
  db.prepare("UPDATE demand_posts SET lifecycle = 'needs_confirmation' WHERE id = ?").run(post.id);
  const day30 = new Date("2026-10-16T00:00:00.000Z");
  assert.throws(() => applyWishLifecycleAction(db, 1, post.id, "full_reconfirm", day30), (err) => err.status === 409);
  const day30Row = db.prepare("SELECT continuous_active_from, lifecycle FROM demand_posts WHERE id = ?").get(post.id);
  assert.equal(day30Row.continuous_active_from, started.toISOString());
  assert.equal(day30Row.lifecycle, "needs_confirmation");
  setRentalMarketplaceFlags({});
  db.close();
});

test("admin catalog-only condition survives wish save reload and edit payload", () => {
  const db = open();
  setRentalMarketplaceFlags({ rental_catalog_v2: { enabled: true } });
  const catalog = upsertCondition(defaultCatalog(), { label: "烘衣機", category_id: "appliance" });
  const dryer = catalog.conditions.find((row) => row.label === "烘衣機");
  assert.ok(dryer?.id);
  setRentalCatalogCache(catalog);
  const post = createDemandPost(db, 1, sample({
    choices: { [dryer.id]: "want", need_cook: "want" },
  }));
  assert.equal(post.choices[dryer.id], "want");
  assert.ok(post.must_have.includes(dryer.id));
  assert.ok(post.must_have_labels.includes("烘衣機"));
  const reloaded = getDemandPost(db, post.id, { viewerId: 1 });
  assert.equal(reloaded.choices[dryer.id], "want");
  assert.ok(reloaded.must_have.includes(dryer.id));
  assert.ok(reloaded.must_have_labels.includes("烘衣機"));
  setRentalMarketplaceFlags({});
  setRentalCatalogCache(null);
  db.close();
});

test("public wish API strips work address and reply identity", () => {
  const db = open();
  db.prepare("INSERT INTO users(id, email, nickname, created_at) VALUES (2, 'b@example.com', '屋主乙暱稱', '2026-01-01T00:00:00.000Z')").run();
  const post = createDemandPost(db, 1, sample({
    destination_note: "台北市信義區松仁路100號某某公司",
    location_note: "天母東路88號",
  }));
  addDemandReply(db, 2, post.id, "我看到一間可以參考");
  const pub = getDemandPost(db, post.public_token, { publicOnly: true });
  const json = JSON.stringify(pub);
  assert.doesNotMatch(json, /松仁路|某某公司|天母東路|屋主乙暱稱/);
  assert.equal("destination_note" in pub, false);
  assert.equal("location_note" in pub, false);
  assert.equal("replies" in pub, false);
  assert.equal("author" in pub, false);
  const owner = getDemandPost(db, post.id, { viewerId: 1 });
  assert.match(owner.destination_note, /松仁路/);
  setRentalMarketplaceFlags({});
  db.close();
});

test("existing login signal updates owner activity bucket", () => {
  const db = open();
  try { db.exec("ALTER TABLE users ADD COLUMN last_login_at TEXT"); } catch { /* already present */ }
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = 1").run(new Date().toISOString());
  const post = createDemandPost(db, 1, sample());
  const signals = collectWishActivitySignals(db, 1, post);
  assert.ok(signals.last_login_at);
  const scored = activityScoreFromSignals(signals, new Date());
  assert.equal(scored.activity_bucket, "today");
  const owner = getDemandPost(db, post.id, { viewerId: 1 });
  assert.equal(owner.activity_bucket, "today");
  const pub = getDemandPost(db, post.public_token, { publicOnly: true });
  assert.equal("activity_bucket" in pub, false);
  db.close();
});

test("guest can open listed wish via token but numeric API still 404s", () => {
  const db = open();
  db.prepare("INSERT INTO users(id, email, nickname, created_at) VALUES (2, 'b@example.com', '會員乙', '2026-01-01T00:00:00.000Z')").run();
  const post = createDemandPost(db, 1, sample());
  const listed = listDemandPosts(db);
  assert.equal(listed.length, 1);
  assert.ok(listed[0].public_token);
  assert.equal(listed[0].public_ref, post.public_token);
  const fromCard = getDemandPost(db, listed[0].public_ref, { publicOnly: true });
  assert.equal(fromCard.id, post.id);
  const other = getDemandPost(db, listed[0].public_ref, { viewerId: 2 });
  assert.equal(other.id, post.id);
  assert.throws(() => getDemandPost(db, String(post.id), { publicOnly: true }), /找不到/);
  assert.throws(() => getDemandPost(db, String(post.id), { viewerId: 2 }), /找不到/);
  db.close();
});

test("disabled catalog condition stays on wish after reload and unrelated edit", () => {
  const db = open();
  setRentalMarketplaceFlags({ rental_catalog_v2: { enabled: true } });
  const catalog = upsertCondition(defaultCatalog(), { label: "烘衣機", category_id: "appliance" });
  const dryer = catalog.conditions.find((row) => row.label === "烘衣機");
  setRentalCatalogCache(catalog);
  const post = createDemandPost(db, 1, sample({ choices: { [dryer.id]: "want", need_cook: "want" } }));
  assert.equal(post.choices[dryer.id], "want");
  const disabled = deleteOrDisableCondition(catalog, dryer.id, { wish: 1 });
  setRentalCatalogCache(disabled.catalog);
  const reloaded = getDemandPost(db, post.id, { viewerId: 1 });
  assert.equal(reloaded.choices[dryer.id], "want");
  assert.ok(reloaded.must_have_labels.includes("烘衣機"));
  const edited = updateWishRoom(db, 1, post.id, { body: "改了說明但仍要烘衣機", choices: { need_cook: "want" } });
  assert.equal(edited.choices[dryer.id], "want");
  assert.ok(edited.must_have_labels.includes("烘衣機"));
  setRentalMarketplaceFlags({});
  setRentalCatalogCache(null);
  db.close();
});

test("catalog and wish modules stay out of listing ranking", () => {
  const scoreSrc = readFileSync(path.join(dir, "../src/listingScore.js"), "utf8");
  const sortSrc = readFileSync(path.join(dir, "../src/db.js"), "utf8");
  const matchSrc = readFileSync(path.join(dir, "../src/match.js"), "utf8");
  for (const src of [scoreSrc, matchSrc]) {
    assert.doesNotMatch(src, /rentalCatalog|wishLifecycle|demand\.js|rentalMatch/);
  }
  const start = sortSrc.indexOf("export function sortListingsRows");
  const end = sortSrc.indexOf("const LIST_CANDIDATE_COLUMNS");
  assert.doesNotMatch(sortSrc.slice(start, end), /rentalCatalog|wishLifecycle|demand_posts/);
  assert.ok(Number.isFinite(listingFitScore({ rent: 18000 }, { maxRent: 25000 })));
  assert.ok(preferPrimaryListing);
});
