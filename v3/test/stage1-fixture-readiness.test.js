import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { defaultCatalog } from "../src/rentalCatalog.js";
import {
  applyWishLifecycleAction,
  createDemandPost,
  ensureDemandSchema,
  getDemandPost,
  listDemandPosts,
  setRentalCatalogCache,
  setRentalMarketplaceFlags,
} from "../src/demand.js";
import { registerUser, deleteUser } from "../src/members.js";
import { ensurePersonalSchema } from "../src/personalSchema.js";
import {
  closeSelfListing,
  createSelfListing,
  ensureSelfListingSchema,
  getSelfListing,
  setSelfListingCatalog,
} from "../src/selfListings.js";
import {
  evaluateCounterfactualMatch,
  evaluateMatch,
  isCounterfactuallyMatchable,
  listingMatchSnapshot,
  wishMatchSnapshot,
} from "../src/rentalMatch.js";
import {
  clearRentalMatchCache,
  computeListingMatches,
  setRentalMatchHydrate,
} from "../src/rentalMatchQuery.js";
import {
  LISTING_SURFACE,
  WISH_SURFACE,
  listingVisibleOnSurface,
  wishVisibleOnSurface,
} from "../src/stage1FixtureIsolation.js";
import {
  STAGE1_FIXTURE_EMAILS,
  STAGE1_FIXTURE_NAMESPACE,
  authorizeFixtureMaturity,
  ensureStage1FixtureSchema,
  isFixtureMaturityAuthorized,
  registerFixtureRow,
  STAGE1_FIXTURE_KIND,
  STAGE1_FIXTURE_ROLE,
} from "../src/stage1FixtureRegistry.js";
import {
  FIXTURE_CLEANUP_FAILED,
  cleanupStage1Fixtures,
  listingFixtureInput,
  prepareStage1Fixtures,
  reapStaleStage1Fixtures,
  runStage1FixtureDomain,
  verifyStage1Fixtures,
} from "../src/stage1FixtureOps.js";
import {
  loadProductionFixtures,
  loadRegistryBoundFixtures,
} from "../../.github/scripts/activate-rental-marketplace-stage1-postcheck.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FLAGS = {
  rental_catalog_v2: { enabled: true },
  wish: {
    lifecycle_enabled: true,
    owner_matching_enabled: false,
    offer_enabled: false,
    public_share_v2_enabled: false,
    owner_notifications_enabled: false,
    notifications_enabled: false,
    digest_enabled: false,
    outbound_mail_enabled: false,
    outbound_push_enabled: false,
  },
};

function hydrate() {
  setRentalMarketplaceFlags(FLAGS);
  setRentalCatalogCache(defaultCatalog());
  setSelfListingCatalog(defaultCatalog(), FLAGS);
  setRentalMatchHydrate(defaultCatalog(), { ...FLAGS, wish: { ...FLAGS.wish, owner_matching_enabled: true } });
  clearRentalMatchCache();
}

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
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
  ensurePersonalSchema(db);
  ensureDemandSchema(db);
  ensureSelfListingSchema(db);
  ensureStage1FixtureSchema(db);
  hydrate();
  return db;
}

function deps() {
  return {
    registerUser,
    deleteUser,
    createSelfListing,
    closeSelfListing,
    getSelfListing,
    createDemandPost,
    applyWishLifecycleAction,
    listDemandPosts,
    getDemandPost,
    evaluateCounterfactualMatch,
    isCounterfactuallyMatchable,
  };
}

test("normal new user 24h gate is unchanged and input fields cannot skip it", () => {
  const db = open();
  const fresh = registerUser(db, {
    email: "fresh@example.com",
    password: "demopass123",
    acceptDisclaimer: true,
    emailVerified: true,
  });
  assert.throws(
    () => createSelfListing(db, fresh.id, listingFixtureInput("run"), new Date()),
    /24 小時/,
  );
  assert.throws(
    () => createSelfListing(db, fresh.id, {
      ...listingFixtureInput("run"),
      skip_wait: true,
      mature: true,
      fixture: true,
    }, new Date(), { skip_wait: true, maturity: { skip: true } }),
    /24 小時/,
  );
  assert.equal(isFixtureMaturityAuthorized(db, fresh.id, new Date(), { skip: true }), false);
  db.close();
});

