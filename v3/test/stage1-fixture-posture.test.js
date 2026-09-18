import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACTIVATED_STAGE_FLAGS,
  FIXTURE_CLEANUP_MODES,
  FIXTURE_OUTBOUND_FLAGS,
  FIXTURE_POSTURE,
  assertReadinessFlags,
  detectFixturePosture,
  postureForMode,
  runStage1FixtureDomain,
} from "../src/stage1FixtureOps.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPS_SRC = readFileSync(path.join(root, "src/stage1FixtureOps.js"), "utf8").replace(/\r\n/g, "\n");
const REMOTE_SRC = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../../.github/scripts/stage1-fixture-remote.sh"),
  "utf8",
).replace(/\r\n/g, "\n");
const EVIDENCE_PY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.github/scripts/stage1-fixture-evidence.py",
);

function preFlags(overrides = {}) {
  return {
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
      ...overrides,
    },
  };
}

function postFlags(overrides = {}) {
  return preFlags({
    owner_matching_enabled: true,
    offer_enabled: true,
    public_share_v2_enabled: true,
    owner_notifications_enabled: true,
    notifications_enabled: true,
    ...overrides,
  });
}

function hasPython3() {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const PYTHON3 = hasPython3();

function pythonTest(name, fn) {
  test(name, { skip: PYTHON3 ? false : "python3 is unavailable on this host" }, fn);
}

function runEvidence(doc) {
  const dir = mkdtempSync(path.join(tmpdir(), "fixture-posture-"));
  const file = path.join(dir, "evidence.json");
  writeFileSync(file, JSON.stringify(doc, null, 2));
  try {
    return { ok: true, stdout: execFileSync("python3", [EVIDENCE_PY, file], { encoding: "utf8" }) };
  } catch (error) {
    return { ok: false, stdout: `${error.stdout || ""}${error.stderr || ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function evidenceDoc(overrides = {}) {
  return {
    schema: "stage1-fixture-evidence-v1",
    mode: "cleanup",
    posture: FIXTURE_POSTURE.POST_ACTIVATION,
    flags_mutated: false,
    owner_matching_enabled: true,
    after_raw_flags: postFlags(),
    evidence_available: true,
    ...overrides,
  };
}


test("fixture posture detection accepts a settled set and refuses a partial one", () => {
  assert.equal(detectFixturePosture(preFlags()), FIXTURE_POSTURE.PRE_ACTIVATION);
  assert.equal(detectFixturePosture(postFlags()), FIXTURE_POSTURE.POST_ACTIVATION);
  assert.throws(() => detectFixturePosture(preFlags({ offer_enabled: true })), /stage flags are inconsistent/);
  assert.throws(() => detectFixturePosture(postFlags({ notifications_enabled: false })), /stage flags are inconsistent/);
});

test("only cleanup modes may use the cleanup posture", () => {
  assert.deepEqual([...FIXTURE_CLEANUP_MODES], ["cleanup", "reap-stale", "cleanup-activated"]);
  for (const mode of FIXTURE_CLEANUP_MODES) assert.equal(postureForMode(mode), "cleanup");
  for (const mode of ["prepare", "verify"]) assert.equal(postureForMode(mode), "strict");
  assert.equal(ACTIVATED_STAGE_FLAGS.length, 4);
  assert.equal(FIXTURE_OUTBOUND_FLAGS.length, 3);
});

test("the strict posture keeps the original pre-activation requirement", () => {
  assert.equal(assertReadinessFlags(preFlags(), "strict"), FIXTURE_POSTURE.PRE_ACTIVATION);
  // The owner_matching gate fires first in the strict posture, which is the
  // original behaviour: prepare/verify only ever run before Stage 1 is ON.
  assert.throws(() => assertReadinessFlags(postFlags(), "strict"), /wish\.owner_matching_enabled must be false/);
  assert.throws(
    () => assertReadinessFlags(preFlags({ offer_enabled: true }), "strict"),
    /wish\.offer_enabled must be false/,
  );
  // prepare and verify must keep calling the readiness contract without a posture.
  assert.match(OPS_SRC, /assertReadinessFlags\(flags, "prepare"\)/);
  assert.match(OPS_SRC, /assertReadinessFlags\(flags, "verify"\)/);
});

test("the cleanup posture accepts both settled postures and never outbound", () => {
  assert.equal(
    assertReadinessFlags(preFlags(), "cleanup", false, { posture: "cleanup" }),
    FIXTURE_POSTURE.PRE_ACTIVATION,
  );
  assert.equal(
    assertReadinessFlags(postFlags(), "cleanup", false, { posture: "cleanup" }),
    FIXTURE_POSTURE.POST_ACTIVATION,
  );
  // Post-activation implies Stage 1 is ON, whatever the mode default says.
  assert.throws(
    () => assertReadinessFlags(postFlags({ owner_matching_enabled: false }), "cleanup", false, { posture: "cleanup" }),
    /owner_matching_enabled must be true/,
  );
  for (const key of FIXTURE_OUTBOUND_FLAGS) {
    assert.throws(
      () => assertReadinessFlags(postFlags({ [key]: true }), "cleanup", false, { posture: "cleanup" }),
      new RegExp(`wish\\.${key} must be false`),
      key,
    );
    assert.throws(
      () => assertReadinessFlags(preFlags({ [key]: true }), "cleanup", false, { posture: "cleanup" }),
      new RegExp(`wish\\.${key} must be false`),
      key,
    );
  }
  assert.throws(
    () => assertReadinessFlags(preFlags({ offer_enabled: true }), "cleanup", false, { posture: "cleanup" }),
    /stage flags are inconsistent/,
  );
  assert.throws(
    () => assertReadinessFlags(preFlags(), "cleanup", false, { posture: "wild" }),
    /unsupported fixture posture/,
  );
});

test("prepare and verify refuse the post-activation posture before touching the database", () => {
  const flags = { current: postFlags() };
  for (const mode of ["prepare", "verify"]) {
    assert.throws(
      () => runStage1FixtureDomain({ db: {}, getRentalMarketplaceFlags: () => flags.current, mode, deps: {} }),
      /wish\.owner_matching_enabled must be false/,
      mode,
    );
  }
});

test("cleanup modes pass the post-activation readiness gate and fail later, not on readiness", () => {
  const flags = { current: postFlags() };
  for (const mode of ["cleanup", "reap-stale", "cleanup-activated"]) {
    // A stub db cannot complete the work, so the call still throws - but never
    // with a readiness or posture rejection, which proves the gate let it through.
    let message = "";
    try {
      runStage1FixtureDomain({ db: {}, getRentalMarketplaceFlags: () => flags.current, mode, deps: {} });
    } catch (error) {
      message = String(error?.message || error);
    }
    assert.notEqual(message, "", `${mode} should still fail on the stub db`);
    for (const fragment of ["must be false", "must be true", "stage flags are inconsistent", "fixture-before"]) {
      assert.ok(!message.includes(fragment), `${mode} failed on readiness: ${message}`);
    }
  }
});

test("cleanup stays registry-scoped and never wildcard-deletes member rows", () => {
  assert.match(OPS_SRC, /listActiveRegistryRows\(db, \{ namespace, runId, now \}\)/);
  assert.match(OPS_SRC, /listStaleRegistryRows\(/);
  assert.match(OPS_SRC, /requireDomain\(deps, "deleteUser"\)/);
  assert.ok(!/DELETE\s+FROM\s+(users|listings|demand_posts)/i.test(OPS_SRC), "fixture cleanup must delete through domain APIs");
  assert.match(OPS_SRC, /Never uses email LIKE cleanup/);
  assert.ok(!/WHERE\s+email\s+LIKE/i.test(OPS_SRC), "fixture cleanup must never wildcard-match emails");
});

pythonTest("fixture evidence accepts a pre-activation run unchanged", () => {
  const out = runEvidence(
    evidenceDoc({
      mode: "prepare",
      posture: FIXTURE_POSTURE.PRE_ACTIVATION,
      owner_matching_enabled: false,
      after_raw_flags: preFlags(),
    }),
  );
  assert.equal(out.ok, true, out.stdout);
  assert.match(out.stdout, /FIXTURE_EVIDENCE_OK/);
});

pythonTest("fixture evidence accepts an activated cleanup or reap run", () => {
  for (const mode of ["cleanup", "reap-stale", "cleanup-activated"]) {
    const out = runEvidence(evidenceDoc({ mode }));
    assert.equal(out.ok, true, `${mode}: ${out.stdout}`);
  }
});

pythonTest("fixture evidence refuses an activated prepare or verify run", () => {
  for (const mode of ["prepare", "verify"]) {
    const out = runEvidence(evidenceDoc({ mode }));
    assert.equal(out.ok, false, mode);
    assert.match(out.stdout, /prepare\/verify must not run in the post-activation posture/);
  }
});

pythonTest("fixture evidence refuses an activated run with any outbound channel on", () => {
  for (const key of FIXTURE_OUTBOUND_FLAGS) {
    const out = runEvidence(evidenceDoc({ after_raw_flags: postFlags({ [key]: true }) }));
    assert.equal(out.ok, false, key);
    assert.match(out.stdout, new RegExp(`wish\\.${key} must be false`));
  }
});

pythonTest("fixture evidence refuses an owner_matching value that contradicts the posture", () => {
  const out = runEvidence(evidenceDoc({ owner_matching_enabled: false }));
  assert.equal(out.ok, false);
  assert.match(out.stdout, /owner_matching_enabled must be True/);
});

pythonTest("fixture evidence refuses a partially activated stage set", () => {
  const out = runEvidence(evidenceDoc({ after_raw_flags: preFlags({ offer_enabled: true, owner_matching_enabled: true }) }));
  assert.equal(out.ok, false);
  assert.match(out.stdout, /must be (True|False)/);
  assert.ok(!/FIXTURE_EVIDENCE_OK/.test(out.stdout));
});

test("the fixture remote and workflow keep the posture-aware fail-closed contract", () => {
  assert.match(REMOTE_SRC, /CLEANUP_MODES = \("cleanup", "reap-stale", "cleanup-activated"\)/);
  assert.match(REMOTE_SRC, /prepare\/verify must not run in the post-activation posture/);
  assert.match(REMOTE_SRC, /post-activation cleanup must use the cleanup readiness posture/);
  for (const key of [...ACTIVATED_STAGE_FLAGS, ...FIXTURE_OUTBOUND_FLAGS]) {
    assert.ok(REMOTE_SRC.includes(key), `remote must check ${key}`);
  }
  const workflow = readFileSync(
    path.join(root, "../.github/workflows/prepare-rental-marketplace-stage1-fixtures.yml"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  assert.match(workflow, /prepare\/verify must not pass in the post-activation posture/);
  assert.match(workflow, /owner_matching_enabled does not match the declared posture/);
  assert.ok(!/owner_matching_enabled must remain false/.test(workflow));
  assert.match(workflow, /"posture": posture/);
});

