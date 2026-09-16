import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WF_NAME = "activate-rental-marketplace-pra.yml";
const UNTOUCHED = [
  "build-production-image.yml",
  "production-predeploy-check.yml",
  "deploy-v3.yml",
];
const DOMAIN = path.join(root, ".github/scripts/activate-rental-marketplace-pra-domain.mjs");
const REMOTE = path.join(root, ".github/scripts/activate-rental-marketplace-pra-remote.sh");
const MANIFEST = path.join(root, ".github/scripts/pra-src-manifest.py");

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

function authorizeScript() {
  return pipeRunScript(namedStep(wf(WF_NAME), "Authorize PR A production activation (fail-closed)"));
}

function runAuthorize(env) {
  return execFileSync("bash", ["-c", authorizeScript()], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

const GOOD = {
  WF_REF: "refs/heads/master",
  ACTOR: "Fyun48",
  TRIGGERING_ACTOR: "Fyun48",
  ALLOWED_ACTOR: "Fyun48",
  CONFIRM: "ACTIVATE-PRA-PRODUCTION",
  SOURCE_SHA: "376876794dabe6eeaa93aef074d045c4543479a6",
  IMAGE_DIGEST: "sha256:35f24fadd3b7d5039343092134a81e32c246cefbcad1194cae34c675d5b0abe0",
  BACKUP_ID: "/DATA/AppData/591-tracker-v3-backups/predeploy-20260916-070640",
  BACKUP_HASH: "sha256:ffceb339b9e1b92f90171915fd8475faf422f6123a11f48b8d3a3c37f0fa2c1d",
};

test("PR A activation remains workflow_dispatch only", () => {
  const text = wf(WF_NAME);
  const block = onBlock(text);
  assert.match(block, /workflow_dispatch:/);
  assert.doesNotMatch(block, /(^|\n)\s*push:/);
  assert.doesNotMatch(block, /(^|\n)\s*pull_request:/);
  assert.doesNotMatch(block, /(^|\n)\s*schedule:/);
  assert.doesNotMatch(block, /(^|\n)\s*workflow_call:/);
  assert.doesNotMatch(block, /(^|\n)\s*workflow_run:/);
  assert.doesNotMatch(text, /on:\n[\s\S]*\n  push:/);
});

test("PR A activation requires exact confirmation, source SHA, digest, backup path and hash", () => {
  const text = wf(WF_NAME);
  const auth = authorizeScript();
  for (const name of ["source_sha", "image_digest", "backup_id", "backup_hash", "confirmation"]) {
    assert.match(inputBlock(text, name), /required:\s*true/);
  }
  assert.match(auth, /confirmation must be exactly ACTIVATE-PRA-PRODUCTION/);
  assert.match(auth, /source_sha must be a full 40-character commit SHA/);
  assert.match(auth, /image_digest must be exactly sha256: plus 64 lowercase hex/);
  assert.match(auth, /backup_id must be \/DATA\/AppData\/591-tracker-v3-backups\/predeploy-YYYYMMDD-HHMMSS/);
  assert.match(auth, /backup_hash must be exactly sha256: plus 64 lowercase hex/);
  assert.match(auth, /backup_id must not contain path traversal/);
});

test("PR A activation keeps master, actor, triggering_actor and SHA ancestry guards", () => {
  const text = wf(WF_NAME);
  const auth = authorizeScript();
  assert.match(text, /vars\.PRODUCTION_DEPLOY_ALLOWED_ACTOR/);
  assert.match(auth, /-z\s*"\$\{ALLOWED_ACTOR:-\}"/);
  assert.match(auth, /"\$ACTOR"\s*!=\s*"\$ALLOWED_ACTOR"/);
  assert.match(auth, /"\$TRIGGERING_ACTOR"\s*!=\s*"\$ALLOWED_ACTOR"/);
  assert.match(text, /github\.triggering_actor/);
  assert.match(auth, /"\$WF_REF"\s*!=\s*"refs\/heads\/master"/);
  assert.match(auth, /cursor\[bot\]/);
  assert.match(text, /merge-base --is-ancestor "\$SOURCE_SHA" origin\/master/);
  assert.match(text, /environment: production/);
  assert.match(text, /group: production-deploy/);
  assert.match(text, /cancel-in-progress:\s*false/);
  assert.match(text, /permissions:\n  contents: read/);
  assert.match(text, /timeout-minutes:\s*20/);
});

test("PR A activation authorize script fail-closes bad confirmation, SHA, digest and backup path", () => {
  runAuthorize(GOOD);
  runAuthorize({
    ...GOOD,
    ACTOR: "cursor",
    TRIGGERING_ACTOR: "cursor[bot]",
    ALLOWED_ACTOR: "Fyun48",
  });
  assert.throws(() => runAuthorize({ ...GOOD, CONFIRM: "DEPLOY-PRODUCTION" }), /ACTIVATE-PRA-PRODUCTION/);
  assert.throws(() => runAuthorize({ ...GOOD, WF_REF: "refs/heads/cursor/activate-pra-workflow-66f0" }), /master workflow definition/);
  assert.throws(() => runAuthorize({ ...GOOD, ACTOR: "intruder", TRIGGERING_ACTOR: "intruder" }), /not the authorized deployer/);
  assert.throws(() => runAuthorize({ ...GOOD, TRIGGERING_ACTOR: "intruder" }), /not the authorized deployer/);
  assert.throws(() => runAuthorize({ ...GOOD, ALLOWED_ACTOR: "" }), /PRODUCTION_DEPLOY_ALLOWED_ACTOR is not configured/);
  assert.throws(() => runAuthorize({ ...GOOD, SOURCE_SHA: "3768767" }), /40-character/);
  assert.throws(() => runAuthorize({ ...GOOD, IMAGE_DIGEST: `SHA256:${"a".repeat(64)}` }), /image_digest/);
  assert.throws(() => runAuthorize({ ...GOOD, BACKUP_HASH: "sha256:abc" }), /backup_hash/);
  assert.throws(
    () => runAuthorize({ ...GOOD, BACKUP_ID: "/DATA/AppData/591-tracker-v3-backups/../etc" }),
    /trusted predeploy backup path|path traversal|backup_id/,
  );
  assert.throws(
    () => runAuthorize({ ...GOOD, BACKUP_ID: "/tmp/predeploy-20260916-070640" }),
    /backup_id/,
  );
});

test("PR A activation pins workflow-definition SHA and does not checkout the candidate onto NAS", () => {
  const text = wf(WF_NAME);
  const checkout = namedStep(text, "Checkout workflow-definition SHA");
  const verify = namedStep(text, "Verify trusted workflow-definition SHA");
  assert.match(checkout, /ref:\s*\$\{\{\s*github\.sha\s*\}\}/);
  assert.doesNotMatch(checkout, /ref:\s*master\b/);
  assert.match(verify, /EXPECTED_WF_SHA:\s*\$\{\{\s*github\.sha\s*\}\}/);
  assert.match(verify, /git rev-parse HEAD/);
  assert.match(verify, /HEAD_SHA" != "\$EXPECTED_WF_SHA"/);
  assert.doesNotMatch(text, /git checkout --force/);
  assert.doesNotMatch(pipeRunScript(verify), /\$\{\{\s*github\.sha/);
  const manifest = namedStep(text, "Build expected v3/src manifest from source SHA");
  assert.match(manifest, /pra-src-manifest\.py --from-git "\$SOURCE_SHA"/);
  assert.doesNotMatch(manifest, /git checkout/);
  assert.match(text, /pra-src-expected\.json/);
  assert.match(text, /pra-src-manifest\.py/);
});

test("PR A activation uses domain getters/savers and forbids raw SQL flag writes", () => {
  const domain = readFileSync(DOMAIN, "utf8");
  const remote = readFileSync(REMOTE, "utf8");
  const text = wf(WF_NAME);
  assert.match(domain, /getRentalMarketplaceFlags/);
  assert.match(domain, /saveRentalMarketplaceFlags/);
  assert.match(domain, /from "\/app\/src\/db\.js"/);
  assert.match(domain, /rental_catalog_v2:\s*\{\s*enabled:\s*true\s*\}/);
  assert.match(domain, /lifecycle_enabled:\s*true/);
  assert.match(domain, /PRA_DOMAIN_MODE/);
  assert.match(domain, /must be exact 0\/0/);
  assert.match(domain, /mode === "rollback"/);
  assert.match(domain, /rental_catalog_v2:\s*\{\s*enabled:\s*false\s*\}/);
  assert.match(domain, /lifecycle_enabled:\s*false/);
  assert.match(domain, /owner_matching_enabled/);
  assert.match(domain, /must be false/);
  assert.doesNotMatch(domain, /owner_matching_enabled:\s*true/);
  assert.doesNotMatch(domain, /offer_enabled:\s*true/);
  assert.doesNotMatch(domain, /public_share_v2_enabled:\s*true/);
  assert.doesNotMatch(domain, /owner_notifications_enabled:\s*true/);
  assert.doesNotMatch(domain, /UPDATE\s+settings/i);
  assert.doesNotMatch(domain, /INSERT\s+INTO\s+settings/i);
  assert.doesNotMatch(domain, /writeSettingKey\(/);
  assert.match(remote, /get\/saveRentalMarketplaceFlags|pra-activate-domain/);
  assert.match(remote, /node \/tmp\/pra-activate-domain\.mjs/);
  assert.doesNotMatch(remote, /UPDATE\s+settings/i);
  assert.doesNotMatch(remote, /INSERT\s+INTO\s+settings/i);
  assert.doesNotMatch(remote, /writeSettingKey\(/);
  assert.doesNotMatch(text, /UPDATE\s+settings/i);
  assert.doesNotMatch(text, /writeSettingKey\(/);
});

test("PR A activation remote guards running digest, OCI revision, backup hash and never mutates deploy state", () => {
  const remote = readFileSync(REMOTE, "utf8");
  const text = wf(WF_NAME);
  assert.match(remote, /591-tracker-v3/);
  assert.match(remote, /State\.Status/);
  assert.match(remote, /RepoDigests/);
  assert.match(remote, /org\.opencontainers\.image\.revision/);
  assert.match(remote, /predeploy-\[0-9\]\{8\}-\[0-9\]\{6\}/);
  assert.match(remote, /sha256sum "\$BACKUP_ID\/v3\.db"/);
  assert.match(remote, /\/mnt\/Storage1\/apps\/5151\/v3\/src/);
  assert.match(remote, /--from-docker/);
  assert.match(remote, /fail-before-save/);
  assert.match(remote, /compensate_and_fail/);
  assert.match(remote, /rollback_pra_flags/);
  assert.match(remote, /PRA_DOMAIN_MODE/);
  assert.match(remote, /exact 0\/0/);
  assert.match(remote, /PRODUCTION_STATE_UNKNOWN/);
  const manifestIdx = remote.indexOf("fail-before-save");
  const activateIdx = remote.indexOf("run_domain activate");
  assert.ok(manifestIdx >= 0 && activateIdx > manifestIdx, "src manifest must run before domain save");
  const postIdx = remote.indexOf("=== running server hydrate + post-check");
  assert.ok(postIdx >= 0, "post-check section missing");
  assert.ok(
    remote.indexOf('compensate_and_fail "post-activation /api/demand failed"', postIdx) > postIdx,
    "post-check failure must call domain rollback",
  );
  assert.match(remote, /http:\/\/127\.0\.0\.1:5153\/api\/demand/);
  assert.match(remote, /http:\/\/127\.0\.0\.1:5153\/api\/health/);
  assert.match(remote, /http:\/\/127\.0\.0\.1:5153\/login\.html/);
  assert.match(remote, /curl -fsS -o \/dev\/null http:\/\/127\.0\.0\.1:5153\//);
  assert.match(remote, /auto_expire/);
  assert.match(remote, /catalog is null/);
  assert.match(remote, /canonical conditions are empty/);
  assert.match(text, /name: pra-activation-evidence/);
  assert.match(text, /pra-activation-evidence\.json/);
  assert.match(text, /ACTIVATION_OK/);
  assert.match(text, /backup_verified/);
  for (const blob of [remote, text]) {
    assert.doesNotMatch(blob, /docker\s+pull\b/);
    assert.doesNotMatch(blob, /compose\s+up/);
    assert.doesNotMatch(blob, /compose\s+down/);
    assert.doesNotMatch(blob, /force-recreate/);
    assert.doesNotMatch(blob, /docker\s+restart\b/);
    assert.doesNotMatch(blob, /DEPLOY-PRODUCTION/);
  }
  assert.doesNotMatch(remote, /rm\s+-rf\s+"\$BACKUP_ID"/);
  assert.doesNotMatch(remote, /rm\s+-rf\s+\/DATA\/AppData\/591-tracker-v3-backups/);
});

test("PR A src manifest matches git tree and fails closed when mounted db.js is tampered", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pra-src-"));
  const expected = path.join(dir, "expected.json");
  const actual = path.join(dir, "actual.json");
  const gitExpected = path.join(dir, "git.json");
  execFileSync("python3", [MANIFEST, "--from-dir", path.join(root, "v3/src"), "--out", expected], { cwd: root });
  execFileSync("python3", [MANIFEST, "--from-git", execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), "--out", gitExpected], { cwd: root });
  execFileSync("python3", [MANIFEST, "--compare", expected, gitExpected], { cwd: root });
  const copy = path.join(dir, "src");
  cpSync(path.join(root, "v3/src"), copy, { recursive: true });
  writeFileSync(path.join(copy, "db.js"), `${readFileSync(path.join(copy, "db.js"), "utf8")}\n// tampered\n`);
  execFileSync("python3", [MANIFEST, "--from-dir", copy, "--out", actual], { cwd: root });
  assert.throws(
    () => execFileSync("python3", [MANIFEST, "--compare", expected, actual], { cwd: root, encoding: "utf8" }),
    /v3\/src manifest mismatch[\s\S]*db\.js/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("PR A activation does not change build, predeploy or deploy workflows", () => {
  for (const name of UNTOUCHED) {
    const text = wf(name);
    assert.doesNotMatch(text, /ACTIVATE-PRA-PRODUCTION/);
    assert.doesNotMatch(text, /activate-rental-marketplace-pra/);
    assert.doesNotMatch(text, /saveRentalMarketplaceFlags/);
  }
});