test("only an active registry-bound fixture user can use the maturity exception", () => {
  const db = open();
  const now = new Date();
  const user = registerUser(db, {
    email: STAGE1_FIXTURE_EMAILS.owner_a,
    password: "demopass123",
    acceptDisclaimer: true,
    emailVerified: true,
  });
  assert.throws(() => authorizeFixtureMaturity(db, user.id, now), /active unexpired registry user/);
  registerFixtureRow(db, {
    runId: "stage1-fix:test:maturity",
    kind: STAGE1_FIXTURE_KIND.USER,
    role: STAGE1_FIXTURE_ROLE.OWNER_A,
    rowId: user.id,
    now,
  });
  const maturity = authorizeFixtureMaturity(db, user.id, now);
  const listing = createSelfListing(db, user.id, listingFixtureInput("maturity"), now, { maturity });
  assert.ok(listing.post_id);
  const stored = db.prepare("SELECT first_seen_at, self_expires_at FROM listings WHERE post_id = ?").get(listing.post_id);
  assert.ok(Date.parse(stored.first_seen_at) <= now.getTime() + 1000);
  assert.ok(Date.parse(stored.first_seen_at) >= now.getTime() - 1000);
  db.close();
});

test("fixture listing/wish are invisible on product surfaces and fail-closed for strangers", () => {
  const db = open();
  const prepared = prepareStage1Fixtures(db, deps(), { now: new Date(), runId: "stage1-fix:test:iso", flags: FLAGS });
  const listing = prepared.bundle.listing;
  const wish = prepared.bundle.wishByRole.wish_active.row;
  assert.equal(listingVisibleOnSurface(listing, { surface: LISTING_SURFACE.BROWSE }), false);
  assert.equal(listingVisibleOnSurface(listing, { surface: LISTING_SURFACE.PUBLIC_DETAIL }), false);
  assert.equal(listingVisibleOnSurface(listing, { surface: LISTING_SURFACE.MEMBER_DETAIL }), false);
  assert.equal(listingVisibleOnSurface(listing, { surface: LISTING_SURFACE.SHARE_GO }), false);
  assert.equal(listingVisibleOnSurface(listing, {
    surface: LISTING_SURFACE.OWNER_SELF,
    viewerId: prepared.bundle.owner.id,
  }), true);
  assert.equal(wishVisibleOnSurface(wish, { surface: WISH_SURFACE.PUBLIC_LIST }), false);
  assert.equal(wishVisibleOnSurface(wish, { surface: WISH_SURFACE.PUBLIC_DETAIL }), false);
  assert.throws(() => getSelfListing(db, listing.post_id, { viewerId: 0 }), /找不到這則站內刊登/);
  assert.throws(() => getSelfListing(db, listing.post_id, { viewerId: prepared.bundle.other.id }), /找不到這則站內刊登/);
  assert.equal(getSelfListing(db, listing.post_id, { viewerId: prepared.bundle.owner.id }).post_id, listing.post_id);
  assert.throws(
    () => getDemandPost(db, wish.public_token, { viewerId: 0, publicOnly: true }),
    /找不到這則許願房/,
  );
  const publicList = listDemandPosts(db, { viewerId: 0 });
  assert.equal(publicList.some((row) => Number(row.id) === Number(wish.id)), false);
  db.close();
});

