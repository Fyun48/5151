/**
 * Seed a local, throwaway evidence database for the PR D responsive pass (Issue #325).
 *
 * It writes only inside v3/evidence/pr-d-20260918/data and never touches Production,
 * the real data-v3/v3.db or any remote system.
 *
 * Run: node v3/evidence/pr-d-20260918/seed-local.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, "data");
mkdirSync(DATA_DIR, { recursive: true });

// The local evidence credential is generated per run (or taken from the environment)
// and written to a gitignored file. This script never assigns a credential into the
// environment or the repository; the operator passes AUTH_EMAIL / AUTH_PASSWORD to the
// server when starting it (see README.md).
const EVIDENCE_PASSWORD = process.env.EVIDENCE_PASSWORD || `Local-${randomBytes(18).toString("base64url")}`;

process.env.DATA_DIR = DATA_DIR;
process.env.PORT = "5199";

const NOW = new Date();
const DAY = 86400000;

const { db, saveRentalMarketplaceFlags } = await import("../../src/db.js");
const { registerUser } = await import("../../src/members.js");
const { defaultCatalog } = await import("../../src/rentalCatalog.js");
const { setSelfListingCatalog, createSelfListing } = await import("../../src/selfListings.js");
const { createDemandPost, setRentalCatalogCache, setRentalMarketplaceFlags } = await import("../../src/demand.js");
const {
  ensureRentalNotifySchema, saveRentalNotifyPrefs, emitRentalNotifyEvent, addDigestItem,
  setRentalNotifyHydrate, bumpAnalytics,
} = await import("../../src/rentalNotify.js");
const { submitCompletionSurvey } = await import("../../src/rentalSurvey.js");
const { hashPassword } = await import("../../src/password.js");

const FLAGS = {
  rental_catalog_v2: { enabled: true },
  wish: {
    lifecycle_enabled: true,
    owner_matching_enabled: true,
    offer_enabled: true,
    public_share_v2_enabled: true,
    owner_notifications_enabled: true,
    notifications_enabled: true,
    digest_enabled: true,
    outbound_mail_enabled: false,
    outbound_push_enabled: false,
  },
};

const catalog = defaultCatalog();
setRentalMarketplaceFlags(FLAGS);
setRentalCatalogCache(catalog);
setSelfListingCatalog(catalog, FLAGS);
setRentalNotifyHydrate(FLAGS);
saveRentalMarketplaceFlags(FLAGS);
ensureRentalNotifySchema(db);

function makeUser(email, nickname, password) {
  let user = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (!user) user = registerUser(db, { email, password, acceptDisclaimer: true, acceptPrivacy: true, emailVerified: true });
  db.prepare("UPDATE users SET nickname = ?, password_hash = ?, created_at = ? WHERE id = ?")
    .run(nickname, hashPassword(password), new Date(NOW.getTime() - 30 * DAY).toISOString(), user.id);
  return Number(user.id);
}

const ownerId = makeUser("owner@evidence.test", "屋主阿明", EVIDENCE_PASSWORD);
const tenantId = makeUser("tenant@evidence.test", "租客小美", EVIDENCE_PASSWORD);

const listing = createSelfListing(db, ownerId, {
  district: "1-8",
  street: "中正路100號",
  rent: 24000,
  ping: 22,
  kind: "whole",
  role: "owner",
  floor: 3,
  total_floors: 5,
  rooms: 3,
  living: 1,
  bath: 2,
  title: "士林捷運 3 房電梯含車位",
  body: "近士林捷運站，三房兩衛，附車位，可養寵物，生活機能佳，適合家庭承租。",
  contact_name: "屋主阿明",
  accept_pledge: true,
  listing_values: { need_pet: "allowed", need_cook: "allowed" },
}, NOW);

// The completed wish is created first: demand_posts allows only one open/draft wish per user.
const done = createDemandPost(db, tenantId, {
  districts: ["1-8"],
  rent_max: 20000,
  housing_type: "suite",
  layout: "1",
  body: "已找到房子，感謝平台。",
}, NOW);
db.prepare("UPDATE demand_posts SET lifecycle = 'completed', status = 'closed' WHERE id = ?").run(done.id);

const wish = createDemandPost(db, tenantId, {
  districts: ["1-8"],
  rent_max: 28000,
  housing_type: "whole",
  layout: "3",
  ping_min: 18,
  body: "小家庭找士林捷運附近三房，需可養寵物與開伙。",
  condition_choices: { need_pet: "want", need_cook: "want" },
  choices: { need_pet: "want", need_cook: "want" },
}, NOW);

const offerToken = "evidenceoffer000000000000000000".slice(0, 32);
db.prepare(`
  INSERT INTO wish_offers(public_token, wish_id, listing_id, owner_user_id, tenant_user_id, status,
    created_at, updated_at, expires_at)
  VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
`).run(
  offerToken,
  wish.id,
  listing.post_id,
  ownerId,
  tenantId,
  new Date(NOW.getTime() - 3600000).toISOString(),
  new Date(NOW.getTime() - 1800000).toISOString(),
  new Date(NOW.getTime() + 3 * DAY).toISOString(),
);

saveRentalNotifyPrefs(db, ownerId, { lifecycle_reminder: true, channel_dock: true, offer_transactional: true });
saveRentalNotifyPrefs(db, tenantId, { lifecycle_reminder: true, channel_dock: true, offer_transactional: true });

for (let i = 0; i < 6; i += 1) {
  emitRentalNotifyEvent(db, {
    eventType: i % 2 === 0 ? "owner_new_match_available" : "wish_lifecycle_due_3d",
    userId: i % 2 === 0 ? ownerId : tenantId,
    eventKey: `evidence-event-${i}`,
    subjectType: "listing",
    subjectRef: String(listing.post_id),
    listingId: listing.post_id,
    now: new Date(NOW.getTime() - i * 3600000),
  });
}
addDigestItem(db, { userId: ownerId, eventId: 1, listingId: listing.post_id, wishRef: wish.public_token, now: NOW });
try {
  submitCompletionSurvey(db, tenantId, db.prepare("SELECT * FROM demand_posts WHERE id = ?").get(done.id), {
    found_via_site: "yes",
    via_feature: "wish_match",
    detail: "配對通知幫上忙",
  }, NOW);
} catch (error) {
  console.log("survey seed skipped:", String(error.message || error));
}
for (let i = 0; i < 30; i += 1) {
  const when = new Date(NOW.getTime() - i * DAY);
  bumpAnalytics(db, "notify_generated", when, 3 + (i % 5));
  bumpAnalytics(db, "notify_queued", when, 2 + (i % 4));
  bumpAnalytics(db, "owner_match_viewed", when, 1 + (i % 3));
}

console.log(JSON.stringify({
  data_dir: DATA_DIR,
  credentials_file: path.join(DATA_DIR, "credentials.json"),
  owner_id: ownerId,
  tenant_id: tenantId,
  listing_post_id: listing.post_id,
  wish_id: wish.id,
  wish_token: wish.public_token,
  offer_token: offerToken,
  counts: {
    users: db.prepare("SELECT COUNT(*) AS n FROM users").get().n,
    listings: db.prepare("SELECT COUNT(*) AS n FROM listings").get().n,
    wishes: db.prepare("SELECT COUNT(*) AS n FROM demand_posts").get().n,
    offers: db.prepare("SELECT COUNT(*) AS n FROM wish_offers").get().n,
    events: db.prepare("SELECT COUNT(*) AS n FROM rental_notify_events").get().n,
    deliveries: db.prepare("SELECT COUNT(*) AS n FROM rental_notify_deliveries").get().n,
    analytics: db.prepare("SELECT COUNT(*) AS n FROM rental_analytics_daily").get().n,
  },
}, null, 2));
writeFileSync(
  path.join(DATA_DIR, "credentials.json"),
  `${JSON.stringify({
    owner: "owner@evidence.test",
    tenant: "tenant@evidence.test",
    password: EVIDENCE_PASSWORD,
    note: "local evidence only; gitignored",
  }, null, 2)}\n`,
);
db.close();
