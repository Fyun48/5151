/** Stage 1 fixture prepare / verify / cleanup.
 * Create/transition/close/delete go through domain APIs.
 * Never mutates feature flags. Never uses email LIKE cleanup.
 */

import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { nextSelfPostId } from "./selfListings.js";
import { nextDemandPostId } from "./demand.js";
import {
  LISTING_SURFACE,
  WISH_SURFACE,
  listingVisibleOnSurface,
  wishVisibleOnSurface,
} from "./stage1FixtureIsolation.js";
import { canSelfTransition, mapLegacyLifecycle } from "./wishLifecycle.js";
import {
  STAGE1_FIXTURE_KIND,
  STAGE1_FIXTURE_NAMESPACE,
  STAGE1_FIXTURE_ROLE,
  STAGE1_FIXTURE_TTL_MS,
  assertPrepareRunExclusive,
  authorizeFixtureIsolation,
  ensureStage1FixtureSchema,
  fixtureEmailForRole,
  listActiveRegistryRows,
  listStaleRegistryRows,
  makeStage1FixtureRunId,
  markRegistryRowCleaned,
  registerFixtureRow,
  registryRowIdentity,
  uncleanedFixtureRunIds,
} from "./stage1FixtureRegistry.js";

export const FIXTURE_CLEANUP_FAILED = "FIXTURE_CLEANUP_FAILED";

export function randomFixturePassword() {
  return `Fx!${randomBytes(32).toString("base64url")}`;
}

/** Stage flags that may legitimately be ON once the Stage 1-4 rollout finished. */
export const ACTIVATED_STAGE_FLAGS = Object.freeze([
  "offer_enabled",
  "public_share_v2_enabled",
  "owner_notifications_enabled",
  "notifications_enabled",
]);

/** Outbound channels must be false in every posture. */
export const FIXTURE_OUTBOUND_FLAGS = Object.freeze([
  "digest_enabled",
  "outbound_mail_enabled",
  "outbound_push_enabled",
]);

/** Flag postures the fixture contract understands. */
export const FIXTURE_POSTURE = Object.freeze({
  PRE_ACTIVATION: "pre_activation",
  POST_ACTIVATION: "post_activation",
});

/**
 * Only these modes may run after the later stages are ON. prepare/verify keep the
 * strict pre-activation requirement, so an abandoned run can still be recovered
 * without ever making preparation valid in an activated posture.
 */
export const FIXTURE_CLEANUP_MODES = Object.freeze(["cleanup", "reap-stale", "cleanup-activated"]);

/** Readiness posture required by a fixture mode. */
export function postureForMode(mode) {
  return FIXTURE_CLEANUP_MODES.includes(mode) ? "cleanup" : "strict";
}

/**
 * Detects the live posture from the stage flags. A partially activated set is
 * refused rather than guessed, so the caller can never pick the posture that
 * happens to be convenient.
 */
export function detectFixturePosture(flags, label = "fixture") {
  const wish = asObject(flags?.wish);
  const on = ACTIVATED_STAGE_FLAGS.filter((key) => wish[key] === true);
  const off = ACTIVATED_STAGE_FLAGS.filter((key) => wish[key] === false);
  if (on.length === ACTIVATED_STAGE_FLAGS.length) return FIXTURE_POSTURE.POST_ACTIVATION;
  if (off.length === ACTIVATED_STAGE_FLAGS.length) return FIXTURE_POSTURE.PRE_ACTIVATION;
  throw new Error(
    `${label} wish stage flags are inconsistent (${on.join("+") || "none"} ON); refusing`,
  );
}

function opaqueId(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12);
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * Readiness contract.
 *
 * `posture: "strict"` (default, used by prepare and verify) keeps the original
 * pre-activation requirement: every later stage flag must be false.
 *
 * `posture: "cleanup"` additionally accepts the post-activation posture, because
 * cleanup and reap only ever touch exact registry-bound fixture rows. In that
 * posture Stage 1 must be ON and the four stage flags must all be ON, while the
 * three outbound channels must still be false. Mixed stage flags are refused.
 */
