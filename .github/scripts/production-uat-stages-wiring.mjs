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

function loadRow(db, table, id) {
  try {
    return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(id)) || null;
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
  const listing = deps.createSelfListing(db, accounts.owner, fixtureOpsMod.listingFixtureInput(runId), now, {
    isolation: { ...registryMod.authorizeFixtureIsolation(db, accounts.owner, { now, runId, kind: KIND.LISTING, role: ROLE.LISTING_A, rowId: listingId }), registered: true },
  });

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

/** Cleans every UAT fixture through the domain APIs and verifies nothing remains. */
export async function cleanupUatFixtures({ db, deps, registryMod, runId, now }) {
  const rows = registryMod.listActiveRegistryRows(db, { runId, now });
  const accounts = rows.filter((row) => row.kind === registryMod.STAGE1_FIXTURE_KIND.USER);
  for (const row of rows) {
    if (row.kind === registryMod.STAGE1_FIXTURE_KIND.USER) continue;
    registryMod.markRegistryRowCleaned(db, row.id, now);
  }
  for (const row of accounts) {
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
      registry_leftover_runs: registryLeftover.length,
    };
  }
  return {
    ok: true,
    reason: "",
    cleaned: rows.length,
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
    saveRentalNotifyPrefs: notifyMod.saveRentalNotifyPrefs,
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
    fatal = String(error?.stack || error?.message || error);
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
