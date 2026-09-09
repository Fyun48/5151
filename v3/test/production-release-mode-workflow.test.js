import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOWS = [
  "build-production-image.yml",
  "production-predeploy-check.yml",
  "deploy-v3.yml",
];
const MANUAL_OWNER_WRITER = path.join(root, ".github/scripts/write-manual-owner-workflow-evidence.py");

function wf(name) {
  return readFileSync(path.join(root, ".github/workflows", name), "utf8");
}

function onBlock(text) {
  const m = text.match(/\non:\n([\s\S]*?)\n[a-zA-Z]/);
  return m ? m[1] : "";
}

function inputBlock(text, name) {
  const re = new RegExp(`\\n      ${name}:\\n([\\s\\S]*?)(?=\\n      [a-z_]|\\n(?:permissions|concurrency|jobs):)`);
  const m = text.match(re);
  return m ? m[1] : "";
}

function authorizeScript(text) {
  const start = text.search(/Authorize (build|production predeploy check|production deployment)/);
  assert.ok(start > 0, "authorize step missing");
  const runIdx = text.indexOf("run: |", start);
  assert.ok(runIdx > 0, "authorize run script missing");
  const nextStep = text.indexOf("\n      - name:", runIdx);
  return text.slice(runIdx, nextStep > 0 ? nextStep : undefined);
}

for (const name of WORKFLOWS) {
  test(`${name} remains workflow_dispatch only`, () => {
    const text = wf(name);
    const block = onBlock(text);
    assert.match(block, /workflow_dispatch:/);
    assert.doesNotMatch(block, /(^|\n)\s*push:/);
    assert.doesNotMatch(block, /(^|\n)\s*pull_request:/);
    assert.doesNotMatch(block, /(^|\n)\s*schedule:/);
    assert.doesNotMatch(block, /(^|\n)\s*workflow_call:/);
    assert.doesNotMatch(block, /(^|\n)\s*workflow_run:/);
    assert.doesNotMatch(text, /on:\n[\s\S]*\n  push:/);
  });
}

for (const name of WORKFLOWS) {
  test(`${name} dual-mode inputs: manual_owner default, intent optional, ops_phase15 fail-closed`, () => {
    const text = wf(name);
    const mode = inputBlock(text, "release_mode");
    assert.match(mode, /type:\s*choice/);
    assert.match(mode, /default:\s*manual_owner/);
    assert.match(mode, /-\s*manual_owner/);
    assert.match(mode, /-\s*ops_phase15/);

    const intent = inputBlock(text, "release_intent_id");
    assert.match(intent, /required:\s*false/);
    assert.doesNotMatch(intent, /required:\s*true/);

    const auth = authorizeScript(text);
    assert.match(auth, /release_mode must be manual_owner or ops_phase15/);
    assert.match(auth, /ops_phase15 requires a non-empty release_intent_id/);
    assert.match(auth, /manual_owner ignores release_intent_id \(not a Phase 15 binding\)/);
  });
}

test("deploy-v3 manual_owner still requires immutable digest + DEPLOY-PRODUCTION", () => {
  const text = wf("deploy-v3.yml");
  const auth = authorizeScript(text);
  assert.match(auth, /confirmation must be exactly DEPLOY-PRODUCTION/);
  assert.match(auth, /image_digest must be exactly sha256: plus 64 lowercase hex/);
  assert.match(inputBlock(text, "image_digest"), /required:\s*true/);
  assert.match(inputBlock(text, "confirmation"), /required:\s*true/);
  assert.doesNotMatch(auth, /RELEASE_MODE.*= "manual_owner"[\s\S]*DEPLOY-PRODUCTION/);
});

test("predeploy still requires PREDEPLOY-PRODUCTION in both modes", () => {
  const text = wf("production-predeploy-check.yml");
  const auth = authorizeScript(text);
  assert.match(auth, /confirmation must be exactly PREDEPLOY-PRODUCTION/);
  assert.match(inputBlock(text, "confirmation"), /required:\s*true/);
});

for (const name of WORKFLOWS) {
  test(`${name} keeps actor + triggering_actor and SHA ancestry guards`, () => {
    const text = wf(name);
    assert.match(text, /vars\.PRODUCTION_DEPLOY_ALLOWED_ACTOR/);
    assert.match(text, /-z\s*"\$\{ALLOWED_ACTOR:-\}"/);
    assert.match(text, /"\$ACTOR"\s*!=\s*"\$ALLOWED_ACTOR"/);
    assert.match(text, /"\$TRIGGERING_ACTOR"\s*!=\s*"\$ALLOWED_ACTOR"/);
    assert.match(text, /github\.triggering_actor/);
    assert.match(text, /refs\/heads\/master/);
    assert.match(text, /\[0-9a-f\]\{40\}/);
    assert.match(text, /merge-base --is-ancestor/);
  });
}