export function assertReadinessFlags(flags, label = "fixture", expectedOwnerMatching = false, { posture = "strict" } = {}) {
  if (posture !== "strict" && posture !== "cleanup") {
    throw new Error(`${label} unsupported fixture posture '${posture}'`);
  }
  const wish = asObject(flags?.wish);
  if (flags?.rental_catalog_v2?.enabled !== true) {
    throw new Error(`${label} rental_catalog_v2.enabled must be true`);
  }
  if (wish.lifecycle_enabled !== true) {
    throw new Error(`${label} wish.lifecycle_enabled must be true`);
  }
  const detected = posture === "cleanup"
    ? detectFixturePosture(flags, label)
    : FIXTURE_POSTURE.PRE_ACTIVATION;
  const activated = detected === FIXTURE_POSTURE.POST_ACTIVATION;
  // A post-activation posture implies Stage 1 is ON, so that expectation wins.
  const ownerExpectation = activated ? true : expectedOwnerMatching;
  if (wish.owner_matching_enabled !== ownerExpectation) {
    throw new Error(`${label} wish.owner_matching_enabled must be ${ownerExpectation}`);
  }
  const stageExpectation = activated;
  for (const key of ACTIVATED_STAGE_FLAGS) {
    if (wish[key] !== stageExpectation) {
      throw new Error(`${label} wish.${key} must be ${stageExpectation}`);
    }
  }
  for (const key of FIXTURE_OUTBOUND_FLAGS) {
    if (wish[key] !== false) {
      throw new Error(`${label} wish.${key} must be false`);
    }
  }
  return detected;
}

export function listingFixtureInput(runId, extra = {}) {
  return {
    district: "1-8",
    rent: 20000,
    ping: 18,
    kind: "whole",
    role: "owner",
    floor: 3,
    total_floors: 5,
    rooms: 2,
    living: 1,
    bath: 1,
    address: "中正路100號",
    title: `【${STAGE1_FIXTURE_NAMESPACE}】士林整層可看屋`,
    body: `${STAGE1_FIXTURE_NAMESPACE} ${runId} owner self listing for authenticated matching.`,
    accept_pledge: true,
    listing_values: { need_pet: "not_allowed", need_cook: "allowed" },
    // P2-21: a deterministic per-run key routes createSelfListing through its
    // existing withImmediate() path, so an onAfterInsert failure rolls back the
    // listing + later partial writes instead of leaving a half-written fixture.
    idempotency_key: `stage1-fix-listing-${opaqueId(runId)}`,
    ...extra,
  };
}

export function wishFixtureInput(runId, role, extra = {}) {
  return {
    districts: ["1-8"],
    rent_max: 30000,
    housing_type: "whole",
    layout: "2",
    ping_min: 10,
    body: `${STAGE1_FIXTURE_NAMESPACE} ${runId} ${role} counterfactual wish`,
    ...extra,
  };
}

function requireDomain(deps, name) {
  if (typeof deps[name] !== "function") {
    throw new Error(`fixture ops require domain API ${name}`);
  }
  return deps[name];
}

function loadUser(db, userId) {
  try {
    return db.prepare("SELECT * FROM users WHERE id = ?").get(Number(userId) || 0) || null;
  } catch {
    return null;
  }
}

function loadListing(db, postId) {
  try {
    return db.prepare("SELECT * FROM listings WHERE post_id = ?").get(Number(postId) || 0) || null;
  } catch {
    return null;
  }
}

function loadWish(db, wishId) {
  try {
    return db.prepare("SELECT * FROM demand_posts WHERE id = ?").get(Number(wishId) || 0) || null;
  } catch {
    return null;
  }
}

function publicEvidence(doc) {
  const copy = structuredClone(doc);
  const strip = (row) => {
    if (!row || typeof row !== "object") return row;
    const next = { ...row };
    delete next.email;
    delete next.phone;
    delete next.password;
    delete next.session;
    return next;
  };
  if (copy.accounts) copy.accounts = copy.accounts.map(strip);
  const text = JSON.stringify(copy);
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text)) {
    throw new Error("fixture evidence leaked email");
  }
  // Boundary-anchored so a compact fixture run id / timestamp such as
  // "stage1-fix:20260918061756:35314199788" is not mistaken for a 09xxxxxxxx phone.
  if (/(?<!\d)09\d{8}(?!\d)/.test(text)) throw new Error("fixture evidence leaked phone");
  for (const token of ["SESSION_SECRET", "NAS_SSH_KEY", "AUTH_PASSWORD", "auth.env", "rank_score", "Fx!"]) {
    if (text.includes(token)) throw new Error(`fixture evidence leaked ${token}`);
  }
  return copy;
}

