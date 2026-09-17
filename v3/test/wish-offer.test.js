import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDemandPost, ensureDemandSchema, setRentalCatalogCache, setRentalMarketplaceFlags } from "../src/demand.js";
import { applyWishLifecycleAction } from "../src/demand.js";
import { defaultCatalog } from "../src/rentalCatalog.js";
import { closeSelfListing, createSelfListing, ensureSelfListingSchema, setSelfListingCatalog } from "../src/selfListings.js";
import {
  attachOfferCtas,
  createWishOffer,
  ensureWishOfferSchema,
  explainWishOfferPlans,
  listAdminOfferReports,
  listMyBlocks,
  unblockByRef,
  OFFER_LISTING_DAILY_CAP,
  OFFER_OWNER_DAILY_CAP,
  OFFER_SAME_WISH_COOLDOWN_MS,
  publicOfferView,
  resetWishOfferRateLimits,
  setWishOfferHydrate,
} from "../src/wishOffers.js";
import {
  acceptWishOffer,
  blockOwnerFromOffer,
  declineWishOffer,
  readOfferContact,
  reportWishOffer,
  withdrawWishOffer,
} from "../src/wishOfferTransitions.js";
import {
  lastWishOfferListStats,
  listOwnerWishOffers,
  listTenantWishOffers,
  resetWishOfferQueryCursors,
  wishOfferQueryMemory,
} from "../src/wishOfferQueries.js";
import { runWishOfferExpiryTick, startWishOfferExpiryLoop } from "../src/wishOfferWorker.js";
import { evaluateMatch, listingMatchSnapshot, wishMatchSnapshot } from "../src/rentalMatch.js";
import { listingFitScore } from "../src/listingScore.js";
import { preferPrimaryListing } from "../src/match.js";
import { computeListingMatches, ownerListingMatches, setRentalMatchHydrate, clearRentalMatchCache } from "../src/rentalMatchQuery.js";

const FLAGS_ON = {
  rental_catalog_v2: { enabled: true },
  wish: { lifecycle_enabled: true, owner_matching_enabled: true, offer_enabled: true },
};
const FLAGS_OFF = {
  rental_catalog_v2: { enabled: true },
  wish: { lifecycle_enabled: true, owner_matching_enabled: true, offer_enabled: false },
};

function hydrate(flags = FLAGS_ON) {
  setRentalMarketplaceFlags(flags);
  setRentalCatalogCache(defaultCatalog());
  setSelfListingCatalog(defaultCatalog(), flags);
  setRentalMatchHydrate(defaultCatalog(), flags);
  setWishOfferHydrate(defaultCatalog(), flags);
  clearRentalMatchCache();
  resetWishOfferRateLimits();
  resetWishOfferQueryCursors();
}

function open(flags = FLAGS_ON) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      nickname TEXT,
      created_at TEXT NOT NULL,
      last_login_at TEXT,
      self_ban_until TEXT
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
  ensureWishOfferSchema(db);
  db.prepare("INSERT INTO users(id, email, nickname, created_at) VALUES (1, 'owner@example.com', '屋主', '2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO users(id, email, nickname, created_at) VALUES (2, 'tenant@example.com', '阿花', '2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO users(id, email, nickname, created_at) VALUES (3, 'other@example.com', '路人', '2026-01-01T00:00:00.000Z')").run();
  hydrate(flags);
  return db;
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
    contact_name: "阿花",
    phone: "0987654321",
    choices: { need_pet: "want", need_cook: "want", elevator: "want" },
    ...extra,
  };
}

function seedPair(db) {
  const listing = createSelfListing(db, 1, listingInput());
  const wish = createDemandPost(db, 2, wishInput());
  return { listing, wish };
}

function codeOf(fn) {
  try {
    fn();
    return "";
  } catch (error) {
    return error.code || "";
  }
}

