// Issue #333 consolidated Production UAT - /app/src wiring and fixtures.
//
// Runs INSIDE the 591-tracker-v3 container via `docker exec -w /app node ...`:
// it is the only place that knows how to reach the deployed domain modules.
// Copied in with production-uat-stages-domain.mjs, which it imports as a sibling.
//
// It never writes feature flags. Fixtures are created and cleaned through the
// existing registry/isolation helpers and domain APIs only.

import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

import { makeUatNamespace, runProductionUat, UAT_SCHEMA } from "./production-uat-stages-domain.mjs";

const SRC_ROOT = process.env.UAT_SRC_ROOT || "/app/src";
const toHref = (file) => pathToFileURL(path.resolve(SRC_ROOT, file)).href;

function fail(message) {
  throw new Error(message);
}

function makeHttpProbe(baseUrl) {
  return async function httpProbe({ path: target, method = "GET", body = null } = {}) {
    const url = `${baseUrl}${target}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      let parsed = {};
      try {
        parsed = await response.json();
      } catch {
        parsed = {};
      }
      return { status: response.status, code: String(parsed?.code || ""), body: parsed };
    } catch (error) {
      return { status: 0, code: "", body: {}, error: String(error?.message || error) };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Raw row loader. The listings table keys on post_id, not id. */
function loadRow(db, table, id) {
  const column = table === "listings" ? "post_id" : "id";
  try {
    return db.prepare(`SELECT * FROM ${table} WHERE ${column} = ?`).get(Number(id)) || null;
  } catch {
    return null;
  }
}

/** Creates the UAT fixtures through the existing registry + domain APIs. */
export async function createUatFixtures({ db, deps, registryMod, fixtureOpsMod, runId, now, namespace }) {
  const KIND = registryMod.STAGE1_FIXTURE_KIND;
  const ROLE = registryMod.STAGE1_FIXTURE_ROLE;
  registryMod.ensureStage1FixtureSchema(db);
  registryMod.assertPrepareRunExclusive(db, runId);

  const accounts = {};
  const tx = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    }
  };

  tx(() => {
    for (const [key, role] of [["owner", ROLE.OWNER_A], ["tenant", ROLE.TENANT_T], ["other", ROLE.OTHER_B]]) {
      const user = deps.registerUser(db, {
        email: registryMod.fixtureEmailForRole(runId, role),
        password: fixtureOpsMod.randomFixturePassword(),
        acceptDisclaimer: true,
        acceptPrivacy: true,
        emailVerified: true,
      });
      registryMod.registerFixtureRow(db, { runId, kind: KIND.USER, role, rowId: user.id, now });
      accounts[key] = Number(user.id);
    }
  });

  const listingId = deps.nextSelfPostId(db);
  registryMod.registerFixtureRow(db, { runId, kind: KIND.LISTING, role: ROLE.LISTING_A, rowId: listingId, now });
  deps.createSelfListing(db, accounts.owner, fixtureOpsMod.listingFixtureInput(runId), now, {
    isolation: { ...registryMod.authorizeFixtureIsolation(db, accounts.owner, { now, runId, kind: KIND.LISTING, role: ROLE.LISTING_A, rowId: listingId }), registered: true },
  });
  // The domain create API returns a projection, not the raw row. assertCreateOfferGates
  // and liveMatchEligible need the raw listings row (listed_by_user_id, self_status).
  const listing = loadRow(db, "listings", listingId);
  if (!listing) fail("the UAT fixture listing was not created");

  const wishes = {};
  // Domain rule: a user may hold only ONE open/public wish at a time
  // (demand.js throwActiveLimit -> 409 wish_active_limit). The non-active wishes
  // are therefore created first and closed immediately, and the open/eligible
  // wish is created last.
  const wishSpec = [
    ["paused", ROLE.WISH_PAUSED, "tenant", "pause"],
    ["completed", ROLE.WISH_COMPLETED, "tenant", "complete"],
    ["closed", ROLE.WISH_HARD_CONFLICT, "tenant", "complete"],
    ["eligible", ROLE.WISH_ACTIVE, "tenant", ""],
  ];
  for (const [key, role, ownerKey, action] of wishSpec) {
    const wishId = deps.nextDemandPostId(db);
    registryMod.registerFixtureRow(db, { runId, kind: KIND.WISH, role, rowId: wishId, now });
    const ownerId = accounts[ownerKey];
    deps.createDemandPost(db, ownerId, fixtureOpsMod.wishFixtureInput(runId, role), now, {
      isolation: { ...registryMod.authorizeFixtureIsolation(db, ownerId, { now, runId, kind: KIND.WISH, role, rowId: wishId }), registered: true },
    });
    if (action) deps.applyWishLifecycleAction(db, ownerId, wishId, action, now);
    wishes[key] = loadRow(db, "demand_posts", wishId);
  }

  const shareToken = String(wishes.eligible?.public_token || wishes.eligible?.public_ref || "");
  if (!shareToken) fail("the eligible UAT wish has no public token");
  return {
    ownerId: accounts.owner,
    tenantId: accounts.tenant,
    otherId: accounts.other,
    listing: listing || loadRow(db, "listings", listingId),
    wishes,
    notifyUserId: accounts.owner,
    shareToken,
    shareIp: "203.0.113.7",
    shareAgent: `issue333-uat/${namespace}`,
    idempotencyKey: `uat-offer-${namespace}`,
    dockRows: [],
    namespace,
    now,
  };
}

/**
 * Closes one fixture listing/wish through the domain API and proves it closed.
 *
 * Issue #349: marking a registry row cleaned while its listing/wish is still open
 * orphans the row - cleanup and reap-stale both enter through active registry rows,
 * so an orphaned row could never be removed again. Closing first (and verifying the
 * close) keeps the CI-side cleanup recoverable in the same order the runtime
 * fixture domain uses.
 */
function closeUatRegistryRow(db, deps, registryMod, row, now) {
  const KIND = registryMod.STAGE1_FIXTURE_KIND;
  const NAMESPACE = registryMod.STAGE1_FIXTURE_NAMESPACE;
  if (row.kind === KIND.LISTING) {
    const listing = loadRow(db, "listings", row.row_id);
    if (!listing) return 0;
    if (String(listing.fixture_namespace || "") !== NAMESPACE) {
      fail(`UAT cleanup refuses to close listing ${row.row_id} outside the fixture namespace`);
    }
    if (String(listing.self_status || "open") !== "open") return 0;
    deps.closeSelfListing(db, Number(listing.listed_by_user_id) || 0, listing.post_id, { admin: true }, now);
    const after = loadRow(db, "listings", row.row_id);
    if (after && String(after.self_status || "") === "open") {
      fail(`UAT cleanup could not close fixture listing ${row.row_id}`);
    }
    return 1;
  }
  if (row.kind === KIND.WISH) {
    const wish = loadRow(db, "demand_posts", row.row_id);
    if (!wish) return 0;
    if (String(wish.fixture_namespace || "") !== NAMESPACE) {
      fail(`UAT cleanup refuses to close wish ${row.row_id} outside the fixture namespace`);
    }
    if (String(wish.status || "open") !== "open") return 0;
    try {
      deps.applyWishLifecycleAction(db, wish.user_id, wish.id, "pause", now);
    } catch {
      deps.applyWishLifecycleAction(db, wish.user_id, wish.id, "complete", now);
    }
    const after = loadRow(db, "demand_posts", row.row_id);
    if (after && String(after.status || "") === "open") {
      fail(`UAT cleanup could not close fixture wish ${row.row_id}`);
    }
    return 1;
  }
  return 0;
}

/** Cleans every UAT fixture through the domain APIs and verifies nothing remains. */
export async function cleanupUatFixtures({ db, deps, registryMod, runId, now }) {
  const KIND = registryMod.STAGE1_FIXTURE_KIND;
  const active = registryMod.listActiveRegistryRows(db, { runId, now });
  const stale = typeof registryMod.listStaleRegistryRows === "function"
    ? registryMod.listStaleRegistryRows(db, { now })
      .filter((row) => String(row.run_id || "") === String(runId || ""))
    : [];
  const seen = new Set();
  const rows = [...active, ...stale].filter((row) => {
    const key = `${row.kind}:${row.row_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const closed = { listings: 0, wishes: 0 };
  // #349: close first, then book the registry row cleaned, then remove the accounts.
  // A cleanup that cannot close a row fails closed and leaves the registry rows
  // uncleaned, so the same run stays recoverable.
  for (const row of rows) {
    if (row.kind === KIND.LISTING) closed.listings += closeUatRegistryRow(db, deps, registryMod, row, now);
    if (row.kind === KIND.WISH) closed.wishes += closeUatRegistryRow(db, deps, registryMod, row, now);
  }
  for (const row of rows) {
    if (row.kind === KIND.USER) continue;
    registryMod.markRegistryRowCleaned(db, row.id, now);
  }
  for (const row of rows.filter((item) => item.kind === KIND.USER)) {
    deps.deleteUser(db, row.row_id, {
      by: "admin",
      reasonCode: "issue333_uat_cleanup",
      reason: "Issue #333 consolidated UAT cleanup",
    });
    registryMod.markRegistryRowCleaned(db, row.id, now);
  }
  const leftoverUsers = registryMod.listUncleanedRegistryRows
    ? registryMod.listUncleanedRegistryRows(db, { runId }).length
    : 0;
  // Read-only transparency: this run's own leftovers plus any other uncleaned
  // fixture run (for example the Stage 1 Phase A rows that can no longer be
  // reaped because the readiness gate rejects the post-activation posture).
  const registryLeftover = typeof registryMod.uncleanedFixtureRunIds === "function"
    ? registryMod.uncleanedFixtureRunIds(db)
    : [];
  if (leftoverUsers > 0) {
    return {
      ok: false,
      reason: `${leftoverUsers} registry rows were not cleaned`,
      cleaned: rows.length,
      closed_listings: closed.listings,
      closed_wishes: closed.wishes,
      registry_leftover_runs: registryLeftover.length,
    };
  }
  return {
    ok: true,
    reason: "",
    cleaned: rows.length,
    closed_listings: closed.listings,
    closed_wishes: closed.wishes,
    namespace: makeUatNamespace(runId),
    registry_leftover_runs: registryLeftover.length,
  };
}

const selfUrl = pathToFileURL(path.resolve(process.argv[1] || "")).href;
if (process.argv[1] && import.meta.url === selfUrl) {
  await main();
}


async function main() {
  const dbSpec = process.env.UAT_DB_MODULE || "/app/src/db.js";
  const dbHref = dbSpec.startsWith("file:") ? dbSpec : pathToFileURL(path.resolve(dbSpec)).href;
  const envSpec = process.env.UAT_ENV_MODULE || "/app/src/env.js";
  // env.js first: auth.js signs cookies with the running server's real secret.
  await import(pathToFileURL(path.resolve(envSpec)).href);

  const [dbMod, membersMod, listingMod, demandMod, offerMod, transitionMod, shareMod, notifyMod, workerMod, registryMod, fixtureOpsMod] =
    await Promise.all([
      import(dbHref),
      import(toHref("members.js")),
      import(toHref("selfListings.js")),
      import(toHref("demand.js")),
      import(toHref("wishOffers.js")),
      import(toHref("wishOfferTransitions.js")),
      import(toHref("rentalShareGrowth.js")),
      import(toHref("rentalNotify.js")),
      import(toHref("rentalNotifyWorker.js")),
      import(toHref("stage1FixtureRegistry.js")),
      import(toHref("stage1FixtureOps.js")),
    ]);

  const db = dbMod.db;
  const flags = dbMod.getRentalMarketplaceFlags();
  // A fresh `docker exec` process does not inherit the running server's in-process
  // flag/catalog snapshots, so hydrate the modules that read them. Without this,
  // demand.js applyWishLifecycleAction refuses with 503 wish_lifecycle_off and
  // selfListings.js cannot create the fixture listing under the right flags.
  demandMod.setRentalMarketplaceFlags(flags);
  if (typeof dbMod.getRentalCatalog === "function") {
    const catalog = dbMod.getRentalCatalog();
    demandMod.setRentalCatalogCache(catalog);
    listingMod.setSelfListingCatalog(catalog, flags);
  }
  const runId = String(process.env.UAT_RUN_ID || "").trim() || `local-${Date.now()}`;
  const namespace = makeUatNamespace(runId);
  const resultPath = process.env.UAT_RESULT_PATH || "/tmp/uat-evidence.json";
  const now = new Date();

  const deps = {
    // --- domain wiring for the UAT items -------------------------------------
    getRentalMarketplaceFlags: dbMod.getRentalMarketplaceFlags,
    getRentalCatalog: dbMod.getRentalCatalog,
    setWishOfferHydrate: offerMod.setWishOfferHydrate,
    setRentalNotifyHydrate: notifyMod.setRentalNotifyHydrate,
    setRentalNotifyDockWriter: notifyMod.setRentalNotifyDockWriter,
    assertCreateOfferGates: offerMod.assertCreateOfferGates,
    insertPendingOffer: offerMod.insertPendingOffer,
    acceptWishOffer: transitionMod.acceptWishOffer,
    readOfferContact: transitionMod.readOfferContact,
    blockOwnerFromOffer: transitionMod.blockOwnerFromOffer,
    assertOfferBurst: offerMod.assertOfferBurst,
    recordOfferFail: offerMod.recordOfferFail,
    liveMatchEligible: offerMod.liveMatchEligible,
    recordShareEvent: shareMod.recordShareEvent,
    resolveValidShareToken: shareMod.resolveValidShareToken,
    shouldAttributeSignup: shareMod.shouldAttributeSignup,
    emitRentalNotifyEvent: notifyMod.emitRentalNotifyEvent,
    getRentalNotifyPrefs: notifyMod.getRentalNotifyPrefs,
    saveRentalNotifyPrefs: notifyMod.saveRentalNotifyPrefs,
    deliverQueuedNotifications: notifyMod.deliverQueuedNotifications,
    processMatchSubscriptionRow: notifyMod.processMatchSubscriptionRow,
    runRentalNotifyTick: workerMod.runRentalNotifyTick,
    startRentalNotifyLoop: workerMod.startRentalNotifyLoop,
    wishHasActiveOffer: notifyMod.wishHasActiveOffer,
    httpProbe: null, // replaced below
    // --- fixture helpers ------------------------------------------------------
    registerUser: membersMod.registerUser,
    deleteUser: membersMod.deleteUser,
    createSelfListing: listingMod.createSelfListing,
    closeSelfListing: listingMod.closeSelfListing,
    nextSelfPostId: listingMod.nextSelfPostId,
    createDemandPost: demandMod.createDemandPost,
    nextDemandPostId: demandMod.nextDemandPostId,
    applyWishLifecycleAction: demandMod.applyWishLifecycleAction,
  };
  deps.httpProbe = makeHttpProbe(process.env.UAT_BASE_URL || "http://127.0.0.1:5153");

  let doc = null;
  let fatal = "";
  let cleanup = { ok: false, reason: "not_done" };
  try {
    const ctx = await createUatFixtures({ db, deps, registryMod, fixtureOpsMod, runId, now, namespace });
    doc = await runProductionUat({
      db,
      deps,
      ctx,
      flags,
      now,
      runId,
      workflow: process.env.UAT_WORKFLOW || "production-uat-stages-functional.yml",
    });
  } catch (error) {
    // Record the ASCII status/code as well as the message: the SSH transport can
    // mangle non-ASCII text in the log, but `code` stays readable and identifies
    // the exact domain rule that refused the call.
    const frame = String(error?.stack || "")
      .split("\n")
      .find((line) => line.includes("production-uat-stages-wiring")) || "";
    fatal = `status=${Number(error?.status || 0)} code=${String(error?.code || "")} at=${frame.trim()} message=${messageOf(error)}`;
    console.error("UAT_FATAL " + fatal);
  } finally {
    try {
      cleanup = await cleanupUatFixtures({ db, deps, registryMod, runId, now });
    } catch (error) {
      cleanup = { ok: false, reason: String(error?.message || error) };
    }
  }

  // Evidence must always exist: a fatal fixture/item error is recorded in the
  // document so the workflow's conclusion step fails closed with the real reason
  // instead of reporting a missing artifact.
  if (!doc) {
    doc = {
      schema: UAT_SCHEMA,
      generated_at: new Date().toISOString(),
      run_id: runId,
      workflow: process.env.UAT_WORKFLOW || "production-uat-stages-functional.yml",
      namespace,
      flags_mutated: false,
      before_raw_flags: flags,
      after_raw_flags: flags,
      summary: { total: 0, passed: 0, failed: 0, failed_ids: [] },
      items: [],
      probe_log: [],
      dock_rows: 0,
      problems: [],
      conclusion: "",
    };
  }
  if (fatal) doc.problems.push(`fatal: ${fatal.split("\n")[0]}`);
  if (cleanup.ok !== true) doc.problems.push(`fixture cleanup failed: ${cleanup.reason}`);
  doc.cleanup = cleanup;
  doc.schema = UAT_SCHEMA;
  if (doc.problems.length) doc.conclusion = "";
  writeFileSync(resultPath, JSON.stringify(doc, null, 2) + "\n");
  console.log(doc.problems.length ? `UAT_FAIL ${JSON.stringify(doc.problems)}` : `UAT_PASS ${doc.conclusion}`);
  process.exitCode = doc.problems.length ? 1 : 0;
}