function createIsolatedListing(db, deps, ownerId, runId, now, isolationExtra = {}) {
  const postId = nextSelfPostId(db);
  registerFixtureRow(db, {
    runId,
    kind: STAGE1_FIXTURE_KIND.LISTING,
    role: STAGE1_FIXTURE_ROLE.LISTING_A,
    rowId: postId,
    now,
  });
  if (typeof isolationExtra.onAfterRegister === "function") isolationExtra.onAfterRegister({ postId });
  const isolation = {
    ...authorizeFixtureIsolation(db, ownerId, {
      now,
      runId,
      kind: STAGE1_FIXTURE_KIND.LISTING,
      role: STAGE1_FIXTURE_ROLE.LISTING_A,
      rowId: postId,
    }),
    registered: true,
    ...isolationExtra,
  };
  return deps.createSelfListing(db, ownerId, listingFixtureInput(runId), now, { isolation });
}

function createIsolatedWish(db, deps, userId, runId, role, input, now, isolationExtra = {}) {
  const wishId = nextDemandPostId(db);
  registerFixtureRow(db, {
    runId,
    kind: STAGE1_FIXTURE_KIND.WISH,
    role,
    rowId: wishId,
    now,
  });
  if (typeof isolationExtra.onAfterRegister === "function") isolationExtra.onAfterRegister({ wishId });
  const isolation = {
    ...authorizeFixtureIsolation(db, userId, {
      now,
      runId,
      kind: STAGE1_FIXTURE_KIND.WISH,
      role,
      rowId: wishId,
    }),
    registered: true,
    ...isolationExtra,
  };
  return deps.createDemandPost(db, userId, input, now, { isolation });
}

function findRole(rows, role) {
  return (rows || []).find((row) => row.role === role) || null;
}

/** P2-13: run a whole fixture phase inside one BEGIN IMMEDIATE so a partial
 * fixture-account preparation can never be left behind. Preferred over
 * per-row transactions: either the complete phase commits or nothing does.
 */
function withFixtureImmediateTx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch { /* transaction may already be rolled back */ }
    throw error;
  }
}

/** Create one fixture user + its registry row inside the caller's transaction.
 * A crash between registerUser and registerFixtureRow must never leave an
 * untracked verified fixture account behind; the caller owns the surrounding
 * BEGIN IMMEDIATE (see withFixtureImmediateTx).
 */
function createFixtureUserRow(db, registerUser, {
  role,
  runId,
  now = new Date(),
  hooks = {},
} = {}) {
  const email = fixtureEmailForRole(runId, role);
  const password = randomFixturePassword();
  const user = registerUser(db, {
    email,
    password,
    acceptDisclaimer: true,
    acceptPrivacy: true,
    emailVerified: true,
  });
  if (typeof hooks.onAfterUserCreate === "function") {
    hooks.onAfterUserCreate({ userId: Number(user.id), role, runId });
  }
  registerFixtureRow(db, {
    runId,
    kind: STAGE1_FIXTURE_KIND.USER,
    role,
    rowId: user.id,
    now,
  });
  return { role, id: Number(user.id), email_hash: opaqueId(email) };
}

/** P2-17: the deterministic wish set for one fixture run (creation + target lifecycle). */
const WISH_PREPARE_RECIPE = Object.freeze([
  {
    role: STAGE1_FIXTURE_ROLE.WISH_HARD_CONFLICT,
    owner: "tenant",
    lifecycle: "completed",
    action: "complete",
    extra: { condition_choices: { need_pet: "want" }, choices: { need_pet: "want" } },
  },
  { role: STAGE1_FIXTURE_ROLE.WISH_COMPLETED, owner: "tenant", lifecycle: "completed", action: "complete" },
  { role: STAGE1_FIXTURE_ROLE.WISH_PAUSED, owner: "tenant", lifecycle: "paused", action: "pause" },
  { role: STAGE1_FIXTURE_ROLE.WISH_ACTIVE, owner: "tenant", lifecycle: "active", action: "" },
  { role: STAGE1_FIXTURE_ROLE.WISH_INACTIVE, owner: "other", lifecycle: "draft", action: "", extra: { draft: true } },
]);