test("create pending offer and public view hides IDs and tenant PII", () => {
  const db = open();
  const { listing, wish } = seedPair(db);
  const offer = createWishOffer(db, 1, listing.post_id, wish.public_token, { idempotencyKey: "offer-key-001" });
  assert.equal(offer.status, "pending");
  const view = publicOfferView(db, offer, 1);
  const json = JSON.stringify(view);
  assert.equal(view.offer_ref, offer.public_token);
  assert.equal("wish_id" in view, false);
  assert.equal("user_id" in view, false);
  assert.doesNotMatch(json, /0987654321|tenant@example.com|"wish_id"|"rank_score"|"activity_score"/);
  assert.equal(view.actions.contact, false);
  assert.throws(() => readOfferContact(db, 1, offer.public_token), /尚未互相確認|無法查看/);
  db.close();
});

test("accepted offer cannot reverse to pending or be accepted again", () => {
  const db = open();
  const { listing, wish } = seedPair(db);
  const accepted = createWishOffer(db, 1, listing.post_id, wish.public_token, { idempotencyKey: "offer-key-acc1" });
  const afterAccept = acceptWishOffer(db, 2, accepted.public_token);
  assert.equal(afterAccept.status, "accepted");
  assert.equal(codeOf(() => acceptWishOffer(db, 2, accepted.public_token)), "offer_conflict");
  assert.equal(codeOf(() => declineWishOffer(db, 2, accepted.public_token)), "offer_conflict");
  db.close();
});

test("pending can decline withdraw expire and block; terminal cannot accept", () => {
  const db = open();
  const a = seedPair(db);
  const pending = createWishOffer(db, 1, a.listing.post_id, a.wish.public_token, { idempotencyKey: "offer-key-d1xx" });
  assert.equal(declineWishOffer(db, 2, pending.public_token).status, "declined");
  assert.equal(codeOf(() => acceptWishOffer(db, 2, pending.public_token)), "offer_conflict");

  const bListing = createSelfListing(db, 1, listingInput({ title: "士林第二間套房", address: "中正路200號" }));
  const pending2 = createWishOffer(db, 1, bListing.post_id, a.wish.public_token, { idempotencyKey: "offer-key-w1xx" });
  assert.equal(withdrawWishOffer(db, 1, pending2.public_token).status, "withdrawn");
  assert.equal(codeOf(() => acceptWishOffer(db, 2, pending2.public_token)), "offer_conflict");

  db.prepare("UPDATE users SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = 3").run();
  const wish2 = createDemandPost(db, 3, wishInput({ body: "另一則需求" }));
  const pending3 = createWishOffer(db, 1, a.listing.post_id, wish2.public_token, { idempotencyKey: "offer-key-e1xx" });
  db.prepare("UPDATE wish_offers SET expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", pending3.id);
  const tick = runWishOfferExpiryTick(db, new Date("2026-09-17T00:00:00.000Z"), { flags: FLAGS_ON });
  assert.equal(tick.changed, 1);
  assert.equal(db.prepare("SELECT status FROM wish_offers WHERE id = ?").get(pending3.id).status, "expired");
  assert.equal(runWishOfferExpiryTick(db, new Date("2026-09-17T00:00:00.000Z"), { flags: FLAGS_ON }).changed, 0);
  assert.equal(codeOf(() => acceptWishOffer(db, 3, pending3.public_token)), "offer_conflict");
  db.close();
});

test("eligibility gates reject inactive wish, other owner, closed listing and stale match", () => {
  const db = open();
  const { listing, wish } = seedPair(db);
  db.prepare("UPDATE demand_posts SET status='closed', lifecycle='paused' WHERE id=?").run(wish.id);
  assert.equal(codeOf(() => createWishOffer(db, 1, listing.post_id, wish.public_token, { idempotencyKey: "offer-key-pause" })), "match_no_longer_eligible");

  const live = createDemandPost(db, 2, wishInput({ body: "恢復後的需求" }));
  assert.equal(codeOf(() => createWishOffer(db, 3, listing.post_id, live.public_token, { idempotencyKey: "offer-key-other" })), "listing_not_found");

  closeSelfListing(db, 1, listing.post_id);
  assert.equal(codeOf(() => createWishOffer(db, 1, listing.post_id, live.public_token, { idempotencyKey: "offer-key-close" })), "match_no_longer_eligible");
  db.close();
});

