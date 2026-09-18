import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cleanupUatFixtures, createUatFixtures } from "../../.github/scripts/production-uat-stages-wiring.mjs";

const WIRING_SRC = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../../.github/scripts/production-uat-stages-wiring.mjs"),
  "utf8",
);

const ROLE = Object.freeze({
  OWNER_A: "owner_a",
  OTHER_B: "other_b",
  TENANT_T: "tenant_t",
  LISTING_A: "listing_a",
  WISH_ACTIVE: "wish_active",
  WISH_PAUSED: "wish_paused",
  WISH_COMPLETED: "wish_completed",
  WISH_HARD_CONFLICT: "wish_hard_conflict",
});
const KIND = Object.freeze({ USER: "user", LISTING: "listing", WISH: "wish" });

/** Registry + domain fakes that enforce the real one-open-wish-per-user rule. */
function makeWorld() {
  const NAMESPACE = "stage1-fix";
  const state = {
    registry: [],
    registryId: 0,
    openWishes: new Map(),
    created: [],
    actions: [],
    deleted: [],
    cleaned: [],
    registeredUsers: 0,
    listings: new Map(),
    wishes: new Map(),
    log: [],
  };
  const registryRows = (runId) => state.registry.filter((row) => !row.cleaned_at && (!runId || row.run_id === runId));
  const closeListing = (_db, userId, postId, options = {}) => {
    const row = state.listings.get(Number(postId));
    state.log.push(`close-listing:${postId}`);
    if (!row) throw new Error("找不到這則站內刊登");
    if (!options.admin && Number(row.listed_by_user_id) !== Number(userId)) throw new Error("只能關閉自己的刊登");
    row.self_status = "closed";
    return { post_id: Number(postId), status: "closed" };
  };
  const world = {
    state,
    closeListing,
    registryMod: {
      STAGE1_FIXTURE_ROLE: ROLE,
      STAGE1_FIXTURE_KIND: KIND,
      STAGE1_FIXTURE_NAMESPACE: NAMESPACE,
      ensureStage1FixtureSchema: () => true,
      assertPrepareRunExclusive: () => true,
      fixtureEmailForRole: (runId, role) => `${role}+${runId}@fixture.invalid`,
      registerFixtureRow: (_db, { runId, kind, role, rowId }) => {
        state.registryId += 1;
        state.registry.push({ id: state.registryId, run_id: runId, kind, role, row_id: rowId, cleaned_at: "" });
        return state.registryId;
      },
      authorizeFixtureIsolation: () => ({ namespace: NAMESPACE }),
      listActiveRegistryRows: (_db, { runId }) => registryRows(runId),
      listStaleRegistryRows: () => [],
      listUncleanedRegistryRows: (_db, { runId }) => registryRows(runId),
      uncleanedFixtureRunIds: () => [...new Set(registryRows().map((row) => row.run_id))],
      markRegistryRowCleaned: (_db, id, now) => {
        const row = state.registry.find((entry) => entry.id === id);
        state.log.push(`clean:${id}:${row ? row.kind : "unknown"}`);
        if (row) row.cleaned_at = String(now || "now");
        state.cleaned.push(id);
        return true;
      },
    },
    fixtureOpsMod: {
      randomFixturePassword: () => "Fx!not-a-real-secret",
      listingFixtureInput: (runId) => ({ title: `fixture ${runId}`, idempotency_key: `k-${runId}` }),
      wishFixtureInput: (runId, role) => ({ body: `fixture ${runId} ${role}` }),
    },
    deps: {
      registerUser: () => {
        state.registeredUsers += 1;
        return { id: 10 + state.registeredUsers };
      },
      deleteUser: (_db, id) => {
        state.log.push(`delete-user:${id}`);
        state.deleted.push(Number(id));
        return true;
      },
      createSelfListing: (_db, userId) => {
        state.listings.set(900001, {
          post_id: 900001,
          self_status: "open",
          listed_by_user_id: Number(userId),
          fixture_namespace: NAMESPACE,
        });
        return { post_id: 900001, self_status: "open" };
      },
      closeSelfListing: closeListing,
      nextSelfPostId: () => 900001,
      nextDemandPostId: () => 800000 + state.created.length + 1,
      createDemandPost: (_db, userId) => {
        const open = state.openWishes.get(userId) || 0;
        if (open >= 1) {
          throw Object.assign(new Error("wish_active_limit"), { status: 409, code: "wish_active_limit" });
        }
        state.openWishes.set(userId, open + 1);
        state.created.push({ userId, wishId: 800000 + state.created.length + 1 });
        const wishId = 800000 + state.created.length;
        state.wishes.set(wishId, {
          id: wishId,
          status: "open",
          user_id: Number(userId),
          fixture_namespace: NAMESPACE,
          public_token: `uat-token-${wishId}`,
        });
        return { id: wishId };
      },
      applyWishLifecycleAction: (_db, userId, wishId, action) => {
        state.actions.push({ userId, wishId, action });
        state.log.push(`wish-${action}:${wishId}`);
        state.openWishes.set(userId, Math.max(0, (state.openWishes.get(userId) || 1) - 1));
        const row = state.wishes.get(Number(wishId));
        if (row) row.status = action === "pause" ? "paused" : "completed";
        return { ok: true };
      },
    },
  };
  const db = {
    exec: () => true,
    prepare: (sql) => ({
      get: (id) => {
        const table = /FROM\s+([A-Za-z_]+)/.exec(String(sql))?.[1] || "";
        if (table === "listings") return state.listings.get(Number(id)) || null;
        if (table === "demand_posts") return state.wishes.get(Number(id)) || null;
        return { id: Number(id), public_token: `uat-token-${id}`, user_id: 12 };
      },
    }),
  };
  return { world, db };
}