export function prepareStage1Fixtures(db, deps = {}, {
  now = new Date(),
  runId = makeStage1FixtureRunId(now, deps.workflowRunId),
  flags,
} = {}) {
  ensureStage1FixtureSchema(db);
  if (flags) assertReadinessFlags(flags, "prepare");
  const registerUser = requireDomain(deps, "registerUser");
  const createSelfListing = requireDomain(deps, "createSelfListing");
  const createDemandPost = requireDomain(deps, "createDemandPost");
  const applyWishLifecycleAction = requireDomain(deps, "applyWishLifecycleAction");
  runId = String(runId || "").trim() || makeStage1FixtureRunId(now, deps.workflowRunId);
  assertPrepareRunExclusive(db, runId);

  const userHooks = deps.userIsolation || {};
  const listingHooks = deps.listingIsolation || {};
  const wishHooks = deps.wishIsolation || {};
  const accountRoles = [
    STAGE1_FIXTURE_ROLE.OWNER_A,
    STAGE1_FIXTURE_ROLE.OTHER_B,
    STAGE1_FIXTURE_ROLE.TENANT_T,
  ];
  const roleRow = (kind, role) => listActiveRegistryRows(db, { runId, now })
    .find((row) => row.kind === kind && row.role === role) || null;

  // P2-17: deterministic same-run resume. A registry row whose domain row was
  // never created (an aborted pre-registration) is released, and every missing
  // role is created, so retrying the same run converges without manual surgery.
  const releaseAbortedRegistration = (kind, role, loader) => {
    const reg = roleRow(kind, role);
    if (!reg) return null;
    const row = loader(db, reg.row_id);
    if (row) return { reg, row };
    markRegistryRowCleaned(db, reg.id, now);
    return null;
  };

  const missingAccounts = accountRoles.filter((role) => !roleRow(STAGE1_FIXTURE_KIND.USER, role));
  if (missingAccounts.length) {
    withFixtureImmediateTx(db, () => {
      for (const role of missingAccounts) {
        createFixtureUserRow(db, registerUser, { role, runId, now, hooks: userHooks });
      }
    });
  }
  const accountId = (role) => {
    const reg = roleRow(STAGE1_FIXTURE_KIND.USER, role);
    if (!reg) throw new Error(`fixture prepare could not resolve the ${role} account`);
    return Number(reg.row_id);
  };
  const ownerId = accountId(STAGE1_FIXTURE_ROLE.OWNER_A);
  const otherId = accountId(STAGE1_FIXTURE_ROLE.OTHER_B);
  const tenantId = accountId(STAGE1_FIXTURE_ROLE.TENANT_T);

  if (!releaseAbortedRegistration(STAGE1_FIXTURE_KIND.LISTING, STAGE1_FIXTURE_ROLE.LISTING_A, loadListing)) {
    createIsolatedListing(db, { createSelfListing }, ownerId, runId, now, listingHooks);
  }

  const ensureWish = (recipe) => {
    const wishOwnerId = recipe.owner === "other" ? otherId : tenantId;
    let row = releaseAbortedRegistration(STAGE1_FIXTURE_KIND.WISH, recipe.role, loadWish)?.row || null;
    if (!row) {
      createIsolatedWish(
        db,
        { createDemandPost },
        wishOwnerId,
        runId,
        recipe.role,
        wishFixtureInput(runId, recipe.role, recipe.extra || {}),
        now,
        wishHooks,
      );
      const reg = roleRow(STAGE1_FIXTURE_KIND.WISH, recipe.role);
      row = reg ? loadWish(db, reg.row_id) : null;
      if (!row) throw new Error(`fixture prepare could not load the ${recipe.role} wish`);
    }
    const current = mapLegacyLifecycle(row);
    if (current === recipe.lifecycle) return;
    if (!recipe.action || !canSelfTransition(current, recipe.action)) {
      throw new Error(`fixture prepare cannot reconcile wish ${recipe.role} (${current} -> ${recipe.lifecycle})`);
    }
    applyWishLifecycleAction(db, wishOwnerId, row.id, recipe.action, now);
  };

  for (const recipe of WISH_PREPARE_RECIPE) ensureWish(recipe);

  return verifyStage1Fixtures(db, deps, { now, runId, flags });
}