test("match engine isolates fixture and normal worlds", () => {
  const db = open();
  const now = new Date();
  const born = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  db.prepare("INSERT INTO users(email, password_hash, created_at) VALUES (?, ?, ?)").run("old-owner@example.com", "x", born.toISOString());
  db.prepare("INSERT INTO users(email, password_hash, created_at) VALUES (?, ?, ?)").run("old-tenant@example.com", "x", born.toISOString());
  const normalListing = createSelfListing(db, 1, listingFixtureInput("normal", { title: "正式士林整層可看屋" }), now);
  const normalWish = createDemandPost(db, 2, {
    districts: ["1-8"],
    rent_max: 30000,
    body: "正式租客找士林整層",
  }, now);
  const prepared = prepareStage1Fixtures(db, deps(), { now, runId: "stage1-fix:test:match", flags: FLAGS });
  const fixtureListing = prepared.bundle.listing;
  const fixtureWish = prepared.bundle.wishByRole.wish_active.row;
  const catalog = defaultCatalog();
  const normalSnap = listingMatchSnapshot(normalListing, { catalog });
  const fixtureSnap = listingMatchSnapshot(fixtureListing, { catalog });
  const matchOpts = { catalog, now };
  assert.equal(evaluateMatch(normalSnap, wishMatchSnapshot(normalWish, { catalog }), matchOpts).eligible, true);
  assert.equal(evaluateMatch(fixtureSnap, wishMatchSnapshot(fixtureWish, { catalog }), matchOpts).eligible, true);
  assert.equal(evaluateMatch(normalSnap, wishMatchSnapshot(fixtureWish, { catalog }), matchOpts).eligible, false);
  assert.equal(evaluateMatch(fixtureSnap, wishMatchSnapshot(normalWish, { catalog }), matchOpts).eligible, false);
  const fixtureMatches = computeListingMatches(db, fixtureSnap, { now });
  assert.ok(fixtureMatches.items.some((item) => item.wish_ref === fixtureWish.public_token));
  assert.equal(fixtureMatches.items.some((item) => item.wish_ref === normalWish.public_token), false);
  const normalMatches = computeListingMatches(db, normalSnap, { now });
  assert.ok(normalMatches.items.some((item) => item.wish_ref === normalWish.public_token));
  assert.equal(normalMatches.items.some((item) => item.wish_ref === fixtureWish.public_token), false);
  db.close();
});

test("prepare verifies counterfactual suppression and hard-conflict negative control", () => {
  const db = open();
  const prepared = prepareStage1Fixtures(db, deps(), { now: new Date(), runId: "stage1-fix:test:cf", flags: FLAGS });
  const listing = prepared.bundle.listing;
  assert.equal(isCounterfactuallyMatchable(listing, prepared.bundle.wishByRole.wish_paused.row), true);
  assert.equal(isCounterfactuallyMatchable(listing, prepared.bundle.wishByRole.wish_completed.row), true);
  assert.equal(isCounterfactuallyMatchable(listing, prepared.bundle.wishByRole.wish_inactive.row), true);
  assert.equal(isCounterfactuallyMatchable(listing, prepared.bundle.wishByRole.wish_hard_conflict.row), false);
  const selected = loadRegistryBoundFixtures(db, {
    evaluateCounterfactualMatch,
    isCounterfactuallyMatchable,
  });
  assert.equal(selected.selector, "stage1_fixture_registry");
  assert.equal(selected.limit_80_used, false);
  assert.equal(selected.hard_conflict_rejected, true);
  assert.deepEqual(new Set(selected.suppressed.map((row) => row.class)), new Set(["paused", "completed", "inactive"]));
  db.close();
});

test("cleanup is exact-identity, idempotent, and cannot delete non-fixture rows", () => {
  const db = open();
  const now = new Date("2026-01-01T00:00:00.000Z");
  db.prepare("INSERT INTO users(email, password_hash, created_at) VALUES (?, ?, ?)").run("keeper@example.com", "x", now.toISOString());
  const prepared = prepareStage1Fixtures(db, deps(), { now: new Date(), runId: "stage1-fix:test:clean", flags: FLAGS });
  const listingId = prepared.bundle.listing.post_id;
  const first = cleanupStage1Fixtures(db, deps(), { now: new Date(), runId: prepared.run_id, flags: FLAGS });
  assert.equal(first.wildcard_email_like, false);
  const again = cleanupStage1Fixtures(db, deps(), { now: new Date(), runId: prepared.run_id, flags: FLAGS });
  assert.equal(again.empty || again.ok, true);
  const keeper = db.prepare("SELECT deleted_at FROM users WHERE email = ?").get("keeper@example.com");
  assert.equal(String(keeper.deleted_at || ""), "");
  const listing = db.prepare("SELECT self_status FROM listings WHERE post_id = ?").get(listingId);
  assert.notEqual(String(listing.self_status || ""), "open");
  db.close();
});

