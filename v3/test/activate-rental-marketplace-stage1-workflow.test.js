import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WF_NAME = "activate-rental-marketplace-stage1.yml";
const UNTOUCHED = [
  "build-production-image.yml",
  "production-predeploy-check.yml",
  "deploy-v3.yml",
  "activate-rental-marketplace-pra.yml",
];
const DOMAIN = path.join(root, ".github/scripts/activate-rental-marketplace-stage1-domain.mjs");
const REMOTE = path.join(root, ".github/scripts/activate-rental-marketplace-stage1-remote.sh");
const PATH_PY = path.join(root, ".github/scripts/activate-rental-marketplace-stage1-path.py");
const PRA_DOMAIN = path.join(root, ".github/scripts/activate-rental-marketplace-pra-domain.mjs");

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
  return pipeRunScript(namedStep(wf(WF_NAME), "Authorize Stage 1 production activation (fail-closed)"));
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
  CONFIRM: "ACTIVATE-STAGE1-PRODUCTION",
  SOURCE_SHA: "877bd25ce7ad0cd22805bb97d528352574612a7b",
  IMAGE_DIGEST: "sha256:aea2d1f7807ea828d56aa3f09894aa38fa5591d296d8382066c71dc10b261eb4",
  BACKUP_ID: "/DATA/AppData/591-tracker-v3-backups/predeploy-20260917-000000",
  BACKUP_HASH: "sha256:ffceb339b9e1b92f90171915fd8475faf422f6123a11f48b8d3a3c37f0fa2c1d",
};