test("idempotent create and cooldown after terminal", () => {
  const db = open();
  const { listing, wish } = seedPair(db);
  const first = createWishOffer(db, 1, listing.post_id, wish.public_token, { idempotencyKey: "offer-key-idem01" });
  const replay = createWishOffer(db, 1, listing.post_id, wish.public_token, { idempotencyKey: "offer-key-idem01" });
  assert.equal(first.id, replay.id);
  const dbl = createWishOffer(db, 1, listing.post_id, wish.public_token, { idempotencyKey: "offer-key-idem02" });
  assert.equal(dbl.id, first.id);
  declineWishOffer(db, 2, first.public_token);
  assert.equal(codeOf(() => createWishOffer(db, 1, listing.post_id, wish.public_token, { idempotencyKey: "offer-key-cool1" })), "OFFER_COOLDOWN");
  db.close();
});

test("accepted contact is dedicated projection; unauthorized and pending cannot read", () => {
  const db = open();
  const { listing, wish } = seedPair(db);
  const offer = createWishOffer(db, 1, listing.post_id, wish.public_token, { idempotencyKey: "offer-key-ct01" });
  assert.equal(codeOf(() => readOfferContact(db, 3, offer.public_token)), "offer_not_found");
  assert.equal(codeOf(() => readOfferContact(db, 1, offer.public_token)), "contact_unavailable");
  acceptWishOffer(db, 2, offer.public_token);
  const owner = readOfferContact(db, 1, offer.public_token);
  assert.equal(owner.contact.phone, "0987654321");
  assert.equal("user_id" in owner, false);
  const tenant = readOfferContact(db, 2, offer.public_token);
  assert.equal(tenant.contact.phone, "0912345678");
  const events = db.prepare("SELECT event_type FROM wish_offer_events WHERE event_type='contact_projection_accessed'").all();
  assert.equal(events.length >= 2, true);
  db.close();
});

test("block prevents future offers, terminals pending, and hides contact", () => {
  const db = open();
  const { listing, wish } = seedPair(db);
  const offer = createWishOffer(db, 1, listing.post_id, wish.public_token, { idempotencyKey: "offer-key-bk01" });
  const blocked = blockOwnerFromOffer(db, 2, offer.public_token);
  assert.equal(blocked.offer.status, "blocked");
  assert.equal(codeOf(() => readOfferContact(db, 1, offer.public_token)), "contact_unavailable");
  assert.equal(codeOf(() => createWishOffer(db, 1, listing.post_id, wish.public_token, { idempotencyKey: "offer-key-bk02" })), "offer_unavailable");
  const matches = ownerListingMatches(db, listing.post_id, 1);
  const card = matches.items.find((item) => item.wish_ref === wish.public_token);
  if (card) {
    assert.equal(card.offer_available, false);
    assert.match(card.offer_cta, /目前無法提供/);
  }
  const blocks = listMyBlocks(db, 2);
  assert.equal(blocks.length, 1);
  assert.equal("blocked_user_id" in blocks[0], false);
  db.close();
});

test("report is bounded, validated, and not enumerable by other users", () => {
  const db = open();
  const { listing, wish } = seedPair(db);
  const offer = createWishOffer(db, 1, listing.post_id, wish.public_token, { idempotencyKey: "offer-key-rp01" });
  assert.equal(codeOf(() => reportWishOffer(db, 2, offer.public_token, { reason: "zzz" })), "invalid_report_reason");
  const first = reportWishOffer(db, 2, offer.public_token, { reason: "spam", detail: "重複洗版" });
  const again = reportWishOffer(db, 2, offer.public_token, { reason: "spam", detail: "再檢舉" });
  assert.equal(first.already, false);
  assert.equal(again.already, true);
  const admin = listAdminOfferReports(db);
  assert.equal(admin[0].reason, "spam");
  assert.equal("reporter_user_id" in admin[0], false);
  db.close();
});