test("UAT fixtures never hold two open wishes for one user (Production wish_active_limit)", async () => {
  const { world, db } = makeWorld();
  const ctx = await createUatFixtures({
    db,
    deps: world.deps,
    registryMod: world.registryMod,
    fixtureOpsMod: world.fixtureOpsMod,
    runId: "35325186077-1",
    now: new Date("2026-09-18T08:36:00Z"),
    namespace: "issue333-uat-35325186077",
  });
  assert.equal(world.state.registry.filter((row) => row.kind === KIND.USER).length, 3);
  assert.equal(world.state.registry.filter((row) => row.kind === KIND.LISTING).length, 1);
  assert.equal(world.state.registry.filter((row) => row.kind === KIND.WISH).length, 4);
  assert.equal(world.state.created.length, 4);
  // Regression: each non-active wish is closed before the next create, so the
  // open/eligible wish is created last and 409 wish_active_limit is never hit.
  assert.deepEqual(world.state.actions.map((a) => a.action), ["pause", "complete", "complete"]);
  assert.equal(world.state.openWishes.get(ctx.tenantId), 1);
  assert.equal(ctx.ownerId, 11);
  assert.equal(ctx.tenantId, 12);
  assert.equal(ctx.otherId, 13);
  assert.match(ctx.shareToken, /^uat-token-/);
  assert.equal(ctx.wishes.eligible.id, 800004);
  assert.deepEqual(ctx.dockRows, []);
});

