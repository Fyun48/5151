import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOWS = [
  "build-production-image.yml",
  "production-predeploy-check.yml",
  "deploy-v3.yml",
];
const CANDIDATE_CHECKOUT_WORKFLOWS = [
  "build-production-image.yml",
  "deploy-v3.yml",
];
const MANUAL_OWNER_WRITER = path.join(root, ".github/scripts/write-manual-owner-workflow-evidence.py");
const PHASE15_WRITER = path.join(root, ".github/scripts/write-phase15-workflow-evidence.py");
const MANUAL_OWNER_WRITER_NAME = "write-manual-owner-workflow-evidence.py";
const PHASE15_WRITER_NAME = "write-phase15-workflow-evidence.py";

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

function namedStep(text, name) {
  const start = text.indexOf(`- name: ${name}`);
  assert.ok(start >= 0, `${name} step missing`);
  const next = text.indexOf("\n      - name:", start + 1);
  return text.slice(start, next > 0 ? next : undefined);
}

function pipeRunScript(step) {
  const marker = "run: |\n";
  const runIdx = step.indexOf(marker);
  assert.ok(runIdx >= 0, "indented run script missing");
  return step.slice(runIdx + marker.length)
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n")
    .replace(/\s+$/, "");
}

function candidateCheckoutIndex(text) {
  return text.search(/git checkout --force "\$(?:BUILD|DEPLOY)_SHA"/);
}

function beforeCandidateCheckout(text) {
  const idx = candidateCheckoutIndex(text);
  assert.ok(idx >= 0, "candidate checkout missing");
  return text.slice(0, idx);
}

function afterCandidateCheckout(text) {
  const idx = candidateCheckoutIndex(text);
  assert.ok(idx >= 0, "candidate checkout missing");
  return text.slice(idx);
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
    assert.match(auth, /manual_owner forbids a non-empty release_intent_id/);
    assert.doesNotMatch(auth, /manual_owner ignores release_intent_id/);
  });
}

function releaseModeChecks(text) {
  const auth = authorizeScript(text);
  const start = auth.indexOf('if [ "${RELEASE_MODE:-}" != "manual_owner" ]');
  assert.ok(start >= 0, "release_mode checks missing");
  return auth.slice(start);
}

function runReleaseModeCheck(snippet, { releaseMode, releaseIntentId }) {
  return execFileSync("bash", ["-c", `set -euo pipefail\n${snippet}`], {
    env: {
      ...process.env,
      RELEASE_MODE: releaseMode,
      RELEASE_INTENT_ID: releaseIntentId,
    },
    encoding: "utf8",
  });
}