test("flag off fail-closes mutations", () => {
  const db = open(FLAGS_OFF);
  const { listing, wish } = seedPair(db);
  assert.equal(codeOf(() => createWishOffer(db, 1, listing.post_id, wish.public_token, { idempotencyKey: "offer-key-off1" })), "wish_offer_disabled");
  assert.equal(codeOf(() => listMyBlocks(db, 1)), "wish_offer_disabled");
  assert.equal(codeOf(() => unblockByRef(db, 1, "any-block-ref")), "wish_offer_disabled");
  db.close();
});

test("create vs pause and listing close fail-closed", () => {
  const db = open();
  const { listing, wish } = seedPair(db);
  const offer = createWishOffer(db, 1, listing.post_id, wish.public_token, { idempotencyKey: "offer-key-lc01" });
  applyWishLifecycleAction(db, 2, wish.public_token, "pause");
  assert.equal(db.prepare("SELECT status FROM wish_offers WHERE id=?").get(offer.id).status, "expired");
  const live = createDemandPost(db, 2, wishInput({ body: "新的一則" }));
  const offer2 = createWishOffer(db, 1, listing.post_id, live.public_token, { idempotencyKey: "offer-key-lc02" });
  closeSelfListing(db, 1, listing.post_id);
  assert.equal(db.prepare("SELECT status FROM wish_offers WHERE id=?").get(offer2.id).status, "withdrawn");
  db.close();
});

test("owner and listing daily caps use indexed counts", () => {
  const db = open();
  const listingA = createSelfListing(db, 1, listingInput({ title: "士林A房整層", address: "中正路1號" }));
  const listingB = createSelfListing(db, 1, listingInput({ title: "士林B房整層", address: "中正路2號" }));
  for (let i = 0; i < OFFER_LISTING_DAILY_CAP; i += 1) {
    const tenantId = 10 + i;
    db.prepare("INSERT INTO users(id, email, nickname, created_at) VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')").run(tenantId, `t${i}@example.com`, `T${i}`);
    const wish = createDemandPost(db, tenantId, wishInput({ body: `找房需求${i}` }));
    createWishOffer(db, 1, listingA.post_id, wish.public_token, { idempotencyKey: `offer-key-cap${i}aa` });
  }
  const extraA = 30;
  db.prepare("INSERT INTO users(id, email, nickname, created_at) VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')").run(extraA, "capa@example.com", "CapA");
  const wishA = createDemandPost(db, extraA, wishInput({ body: "A超過上限" }));
  assert.equal(codeOf(() => createWishOffer(db, 1, listingA.post_id, wishA.public_token, { idempotencyKey: "offer-key-capa9" })), "RATE_LIMITED");
  for (let i = OFFER_LISTING_DAILY_CAP; i < OFFER_OWNER_DAILY_CAP; i += 1) {
    const tenantId = 10 + i;
    db.prepare("INSERT INTO users(id, email, nickname, created_at) VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')").run(tenantId, `t${i}@example.com`, `T${i}`);
    const wish = createDemandPost(db, tenantId, wishInput({ body: `找房需求B${i}` }));
    createWishOffer(db, 1, listingB.post_id, wish.public_token, { idempotencyKey: `offer-key-cap${i}bb` });
  }
  const extraB = 40;
  db.prepare("INSERT INTO users(id, email, nickname, created_at) VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')").run(extraB, "capb@example.com", "CapB");
  const wishB = createDemandPost(db, extraB, wishInput({ body: "B超過上限" }));
  assert.equal(codeOf(() => createWishOffer(db, 1, listingB.post_id, wishB.public_token, { idempotencyKey: "offer-key-capb9" })), "RATE_LIMITED");
  const plans = explainWishOfferPlans(db);
  const text = JSON.stringify(plans);
  assert.match(text, /idx_wish_offers_owner_created|idx_wish_offers_listing_created|SEARCH/);
  db.close();
});