export function loadRegistryFixtureBundle(db, {
  now = new Date(),
  runId,
  namespace = STAGE1_FIXTURE_NAMESPACE,
} = {}) {
  ensureStage1FixtureSchema(db);
  const rows = listActiveRegistryRows(db, { namespace, runId, now });
  const users = rows.filter((row) => row.kind === STAGE1_FIXTURE_KIND.USER);
  const listings = rows.filter((row) => row.kind === STAGE1_FIXTURE_KIND.LISTING);
  const wishes = rows.filter((row) => row.kind === STAGE1_FIXTURE_KIND.WISH);
  const ownerReg = findRole(users, STAGE1_FIXTURE_ROLE.OWNER_A);
  const otherReg = findRole(users, STAGE1_FIXTURE_ROLE.OTHER_B);
  const tenantReg = findRole(users, STAGE1_FIXTURE_ROLE.TENANT_T);
  const listingReg = findRole(listings, STAGE1_FIXTURE_ROLE.LISTING_A);
  if (!ownerReg || !otherReg || !tenantReg || !listingReg) return null;
  const owner = loadUser(db, ownerReg.row_id);
  const other = loadUser(db, otherReg.row_id);
  const tenant = loadUser(db, tenantReg.row_id);
  const listing = loadListing(db, listingReg.row_id);
  const wishByRole = {};
  for (const row of wishes) {
    wishByRole[row.role] = { registry: row, row: loadWish(db, row.row_id) };
  }
  return {
    rows,
    ownerReg,
    otherReg,
    tenantReg,
    listingReg,
    owner,
    other,
    tenant,
    listing,
    wishByRole,
  };
}

