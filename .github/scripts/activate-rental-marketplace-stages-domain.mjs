// Single-process staged Marketplace activation (Stage 2 / 3 / 4).
// Uses exported domain functions only. Never mutates settings with raw SQL.
// Monotonic order: Stage N may only be enabled when every earlier stage is ON,
// every later stage is OFF and every outbound channel is OFF. Compensating
// rollback touches ONLY the target stage. Enabling an already-ON stage is an
// idempotent no-op (verify-only replay).
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STAGE_ORDER = Object.freeze([1, 2, 3, 4]);
export const STAGE1_FLAGS = Object.freeze(["owner_matching_enabled"]);
export const STAGE_FLAGS = Object.freeze({
  2: Object.freeze(["offer_enabled"]),
  3: Object.freeze(["public_share_v2_enabled"]),
  4: Object.freeze(["owner_notifications_enabled", "notifications_enabled"]),
});
// email / push / digest must never be enabled by staged activation.
export const OUTBOUND_FLAGS = Object.freeze([
  "digest_enabled",
  "outbound_mail_enabled",
  "outbound_push_enabled",
]);
export const TARGET_STAGES = Object.freeze([2, 3, 4]);

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function normalizeStage(value) {
  const stage = Number(value);
  if (!TARGET_STAGES.includes(stage)) throw new Error(`unsupported target stage ${value}`);
  return stage;
}

export function flagsForStage(stage) {
  return Number(stage) === 1 ? STAGE1_FLAGS : STAGE_FLAGS[normalizeStage(stage)];
}

export function earlierStageFlags(stage) {
  const target = normalizeStage(stage);
  const out = [];
  for (const n of STAGE_ORDER) if (n < target) out.push(...flagsForStage(n));
  return out;
}

export function laterStageFlags(stage) {
  const target = normalizeStage(stage);
  const out = [];
  for (const n of STAGE_ORDER) if (n > target) out.push(...flagsForStage(n));
  return out;
}

export function targetFlagState(flags, stage) {
  const wish = asObject(flags?.wish);
  return flagsForStage(stage).map((flag) => ({ flag, enabled: wish[flag] === true }));
}

/** Fail-closed contract for the target stage. */
export function assertStagedFlags(flags, label, stage, { expectTargetOn } = {}) {
  const target = normalizeStage(stage);
  const wish = asObject(flags?.wish);
  if (flags?.rental_catalog_v2?.enabled !== true) {
    throw new Error(`${label} rental_catalog_v2.enabled must be true`);
  }
  if (wish.lifecycle_enabled !== true) {
    throw new Error(`${label} wish.lifecycle_enabled must be true`);
  }
  for (const flag of earlierStageFlags(target)) {
    if (wish[flag] !== true) {
      throw new Error(`${label} earlier-stage flag ${flag} must be true before Stage ${target}`);
    }
  }
  for (const flag of laterStageFlags(target)) {
    if (wish[flag] !== false) {
      throw new Error(`${label} later-stage flag ${flag} must be false for Stage ${target}`);
    }
  }
  for (const flag of OUTBOUND_FLAGS) {
    if (wish[flag] !== false) {
      throw new Error(`${label} outbound flag ${flag} must be false`);
    }
  }
  const want = expectTargetOn === true;
  for (const flag of flagsForStage(target)) {
    if (wish[flag] !== want) {
      throw new Error(`${label} wish.${flag} must be ${want} for Stage ${target}`);
    }
  }
  return { target, flags: flagsForStage(target) };
}