test("inbox and owner lists are opaque and bounded", () => {
  const db = open();
  const { listing, wish } = seedPair(db);
  createWishOffer(db, 1, listing.post_id, wish.public_token, { idempotencyKey: "offer-key-in01" });
  const inbox = listTenantWishOffers(db, 2, { limit: 20 });
  assert.equal(inbox.pending_count, 1);
  assert.equal(inbox.total, 1);
  assert.equal(inbox.items[0].viewer_role, "tenant");
  assert.doesNotMatch(JSON.stringify(inbox), /"wish_id"|0987654321/);
  const inboxStats = lastWishOfferListStats();
  assert.equal(inboxStats.counted, true);
  assert.equal(inboxStats.pending_counted, true);
  assert.ok(inboxStats.fetched <= 21);
  assert.ok(inboxStats.projected <= 20);
  const owner = listOwnerWishOffers(db, 1, { limit: 20 });
  assert.equal(owner.items[0].viewer_role, "owner");
  assert.equal(wishOfferQueryMemory().snapshots, 0);
  db.close();
});

test("offer state does not change listing ranking or match quality", () => {
  const db = open();
  const { listing, wish } = seedPair(db);
  const before = computeListingMatches(db, listingMatchSnapshot(listing, { catalog: defaultCatalog() }));
  createWishOffer(db, 1, listing.post_id, wish.public_token, { idempotencyKey: "offer-key-iso1" });
  const after = computeListingMatches(db, listingMatchSnapshot(listing, { catalog: defaultCatalog() }));
  assert.equal(before.items[0].match_score, after.items[0].match_score);
  const settings = { priceMin: 10000, priceMax: 30000, wholeFloorOnly: true };
  const row = { post_id: listing.post_id, price_num: 22000, kind_name: "整層住家", floor_name: "3/5", tags: "[]", last_seen_at: "2026-09-01T00:00:00.000Z", first_seen_at: "2026-08-01T00:00:00.000Z" };
  assert.equal(listingFitScore(row, settings), listingFitScore({ ...row, offer_count: 9, accepted_offers: 3 }, settings));
  assert.equal(preferPrimaryListing(row, { ...row, post_id: row.post_id + 1, accepted_offers: 99 }, Date.parse("2026-09-15T00:00:00.000Z")).post_id, row.post_id);
  db.close();
});

test("worker is bounded, idempotent and non-reentrant", () => {
  const db = open();
  let inner = 0;
  const loop = startWishOfferExpiryLoop(() => {
    inner += 1;
    loop.tick();
    return { changed: 0, scanned: 0 };
  }, { intervalMs: 60_000 });
  loop.tick();
  assert.equal(inner, 1);
  loop.stop();
  const { listing, wish } = seedPair(db);
  const offer = createWishOffer(db, 1, listing.post_id, wish.public_token, { idempotencyKey: "offer-key-wk01" });
  db.prepare("UPDATE wish_offers SET expires_at=? WHERE id=?").run("2020-01-01T00:00:00.000Z", offer.id);
  assert.equal(runWishOfferExpiryTick(db, new Date(), { flags: FLAGS_ON, limit: 80 }).changed, 1);
  assert.equal(runWishOfferExpiryTick(db, new Date(), { flags: FLAGS_ON, limit: 80 }).changed, 0);
  db.close();
});

test("concurrent create yields one pending", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wish-offer-"));
  const file = path.join(dir, "t.db");
  const setup = new DatabaseSync(file);
  setup.exec("PRAGMA journal_mode = WAL");
  setup.close();
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      nickname TEXT,
      created_at TEXT NOT NULL
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
  ensureWishOfferSchema(db);
  db.prepare("INSERT INTO users(id, email, nickname, created_at) VALUES (1, 'owner@example.com', '屋主', '2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO users(id, email, nickname, created_at) VALUES (2, 'tenant@example.com', '阿花', '2026-01-01T00:00:00.000Z')").run();
  hydrate();
  const { listing, wish } = seedPair(db);
  db.close();
  const a = new DatabaseSync(file);
  const b = new DatabaseSync(file);
  hydrate();
  ensureWishOfferSchema(a);
  ensureWishOfferSchema(b);
  const first = createWishOffer(a, 1, listing.post_id, wish.public_token, { idempotencyKey: "offer-key-cc01" });
  const second = createWishOffer(b, 1, listing.post_id, wish.public_token, { idempotencyKey: "offer-key-cc02" });
  assert.equal(first.id, second.id);
  a.close();
  b.close();
  rmSync(dir, { recursive: true, force: true });
});

