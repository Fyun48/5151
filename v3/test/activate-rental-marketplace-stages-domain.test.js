import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OUTBOUND_FLAGS,
  STAGE_FLAGS,
  assertStagedFlags,
  laterStageFlags,
  runStagedDomain,
  targetFlagState,
} from "../../.github/scripts/activate-rental-marketplace-stages-domain.mjs";

function baseFlags({ rental_catalog_v2 = {}, wish = {} } = {}) {
  return {
    rental_catalog_v2: { enabled: true, ...rental_catalog_v2 },
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
      ...wish,
    },
  };
}

function harness(initial = baseFlags()) {
  const dir = mkdtempSync(path.join(tmpdir(), "stages-domain-"));
  let current = structuredClone(initial);
  const writes = [];
  return {
    getRentalMarketplaceFlags: () => structuredClone(current),
    saveRentalMarketplaceFlags: (patch) => {
      writes.push(structuredClone(patch));
      current = {
        ...current,
        ...structuredClone(patch),
        wish: { ...current.wish, ...(patch.wish || {}) },
      };
      return structuredClone(current);
    },
    statusPath: path.join(dir, "status.json"),
    resultPath: path.join(dir, "result.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    state: () => structuredClone(current),
    writes: () => writes,
  };
}

const stage1On = (extra = {}) => baseFlags({ wish: { owner_matching_enabled: true, ...extra } });

test("Stage 2 happy path enables only offer_enabled", () => {
  const h = harness(stage1On());
  const doc = runStagedDomain({ ...h, stage: 2, mode: "activate" });
  assert.equal(doc.mode, "activate");
  assert.equal(doc.target_stage, 2);
  const wish = h.state().wish;
  assert.equal(wish.offer_enabled, true);
  assert.equal(wish.owner_matching_enabled, true);
  assert.equal(wish.public_share_v2_enabled, false);
  for (const flag of OUTBOUND_FLAGS) assert.equal(wish[flag], false);
  h.cleanup();
});

test("out-of-order activation is refused and writes nothing", () => {
  const h = harness(stage1On());
  assert.throws(
    () => runStagedDomain({ ...h, stage: 3, mode: "activate" }),
    /earlier-stage flag offer_enabled must be true before Stage 3/,
  );
  assert.equal(h.state().wish.public_share_v2_enabled, false);
  assert.equal(h.writes().length, 0);
  h.cleanup();
});

test("a later stage already ON blocks activation without mutation", () => {
  const h = harness(stage1On({ public_share_v2_enabled: true }));
  assert.throws(
    () => runStagedDomain({ ...h, stage: 2, mode: "activate" }),
    /later-stage flag public_share_v2_enabled must be false for Stage 2/,
  );
  assert.equal(h.state().wish.offer_enabled, false);
  assert.equal(h.writes().length, 0);
  h.cleanup();
});

test("any outbound channel ON blocks activation without mutation", () => {
  const h = harness(stage1On({ outbound_mail_enabled: true }));
  assert.throws(
    () => runStagedDomain({ ...h, stage: 2, mode: "activate" }),
    /outbound flag outbound_mail_enabled must be false/,
  );
  assert.equal(h.writes().length, 0);
  h.cleanup();
});

test("idempotent replay of an already-ON stage is verify-only", () => {
  const h = harness(stage1On({ offer_enabled: true }));
  const doc = runStagedDomain({ ...h, stage: 2, mode: "activate" });
  assert.equal(doc.mode, "activate-already-on");
  assert.equal(h.writes().length, 0);
  assert.equal(h.state().wish.offer_enabled, true);
  h.cleanup();
});

test("Stage 4 enables both in-app flags and keeps outbound OFF", () => {
  const h = harness(stage1On({ offer_enabled: true, public_share_v2_enabled: true }));
  const doc = runStagedDomain({ ...h, stage: 4, mode: "activate" });
  assert.equal(doc.mode, "activate");
  const wish = h.state().wish;
  assert.equal(wish.owner_notifications_enabled, true);
  assert.equal(wish.notifications_enabled, true);
  assert.equal(wish.offer_enabled, true);
  assert.equal(wish.public_share_v2_enabled, true);
  for (const flag of OUTBOUND_FLAGS) assert.equal(wish[flag], false);
  h.cleanup();
});

test("rollback clears only the target stage", () => {
  const h = harness(stage1On({ offer_enabled: true, public_share_v2_enabled: true }));
  const doc = runStagedDomain({ ...h, stage: 3, mode: "rollback" });
  assert.equal(doc.mode, "rollback");
  const wish = h.state().wish;
  assert.equal(wish.public_share_v2_enabled, false);
  assert.equal(wish.offer_enabled, true);
  assert.equal(wish.owner_matching_enabled, true);
  assert.equal(wish.notifications_enabled, false);
  h.cleanup();
});

test("rollback of an already-OFF stage is a no-op", () => {
  const h = harness(stage1On());
  const doc = runStagedDomain({ ...h, stage: 2, mode: "rollback" });
  assert.equal(doc.mode, "rollback-already-off");
  assert.equal(h.writes().length, 0);
  h.cleanup();
});

test("post-activation verify failure compensates the target stage only", () => {
  const h = harness(stage1On());
  let enabled = false;
  const deps = {
    ...h,
    saveRentalMarketplaceFlags: (patch) => {
      if (patch.wish?.offer_enabled === true) {
        enabled = true;
        return undefined;
      }
      return h.saveRentalMarketplaceFlags(patch);
    },
  };
  assert.throws(
    () => runStagedDomain({ ...deps, stage: 2, mode: "activate" }),
    /must be true for Stage 2/,
  );
  assert.equal(enabled, true);
  assert.equal(h.state().wish.offer_enabled, false);
  assert.equal(h.state().wish.owner_matching_enabled, true);
  h.cleanup();
});

test("rollback failure surfaces a fail-closed error", () => {
  const h = harness(stage1On());
  let rollbackAttempted = false;
  const deps = {
    ...h,
    saveRentalMarketplaceFlags: (patch) => {
      if (patch.wish?.offer_enabled === true) return undefined;
      if (patch.wish?.offer_enabled === false) {
        rollbackAttempted = true;
        throw new Error("rollback save failed");
      }
      return h.saveRentalMarketplaceFlags(patch);
    },
  };
  assert.throws(
    () => runStagedDomain({ ...deps, stage: 2, mode: "activate" }),
    /rollback save failed/,
  );
  assert.equal(rollbackAttempted, true);
  h.cleanup();
});

test("unsupported target stages fail closed", () => {
  const h = harness(stage1On());
  assert.throws(() => runStagedDomain({ ...h, stage: 5, mode: "activate" }), /unsupported target stage/);
  assert.throws(() => runStagedDomain({ ...h, stage: 1, mode: "activate" }), /unsupported target stage/);
  h.cleanup();
});

test("staged flag contract: stage map, later flags and target state", () => {
  assert.deepEqual(STAGE_FLAGS[2], ["offer_enabled"]);
  assert.deepEqual(STAGE_FLAGS[3], ["public_share_v2_enabled"]);
  assert.deepEqual(STAGE_FLAGS[4], ["owner_notifications_enabled", "notifications_enabled"]);
  assert.deepEqual(laterStageFlags(2), [
    "public_share_v2_enabled",
    "owner_notifications_enabled",
    "notifications_enabled",
  ]);
  assert.throws(
    () => assertStagedFlags(baseFlags(), "label", 2, { expectTargetOn: false }),
    /earlier-stage flag owner_matching_enabled must be true/,
  );
  assert.deepEqual(targetFlagState(stage1On({ offer_enabled: true }), 2), [
    { flag: "offer_enabled", enabled: true },
  ]);
});