export function runStagedDomain({
  db,
  getRentalMarketplaceFlags,
  saveRentalMarketplaceFlags,
  stage,
  mode = "activate",
  statusPath = process.env.STAGES_DOMAIN_STATUS_PATH || "/tmp/stages-domain-status.json",
  resultPath = process.env.STAGES_DOMAIN_RESULT_PATH || "/tmp/stages-domain-result.json",
} = {}) {
  if (!getRentalMarketplaceFlags || !saveRentalMarketplaceFlags) {
    throw new Error("staged domain requires getRentalMarketplaceFlags and saveRentalMarketplaceFlags");
  }
  void db;
  const target = normalizeStage(stage);
  const mine = flagsForStage(target);
  const writeStatus = (doc) => writeFileSync(statusPath, JSON.stringify(doc));
  const writeResult = (doc) => {
    writeFileSync(resultPath, JSON.stringify(doc));
    return doc;
  };
  const snapshot = () => getRentalMarketplaceFlags();

  function apply(enabled) {
    const wish = {};
    for (const flag of mine) wish[flag] = enabled === true;
    saveRentalMarketplaceFlags({ wish });
  }

  function compensateOff(label) {
    apply(false);
    const after = snapshot();
    assertStagedFlags(after, label, target, { expectTargetOn: false });
    return after;
  }

  if (mode === "inspect") {
    const raw_flags = snapshot();
    const mutated = targetFlagState(raw_flags, target).some((row) => row.enabled);
    writeStatus({ phase: "inspect", mutated });
    return writeResult({ mode: "inspect", target_stage: target, raw_flags, target_flags: targetFlagState(raw_flags, target) });
  }

  if (mode === "rollback") {
    const before_raw_flags = snapshot();
    if (targetFlagState(before_raw_flags, target).every((row) => !row.enabled)) {
      assertStagedFlags(before_raw_flags, "rollback-already-off", target, { expectTargetOn: false });
      writeStatus({ phase: "already-off", mutated: false });
      return writeResult({
        mode: "rollback-already-off",
        target_stage: target,
        before_raw_flags,
        after_raw_flags: before_raw_flags,
        target_flags: targetFlagState(before_raw_flags, target),
      });
    }
    const after_raw_flags = compensateOff(`rollback-stage-${target}`);
    writeStatus({ phase: "rolled-back", mutated: false });
    return writeResult({ mode: "rollback", target_stage: target, before_raw_flags, after_raw_flags, target_flags: targetFlagState(after_raw_flags, target) });
  }

  if (mode !== "activate") throw new Error(`unsupported STAGES_DOMAIN_MODE ${mode}`);

  writeStatus({ phase: "before-save", mutated: false });
  const before_raw_flags = snapshot();
  if (targetFlagState(before_raw_flags, target).every((row) => row.enabled)) {
    assertStagedFlags(before_raw_flags, "already-on", target, { expectTargetOn: true });
    writeStatus({ phase: "already-on", mutated: false });
    return writeResult({
      mode: "activate-already-on",
      target_stage: target,
      before_raw_flags,
      after_raw_flags: before_raw_flags,
      target_flags: targetFlagState(before_raw_flags, target),
    });
  }
  assertStagedFlags(before_raw_flags, "before", target, { expectTargetOn: false });

  apply(true);
  writeStatus({ phase: "after-save", mutated: true });
  try {
    const after_raw_flags = snapshot();
    assertStagedFlags(after_raw_flags, "after", target, { expectTargetOn: true });
    writeStatus({ phase: "after-verify", mutated: true });
    return writeResult({ mode: "activate", target_stage: target, before_raw_flags, after_raw_flags, target_flags: targetFlagState(after_raw_flags, target) });
  } catch (error) {
    try {
      const rolled = compensateOff(`activate-in-process-rollback-stage-${target}`);
      writeStatus({ phase: "rolled-back-in-process", mutated: false, error: String(error?.message || error) });
      writeResult({
        mode: "activate-compensated",
        target_stage: target,
        error: String(error?.message || error),
        before_raw_flags,
        after_raw_flags: rolled,
        target_flags: targetFlagState(rolled, target),
      });
    } catch (rollbackError) {
      writeStatus({ phase: "PRODUCTION_STATE_UNKNOWN", mutated: true, error: String(rollbackError?.message || rollbackError) });
      writeResult({
        mode: "PRODUCTION_STATE_UNKNOWN",
        target_stage: target,
        error: String(rollbackError?.message || rollbackError),
        original_error: String(error?.message || error),
        before_raw_flags,
      });
      throw rollbackError;
    }
    throw error;
  }
}

async function main() {
  const spec = process.env.STAGES_DOMAIN_DB_MODULE || "/app/src/db.js";
  const href = spec.startsWith("file:") ? spec : pathToFileURL(path.resolve(spec)).href;
  const envSpec = process.env.STAGES_ENV_MODULE || "/app/src/env.js";
  await import(pathToFileURL(path.resolve(envSpec)).href);
  const mod = await import(href);
  runStagedDomain({
    db: mod.db,
    getRentalMarketplaceFlags: mod.getRentalMarketplaceFlags,
    saveRentalMarketplaceFlags: mod.saveRentalMarketplaceFlags,
    stage: process.env.STAGES_TARGET_STAGE,
    mode: process.env.STAGES_DOMAIN_MODE || "activate",
  });
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  await main();
}