const IDENTITY = {
  source_sha: GOOD.SOURCE_SHA,
  image_digest: GOOD.IMAGE_DIGEST,
  backup_id: GOOD.BACKUP_ID,
  backup_hash: GOOD.BACKUP_HASH,
  src_tree_sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

function praOn(stage1 = false, extra = {}) {
  return {
    rental_catalog_v2: { enabled: true },
    wish: {
      lifecycle_enabled: true,
      owner_matching_enabled: stage1,
      offer_enabled: false,
      public_share_v2_enabled: false,
      owner_notifications_enabled: false,
      notifications_enabled: false,
      digest_enabled: false,
      outbound_mail_enabled: false,
      outbound_push_enabled: false,
      ...extra,
    },
  };
}

function classify(flags, receiptPath, identity = IDENTITY) {
  const dir = mkdtempSync(path.join(tmpdir(), "stage1-path-"));
  const flagsFile = path.join(dir, "flags.json");
  writeFileSync(flagsFile, JSON.stringify({ mode: "inspect", raw_flags: flags }));
  try {
    return execFileSync("python3", [
      PATH_PY,
      flagsFile,
      receiptPath,
      identity.source_sha,
      identity.image_digest,
      identity.backup_id,
      identity.backup_hash,
      identity.src_tree_sha256,
    ], { encoding: "utf8" }).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Stage 1 activation remains workflow_dispatch only", () => {
  const text = wf(WF_NAME);
  const block = onBlock(text);
  assert.match(block, /workflow_dispatch:/);
  assert.doesNotMatch(block, /(^|\n)\s*push:/);
  assert.doesNotMatch(block, /(^|\n)\s*pull_request:/);
  assert.doesNotMatch(block, /(^|\n)\s*schedule:/);
  assert.doesNotMatch(block, /(^|\n)\s*workflow_call:/);
  assert.doesNotMatch(block, /(^|\n)\s*workflow_run:/);
});

test("Stage 1 activation requires exact confirmation, source SHA, digest, backup path and hash", () => {
  const text = wf(WF_NAME);
  const auth = authorizeScript();
  for (const name of ["source_sha", "image_digest", "backup_id", "backup_hash", "confirmation"]) {
    assert.match(inputBlock(text, name), /required:\s*true/);
  }
  assert.match(auth, /confirmation must be exactly ACTIVATE-STAGE1-PRODUCTION/);
  assert.match(auth, /source_sha must be a full 40-character commit SHA/);
  assert.match(auth, /image_digest must be exactly sha256: plus 64 lowercase hex/);
  assert.match(auth, /backup_id must be \/DATA\/AppData\/591-tracker-v3-backups\/predeploy-YYYYMMDD-HHMMSS/);
  assert.match(auth, /backup_hash must be exactly sha256: plus 64 lowercase hex/);
  assert.match(auth, /backup_id must not contain path traversal/);
});

test("Stage 1 activation keeps master, actor, triggering_actor and SHA ancestry guards", () => {
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

test("Stage 1 activation authorize script fail-closes wrong ref/actor/confirmation/SHA/digest/backup", () => {
  runAuthorize(GOOD);
  runAuthorize({
    ...GOOD,
    ACTOR: "cursor",
    TRIGGERING_ACTOR: "cursor[bot]",
    ALLOWED_ACTOR: "Fyun48",
  });
  assert.throws(() => runAuthorize({ ...GOOD, CONFIRM: "ACTIVATE-PRA-PRODUCTION" }), /ACTIVATE-STAGE1-PRODUCTION/);
  assert.throws(() => runAuthorize({ ...GOOD, CONFIRM: "DEPLOY-PRODUCTION" }), /ACTIVATE-STAGE1-PRODUCTION/);
  assert.throws(() => runAuthorize({ ...GOOD, WF_REF: "refs/heads/cursor/stage1-owner-matching-activation-eeec" }), /master workflow definition/);
  assert.throws(() => runAuthorize({ ...GOOD, ACTOR: "intruder", TRIGGERING_ACTOR: "intruder" }), /not the authorized deployer/);
  assert.throws(() => runAuthorize({ ...GOOD, TRIGGERING_ACTOR: "intruder" }), /not the authorized deployer/);
  assert.throws(() => runAuthorize({ ...GOOD, ALLOWED_ACTOR: "" }), /PRODUCTION_DEPLOY_ALLOWED_ACTOR is not configured/);
  assert.throws(() => runAuthorize({ ...GOOD, SOURCE_SHA: "877bd25" }), /40-character/);
  assert.throws(() => runAuthorize({ ...GOOD, IMAGE_DIGEST: `SHA256:${"a".repeat(64)}` }), /image_digest/);
  assert.throws(() => runAuthorize({ ...GOOD, BACKUP_HASH: "sha256:abc" }), /backup_hash/);
  assert.throws(
    () => runAuthorize({ ...GOOD, BACKUP_ID: "/DATA/AppData/591-tracker-v3-backups/../etc" }),
    /trusted predeploy backup path|path traversal|backup_id/,
  );
  assert.throws(
    () => runAuthorize({ ...GOOD, BACKUP_ID: "/tmp/predeploy-20260917-000000" }),
    /backup_id/,
  );
});

test("Stage 1 activation pins workflow-definition SHA and does not checkout the candidate onto NAS", () => {
  const text = wf(WF_NAME);
  const checkout = namedStep(text, "Checkout workflow-definition SHA");
  const verify = namedStep(text, "Verify trusted workflow-definition SHA");
  assert.match(checkout, /ref:\s*\$\{\{\s*github\.sha\s*\}\}/);
  assert.doesNotMatch(checkout, /ref:\s*master\b/);
  assert.match(verify, /EXPECTED_WF_SHA:\s*\$\{\{\s*github\.sha\s*\}\}/);
  assert.match(verify, /git rev-parse HEAD/);
  assert.match(verify, /HEAD_SHA" != "\$EXPECTED_WF_SHA"/);
  assert.doesNotMatch(text, /git checkout --force/);
  const manifest = namedStep(text, "Build expected v3/src manifest from source SHA");
  assert.match(manifest, /pra-src-manifest\.py --from-git "\$SOURCE_SHA"/);
  assert.doesNotMatch(manifest, /git checkout/);
});

test("Stage 1 domain uses saveRentalMarketplaceFlags and only mutates owner_matching", () => {
  const domain = readFileSync(DOMAIN, "utf8");
  const remote = readFileSync(REMOTE, "utf8");
  const text = wf(WF_NAME);
  assert.match(domain, /getRentalMarketplaceFlags/);
  assert.match(domain, /saveRentalMarketplaceFlags/);
  assert.match(domain, /owner_matching_enabled:\s*true/);
  assert.match(domain, /owner_matching_enabled:\s*false/);
  assert.doesNotMatch(domain, /rental_catalog_v2:\s*\{\s*enabled:\s*false\s*\}/);
  assert.doesNotMatch(domain, /lifecycle_enabled:\s*false/);
  assert.doesNotMatch(domain, /offer_enabled:\s*true/);
  assert.doesNotMatch(domain, /public_share_v2_enabled:\s*true/);
  assert.doesNotMatch(domain, /owner_notifications_enabled:\s*true/);
  assert.doesNotMatch(domain, /notifications_enabled:\s*true/);
  assert.doesNotMatch(domain, /digest_enabled:\s*true/);
  assert.doesNotMatch(domain, /outbound_mail_enabled:\s*true/);
  assert.doesNotMatch(domain, /outbound_push_enabled:\s*true/);
  assert.doesNotMatch(domain, /UPDATE\s+settings/i);
  assert.doesNotMatch(domain, /INSERT\s+INTO\s+settings/i);
  assert.doesNotMatch(domain, /writeSettingKey\(/);
  assert.match(remote, /saveRentalMarketplaceFlags|stage1-activate-domain/);
  assert.match(remote, /node \/tmp\/stage1-activate-domain\.mjs/);
  assert.doesNotMatch(remote, /UPDATE\s+settings/i);
  assert.doesNotMatch(text, /UPDATE\s+settings/i);
});

test("Stage 1 remote guards digest, OCI, backup, concurrent lease and compensating rollback", () => {
  const remote = readFileSync(REMOTE, "utf8");
  const text = wf(WF_NAME);
  assert.match(remote, /591-tracker-v3/);
  assert.match(remote, /RepoDigests/);
  assert.match(remote, /org\.opencontainers\.image\.revision/);
  assert.match(remote, /sha256sum "\$BACKUP_ID\/v3\.db"/);
  assert.match(remote, /fail-before-save/);
  assert.match(remote, /compensate_and_fail/);
  assert.match(remote, /compensate_if_mutated/);
  assert.match(remote, /verify_runtime_stage1_off/);
  assert.match(remote, /verify-only/);
  assert.match(remote, /stage1-activation-receipt\.json/);
  assert.match(remote, /rollback wish.lifecycle_enabled is not true/);
  assert.match(remote, /rollback_stage1_flag/);
  assert.match(remote, /PRODUCTION_STATE_UNKNOWN/);
  assert.match(remote, /\/api\/demand\/aggregate/);
  assert.match(remote, /\/api\/self-listings\/1\/matches\/summary/);
  assert.match(remote, /\/api\/self-listings\/1\/matches/);
  assert.match(remote, /owner_matching_disabled/);
  assert.match(remote, /rank_score/);
  assert.match(remote, /SQLITE_BUSY|database is locked/);
  assert.match(text, /name: stage1-activation-evidence/);
  assert.match(text, /group: production-deploy/);
  for (const blob of [remote, text]) {
    assert.doesNotMatch(blob, /docker\s+pull\b/);
    assert.doesNotMatch(blob, /compose\s+up/);
    assert.doesNotMatch(blob, /force-recreate/);
    assert.doesNotMatch(blob, /docker\s+restart\b/);
    assert.doesNotMatch(blob, /DEPLOY-PRODUCTION/);
    assert.doesNotMatch(blob, /ACTIVATE-PRA-PRODUCTION/);
  }
  assert.doesNotMatch(remote, /rm\s+-rf\s+"\$BACKUP_ID"/);
});

test("Stage 1 path classifier happy path and fail-closed unexpected PRA / Stage2-4 / identity mismatch", () => {
  const missing = path.join(tmpdir(), "stage1-missing-receipt.json");
  assert.equal(classify(praOn(false), missing), "activate");
  assert.throws(() => classify({
    rental_catalog_v2: { enabled: false },
    wish: praOn(false).wish,
  }, missing), /PRA rental_catalog_v2.enabled is not true/);
  assert.throws(() => classify({
    rental_catalog_v2: { enabled: true },
    wish: { ...praOn(false).wish, lifecycle_enabled: false },
  }, missing), /lifecycle_enabled is not true/);
  assert.throws(() => classify(praOn(false, { offer_enabled: true }), missing), /Stage 2-4 or outbound flag is already true/);
  assert.throws(() => classify(praOn(false, { digest_enabled: true }), missing), /Stage 2-4 or outbound flag is already true/);
  assert.throws(() => classify(praOn(true), missing), /durable receipt is missing/);

  const dir = mkdtempSync(path.join(tmpdir(), "stage1-receipt-"));
  const receipt = path.join(dir, "stage1-activation-receipt.json");
  writeFileSync(receipt, JSON.stringify({
    ...IDENTITY,
    ACTIVATION_OK: true,
  }));
  assert.equal(classify(praOn(true), receipt), "verify-only");
  assert.throws(
    () => classify(praOn(true), receipt, { ...IDENTITY, source_sha: "0".repeat(40) }),
    /receipt source_sha does not match/,
  );
  writeFileSync(receipt, JSON.stringify({ ...IDENTITY, ACTIVATION_OK: false }));
  assert.throws(() => classify(praOn(true), receipt), /receipt is not ACTIVATION_OK/);
  rmSync(dir, { recursive: true, force: true });
});

test("Stage 1 evidence identity mismatch and concurrent/replay contract stay fail-closed", () => {
  const remote = readFileSync(REMOTE, "utf8");
  const pathPy = readFileSync(PATH_PY, "utf8");
  assert.match(pathPy, /receipt \{key\} does not match/);
  assert.match(pathPy, /durable receipt is missing/);
  assert.match(remote, /verify-only recovery \(no mutation/);
  assert.match(remote, /if ! run_domain activate; then\n  compensate_if_mutated/);
  assert.match(wf(WF_NAME), /group: production-deploy/);
  assert.match(wf("deploy-v3.yml"), /group: production-deploy/);
  assert.match(wf("activate-rental-marketplace-pra.yml"), /group: production-deploy/);
});

test("PR A domain still reserves owner_matching and is not reused as Stage 1", () => {
  const pra = readFileSync(PRA_DOMAIN, "utf8");
  assert.match(pra, /"owner_matching_enabled"/);
  assert.doesNotMatch(pra, /owner_matching_enabled:\s*true/);
  assert.doesNotMatch(wf("activate-rental-marketplace-pra.yml"), /ACTIVATE-STAGE1-PRODUCTION/);
  assert.doesNotMatch(wf(WF_NAME), /ACTIVATE-PRA-PRODUCTION/);
});

test("Stage 1 activation does not change build, predeploy, deploy or PRA workflows", () => {
  for (const name of UNTOUCHED) {
    const text = wf(name);
    assert.doesNotMatch(text, /ACTIVATE-STAGE1-PRODUCTION/);
    assert.doesNotMatch(text, /activate-rental-marketplace-stage1/);
  }
});
