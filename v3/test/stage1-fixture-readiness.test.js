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
  STAGE1_FIXTURE_NAMESPACE,
  authorizeFixtureIsolation,
  authorizeFixtureMaturity,
  ensureStage1FixtureSchema,
  fixtureEmailForRole,
  isFixtureMaturityAuthorized,
  makeStage1FixtureRunId,
  registerFixtureRow,
  STAGE1_FIXTURE_KIND,
  STAGE1_FIXTURE_ROLE,
} from "../src/stage1FixtureRegistry.js";
import {
  FIXTURE_CLEANUP_FAILED,
  cleanupStage1Fixtures,
  listingFixtureInput,
  prepareStage1Fixtures,
  randomFixturePassword,
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
    email: "maturity-owner@example.com",
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

test("P1-8 cleanup-activated succeeds with owner_matching=true and does not mutate flags", () => {
  const db = open();
  prepareStage1Fixtures(db, deps(), {
    now: new Date(),
    runId: "stage1-fix:test:p18",
    flags: FLAGS,
  });
  const activated = structuredClone({ ...FLAGS, wish: { ...FLAGS.wish, owner_matching_enabled: true } });
  const flags = { current: activated };
  const doc = runStage1FixtureDomain({
    db,
    getRentalMarketplaceFlags: () => flags.current,
    mode: "cleanup-activated",
    runId: "stage1-fix:test:p18",
    deps: deps(),
  });
  assert.equal(doc.flags_mutated, false);
  assert.equal(doc.owner_matching_enabled, true);
  assert.equal(doc.result.ok, true);
  assert.deepEqual(flags.current, activated);
  const openListings = db.prepare(
    "SELECT post_id FROM listings WHERE fixture_namespace = ? AND COALESCE(self_status, 'open') = 'open'",
  ).all(STAGE1_FIXTURE_NAMESPACE);
  assert.equal(openListings.length, 0);
  const openWishes = db.prepare(
    "SELECT id FROM demand_posts WHERE fixture_namespace = ? AND status = 'open'",
  ).all(STAGE1_FIXTURE_NAMESPACE);
  assert.equal(openWishes.length, 0);
  const active = db.prepare(
    "SELECT id FROM stage1_fixture_registry WHERE cleaned_at IS NULL AND status = 'active'",
  ).all();
  assert.equal(active.length, 0);
  db.close();
});
test("P2 fixture user creation and registry binding are atomic (no orphan, retry unblocked)", () => {
  const db = open();
  const runId = "stage1-fix:test:p2-atomic";
  assert.throws(
    () => prepareStage1Fixtures(db, {
      ...deps(),
      userIsolation: {
        onAfterUserCreate() { throw new Error("inject-after-user-create"); },
      },
    }, { now: new Date(), runId, flags: FLAGS }),
    /inject-after-user-create/,
  );
  const email = fixtureEmailForRole(runId, STAGE1_FIXTURE_ROLE.OWNER_A);
  const orphan = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  assert.equal(orphan, undefined);
  const registry = db.prepare("SELECT id FROM stage1_fixture_registry WHERE run_id = ?").all(runId);
  assert.equal(registry.length, 0);
  const members = readFileSync(path.join(root, "v3/src/members.js"), "utf8");
  assert.match(members, /signups >= 2/);
  const retried = prepareStage1Fixtures(db, deps(), { now: new Date(), runId, flags: FLAGS });
  assert.equal(retried.ok, true);
  assert.equal(retried.run_id, runId);
  db.close();
});

test("P2 cleanup and reap never delete a normal user", () => {
  const db = open();
  const now = new Date("2026-01-01T00:00:00.000Z");
  db.prepare("INSERT INTO users(email, password_hash, created_at) VALUES (?, ?, ?)").run("normal-p2@example.com", "x", now.toISOString());
  const prepared = prepareStage1Fixtures(db, deps(), { now: new Date(), runId: "stage1-fix:test:p2-normal", flags: FLAGS });
  cleanupStage1Fixtures(db, deps(), { now: new Date(), runId: prepared.run_id, flags: FLAGS });
  reapStaleStage1Fixtures(db, deps(), { now: new Date(), flags: FLAGS });
  const keeper = db.prepare("SELECT deleted_at FROM users WHERE email = ?").get("normal-p2@example.com");
  assert.equal(String(keeper.deleted_at || ""), "");
  db.close();
});




test("P1-10 a cleaned fixture run leaves zero active rows so the fixture-dependent selector cannot run", () => {
  const db = open();
  const prepared = prepareStage1Fixtures(db, deps(), { now: new Date(), runId: "stage1-fix:test:p110", flags: FLAGS });
  cleanupStage1Fixtures(db, deps(), { now: new Date(), runId: prepared.run_id, flags: FLAGS });
  const active = db.prepare(
    "SELECT id FROM stage1_fixture_registry WHERE cleaned_at IS NULL AND status = 'active'",
  ).all();
  assert.equal(active.length, 0);
  // The registry-bound post-activation selector used by run_post_activation_probes
  // is therefore unusable after a successful cleanup: verify-only must not need it.
  assert.throws(
    () => loadRegistryBoundFixtures(db, { evaluateCounterfactualMatch, isCounterfactuallyMatchable }),
    /no active fixtures|must bind a single uncleaned run_id/,
  );
  db.close();
});


test("P2-13 the whole A/B/T account phase is one transaction (no partial accounts)", () => {
  const db = open();
  const runId = "stage1-fix:test:p213";
  assert.throws(
    () => prepareStage1Fixtures(db, {
      ...deps(),
      userIsolation: {
        onAfterUserCreate({ role }) {
          if (role === STAGE1_FIXTURE_ROLE.OTHER_B) throw new Error("inject-after-b");
        },
      },
    }, { now: new Date(), runId, flags: FLAGS }),
    /inject-after-b/,
  );
  // A had already been created before B threw, but the whole phase must roll back.
  const emailA = fixtureEmailForRole(runId, STAGE1_FIXTURE_ROLE.OWNER_A);
  const anyUser = db.prepare("SELECT id FROM users WHERE email = ?").get(emailA);
  assert.equal(anyUser, undefined);
  const registry = db.prepare("SELECT id FROM stage1_fixture_registry WHERE run_id = ?").all(runId);
  assert.equal(registry.length, 0);
  // Retry of the same run completes deterministically from a clean slate.
  const retried = prepareStage1Fixtures(db, deps(), { now: new Date(), runId, flags: FLAGS });
  assert.equal(retried.ok, true);
  assert.equal(retried.run_id, runId);
  db.close();
});

test("P2-13 a leftover run stays fail-closed for a different run until cleaned", () => {
  const db = open();
  const now = new Date("2026-01-01T00:00:00.000Z");
  db.prepare("INSERT INTO users(email, password_hash, created_at) VALUES (?, ?, ?)").run("normal-p213@example.com", "x", now.toISOString());
  prepareStage1Fixtures(db, deps(), { now: new Date(), runId: "stage1-fix:test:p213-a", flags: FLAGS });
  assert.throws(
    () => prepareStage1Fixtures(db, deps(), { now: new Date(), runId: "stage1-fix:test:p213-b", flags: FLAGS }),
    /uncleaned fixture run exists/,
  );
  cleanupStage1Fixtures(db, deps(), { now: new Date(), runId: "stage1-fix:test:p213-a", flags: FLAGS });
  reapStaleStage1Fixtures(db, deps(), { now: new Date(), flags: FLAGS });
  const fresh = prepareStage1Fixtures(db, deps(), { now: new Date(), runId: "stage1-fix:test:p213-b", flags: FLAGS });
  assert.equal(fresh.ok, true);
  // cleanup/reap never touch normal users.
  const keeper = db.prepare("SELECT deleted_at FROM users WHERE email = ?").get("normal-p213@example.com");
  assert.equal(String(keeper.deleted_at || ""), "");
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
  assert.doesNotMatch(JSON.stringify(doc), /@|(?<!\d)09\d{8}(?!\d)|SESSION_SECRET/);
  rmSync(dir, { recursive: true, force: true });
});

test("P1-1 fixture passwords are random and never stored in repo or evidence", () => {
  const first = randomFixturePassword();
  const second = randomFixturePassword();
  assert.notEqual(first, second);
  assert.ok(first.length >= 24);
  const repo = [
    "v3/src/stage1FixtureOps.js",
    "v3/src/stage1FixtureRegistry.js",
    ".github/scripts/stage1-fixture-domain.mjs",
    ".github/scripts/stage1-fixture-remote.sh",
    "v3/STAGE1-FIXTURE-READINESS.md",
  ].map((file) => readFileSync(path.join(root, file), "utf8")).join("\n");
  assert.doesNotMatch(repo, /STAGE1_FIXTURE_PASSWORD|Stage1Fixture#Readiness-72h/);
  assert.match(readFileSync(path.join(root, "v3/src/stage1FixtureOps.js"), "utf8"), /randomBytes\(32\)/);
  assert.doesNotMatch(readFileSync(path.join(root, "v3/src/stage1FixtureOps.js"), "utf8"), /stampFixtureNamespace/);
  const db = open();
  const prepared = prepareStage1Fixtures(db, deps(), { now: new Date(), runId: "stage1-fix:test:pwd", flags: FLAGS });
  assert.doesNotMatch(JSON.stringify(prepared.evidence), /Fx!|password/);
  const registryBlob = JSON.stringify(db.prepare("SELECT * FROM stage1_fixture_registry").all());
  assert.doesNotMatch(registryBlob, /Fx!|password|@jibby\.test/);
  db.close();
});

test("P1-2 fixture emails are per-run unique so signup_count cannot block the next run", () => {
  const a = fixtureEmailForRole("stage1-fix:run-a", STAGE1_FIXTURE_ROLE.OWNER_A);
  const b = fixtureEmailForRole("stage1-fix:run-b", STAGE1_FIXTURE_ROLE.OWNER_A);
  assert.notEqual(a, b);
  assert.match(a, /@jibby\.test$/);
  const db = open();
  const first = prepareStage1Fixtures(db, deps(), { now: new Date(), runId: "stage1-fix:test:email-a", flags: FLAGS });
  cleanupStage1Fixtures(db, deps(), { now: new Date(), runId: first.run_id, flags: FLAGS });
  const second = prepareStage1Fixtures(db, deps(), { now: new Date(), runId: "stage1-fix:test:email-b", flags: FLAGS });
  assert.notEqual(first.evidence.accounts[0].email_hash, second.evidence.accounts[0].email_hash);
  db.close();
});

test("P1-3 fixture namespace lands in the same create write and user input cannot set it", () => {
  const db = open();
  const now = new Date();
  const owner = registerUser(db, {
    email: "iso-owner@example.com",
    password: "demopass123",
    acceptDisclaimer: true,
    emailVerified: true,
  });
  registerFixtureRow(db, {
    runId: "stage1-fix:test:iso-write",
    kind: STAGE1_FIXTURE_KIND.USER,
    role: STAGE1_FIXTURE_ROLE.OWNER_A,
    rowId: owner.id,
    now,
  });
  const ignored = createSelfListing(db, owner.id, {
    ...listingFixtureInput("iso-input"),
    fixture_namespace: STAGE1_FIXTURE_NAMESPACE,
  }, now, { maturity: authorizeFixtureMaturity(db, owner.id, now) });
  assert.equal(String(db.prepare("SELECT fixture_namespace FROM listings WHERE post_id = ?").get(ignored.post_id).fixture_namespace || ""), "");
  db.prepare("UPDATE listings SET self_status = 'closed' WHERE post_id = ?").run(ignored.post_id);
  const isolation = authorizeFixtureIsolation(db, owner.id, {
    now,
    runId: "stage1-fix:test:iso-write",
    kind: STAGE1_FIXTURE_KIND.LISTING,
    role: STAGE1_FIXTURE_ROLE.LISTING_A,
    rowId: 900000002,
  });
  const created = createSelfListing(db, owner.id, listingFixtureInput("iso-write"), now, { isolation });
  assert.equal(
    db.prepare("SELECT fixture_namespace FROM listings WHERE post_id = ?").get(created.post_id).fixture_namespace,
    STAGE1_FIXTURE_NAMESPACE,
  );
  db.close();
});

test("P1-2 ordinary member signup_count re-register rule is unchanged", () => {
  const db = open();
  const email = "reuse@example.com";
  const payload = {
    email,
    password: "demopass123",
    acceptDisclaimer: true,
    emailVerified: true,
  };
  const first = registerUser(db, payload);
  deleteUser(db, first.id, { by: "admin", reasonCode: "test", reason: "first delete" });
  const second = registerUser(db, payload);
  assert.equal(Number(second.id), Number(first.id));
  deleteUser(db, second.id, { by: "admin", reasonCode: "test", reason: "second delete" });
  assert.throws(() => registerUser(db, payload), /已刪除兩次/);
  const members = readFileSync(path.join(root, "v3/src/members.js"), "utf8");
  assert.match(members, /這個 Email 已刪除兩次，不能再註冊/);
  assert.match(members, /signups >= 2/);
  db.close();
});

test("P1-3 fault injection after registry before create leaves no public listing", () => {
  const db = open();
  assert.throws(
    () => prepareStage1Fixtures(db, {
      ...deps(),
      listingIsolation: {
        onAfterRegister() { throw new Error("inject-after-register"); },
      },
    }, { now: new Date(), runId: "stage1-fix:test:crash-reg", flags: FLAGS }),
    /inject-after-register/,
  );
  const openListings = db.prepare(
    "SELECT post_id FROM listings WHERE COALESCE(source, '591') = 'self' AND COALESCE(self_status, 'open') = 'open'",
  ).all();
  assert.equal(openListings.length, 0);
  db.close();
});

test("P1-3 fault injection before insert leaves no listing row", () => {
  const db = open();
  assert.throws(
    () => prepareStage1Fixtures(db, {
      ...deps(),
      listingIsolation: {
        onBeforeInsert() { throw new Error("inject-before-insert"); },
      },
    }, { now: new Date(), runId: "stage1-fix:test:crash-pre", flags: FLAGS }),
    /inject-before-insert/,
  );
  const listings = db.prepare(
    "SELECT post_id FROM listings WHERE COALESCE(source, '591') = 'self'",
  ).all();
  assert.equal(listings.length, 0);
  db.close();
});

test("P1-3 fault injection after create does not leak an untagged listing", () => {
  const db = open();
  assert.throws(
    () => prepareStage1Fixtures(db, {
      ...deps(),
      listingIsolation: {
        onAfterInsert() { throw new Error("inject-after-insert"); },
      },
    }, { now: new Date(), runId: "stage1-fix:test:crash-ins", flags: FLAGS }),
    /inject-after-insert/,
  );
  const leaked = db.prepare(
    "SELECT post_id, fixture_namespace FROM listings WHERE COALESCE(source, '591') = 'self'",
  ).all();
  assert.ok(leaked.every((row) => String(row.fixture_namespace || "") === STAGE1_FIXTURE_NAMESPACE));
  assert.equal(listDemandPosts(db, { viewerId: 0 }).length, 0);
  db.close();
});

test("P1-4 prepare fail-closes when another uncleaned run exists", () => {
  const db = open();
  prepareStage1Fixtures(db, deps(), { now: new Date(), runId: "stage1-fix:test:run-one", flags: FLAGS });
  assert.throws(
    () => prepareStage1Fixtures(db, deps(), { now: new Date(), runId: "stage1-fix:test:run-two", flags: FLAGS }),
    /uncleaned fixture run exists/,
  );
  registerFixtureRow(db, {
    runId: "stage1-fix:test:stale-other",
    kind: STAGE1_FIXTURE_KIND.USER,
    role: STAGE1_FIXTURE_ROLE.OWNER_A,
    rowId: 900000099,
    now: new Date(),
  });
  assert.throws(
    () => loadRegistryBoundFixtures(db, {
      evaluateCounterfactualMatch,
      isCounterfactuallyMatchable,
    }),
    /single uncleaned run_id/,
  );
  db.close();
});

test("P2-15 missing hard-conflict registry row fails the post-activation gate", () => {
  const db = open();
  prepareStage1Fixtures(db, deps(), { now: new Date(), runId: "stage1-fix:test:p215", flags: FLAGS });
  db.prepare("DELETE FROM stage1_fixture_registry WHERE role = 'wish_hard_conflict'").run();
  assert.throws(
    () => loadRegistryBoundFixtures(db, { evaluateCounterfactualMatch, isCounterfactuallyMatchable }),
    /exactly one hard-conflict registry row/,
  );
  db.close();
});

test("P2-15 a hard-conflict registry row without its wish row fails the gate", () => {
  const db = open();
  prepareStage1Fixtures(db, deps(), { now: new Date(), runId: "stage1-fix:test:p215b", flags: FLAGS });
  const hard = db.prepare("SELECT row_id FROM stage1_fixture_registry WHERE role = 'wish_hard_conflict'").get();
  db.prepare("DELETE FROM demand_posts WHERE id = ?").run(hard.row_id);
  assert.throws(
    () => loadRegistryBoundFixtures(db, { evaluateCounterfactualMatch, isCounterfactuallyMatchable }),
    /hard-conflict wish row is missing/,
  );
  db.close();
});

test("P2-15 an unexpectedly eligible hard-conflict control fails the gate", () => {
  const db = open();
  prepareStage1Fixtures(db, deps(), { now: new Date(), runId: "stage1-fix:test:p215c", flags: FLAGS });
  assert.throws(
    () => loadRegistryBoundFixtures(db, {
      evaluateCounterfactualMatch: () => ({ eligible: true, hard_conflicts: [] }),
      isCounterfactuallyMatchable,
    }),
    /hard-conflict control was eligible/,
  );
  db.close();
});

test("P2-20 the hard-conflict control must expose the intended condition:need_pet code", () => {
  const db = open();
  prepareStage1Fixtures(db, deps(), { now: new Date(), runId: "stage1-fix:test:p220", flags: FLAGS });
  const run = (evaluateCounterfactualMatch) => loadRegistryBoundFixtures(db, {
    evaluateCounterfactualMatch,
    isCounterfactuallyMatchable,
  });
  // valid fixture: exactly the intended condition conflict
  const valid = run(evaluateCounterfactualMatch);
  assert.equal(valid.hard_conflict_rejected, true);
  // district corruption => an unrelated conflict, the need_pet control was never exercised
  assert.throws(
    () => run(() => ({ eligible: false, hard_conflicts: [{ code: "district" }] })),
    /did not exercise condition:need_pet/,
  );
  // budget corruption => unrelated conflict
  assert.throws(
    () => run(() => ({ eligible: false, hard_conflicts: [{ code: "budget" }] })),
    /did not exercise condition:need_pet/,
  );
  // need_pet unexpectedly compatible => no conflict at all
  assert.throws(
    () => run(() => ({ eligible: false, hard_conflicts: [] })),
    /did not exercise condition:need_pet/,
  );
  // intended condition plus an extra unrelated conflict => fail closed
  assert.throws(
    () => run(() => ({ eligible: false, hard_conflicts: [{ code: "condition:need_pet" }, { code: "lifecycle" }] })),
    /unrelated conflicts \(lifecycle\)/,
  );
  db.close();
});

test("P1-16 the MAP surface hides fixture listings from every viewer", () => {
  const db = open();
  const prepared = prepareStage1Fixtures(db, deps(), { now: new Date(), runId: "stage1-fix:test:p116", flags: FLAGS });
  const listing = prepared.bundle.listing;
  assert.equal(listingVisibleOnSurface(listing, { surface: LISTING_SURFACE.MAP }), false);
  assert.equal(listingVisibleOnSurface(listing, { surface: LISTING_SURFACE.MAP, viewerId: prepared.bundle.owner.id }), false);
  assert.equal(listingVisibleOnSurface({ post_id: 1, source: "591" }, { surface: LISTING_SURFACE.MAP, viewerId: 7 }), true);
  db.close();
});

test("P2-17 retry of the same run completes after an aborted listing registration", () => {
  const db = open();
  const runId = "stage1-fix:test:p217a";
  assert.throws(
    () => prepareStage1Fixtures(db, {
      ...deps(),
      listingIsolation: { onAfterRegister() { throw new Error("inject-listing-reg"); } },
    }, { now: new Date(), runId, flags: FLAGS }),
    /inject-listing-reg/,
  );
  const retried = prepareStage1Fixtures(db, deps(), { now: new Date(), runId, flags: FLAGS });
  assert.equal(retried.ok, true);
  assert.equal(retried.run_id, runId);
  const openListings = db.prepare(
    "SELECT post_id FROM listings WHERE fixture_namespace = ? AND COALESCE(self_status, 'open') = 'open'",
  ).all(STAGE1_FIXTURE_NAMESPACE);
  assert.equal(openListings.length, 1);
  db.close();
});

test("P2-17 retry of the same run completes after an aborted wish registration", () => {
  const db = open();
  const runId = "stage1-fix:test:p217b";
  assert.throws(
    () => prepareStage1Fixtures(db, {
      ...deps(),
      wishIsolation: { onAfterRegister() { throw new Error("inject-wish-reg"); } },
    }, { now: new Date(), runId, flags: FLAGS }),
    /inject-wish-reg/,
  );
  const retried = prepareStage1Fixtures(db, deps(), { now: new Date(), runId, flags: FLAGS });
  assert.equal(retried.ok, true);
  assert.equal(retried.run_id, runId);
  db.close();
});

test("P2-17 retry reconciles a wish whose lifecycle transition did not complete", () => {
  const db = open();
  const runId = "stage1-fix:test:p217c";
  prepareStage1Fixtures(db, deps(), { now: new Date(), runId, flags: FLAGS });
  const reg = db.prepare(
    "SELECT row_id FROM stage1_fixture_registry WHERE run_id = ? AND role = 'wish_completed'",
  ).get(runId);
  // simulate a crash between the wish create and its complete transition
  db.prepare("UPDATE demand_posts SET lifecycle = 'active' WHERE id = ?").run(reg.row_id);
  assert.equal(db.prepare("SELECT lifecycle FROM demand_posts WHERE id = ?").get(reg.row_id).lifecycle, "active");
  const retried = prepareStage1Fixtures(db, deps(), { now: new Date(), runId, flags: FLAGS });
  assert.equal(retried.ok, true);
  assert.equal(db.prepare("SELECT lifecycle FROM demand_posts WHERE id = ?").get(reg.row_id).lifecycle, "completed");
  db.close();
});

test("P2-21 an onAfterInsert crash rolls the fixture listing back and retry recovers", () => {
  const db = open();
  const runId = "stage1-fix:test:p221";
  assert.throws(
    () => prepareStage1Fixtures(db, {
      ...deps(),
      listingIsolation: { onAfterInsert() { throw new Error("inject-after-insert-atomic"); } },
    }, { now: new Date(), runId, flags: FLAGS }),
    /inject-after-insert-atomic/,
  );
  // the deterministic idempotency key routes creation through withImmediate(),
  // so the half-written fixture listing must not survive the injected crash
  const leftover = db.prepare(
    "SELECT post_id FROM listings WHERE fixture_namespace = ?",
  ).all(STAGE1_FIXTURE_NAMESPACE);
  assert.equal(leftover.length, 0);
  const retried = prepareStage1Fixtures(db, deps(), { now: new Date(), runId, flags: FLAGS });
  assert.equal(retried.ok, true);
  assert.equal(retried.run_id, runId);
  const active = db.prepare(
    "SELECT post_id FROM listings WHERE fixture_namespace = ? AND COALESCE(self_status, 'open') = 'open'",
  ).all(STAGE1_FIXTURE_NAMESPACE);
  assert.equal(active.length, 1);
  db.close();
});

test("P1-22 a production-shaped compact run id is not mistaken for a leaked phone", () => {
  const db = open();
  // exact production format: <namespace>:<compact UTC stamp>:<workflow run id>
  const runId = makeStage1FixtureRunId(new Date("2026-09-18T06:17:56Z"), "35314199788");
  assert.equal(runId, "stage1-fix:20260918061756:35314199788");
  // the raw digits really do contain a phone-shaped substring (09 + 8 digits)...
  assert.match(runId, /09\d{8}/);
  // ...so the naive detector fired on every Production fixture run (stage1FixtureOps
  // threw "fixture evidence leaked phone"). The evidence must be accepted instead.
  const prepared = prepareStage1Fixtures(db, deps(), { now: new Date(), runId, flags: FLAGS });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.run_id, runId);
  db.close();
});

test("P1-22 the boundary-anchored phone detector still catches real phone numbers", () => {
  const phoneRe = /(?<!\d)09\d{8}(?!\d)/;
  // real, unformatted 09xxxxxxxx mobile numbers are still detected...
  assert.equal(phoneRe.test('"phone":"0912345678"'), true);
  assert.equal(phoneRe.test("0912-345-678"), false); // formatted: never matched before either
  // ...while compact timestamps / long digit runs are not
  assert.equal(phoneRe.test("20260918061756"), false);
  assert.equal(phoneRe.test("/DATA/predeploy-20260918-055613"), false);
});