for (const name of WORKFLOWS) {
  test(`${name} rejects mixed-mode intent and keeps Phase 15 intent required`, () => {
    const snippet = releaseModeChecks(wf(name));
    assert.throws(
      () => runReleaseModeCheck(snippet, { releaseMode: "manual_owner", releaseIntentId: "intent-stale-phase15" }),
      /manual_owner forbids a non-empty release_intent_id/,
    );
    assert.throws(
      () => runReleaseModeCheck(snippet, { releaseMode: "", releaseIntentId: "intent-stale-phase15" }),
      /release_mode must be manual_owner or ops_phase15/,
    );
    runReleaseModeCheck(snippet, { releaseMode: "manual_owner", releaseIntentId: "" });
    runReleaseModeCheck(snippet, { releaseMode: "ops_phase15", releaseIntentId: "intent-live-phase15" });
    assert.throws(
      () => runReleaseModeCheck(snippet, { releaseMode: "ops_phase15", releaseIntentId: "" }),
      /ops_phase15 requires a non-empty release_intent_id/,
    );
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
    assert.match(text, /write-phase15-workflow-evidence\.py"? phase15-run-identity\.json/);
    assert.match(text, /write-phase15-workflow-evidence\.py"? phase15-workflow-evidence\.json/);
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

test("manual owner evidence writer is not Phase 15 and rejects a leftover intent", () => {
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
      IMAGE_DIGEST: `sha256:${"ab".repeat(32)}`,
    },
    encoding: "utf8",
  });
  const doc = JSON.parse(readFileSync(dest, "utf8"));
  assert.equal(doc.schema, "manual-owner-workflow-evidence-v1");
  assert.equal(doc.release_mode, "manual_owner");
  assert.equal(Object.hasOwn(doc, "release_intent_id"), false);
  assert.equal(Object.hasOwn(doc, "ignored_release_intent_id"), false);
  assert.doesNotMatch(doc.schema, /^phase15/);
  assert.match(doc.evidence_sha256, /^sha256:[0-9a-f]{64}$/);
  assert.throws(() => execFileSync("python3", [MANUAL_OWNER_WRITER, dest], {
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
    },
  }), /forbids a non-empty release_intent_id/);
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

function trustedCheckoutStep(text) {
  return namedStep(text, "Checkout workflow-definition SHA");
}

for (const name of CANDIDATE_CHECKOUT_WORKFLOWS) {
  test(`${name} stages trusted evidence writers before candidate checkout and invokes the copies afterward`, () => {
    const text = wf(name);
    const before = beforeCandidateCheckout(text);
    const after = afterCandidateCheckout(text);
    const staging = namedStep(text, "Stage trusted workflow-definition evidence writers");
    assert.match(staging, /runner\.temp/);
    assert.match(staging, /trusted-workflow-scripts/);
    assert.match(staging, /write-manual-owner-workflow-evidence\.py/);
    assert.match(staging, /write-phase15-workflow-evidence\.py/);
    assert.match(staging, /GITHUB_ENV/);
    assert.ok(
      text.indexOf("Stage trusted workflow-definition evidence writers")
        < candidateCheckoutIndex(text),
      "staging must happen before candidate checkout",
    );
    assert.match(before, /Stage trusted workflow-definition evidence writers/);
    assert.doesNotMatch(after, /Stage trusted workflow-definition evidence writers/);
    assert.match(after, /\$\{TRUSTED_SCRIPT_DIR:\?\}.*write-manual-owner-workflow-evidence\.py/);
    assert.match(after, /\$\{TRUSTED_SCRIPT_DIR:\?\}.*write-phase15-workflow-evidence\.py/);
    assert.doesNotMatch(after, /python3 \.github\/scripts\/write-manual-owner-workflow-evidence\.py/);
    assert.doesNotMatch(after, /python3 \.github\/scripts\/write-phase15-workflow-evidence\.py/);
  });

  test(`${name} binds trusted writers to exact github.sha, not a moving master tip`, () => {
    const text = wf(name);
    const checkout = trustedCheckoutStep(text);
    const staging = namedStep(text, "Stage trusted workflow-definition evidence writers");
    const ancestry = namedStep(text, "Validate SHA reachable from origin/master, then check it out");
    assert.match(checkout, /ref:\s*\$\{\{\s*github\.sha\s*\}\}/);
    assert.doesNotMatch(checkout, /ref:\s*master\b/);
    assert.match(authorizeScript(text), /"\$WF_REF"\s*!=\s*"refs\/heads\/master"/);
    assert.match(staging, /EXPECTED_WF_SHA:\s*\$\{\{\s*github\.sha\s*\}\}/);
    assert.match(staging, /git rev-parse HEAD/);
    assert.match(staging, /HEAD_SHA" != "\$EXPECTED_WF_SHA"/);
    assert.doesNotMatch(pipeRunScript(staging), /\$\{\{\s*github\.sha/);
    assert.match(ancestry, /git fetch origin master/);
    assert.match(ancestry, /merge-base --is-ancestor "\$(?:BUILD|DEPLOY)_SHA" origin\/master/);
  });
}

for (const name of WORKFLOWS) {
  test(`${name} binds trusted workflow-definition code to exact github.sha before helpers or evidence`, () => {
    const text = wf(name);
    const checkout = trustedCheckoutStep(text);
    assert.match(checkout, /ref:\s*\$\{\{\s*github\.sha\s*\}\}/);
    assert.doesNotMatch(checkout, /ref:\s*master\b/);
    assert.match(authorizeScript(text), /"\$WF_REF"\s*!=\s*"refs\/heads\/master"/);
    assert.match(text, /EXPECTED_WF_SHA:\s*\$\{\{\s*github\.sha\s*\}\}/);
    assert.match(text, /git rev-parse HEAD/);
    assert.match(text, /HEAD_SHA" != "\$EXPECTED_WF_SHA"/);
    assert.match(text, /git fetch origin master/);
    assert.match(text, /merge-base --is-ancestor/);
    const checkoutIdx = text.indexOf("Checkout workflow-definition SHA");
    const expectedIdx = text.indexOf("EXPECTED_WF_SHA:");
    const firstEvidence = text.indexOf("Write Phase 15 run identity");
    const nasCopy = text.indexOf("Copy inspect/backup helpers");
    assert.ok(checkoutIdx >= 0 && expectedIdx > checkoutIdx);
    assert.ok(firstEvidence < 0 || expectedIdx < firstEvidence);
    assert.ok(nasCopy < 0 || expectedIdx < nasCopy);
  });
}

test("predeploy never checks out the candidate and verifies workflow SHA before writers or NAS helpers", () => {
  const text = wf("production-predeploy-check.yml");
  const verify = namedStep(text, "Verify trusted workflow-definition SHA");
  const ancestry = namedStep(text, "Validate SHA reachable from origin/master (no checkout of that SHA onto NAS)");
  assert.equal(candidateCheckoutIndex(text), -1);
  assert.doesNotMatch(text, /git checkout --force/);
  assert.doesNotMatch(text, /Stage trusted workflow-definition evidence writers/);
  assert.match(verify, /EXPECTED_WF_SHA:\s*\$\{\{\s*github\.sha\s*\}\}/);
  assert.match(verify, /git rev-parse HEAD/);
  assert.match(verify, /HEAD_SHA" != "\$EXPECTED_WF_SHA"/);
  assert.doesNotMatch(pipeRunScript(verify), /\$\{\{\s*github\.sha/);
  assert.match(ancestry, /git fetch origin master/);
  assert.match(ancestry, /merge-base --is-ancestor "\$CHECK_SHA" origin\/master/);
  assert.doesNotMatch(ancestry, /git checkout --force/);
  assert.match(text, /python3 \.github\/scripts\/write-manual-owner-workflow-evidence\.py/);
  assert.match(text, /python3 \.github\/scripts\/write-phase15-workflow-evidence\.py/);
});

test("predeploy SHA verify fails closed when HEAD is not the workflow execution SHA", () => {
  const verify = pipeRunScript(namedStep(wf("production-predeploy-check.yml"), "Verify trusted workflow-definition SHA"));
  const workspace = mkdtempSync(path.join(tmpdir(), "predeploy-wf-sha-"));
  const exactSha = initTrustedWriterRepo(workspace);
  assert.throws(() => execFileSync("bash", ["-c", verify], {
    cwd: workspace,
    env: { ...process.env, EXPECTED_WF_SHA: "0".repeat(40) },
    encoding: "utf8",
  }), /trusted checkout HEAD .* != workflow execution SHA/);
  execFileSync("bash", ["-c", verify], {
    cwd: workspace,
    env: { ...process.env, EXPECTED_WF_SHA: exactSha },
    encoding: "utf8",
  });
  rmSync(workspace, { recursive: true, force: true });
});

function initTrustedWriterRepo(workspace) {
  const scriptsDir = path.join(workspace, ".github", "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  copyFileSync(MANUAL_OWNER_WRITER, path.join(scriptsDir, MANUAL_OWNER_WRITER_NAME));
  copyFileSync(PHASE15_WRITER, path.join(scriptsDir, PHASE15_WRITER_NAME));
  execFileSync("git", ["init"], { cwd: workspace, encoding: "utf8" });
  execFileSync("git", ["add", ".github/scripts"], { cwd: workspace, encoding: "utf8" });
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-m", "trusted-writers"], {
    cwd: workspace,
    encoding: "utf8",
  });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim();
}

test("trusted workflow-definition copies still write manual_owner and Phase 15 evidence after an old candidate deletes the scripts", () => {
  const buildStaging = pipeRunScript(namedStep(wf("build-production-image.yml"), "Stage trusted workflow-definition evidence writers"));
  const deployStaging = pipeRunScript(namedStep(wf("deploy-v3.yml"), "Stage trusted workflow-definition evidence writers"));
  assert.equal(buildStaging, deployStaging);
  assert.match(buildStaging, /mkdir -p "\$TRUSTED_SCRIPT_DIR"/);
  assert.match(buildStaging, /cp -f/);
  assert.match(buildStaging, /EXPECTED_WF_SHA/);

  const workspace = mkdtempSync(path.join(tmpdir(), "trusted-wf-master-"));
  const runnerTemp = mkdtempSync(path.join(tmpdir(), "trusted-wf-runner-"));
  const githubEnv = path.join(runnerTemp, "github.env");
  const trustedDir = path.join(runnerTemp, "trusted-workflow-scripts");
  const scriptsDir = path.join(workspace, ".github", "scripts");
  const exactSha = initTrustedWriterRepo(workspace);
  assert.match(exactSha, /^[0-9a-f]{40}$/);
  writeFileSync(githubEnv, "");

  assert.throws(() => execFileSync("bash", ["-c", buildStaging], {
    cwd: workspace,
    env: {
      ...process.env,
      TRUSTED_SCRIPT_DIR: path.join(runnerTemp, "trusted-mismatch"),
      GITHUB_ENV: githubEnv,
      EXPECTED_WF_SHA: "0".repeat(40),
    },
    encoding: "utf8",
  }), /trusted checkout HEAD .* != workflow execution SHA/);
  assert.equal(existsSync(path.join(runnerTemp, "trusted-mismatch", MANUAL_OWNER_WRITER_NAME)), false);

  execFileSync("bash", ["-c", buildStaging], {
    cwd: workspace,
    env: {
      ...process.env,
      TRUSTED_SCRIPT_DIR: trustedDir,
      GITHUB_ENV: githubEnv,
      EXPECTED_WF_SHA: exactSha,
    },
    encoding: "utf8",
  });
  assert.match(readFileSync(githubEnv, "utf8"), /TRUSTED_SCRIPT_DIR=/);
  assert.equal(existsSync(path.join(trustedDir, MANUAL_OWNER_WRITER_NAME)), true);
  assert.equal(existsSync(path.join(trustedDir, PHASE15_WRITER_NAME)), true);

  // Simulate `git checkout --force` of a pre-#217 candidate such as 010095...
  rmSync(path.join(scriptsDir, MANUAL_OWNER_WRITER_NAME), { force: true });
  rmSync(path.join(scriptsDir, PHASE15_WRITER_NAME), { force: true });
  assert.equal(existsSync(path.join(scriptsDir, MANUAL_OWNER_WRITER_NAME)), false);
  assert.equal(existsSync(path.join(scriptsDir, PHASE15_WRITER_NAME)), false);
  assert.throws(() => execFileSync("python3", [
    path.join(scriptsDir, MANUAL_OWNER_WRITER_NAME),
    path.join(workspace, "would-fail.json"),
  ], { encoding: "utf8" }), /can't open file|No such file|ENOENT/i);

  const identityEnv = {
    EVIDENCE_KIND: "identity",
    WF_REF: "refs/heads/master",
    WF_RUN_ID: "34312182896",
    WF_ATTEMPT: "1",
    WF_HEAD_SHA: "439cf82d011aaf56d00cf211d7c955db7bda6f1b",
    SOURCE_SHA: "01009558300288e772fd13592fcdffaa150a009d",
    WF_ACTOR: "Fyun48",
    WF_TRIGGERING_ACTOR: "Fyun48",
  };
  const manualDest = path.join(workspace, "manual-owner-workflow-evidence.json");
  execFileSync("python3", [path.join(trustedDir, MANUAL_OWNER_WRITER_NAME), manualDest], {
    cwd: workspace,
    env: {
      ...process.env,
      ...identityEnv,
      RELEASE_MODE: "manual_owner",
      EVIDENCE_KIND: "full",
      WF_FILE: ".github/workflows/build-production-image.yml",
      IMAGE_DIGEST: `sha256:${"ae".repeat(32)}`,
      OCI_REVISION: identityEnv.SOURCE_SHA,
      OCI_SOURCE: "https://github.com/Fyun48/5151",
    },
    encoding: "utf8",
  });
  const manualDoc = JSON.parse(readFileSync(manualDest, "utf8"));
  assert.equal(manualDoc.schema, "manual-owner-workflow-evidence-v1");
  assert.equal(manualDoc.release_mode, "manual_owner");
  assert.equal(manualDoc.source_sha, identityEnv.SOURCE_SHA);
  assert.equal(Object.hasOwn(manualDoc, "release_intent_id"), false);

  const phase15Dest = path.join(workspace, "phase15-workflow-evidence.json");
  execFileSync("python3", [path.join(trustedDir, PHASE15_WRITER_NAME), phase15Dest], {
    cwd: workspace,
    env: {
      ...process.env,
      ...identityEnv,
      EVIDENCE_KIND: "full",
      WF_FILE: ".github/workflows/build-production-image.yml",
      RELEASE_INTENT_ID: "intent_trusted_copy_regression",
      IMAGE_DIGEST: `sha256:${"ab".repeat(32)}`,
      OCI_REVISION: identityEnv.SOURCE_SHA,
      OCI_SOURCE: "https://github.com/Fyun48/5151",
    },
    encoding: "utf8",
  });
  const phase15Doc = JSON.parse(readFileSync(phase15Dest, "utf8"));
  assert.equal(phase15Doc.schema, "phase15-workflow-evidence-v1");
  assert.equal(phase15Doc.release_intent_id, "intent_trusted_copy_regression");
  assert.equal(phase15Doc.source_sha, identityEnv.SOURCE_SHA);

  rmSync(workspace, { recursive: true, force: true });
  rmSync(runnerTemp, { recursive: true, force: true });
});