test("stale recovery reaps expired registry rows only", () => {
  const db = open();
  prepareStage1Fixtures(db, deps(), { now: new Date(), runId: "stage1-fix:test:stale", flags: FLAGS });
  db.prepare("UPDATE stage1_fixture_registry SET expires_at = ? WHERE cleaned_at IS NULL").run("2020-01-01T00:00:00.000Z");
  const reaped = reapStaleStage1Fixtures(db, deps(), { now: new Date(), flags: FLAGS });
  assert.ok(reaped.cleaned_count > 0);
  db.close();
});

test("fixture domain never mutates flags and loadProductionFixtures uses the registry", () => {
  const db = open();
  const flags = { current: structuredClone(FLAGS) };
  const prepared = runStage1FixtureDomain({
    db,
    getRentalMarketplaceFlags: () => flags.current,
    mode: "prepare",
    runId: "stage1-fix:test:domain",
    deps: deps(),
  });
  assert.equal(prepared.flags_mutated, false);
  assert.equal(prepared.after_raw_flags.wish.owner_matching_enabled, false);
  const selected = loadProductionFixtures(db, {
    evaluateCounterfactualMatch,
    isCounterfactuallyMatchable,
  });
  assert.equal(selected.selector, "stage1_fixture_registry");
  const src = readFileSync(path.join(root, "v3/src/stage1FixtureOps.js"), "utf8")
    + readFileSync(path.join(root, ".github/scripts/stage1-fixture-domain.mjs"), "utf8")
    + readFileSync(path.join(root, ".github/scripts/stage1-fixture-remote.sh"), "utf8");
  assert.doesNotMatch(src, /saveRentalMarketplaceFlags/);
  db.close();
});

test("cleanup failure keeps non-fixture rows and reports FIXTURE_CLEANUP_FAILED", () => {
  const db = open();
  prepareStage1Fixtures(db, deps(), { now: new Date(), runId: "stage1-fix:test:fail", flags: FLAGS });
  assert.throws(
    () => cleanupStage1Fixtures(db, {
      ...deps(),
      closeSelfListing() { throw new Error("boom"); },
    }, { now: new Date(), runId: "stage1-fix:test:fail", flags: FLAGS }),
    (error) => error.code === FIXTURE_CLEANUP_FAILED || String(error.message).includes(FIXTURE_CLEANUP_FAILED),
  );
  db.close();
});

test("durable Stage 1 failure evidence is written without becoming PASS", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "stage1-ev-"));
  const rollback = path.join(dir, "rollback.json");
  const out = path.join(dir, "out.json");
  writeFileSync(rollback, JSON.stringify({
    schema: "stage1-rollback-evidence-v1",
    rollback_used: true,
    rollback_ok: true,
    source_sha: "b9c6347660defb26cbc3948b1ed8c65725793a7a",
    image_digest: "sha256:eb90e49ca1fe8caff155d47cec865f26fbb345b3402246a2d9235f1bdc7dd8aa",
    reason: "no matchable self-listing with a living owner",
  }));
  const outText = execFileSync("python3", [path.join(root, ".github/scripts/write-stage1-activation-artifact.py")], {
    env: {
      ...process.env,
      STAGE1_CORE_PATH: path.join(dir, "missing-core.json"),
      STAGE1_ROLLBACK_PATH: rollback,
      STAGE1_EVIDENCE_OUT: out,
      SOURCE_SHA: "b9c6347660defb26cbc3948b1ed8c65725793a7a",
      IMAGE_DIGEST: "sha256:eb90e49ca1fe8caff155d47cec865f26fbb345b3402246a2d9235f1bdc7dd8aa",
      BACKUP_ID: "/DATA/AppData/591-tracker-v3-backups/predeploy-20260917-105925",
      BACKUP_HASH: "sha256:4fab759ab6ffb1daa2a607e4dc0e597007b9e9017be31d5c10db356053c9f6e3",
    },
    encoding: "utf8",
  });
  const doc = JSON.parse(readFileSync(out, "utf8"));
  assert.match(outText, /rolled_back:ok:false/);
  assert.equal(doc.ACTIVATION_OK, false);
  assert.equal(doc.activation_result, "rolled_back");
  assert.equal(doc.rollback_result, "ok");
  assert.doesNotMatch(JSON.stringify(doc), /@|09\d{8}|SESSION_SECRET/);
  rmSync(dir, { recursive: true, force: true });
});