test("deploy-v3 still recreates only v3, never :latest, and keeps health/landing/login", () => {
  const text = wf("deploy-v3.yml");
  assert.match(text, /force-recreate 591-tracker-v3/);
  assert.doesNotMatch(text, /force-recreate 591-tracker-v2/);
  assert.doesNotMatch(text, /up -d[^\n]*591-tracker-v2/);
  assert.match(text, /v3 must not resolve to :latest/);
  assert.match(text, /v2 must not be digest-replaced/);
  assert.match(text, /override must not contain :latest/);
  assert.match(text, /\/api\/health/);
  assert.match(text, /login\.html/);
  assert.match(text, /curl -fsS -o \/dev\/null http:\/\/127\.0\.0\.1:5153\//);
});

for (const name of WORKFLOWS) {
  test(`${name} Phase 15 mode evidence and run-name do not regress`, () => {
    const text = wf(name);
    assert.match(
      text,
      /run-name:\s*"\$\{\{\s*inputs\.release_mode == 'ops_phase15' && format\('phase15-intent:\{0\}',\s*inputs\.release_intent_id\) \|\| format\('manual-owner:\{0\}',\s*inputs\.sha\)\s*\}\}"/,
    );
    assert.match(text, /write-phase15-workflow-evidence\.py phase15-run-identity\.json/);
    assert.match(text, /write-phase15-workflow-evidence\.py phase15-workflow-evidence\.json/);
    assert.match(text, /name: phase15-run-identity/);
    assert.match(text, /name: phase15-workflow-evidence/);
    assert.match(text, /if: \$\{\{ always\(\) && inputs\.release_mode == 'ops_phase15' \}\}/);
    assert.match(text, /if: \$\{\{ always\(\) && inputs\.release_mode == 'manual_owner' \}\}/);
    assert.match(text, /write-manual-owner-workflow-evidence\.py/);
    assert.match(text, /name: manual-owner-run-identity/);
    assert.match(text, /name: manual-owner-workflow-evidence/);
    assert.doesNotMatch(text, /run-name:\s*"phase15-intent:\$\{\{ inputs\.release_intent_id \}\}"/);
  });
}

test("manual owner evidence writer is not Phase 15 and records ignored intent", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "manual-owner-ev-"));
  const dest = path.join(dir, "manual-owner-workflow-evidence.json");
  execFileSync("python3", [MANUAL_OWNER_WRITER, dest], {
    env: {
      ...process.env,
      RELEASE_MODE: "manual_owner",
      EVIDENCE_KIND: "full",
      WF_FILE: ".github/workflows/deploy-v3.yml",
      WF_REF: "refs/heads/master",
      WF_RUN_ID: "123456789",
      WF_ATTEMPT: "1",
      WF_HEAD_SHA: "a".repeat(40),
      SOURCE_SHA: "b".repeat(40),
      WF_ACTOR: "Fyun48",
      WF_TRIGGERING_ACTOR: "Fyun48",
      WF_ENVIRONMENT: "production",
      CONFIRMATION: "DEPLOY-PRODUCTION",
      RELEASE_INTENT_ID: "should-not-bind-phase15",
      IMAGE_DIGEST: `sha256:${"ab".repeat(32)}`,
    },
    encoding: "utf8",
  });
  const doc = JSON.parse(readFileSync(dest, "utf8"));
  assert.equal(doc.schema, "manual-owner-workflow-evidence-v1");
  assert.equal(doc.release_mode, "manual_owner");
  assert.equal(doc.ignored_release_intent_id, "should-not-bind-phase15");
  assert.equal(Object.hasOwn(doc, "release_intent_id"), false);
  assert.doesNotMatch(doc.schema, /^phase15/);
  assert.match(doc.evidence_sha256, /^sha256:[0-9a-f]{64}$/);
  rmSync(dir, { recursive: true, force: true });
});

test("manual owner writer rejects Phase 15 mode and missing identity", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "manual-owner-ev-bad-"));
  const dest = path.join(dir, "out.json");
  assert.throws(() => execFileSync("python3", [MANUAL_OWNER_WRITER, dest], {
    env: {
      ...process.env,
      RELEASE_MODE: "ops_phase15",
      WF_FILE: ".github/workflows/deploy-v3.yml",
      WF_REF: "refs/heads/master",
      WF_RUN_ID: "1",
      WF_ATTEMPT: "1",
      WF_HEAD_SHA: "a".repeat(40),
      SOURCE_SHA: "a".repeat(40),
      WF_ACTOR: "Fyun48",
      WF_TRIGGERING_ACTOR: "Fyun48",
      WF_ENVIRONMENT: "production",
      CONFIRMATION: "DEPLOY-PRODUCTION",
    },
  }), /manual_owner/);
  assert.throws(() => execFileSync("python3", [MANUAL_OWNER_WRITER, dest], {
    env: {
      ...process.env,
      RELEASE_MODE: "manual_owner",
      WF_FILE: ".github/workflows/deploy-v3.yml",
      WF_REF: "refs/heads/master",
      WF_RUN_ID: "1",
      WF_ATTEMPT: "1",
      WF_HEAD_SHA: "a".repeat(40),
      SOURCE_SHA: "",
      WF_ACTOR: "Fyun48",
      WF_TRIGGERING_ACTOR: "Fyun48",
      WF_ENVIRONMENT: "production",
      CONFIRMATION: "DEPLOY-PRODUCTION",
    },
  }), /missing required identity/);
  rmSync(dir, { recursive: true, force: true });
});
