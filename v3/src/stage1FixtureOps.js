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

const LATER_OFF = [
  "offer_enabled",
  "public_share_v2_enabled",
  "owner_notifications_enabled",
  "notifications_enabled",
  "digest_enabled",
  "outbound_mail_enabled",
  "outbound_push_enabled",
];

function opaqueId(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12);
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function assertReadinessFlags(flags, label = "fixture") {
  const wish = asObject(flags?.wish);
  if (flags?.rental_catalog_v2?.enabled !== true) {
    throw new Error(`${label} rental_catalog_v2.enabled must be true`);
  }
  if (wish.lifecycle_enabled !== true) {
    throw new Error(`${label} wish.lifecycle_enabled must be true`);
  }
  if (wish.owner_matching_enabled !== false) {
    throw new Error(`${label} wish.owner_matching_enabled must be false`);
  }
  for (const key of LATER_OFF) {
    if (wish[key] !== false) {
      throw new Error(`${label} wish.${key} must be false`);
    }
  }
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
  if (/09\d{8}/.test(text)) throw new Error("fixture evidence leaked phone");
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

  const existing = listActiveRegistryRows(db, { runId, now });
  if (existing.length) {
    return verifyStage1Fixtures(db, deps, { now, runId, flags });
  }

  const accounts = [];
  for (const role of [
    STAGE1_FIXTURE_ROLE.OWNER_A,
    STAGE1_FIXTURE_ROLE.OTHER_B,
    STAGE1_FIXTURE_ROLE.TENANT_T,
  ]) {
    const email = fixtureEmailForRole(runId, role);
    const password = randomFixturePassword();
    const user = registerUser(db, {
      email,
      password,
      acceptDisclaimer: true,
      acceptPrivacy: true,
      emailVerified: true,
    });
    registerFixtureRow(db, {
      runId,
      kind: STAGE1_FIXTURE_KIND.USER,
      role,
      rowId: user.id,
      now,
    });
    accounts.push({ role, id: Number(user.id), email_hash: opaqueId(email) });
  }

  const owner = accounts.find((row) => row.role === STAGE1_FIXTURE_ROLE.OWNER_A);
  const other = accounts.find((row) => row.role === STAGE1_FIXTURE_ROLE.OTHER_B);
  const tenant = accounts.find((row) => row.role === STAGE1_FIXTURE_ROLE.TENANT_T);

  createIsolatedListing(db, { createSelfListing }, owner.id, runId, now, deps.listingIsolation || {});

  function publishWish(role, input) {
    return createIsolatedWish(db, { createDemandPost }, tenant.id, runId, role, input, now, deps.wishIsolation || {});
  }

  const hard = publishWish(
    STAGE1_FIXTURE_ROLE.WISH_HARD_CONFLICT,
    wishFixtureInput(runId, STAGE1_FIXTURE_ROLE.WISH_HARD_CONFLICT, {
      condition_choices: { need_pet: "want" },
      choices: { need_pet: "want" },
    }),
  );
  applyWishLifecycleAction(db, tenant.id, hard.id, "complete", now);

  const completed = publishWish(
    STAGE1_FIXTURE_ROLE.WISH_COMPLETED,
    wishFixtureInput(runId, STAGE1_FIXTURE_ROLE.WISH_COMPLETED),
  );
  applyWishLifecycleAction(db, tenant.id, completed.id, "complete", now);

  const paused = publishWish(
    STAGE1_FIXTURE_ROLE.WISH_PAUSED,
    wishFixtureInput(runId, STAGE1_FIXTURE_ROLE.WISH_PAUSED),
  );
  applyWishLifecycleAction(db, tenant.id, paused.id, "pause", now);

  publishWish(
    STAGE1_FIXTURE_ROLE.WISH_ACTIVE,
    wishFixtureInput(runId, STAGE1_FIXTURE_ROLE.WISH_ACTIVE),
  );

  createIsolatedWish(
    db,
    { createDemandPost },
    other.id,
    runId,
    STAGE1_FIXTURE_ROLE.WISH_INACTIVE,
    { ...wishFixtureInput(runId, STAGE1_FIXTURE_ROLE.WISH_INACTIVE), draft: true },
    now,
    deps.wishIsolation || {},
  );

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
} = {}) {
  ensureStage1FixtureSchema(db);
  if (flags) assertReadinessFlags(flags, "cleanup");
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
    return verifyCleanup(db, deps, { now, runId, namespace, flags, emptyOk: true });
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
  });
}

export function verifyCleanup(db, deps = {}, {
  now = new Date(),
  runId,
  namespace = STAGE1_FIXTURE_NAMESPACE,
  flags,
  cleanedIdentities = [],
  emptyOk = false,
} = {}) {
  if (flags) assertReadinessFlags(flags, "cleanup-verify");
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
    owner_matching_enabled: false,
    flags_mutated: false,
    wildcard_email_like: false,
  });
}

export function reapStaleStage1Fixtures(db, deps = {}, options = {}) {
  return cleanupStage1Fixtures(db, deps, { ...options, includeStale: true, runId: undefined });
}

export const FIXTURE_MODES = Object.freeze(["prepare", "verify", "cleanup", "reap-stale"]);

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
  assertReadinessFlags(before, "fixture-before");
  let result;
  if (mode === "prepare") {
    result = prepareStage1Fixtures(db, deps, {
      now,
      runId: String(runId || "").trim() || makeStage1FixtureRunId(now, deps.workflowRunId),
      flags: before,
    });
  } else if (mode === "cleanup") {
    result = cleanupStage1Fixtures(db, deps, { now, runId, flags: before });
  } else if (mode === "reap-stale") {
    result = reapStaleStage1Fixtures(db, deps, { now, flags: before });
  } else {
    result = verifyStage1Fixtures(db, deps, { now, runId, flags: before });
  }
  const after = snapshotFlags(getRentalMarketplaceFlags);
  if (!sameFlags(before, after)) {
    throw new Error("fixture domain mutated feature flags");
  }
  assertReadinessFlags(after, "fixture-after");
  const doc = {
    schema: "stage1-fixture-domain-v1",
    mode,
    flags_mutated: false,
    before_raw_flags: before,
    after_raw_flags: after,
    owner_matching_enabled: false,
    result: result?.evidence || result,
    ok: true,
  };
  if (resultPath) writeFileSync(resultPath, JSON.stringify(doc, null, 2) + "\n");
  return doc;
}