test("accept vs withdraw only one terminal path wins", () => {
  const db = open();
  const { listing, wish } = seedPair(db);
  const offer = createWishOffer(db, 1, listing.post_id, wish.public_token, { idempotencyKey: "offer-key-aw01" });
  const accepted = acceptWishOffer(db, 2, offer.public_token);
  assert.equal(accepted.status, "accepted");
  assert.equal(codeOf(() => withdrawWishOffer(db, 1, offer.public_token)), "offer_conflict");
  assert.equal(db.prepare("SELECT status FROM wish_offers WHERE id=?").get(offer.id).status, "accepted");
  db.close();
});

test("attachOfferCtas keeps upcoming CTA when flag on", () => {
  const db = open();
  const { listing, wish } = seedPair(db);
  const items = attachOfferCtas(db, [{ wish_ref: wish.public_token }], { listingId: listing.post_id, ownerUserId: 1 });
  assert.equal(items[0].offer_available, true);
  assert.equal(items[0].offer_cta, "提供我的房源");
  db.close();
});

test("evaluateMatch still works after offer history", () => {
  const db = open();
  const { listing, wish } = seedPair(db);
  const listingSnap = listingMatchSnapshot(listing, { catalog: defaultCatalog() });
  const wishSnap = wishMatchSnapshot(wish, { catalog: defaultCatalog() });
  const before = evaluateMatch(listingSnap, wishSnap, { catalog: defaultCatalog() });
  createWishOffer(db, 1, listing.post_id, wish.public_token, { idempotencyKey: "offer-key-em01" });
  const after = evaluateMatch(listingSnap, wishSnap, { catalog: defaultCatalog() });
  assert.equal(before.match_score, after.match_score);
  db.close();
});

test("idempotency key replays same target and conflicts on different listing or wish", () => {
  const db = open();
  const { listing, wish } = seedPair(db);
  const listingB = createSelfListing(db, 1, listingInput({ title: "士林第二間套房", address: "中正路200號" }));
  const wishB = createDemandPost(db, 3, wishInput({ body: "另一則需求" }));
  const first = createWishOffer(db, 1, listing.post_id, wish.public_token, { idempotencyKey: "offer-key-idm-x" });
  const replay = createWishOffer(db, 1, listing.post_id, wish.public_token, { idempotencyKey: "offer-key-idm-x" });
  assert.equal(first.id, replay.id);
  assert.equal(first.public_token, replay.public_token);
  assert.equal(codeOf(() => createWishOffer(db, 1, listingB.post_id, wish.public_token, { idempotencyKey: "offer-key-idm-x" })), "IDEMPOTENCY_CONFLICT");
  assert.equal(codeOf(() => createWishOffer(db, 1, listing.post_id, wishB.public_token, { idempotencyKey: "offer-key-idm-x" })), "IDEMPOTENCY_CONFLICT");
  assert.equal(codeOf(() => createWishOffer(db, 1, 99999999, wish.public_token, { idempotencyKey: "offer-key-idm-x" })), "IDEMPOTENCY_CONFLICT");
  assert.equal(codeOf(() => createWishOffer(db, 1, listing.post_id, "missingwishtokenxx", { idempotencyKey: "offer-key-idm-x" })), "IDEMPOTENCY_CONFLICT");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wish_offers").get().n, 1);
  db.close();
});