test("UAT cleanup deletes every fixture account through the domain API", async () => {
  const { world, db } = makeWorld();
  await createUatFixtures({
    db,
    deps: world.deps,
    registryMod: world.registryMod,
    fixtureOpsMod: world.fixtureOpsMod,
    runId: "run-a",
    now: new Date("2026-09-18T08:36:00Z"),
    namespace: "issue333-uat-run-a",
  });
  const result = await cleanupUatFixtures({
    db,
    deps: world.deps,
    registryMod: world.registryMod,
    runId: "run-a",
    now: new Date(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.cleaned, 8);
  assert.deepEqual(world.state.deleted.sort((a, b) => a - b), [11, 12, 13]);
  assert.equal(result.registry_leftover_runs, 0);
});

test("#349 UAT cleanup closes every fixture row before it books the registry row cleaned", async () => {
  const { world, db } = makeWorld();
  await createUatFixtures({
    db,
    deps: world.deps,
    registryMod: world.registryMod,
    fixtureOpsMod: world.fixtureOpsMod,
    runId: "run-close",
    now: new Date("2026-09-18T08:36:00Z"),
    namespace: "issue333-uat-run-close",
  });
  const result = await cleanupUatFixtures({
    db,
    deps: world.deps,
    registryMod: world.registryMod,
    runId: "run-close",
    now: new Date("2026-09-18T09:00:00Z"),
  });
  assert.equal(result.ok, true);
  assert.equal(result.closed_listings, 1);
  // the three non-active wishes are already closed by create; only the
  // open/eligible wish is left for cleanup to close.
  assert.equal(result.closed_wishes, 1);
  const firstClean = world.state.log.findIndex((entry) => entry.startsWith("clean:"));
  const lastClose = world.state.log.reduce(
    (last, entry, index) => (entry.startsWith("close-listing:") || entry.startsWith("wish-") ? index : last),
    -1,
  );
  assert.ok(lastClose >= 0, "fixture rows must be closed through the domain APIs");
  assert.ok(firstClean > lastClose, "no registry row may be booked cleaned before its row is closed");
  assert.equal(world.state.listings.get(900001).self_status, "closed");
  assert.equal([...world.state.wishes.values()].every((row) => row.status !== "open"), true);
  assert.equal(world.state.registry.every((row) => row.cleaned_at), true);
});

test("#349 UAT cleanup fails closed when a fixture row cannot be closed and stays retryable", async () => {
  const { world, db } = makeWorld();
  await createUatFixtures({
    db,
    deps: world.deps,
    registryMod: world.registryMod,
    fixtureOpsMod: world.fixtureOpsMod,
    runId: "run-refuse",
    now: new Date("2026-09-18T08:36:00Z"),
    namespace: "issue333-uat-run-refuse",
  });
  world.deps.closeSelfListing = () => {
    throw new Error("close refused");
  };
  await assert.rejects(
    () => cleanupUatFixtures({
      db,
      deps: world.deps,
      registryMod: world.registryMod,
      runId: "run-refuse",
      now: new Date(),
    }),
    /close refused/,
  );
  // nothing was booked cleaned and no account was removed, so the run is recoverable
  assert.equal(world.state.registry.every((row) => !row.cleaned_at), true);
  assert.deepEqual(world.state.deleted, []);
  assert.equal(world.state.listings.get(900001).self_status, "open");
  world.deps.closeSelfListing = world.closeListing;
  const retry = await cleanupUatFixtures({
    db,
    deps: world.deps,
    registryMod: world.registryMod,
    runId: "run-refuse",
    now: new Date(),
  });
  assert.equal(retry.ok, true);
  assert.deepEqual(world.state.deleted.sort((a, b) => a - b), [11, 12, 13]);
  assert.equal(world.state.listings.get(900001).self_status, "closed");
});

test("#349 UAT cleanup fails closed when a listing silently stays open", async () => {
  const { world, db } = makeWorld();
  await createUatFixtures({
    db,
    deps: world.deps,
    registryMod: world.registryMod,
    fixtureOpsMod: world.fixtureOpsMod,
    runId: "run-silent",
    now: new Date("2026-09-18T08:36:00Z"),
    namespace: "issue333-uat-run-silent",
  });
  world.deps.closeSelfListing = () => ({ post_id: 900001, status: "open" });
  await assert.rejects(
    () => cleanupUatFixtures({
      db,
      deps: world.deps,
      registryMod: world.registryMod,
      runId: "run-silent",
      now: new Date(),
    }),
    /could not close fixture listing 900001/,
  );
  assert.equal(world.state.registry.every((row) => !row.cleaned_at), true);
});

test("UAT cleanup reports leftovers instead of passing silently", async () => {
  const { world, db } = makeWorld();
  await createUatFixtures({
    db,
    deps: world.deps,
    registryMod: world.registryMod,
    fixtureOpsMod: world.fixtureOpsMod,
    runId: "run-b",
    now: new Date(),
    namespace: "issue333-uat-run-b",
  });
  world.registryMod.listUncleanedRegistryRows = () => [{ id: 999, run_id: "run-b" }];
  world.registryMod.uncleanedFixtureRunIds = () => ["run-b", "stage1-fix:20260918064529:35316208975"];
  const result = await cleanupUatFixtures({
    db,
    deps: world.deps,
    registryMod: world.registryMod,
    runId: "run-b",
    now: new Date(),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /registry rows were not cleaned/);
  assert.equal(result.registry_leftover_runs, 2);
});

test("UAT wiring hydrates the demand and listing modules a fresh process would not have", () => {
  // Regression for the Production 503 wish_lifecycle_off: demand.js reads an
  // in-process flag snapshot, so a fresh `docker exec` process must hydrate it
  // exactly as stage1-fixture-domain.mjs does.
  assert.match(WIRING_SRC, /demandMod\.setRentalMarketplaceFlags\(flags\)/);
  assert.match(WIRING_SRC, /demandMod\.setRentalCatalogCache\(catalog\)/);
  assert.match(WIRING_SRC, /listingMod\.setSelfListingCatalog\(catalog, flags\)/);
  assert.match(WIRING_SRC, /await import\(pathToFileURL\(path\.resolve\(envSpec\)\)\.href\)/);
});

test("UAT wiring records ASCII status and code for a fatal domain refusal", () => {
  // The SSH transport can mangle non-ASCII text in the log, so the fatal record
  // must carry the machine-readable status/code.
  assert.match(WIRING_SRC, /fatal = `status=\$\{Number\(error\?\.status \|\| 0\)\} code=\$\{String\(error\?\.code \|\| ""\)\}/);
  assert.match(WIRING_SRC, /console\.error\("UAT_FATAL " \+ fatal\)/);
  assert.match(WIRING_SRC, /if \(!doc\) \{/);
});