export function verifyStage1Fixtures(db, deps = {}, {
  now = new Date(),
  runId,
  flags,
} = {}) {
  ensureStage1FixtureSchema(db);
  if (flags) assertReadinessFlags(flags, "verify");
  if (!runId) {
    const runs = uncleanedFixtureRunIds(db);
    if (runs.length !== 1) throw new Error("fixture verify must bind a unique run_id");
    runId = runs[0];
  }
  const bundle = loadRegistryFixtureBundle(db, { now, runId });
  if (!bundle?.listing || !bundle.owner || !bundle.other || !bundle.tenant) {
    throw new Error("fixture verify missing registry-bound owner/listing/second account");
  }
  if (String(bundle.owner.deleted_at || "").trim()) {
    throw new Error("fixture owner is deleted");
  }
  if (String(bundle.listing.self_status || "") !== "open") {
    throw new Error("fixture listing is not open");
  }
  if (String(bundle.listing.fixture_namespace || "") !== STAGE1_FIXTURE_NAMESPACE) {
    throw new Error("fixture listing namespace missing");
  }

  const listingRow = bundle.listing;
  if (listingVisibleOnSurface(listingRow, { surface: LISTING_SURFACE.BROWSE, viewerId: 0 })) {
    throw new Error("fixture listing leaked into browse surface");
  }
  if (listingVisibleOnSurface(listingRow, { surface: LISTING_SURFACE.PUBLIC_DETAIL, viewerId: 0 })) {
    throw new Error("fixture listing leaked into public detail");
  }
  if (!listingVisibleOnSurface(listingRow, {
    surface: LISTING_SURFACE.OWNER_SELF,
    viewerId: bundle.owner.id,
  })) {
    throw new Error("fixture owner cannot read own listing on owner_self surface");
  }

  const required = [
    STAGE1_FIXTURE_ROLE.WISH_ACTIVE,
    STAGE1_FIXTURE_ROLE.WISH_PAUSED,
    STAGE1_FIXTURE_ROLE.WISH_COMPLETED,
    STAGE1_FIXTURE_ROLE.WISH_INACTIVE,
    STAGE1_FIXTURE_ROLE.WISH_HARD_CONFLICT,
  ];
  for (const role of required) {
    const wish = bundle.wishByRole[role]?.row;
    if (!wish) throw new Error(`fixture verify missing wish ${role}`);
    if (String(wish.fixture_namespace || "") !== STAGE1_FIXTURE_NAMESPACE) {
      throw new Error(`fixture wish ${role} namespace missing`);
    }
    if (wishVisibleOnSurface(wish, { surface: WISH_SURFACE.PUBLIC_LIST })) {
      throw new Error(`fixture wish ${role} leaked into public list`);
    }
  }

  const evaluateCounterfactualMatch = deps.evaluateCounterfactualMatch;
  const isCounterfactuallyMatchable = typeof deps.isCounterfactuallyMatchable === "function"
    ? deps.isCounterfactuallyMatchable
    : (listing, wish, options) => evaluateCounterfactualMatch?.(listing, wish, options)?.eligible === true;
  if (typeof isCounterfactuallyMatchable !== "function") {
    throw new Error("fixture verify requires Match Engine counterfactual helper");
  }

  for (const role of [
    STAGE1_FIXTURE_ROLE.WISH_ACTIVE,
    STAGE1_FIXTURE_ROLE.WISH_PAUSED,
    STAGE1_FIXTURE_ROLE.WISH_COMPLETED,
    STAGE1_FIXTURE_ROLE.WISH_INACTIVE,
  ]) {
    if (!isCounterfactuallyMatchable(listingRow, bundle.wishByRole[role].row, { now })) {
      throw new Error(`fixture wish ${role} is not counterfactually eligible`);
    }
  }
  if (isCounterfactuallyMatchable(listingRow, bundle.wishByRole[STAGE1_FIXTURE_ROLE.WISH_HARD_CONFLICT].row, { now })) {
    throw new Error("hard-conflict fixture was unexpectedly eligible");
  }

  if (typeof deps.listDemandPosts === "function") {
    const publicWishes = deps.listDemandPosts(db, { viewerId: 0 });
    if (publicWishes.some((row) => Number(row.id) === Number(bundle.wishByRole[STAGE1_FIXTURE_ROLE.WISH_ACTIVE].row.id))) {
      throw new Error("active fixture wish appeared on public demand list");
    }
  }
  if (typeof deps.getDemandPost === "function") {
    try {
      const leaked = deps.getDemandPost(db, bundle.wishByRole[STAGE1_FIXTURE_ROLE.WISH_ACTIVE].row.public_token, {
        viewerId: 0,
        publicOnly: true,
      });
      if (leaked && leaked.id) {
        throw new Error("fixture wish public detail is not fail-closed");
      }
    } catch (error) {
      if (!/找不到/.test(String(error?.message || error))) throw error;
    }
  }
  if (typeof deps.getSelfListing === "function") {
    try {
      deps.getSelfListing(db, listingRow.post_id, { viewerId: 0 });
      throw new Error("fixture listing public detail is not fail-closed");
    } catch (error) {
      if (!/找不到/.test(String(error?.message || error))) throw error;
    }
    const mine = deps.getSelfListing(db, listingRow.post_id, { viewerId: bundle.owner.id });
    if (Number(mine?.post_id) !== Number(listingRow.post_id)) {
      throw new Error("fixture owner cannot read own listing");
    }
  }

  const evidence = publicEvidence({
    schema: "stage1-fixture-registry-v1",
    namespace: STAGE1_FIXTURE_NAMESPACE,
    run_id: bundle.listingReg.run_id,
    ttl_ms: STAGE1_FIXTURE_TTL_MS,
    owner_matching_enabled: false,
    flags_mutated: false,
    accounts: [
      { role: STAGE1_FIXTURE_ROLE.OWNER_A, id_hash: opaqueId(bundle.owner.id), email_hash: opaqueId(bundle.owner.email) },
      { role: STAGE1_FIXTURE_ROLE.OTHER_B, id_hash: opaqueId(bundle.other.id), email_hash: opaqueId(bundle.other.email) },
      { role: STAGE1_FIXTURE_ROLE.TENANT_T, id_hash: opaqueId(bundle.tenant.id), email_hash: opaqueId(bundle.tenant.email) },
    ],
    listing_hash: opaqueId(listingRow.post_id),
    wishes: required.map((role) => ({
      role,
      id_hash: opaqueId(bundle.wishByRole[role].row.id),
      token_hash: opaqueId(bundle.wishByRole[role].row.public_token),
    })),
    hard_conflict_rejected: true,
    selector: "stage1_fixture_registry",
    limit_80_used: false,
  });
  return {
    ok: true,
    run_id: bundle.listingReg.run_id,
    bundle,
    evidence,
  };
}