test("accept decline and withdraw fail-closed after TTL without worker", () => {
  const db = open();
  const { listing, wish } = seedPair(db);
  const acceptOffer = createWishOffer(db, 1, listing.post_id, wish.public_token, { idempotencyKey: "offer-key-ttl-a" });
  db.prepare("UPDATE wish_offers SET expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", acceptOffer.id);
  const now = new Date("2026-09-17T00:00:00.000Z");
  assert.equal(codeOf(() => acceptWishOffer(db, 2, acceptOffer.public_token, { now })), "offer_expired");
  assert.equal(db.prepare("SELECT status FROM wish_offers WHERE id = ?").get(acceptOffer.id).status, "expired");
  assert.equal(codeOf(() => acceptWishOffer(db, 2, acceptOffer.public_token, { now })), "offer_conflict");

  const listingB = createSelfListing(db, 1, listingInput({ title: "士林第二間套房", address: "中正路200號" }));
  const declineOffer = createWishOffer(db, 1, listingB.post_id, wish.public_token, { idempotencyKey: "offer-key-ttl-d" });
  db.prepare("UPDATE wish_offers SET expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", declineOffer.id);
  assert.equal(codeOf(() => declineWishOffer(db, 2, declineOffer.public_token, { now })), "offer_expired");
  assert.equal(db.prepare("SELECT status FROM wish_offers WHERE id = ?").get(declineOffer.id).status, "expired");

  const listingC = createSelfListing(db, 1, listingInput({ title: "士林第三間套房", address: "中正路300號" }));
  const withdrawOffer = createWishOffer(db, 1, listingC.post_id, wish.public_token, { idempotencyKey: "offer-key-ttl-w" });
  db.prepare("UPDATE wish_offers SET expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", withdrawOffer.id);
  assert.equal(codeOf(() => withdrawWishOffer(db, 1, withdrawOffer.public_token, { now })), "offer_expired");
  assert.equal(db.prepare("SELECT status FROM wish_offers WHERE id = ?").get(withdrawOffer.id).status, "expired");
  db.close();
});

test("accepted stays active and cannot resend after cooldown until terminalized", () => {
  const db = open();
  const { listing, wish } = seedPair(db);
  const createdAt = new Date("2026-09-01T00:00:00.000Z");
  const later = new Date(createdAt.getTime() + OFFER_SAME_WISH_COOLDOWN_MS + 24 * 60 * 60 * 1000);
  const offer = createWishOffer(db, 1, listing.post_id, wish.public_token, {
    idempotencyKey: "offer-key-actv1",
    now: createdAt,
  });
  acceptWishOffer(db, 2, offer.public_token, { now: createdAt });
  assert.equal(codeOf(() => createWishOffer(db, 1, listing.post_id, wish.public_token, {
    idempotencyKey: "offer-key-actv2",
    now: createdAt,
  })), "offer_already_active");
  assert.equal(codeOf(() => createWishOffer(db, 1, listing.post_id, wish.public_token, {
    idempotencyKey: "offer-key-actv3",
    now: later,
  })), "offer_already_active");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wish_offers").get().n, 1);
  assert.equal(db.prepare("SELECT status FROM wish_offers WHERE id = ?").get(offer.id).status, "accepted");
  const card = attachOfferCtas(db, [{ wish_ref: wish.public_token }], {
    listingId: listing.post_id,
    ownerUserId: 1,
    now: later,
  })[0];
  assert.equal(card.offer_available, false);
  assert.equal(card.offer_status, "accepted");

  applyWishLifecycleAction(db, 2, wish.public_token, "pause");
  assert.equal(db.prepare("SELECT status FROM wish_offers WHERE id = ?").get(offer.id).status, "expired");
  applyWishLifecycleAction(db, 2, wish.public_token, "resume");
  const resent = createWishOffer(db, 1, listing.post_id, wish.public_token, {
    idempotencyKey: "offer-key-actv4",
    now: later,
  });
  assert.equal(resent.status, "pending");
  assert.notEqual(resent.id, offer.id);
  db.close();
});

