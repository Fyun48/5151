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
  const state = {
    registry: [],
    registryId: 0,
    openWishes: new Map(),
    created: [],
    actions: [],
    deleted: [],
    cleaned: [],
    registeredUsers: 0,
  };
  const registryRows = (runId) => state.registry.filter((row) => !row.cleaned_at && (!runId || row.run_id === runId));
  const world = {
    state,
    registryMod: {
      STAGE1_FIXTURE_ROLE: ROLE,
      STAGE1_FIXTURE_KIND: KIND,
      ensureStage1FixtureSchema: () => true,
      assertPrepareRunExclusive: () => true,
      fixtureEmailForRole: (runId, role) => `${role}+${runId}@fixture.invalid`,
      registerFixtureRow: (_db, { runId, kind, role, rowId }) => {
        state.registryId += 1;
        state.registry.push({ id: state.registryId, run_id: runId, kind, role, row_id: rowId, cleaned_at: "" });
        return state.registryId;
      },
      authorizeFixtureIsolation: () => ({ namespace: "stage1-fix" }),
      listActiveRegistryRows: (_db, { runId }) => registryRows(runId),
      listUncleanedRegistryRows: (_db, { runId }) => registryRows(runId),
      uncleanedFixtureRunIds: () => [...new Set(registryRows().map((row) => row.run_id))],
      markRegistryRowCleaned: (_db, id) => {
        const row = state.registry.find((entry) => entry.id === id);
        if (row) row.cleaned_at = "now";
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
        state.deleted.push(Number(id));
        return true;
      },
      createSelfListing: () => ({ post_id: 900001, self_status: "open" }),
      nextSelfPostId: () => 900001,
      nextDemandPostId: () => 800000 + state.created.length + 1,
      createDemandPost: (_db, userId) => {
        const open = state.openWishes.get(userId) || 0;
        if (open >= 1) {
          throw Object.assign(new Error("wish_active_limit"), { status: 409, code: "wish_active_limit" });
        }
        state.openWishes.set(userId, open + 1);
        state.created.push({ userId, wishId: 800000 + state.created.length + 1 });
        return { id: 800000 + state.created.length };
      },
      applyWishLifecycleAction: (_db, userId, wishId, action) => {
        state.actions.push({ userId, wishId, action });
        state.openWishes.set(userId, Math.max(0, (state.openWishes.get(userId) || 1) - 1));
        return { ok: true };
      },
    },
  };
  const db = {
    exec: () => true,
    prepare: () => ({ get: (id) => ({ id: Number(id), public_token: `uat-token-${id}`, user_id: 12 }) }),
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