function failCleanup(message) {
  const error = new Error(`${FIXTURE_CLEANUP_FAILED}: ${message}`);
  error.code = FIXTURE_CLEANUP_FAILED;
  throw error;
}

export function cleanupStage1Fixtures(db, deps = {}, {
  now = new Date(),
  runId,
  namespace = STAGE1_FIXTURE_NAMESPACE,
  flags,
  includeStale = false,
  ownerMatching = false,
} = {}) {
  ensureStage1FixtureSchema(db);
  if (flags) assertReadinessFlags(flags, "cleanup", ownerMatching, { posture: "cleanup" });
  const closeSelfListing = requireDomain(deps, "closeSelfListing");
  const applyWishLifecycleAction = requireDomain(deps, "applyWishLifecycleAction");
  const deleteUser = requireDomain(deps, "deleteUser");

  const active = listActiveRegistryRows(db, { namespace, runId, now });
  const stale = includeStale || !runId ? listStaleRegistryRows(db, { namespace, now }) : [];
  const seen = new Set();
  const rows = [...active, ...stale].filter((row) => {
    const key = `${row.namespace}:${row.kind}:${row.row_id}:${row.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!rows.length) {
    return verifyCleanup(db, deps, { now, runId, namespace, flags, emptyOk: true, ownerMatching });
  }

  const identities = rows.map((row) => registryRowIdentity(row));
  try {
    for (const row of rows.filter((item) => item.kind === STAGE1_FIXTURE_KIND.LISTING)) {
      const listing = loadListing(db, row.row_id);
      if (!listing) continue;
      if (String(listing.fixture_namespace || "") !== namespace) {
        failCleanup("refusing to close a listing outside fixture namespace");
      }
      if (String(listing.self_status || "") === "open") {
        closeSelfListing(db, Number(listing.listed_by_user_id) || 0, listing.post_id, { admin: true }, now);
      }
    }
    for (const row of rows.filter((item) => item.kind === STAGE1_FIXTURE_KIND.WISH)) {
      const wish = loadWish(db, row.row_id);
      if (!wish) continue;
      if (String(wish.fixture_namespace || "") !== namespace) {
        failCleanup("refusing to close a wish outside fixture namespace");
      }
      if (String(wish.status || "") === "open") {
        try {
          applyWishLifecycleAction(db, wish.user_id, wish.id, "pause", now);
        } catch {
          applyWishLifecycleAction(db, wish.user_id, wish.id, "complete", now);
        }
      }
    }
    for (const row of rows.filter((item) => item.kind === STAGE1_FIXTURE_KIND.USER)) {
      const user = loadUser(db, row.row_id);
      if (!user || String(user.deleted_at || "").trim()) continue;
      deleteUser(db, user.id, { by: "admin", reasonCode: "stage1_fixture_cleanup", reason: "stage1 fixture cleanup" });
    }
    for (const row of rows) {
      markRegistryRowCleaned(db, row.id, now);
    }
  } catch (error) {
    if (error?.code === FIXTURE_CLEANUP_FAILED) throw error;
    failCleanup(error?.message || error);
  }

  return verifyCleanup(db, deps, {
    now,
    runId,
    namespace,
    flags,
    cleanedIdentities: identities,
    ownerMatching,
  });
}

export function verifyCleanup(db, deps = {}, {
  now = new Date(),
  runId,
  namespace = STAGE1_FIXTURE_NAMESPACE,
  flags,
  cleanedIdentities = [],
  emptyOk = false,
  ownerMatching = false,
} = {}) {
  if (flags) assertReadinessFlags(flags, "cleanup-verify", ownerMatching, { posture: "cleanup" });
  const leftover = listActiveRegistryRows(db, { namespace, runId, now });
  if (leftover.length) failCleanup("active registry rows remain after cleanup");

  const openListings = db.prepare(`
    SELECT post_id FROM listings
    WHERE fixture_namespace = ?
      AND COALESCE(self_status, 'open') = 'open'
  `).all(namespace);
  if (openListings.length) failCleanup("open fixture listings remain");

  const openWishes = db.prepare(`
    SELECT id FROM demand_posts
    WHERE fixture_namespace = ?
      AND status = 'open'
  `).all(namespace);
  if (openWishes.length) failCleanup("open fixture wishes remain");

  if (typeof deps.listDemandPosts === "function") {
    const publicWishes = deps.listDemandPosts(db, { viewerId: 0 });
    if (publicWishes.some((row) => String(row.fixture_namespace || "") === namespace)) {
      failCleanup("fixture wish still in public list");
    }
  }

  return publicEvidence({
    schema: "stage1-fixture-cleanup-v1",
    ok: true,
    empty: emptyOk === true && !cleanedIdentities.length,
    namespace,
    run_id: runId || "",
    cleaned_count: cleanedIdentities.length,
    cleaned: cleanedIdentities.map((row) => ({
      registry_id: row.registry_id,
      kind: row.kind,
      role: row.role,
      row_hash: opaqueId(row.row_id),
    })),
    owner_matching_enabled: ownerMatching,
    flags_mutated: false,
    wildcard_email_like: false,
  });
}

export function reapStaleStage1Fixtures(db, deps = {}, options = {}) {
  return cleanupStage1Fixtures(db, deps, { ...options, includeStale: true, runId: undefined });
}

export const FIXTURE_MODES = Object.freeze(["prepare", "verify", "cleanup", "reap-stale", "cleanup-activated"]);

function snapshotFlags(getRentalMarketplaceFlags) {
  return JSON.parse(JSON.stringify(getRentalMarketplaceFlags()));
}

function sameFlags(before, after) {
  return JSON.stringify(before) === JSON.stringify(after);
}

export function runStage1FixtureDomain({
  db,
  getRentalMarketplaceFlags,
  deps,
  mode = "verify",
  runId,
  now = new Date(),
  resultPath,
} = {}) {
  if (!db || !getRentalMarketplaceFlags) {
    throw new Error("fixture domain requires db and getRentalMarketplaceFlags");
  }
  if (!FIXTURE_MODES.includes(mode)) {
    throw new Error(`unsupported STAGE1_FIXTURE_MODE ${mode}`);
  }
  const before = snapshotFlags(getRentalMarketplaceFlags);
  const expectOwnerMatching = mode === "cleanup-activated";
  const posture = postureForMode(mode);
  const beforePosture = assertReadinessFlags(before, "fixture-before", expectOwnerMatching, { posture });
  let result;
  if (mode === "prepare") {
    result = prepareStage1Fixtures(db, deps, {
      now,
      runId: String(runId || "").trim() || makeStage1FixtureRunId(now, deps.workflowRunId),
      flags: before,
    });
  } else if (mode === "cleanup") {
    result = cleanupStage1Fixtures(db, deps, { now, runId, flags: before });
  } else if (mode === "cleanup-activated") {
    result = cleanupStage1Fixtures(db, deps, { now, runId, flags: before, ownerMatching: true });
  } else if (mode === "reap-stale") {
    result = reapStaleStage1Fixtures(db, deps, { now, flags: before });
  } else {
    result = verifyStage1Fixtures(db, deps, { now, runId, flags: before });
  }
  const after = snapshotFlags(getRentalMarketplaceFlags);
  if (!sameFlags(before, after)) {
    throw new Error("fixture domain mutated feature flags");
  }
  assertReadinessFlags(after, "fixture-after", expectOwnerMatching, { posture });
  // The actionable value is the posture that was actually verified, not the
  // mode default: plain cleanup/reap run with Stage 1 ON in the activated posture.
  const enactedOwnerMatching = beforePosture === FIXTURE_POSTURE.POST_ACTIVATION ? true : expectOwnerMatching;
  const doc = {
    schema: "stage1-fixture-domain-v1",
    mode,
    posture: beforePosture,
    readiness_posture: posture,
    flags_mutated: false,
    before_raw_flags: before,
    after_raw_flags: after,
    owner_matching_enabled: enactedOwnerMatching,
    result: result?.evidence || result,
    ok: true,
  };
  if (resultPath) writeFileSync(resultPath, JSON.stringify(doc, null, 2) + "\n");
  return doc;
}