test("offer list keyset stays bounded at 10k rows", () => {
  const db = open();
  const { listing, wish } = seedPair(db);
  const insert = db.prepare(`
    INSERT INTO wish_offers(
      public_token, wish_id, listing_id, owner_user_id, tenant_user_id, status,
      idempotency_key, created_at, updated_at, expires_at, declined_at, version
    ) VALUES (?, ?, ?, 1, 2, 'declined', NULL, ?, ?, ?, ?, 1)
  `);
  db.exec("BEGIN");
  for (let i = 0; i < 10000; i += 1) {
    const created = new Date(Date.parse("2026-01-01T00:00:00.000Z") + (i * 1000)).toISOString();
    insert.run(
      `bulk${String(i).padStart(6, "0")}tok`,
      wish.id,
      listing.post_id,
      created,
      created,
      "2026-12-01T00:00:00.000Z",
      created,
    );
  }
  db.exec("COMMIT");
  const pending = createWishOffer(db, 1, listing.post_id, wish.public_token, { idempotencyKey: "offer-key-10k01" });
  const owner = listOwnerWishOffers(db, 1, { limit: 20 });
  const ownerStats = lastWishOfferListStats();
  assert.equal(owner.total, 10001);
  assert.equal(owner.items.length, 20);
  assert.equal(owner.items[0].offer_ref, pending.public_token);
  assert.equal(ownerStats.counted, true);
  assert.equal(ownerStats.count_queries, 1);
  assert.ok(ownerStats.fetched <= 21);
  assert.ok(ownerStats.projected <= 20);
  assert.equal(wishOfferQueryMemory().snapshots, 0);
  assert.ok(owner.next_cursor);
  assert.doesNotMatch(String(owner.next_cursor), /created_at|"id":/);

  const owner2 = listOwnerWishOffers(db, 1, { limit: 20, cursor: owner.next_cursor });
  const owner2Stats = lastWishOfferListStats();
  assert.equal(owner2.items.length, 20);
  assert.notEqual(owner2.items[0].offer_ref, owner.items[0].offer_ref);
  assert.equal(owner.items.some((item) => item.offer_ref === owner2.items[0].offer_ref), false);
  assert.ok(owner2Stats.fetched <= 21);
  assert.ok(owner2Stats.projected <= 20);
  assert.equal(owner2.total, 10001);
  assert.equal(owner2Stats.counted, false);
  assert.equal(owner2Stats.pending_counted, false);
  assert.equal(owner2Stats.count_queries, 0);
  assert.equal(codeOf(() => listOwnerWishOffers(db, 1, { limit: 20, cursor: owner.next_cursor })), "cursor_expired");
  assert.equal(codeOf(() => listTenantWishOffers(db, 2, { limit: 20, cursor: owner2.next_cursor })), "cursor_expired");

  const inbox = listTenantWishOffers(db, 2, { limit: 20 });
  const inboxStats = lastWishOfferListStats();
  assert.equal(inbox.total, 10001);
  assert.equal(inbox.pending_count, 1);
  assert.equal(inbox.items.length, 20);
  assert.equal(inboxStats.counted, true);
  assert.equal(inboxStats.pending_counted, true);
  assert.equal(inboxStats.count_queries, 2);
  assert.ok(inboxStats.fetched <= 21);
  assert.ok(inboxStats.projected <= 20);
  const inbox2 = listTenantWishOffers(db, 2, { limit: 20, cursor: inbox.next_cursor });
  const inbox2Stats = lastWishOfferListStats();
  assert.equal(inbox2.total, 10001);
  assert.equal(inbox2.pending_count, 1);
  assert.equal(inbox2Stats.counted, false);
  assert.equal(inbox2Stats.pending_counted, false);
  assert.equal(inbox2Stats.count_queries, 0);
  assert.ok(inbox2Stats.fetched <= 21);
  assert.ok(inbox2Stats.projected <= 20);

  const plans = explainWishOfferPlans(db);
  const text = JSON.stringify(plans);
  assert.match(text, /idx_wish_offers_owner_keyset|idx_wish_offers_owner_created|idx_wish_offers_owner_status/);
  assert.match(text, /idx_wish_offers_tenant_status_keyset|idx_wish_offers_tenant_inbox|idx_wish_offers_tenant_keyset/);
  db.close();
});
