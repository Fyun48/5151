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
const EVIDENCE_PY = path.join(root, ".github/scripts/activate-rental-marketplace-stage1-evidence.py");
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
  OWNER_AUTHORIZATION: "AUTHORIZE-STAGE1:877bd25ce7ad0cd22805bb97d528352574612a7b:sha256:aea2d1f7807ea828d56aa3f09894aa38fa5591d296d8382066c71dc10b261eb4:/DATA/AppData/591-tracker-v3-backups/predeploy-20260917-000000:sha256:ffceb339b9e1b92f90171915fd8475faf422f6123a11f48b8d3a3c37f0fa2c1d",
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
  for (const name of ["source_sha", "image_digest", "backup_id", "backup_hash", "confirmation", "owner_authorization"]) {
    assert.match(inputBlock(text, name), /required:\s*true/);
  }
  assert.equal(inputBlock(text, "uat_attestation"), "");
  assert.match(auth, /confirmation must be exactly ACTIVATE-STAGE1-PRODUCTION/);
  assert.match(auth, /source_sha must be a full 40-character commit SHA/);
  assert.match(auth, /image_digest must be exactly sha256: plus 64 lowercase hex/);
  assert.match(auth, /backup_id must be \(\/DATA\/AppData\|\/mnt\/Storage1\/docker_data\)\/591-tracker-v3-backups\/predeploy-YYYYMMDD-HHMMSS/);
  assert.match(auth, /backup_hash must be exactly sha256: plus 64 lowercase hex/);
  assert.match(auth, /backup_id must not contain path traversal/);
});

test("Stage 1 activation accepts a predeploy backup under the Storage1 root (Issue #355)", () => {
  const storage1 = "/mnt/Storage1/docker_data/591-tracker-v3-backups/predeploy-20260918-170000";
  assert.doesNotThrow(() => runAuthorize({
    ...GOOD,
    BACKUP_ID: storage1,
    OWNER_AUTHORIZATION: GOOD.OWNER_AUTHORIZATION.replace(GOOD.BACKUP_ID, storage1),
  }));
  assert.throws(() => runAuthorize({ ...GOOD, BACKUP_ID: "/mnt/Storage1/docker_data/tmp/evil" }), /backup_id must be/);
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
  assert.doesNotMatch(auth, /CURSOR_DEPLOY=1/);
  assert.match(auth, /cursor is not a durable Production activator/);
  assert.match(auth, /owner_authorization must be exactly AUTHORIZE-STAGE1/);
  assert.doesNotMatch(auth, /uat_attestation must be exactly PRODUCTION_UAT_PASS/);
  assert.match(text, /merge-base --is-ancestor "\$SOURCE_SHA" origin\/master/);
  assert.match(text, /environment: production/);
  assert.match(text, /group: production-deploy/);
  assert.match(text, /cancel-in-progress:\s*false/);
  assert.match(text, /permissions:\n  contents: read/);
  assert.match(text, /timeout-minutes:\s*20/);
});

test("Stage 1 activation authorize script fail-closes wrong ref/actor/confirmation/SHA/digest/backup", () => {
  runAuthorize(GOOD);
  assert.throws(
    () => runAuthorize({ ...GOOD, ACTOR: "cursor", TRIGGERING_ACTOR: "cursor[bot]" }),
    /not a durable Production activator|not the authorized deployer/,
  );
  assert.throws(
    () => runAuthorize({ ...GOOD, ACTOR: "cursor[bot]", TRIGGERING_ACTOR: "cursor[bot]" }),
    /not a durable Production activator|not the authorized deployer/,
  );
  assert.throws(
    () => runAuthorize({ ...GOOD, ACTOR: "cursor", TRIGGERING_ACTOR: "Fyun48" }),
    /not a durable Production activator|not the authorized deployer/,
  );
  assert.throws(() => runAuthorize({ ...GOOD, OWNER_AUTHORIZATION: "AUTHORIZE-STAGE1-PRODUCTION" }), /owner_authorization/);
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
  assert.match(remote, /run_post_activation_probes/);
  assert.match(remote, /stage1-postcheck\.mjs/);
  assert.match(remote, /write_rollback_evidence/);
  assert.match(remote, /owner_matching_disabled/);
  assert.match(remote, /rank_score/);
  assert.match(remote, /SQLITE_BUSY|database is locked/);
  assert.match(text, /name: stage1-activation-evidence/);
  assert.match(text, /activate-rental-marketplace-stage1-evidence\.py/);
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

test("Stage 1 failure/rollback evidence is still uploaded via always() steps", () => {
  const text = wf(WF_NAME);
  const pull = namedStep(text, "Pull NAS activation evidence");
  const write = namedStep(text, "Write Stage 1 activation evidence");
  const upload = namedStep(text, "Upload Stage 1 activation evidence");
  const conclude = namedStep(text, "Conclude Stage 1 activation (fail-closed)");
  const authorize = namedStep(text, "Authorize Stage 1 production activation (fail-closed)");
  assert.match(authorize, /id: authorize/);
  assert.match(authorize, /authorized=true/);
  assert.match(pull, /always\(\)/);
  assert.match(pull, /steps.authorize.outputs.authorized == 'true'/);
  assert.match(pull, /steps.activate.outcome/);
  assert.match(write, /if: \$\{\{ always\(\) \}\}/);
  assert.match(upload, /if: \$\{\{ always\(\) \}\}/);
  assert.match(write, /write-stage1-activation-artifact\.py/);
  assert.match(conclude, /activate-rental-marketplace-stage1-evidence\.py --check-receipt/);
  assert.match(conclude, /write-stage1-activation-artifact\.py --check-success/);
  assert.match(conclude, /refusing PASS|is not PASS/);
  assert.doesNotMatch(authorize, /if: \$\{\{ always\(\) \}\}/);
});

test("P1-5 unauthorized Stage 1 actor cannot take the NAS evidence pull path", () => {
  const text = wf(WF_NAME);
  const pull = namedStep(text, "Pull NAS activation evidence");
  assert.match(pull, /NAS_SSH_KEY/);
  assert.match(pull, /steps.authorize.outputs.authorized == 'true'/);
  assert.match(namedStep(text, "Write Stage 1 activation evidence"), /if: \$\{\{ always\(\) \}\}/);
  assert.doesNotMatch(namedStep(text, "Write Stage 1 activation evidence"), /NAS_SSH_KEY/);
  assert.doesNotMatch(namedStep(text, "Copy Stage 1 activation helpers to NAS /tmp"), /if: \$\{\{ always\(\) \}\}/);
  assert.doesNotMatch(namedStep(text, "Activate Stage 1 owner_matching on running v3"), /if: \$\{\{ always\(\) \}\}/);
  assert.throws(() => runAuthorize({ ...GOOD, ACTOR: "cursor", TRIGGERING_ACTOR: "cursor[bot]" }), /not a durable Production activator|not the authorized deployer/);
  assert.throws(() => runAuthorize({ ...GOOD, CONFIRM: "NO" }), /ACTIVATE-STAGE1-PRODUCTION/);
  assert.throws(
    () => runAuthorize({ ...GOOD, OWNER_AUTHORIZATION: "AUTHORIZE-STAGE1:wrong" }),
    /AUTHORIZE-STAGE1/,
  );
});

function completeSuccessCore() {
  const after = {
    rental_catalog_v2: { enabled: true },
    wish: {
      lifecycle_enabled: true,
      owner_matching_enabled: true,
      offer_enabled: false,
      public_share_v2_enabled: false,
      owner_notifications_enabled: false,
      notifications_enabled: false,
      digest_enabled: false,
      outbound_mail_enabled: false,
      outbound_push_enabled: false,
    },
  };
  return {
    ...goodSmoke(),
    source_sha: GOOD.SOURCE_SHA,
    image_digest: GOOD.IMAGE_DIGEST,
    rollback_used: false,
    backup_id: GOOD.BACKUP_ID,
    backup_hash: GOOD.BACKUP_HASH,
    backup_verified: true,
    src_mount: "/mnt/Storage1/apps/5151/v3/src",
    src_manifest_verified: true,
    src_tree_sha256: "a".repeat(64),
    durable_receipt: true,
    verify_only: false,
    receipt_path: "/DATA/AppData/591-tracker-v3/stage1-activation-receipt.json",
    before_raw_flags: { ...after, wish: { ...after.wish, owner_matching_enabled: false } },
    after_raw_flags: after,
    before_counts: { total_posts: 1, total_open: 1 },
    after_counts: { total_posts: 1, total_open: 1 },
    runtime_public_flags: after,
    privacy_smoke: { ok: true },
    health: true,
    landing: true,
    login: true,
    final_digest: GOOD.IMAGE_DIGEST,
    final_oci_revision: GOOD.SOURCE_SHA,
    fixture_run_id: "stage1-fix:20260918:000000:test-run",
    fixture_cleanup: true,
  };
}

test("Stage 1 success evidence still becomes ACTIVATION_OK after durable write", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "stage1-ok-"));
  const core = path.join(dir, "core.json");
  const out = path.join(dir, "out.json");
  writeFileSync(core, JSON.stringify(completeSuccessCore()));
  execFileSync("python3", [path.join(root, ".github/scripts/write-stage1-activation-artifact.py")], {
    env: {
      ...process.env,
      STAGE1_CORE_PATH: core,
      STAGE1_ROLLBACK_PATH: path.join(dir, "missing-rollback.json"),
      STAGE1_EVIDENCE_OUT: out,
      SOURCE_SHA: GOOD.SOURCE_SHA,
      IMAGE_DIGEST: GOOD.IMAGE_DIGEST,
      BACKUP_ID: GOOD.BACKUP_ID,
      BACKUP_HASH: GOOD.BACKUP_HASH,
    },
  });
  const doc = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(doc.ACTIVATION_OK, true);
  assert.equal(doc.activation_result, "activated");
  assert.match(checkEvidence("--check-receipt", doc), /EVIDENCE_RECEIPT_OK/);
  assert.match(
    execFileSync("python3", [path.join(root, ".github/scripts/write-stage1-activation-artifact.py"), "--check-success", out], { encoding: "utf8" }),
    /STAGE1_SUCCESS_CONTRACT_OK/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("P1-6 success contract still fail-closes missing fields, wrong flags, digest or receipt", () => {
  const writer = path.join(root, ".github/scripts/write-stage1-activation-artifact.py");
  const run = (coreDoc) => {
    const dir = mkdtempSync(path.join(tmpdir(), "stage1-p16-"));
    const core = path.join(dir, "core.json");
    const out = path.join(dir, "out.json");
    writeFileSync(core, JSON.stringify(coreDoc));
    execFileSync("python3", [writer], {
      env: {
        ...process.env,
        STAGE1_CORE_PATH: core,
        STAGE1_ROLLBACK_PATH: path.join(dir, "missing-rollback.json"),
        STAGE1_EVIDENCE_OUT: out,
        SOURCE_SHA: GOOD.SOURCE_SHA,
        IMAGE_DIGEST: GOOD.IMAGE_DIGEST,
        BACKUP_ID: GOOD.BACKUP_ID,
        BACKUP_HASH: GOOD.BACKUP_HASH,
      },
    });
    const doc = JSON.parse(readFileSync(out, "utf8"));
    rmSync(dir, { recursive: true, force: true });
    return doc;
  };
  const missingReceipt = completeSuccessCore();
  delete missingReceipt.receipt_path;
  assert.equal(run(missingReceipt).ACTIVATION_OK, false);
  const missingDurable = completeSuccessCore();
  delete missingDurable.durable_receipt;
  assert.equal(run(missingDurable).ACTIVATION_OK, false);
  const matchingOff = completeSuccessCore();
  matchingOff.after_raw_flags.wish.owner_matching_enabled = false;
  assert.equal(run(matchingOff).ACTIVATION_OK, false);
  const stage2On = completeSuccessCore();
  stage2On.after_raw_flags.wish.offer_enabled = true;
  assert.equal(run(stage2On).ACTIVATION_OK, false);
  const wrongDigest = completeSuccessCore();
  wrongDigest.final_digest = "sha256:" + "b".repeat(64);
  assert.equal(run(wrongDigest).ACTIVATION_OK, false);
  const missingBackupVerified = completeSuccessCore();
  delete missingBackupVerified.backup_verified;
  assert.equal(run(missingBackupVerified).ACTIVATION_OK, false);
});
test("P1-7/P1-8 success contract requires fixture_run_id and fixture_cleanup", () => {
  const writer = path.join(root, ".github/scripts/write-stage1-activation-artifact.py");
  const run = (coreDoc) => {
    const dir = mkdtempSync(path.join(tmpdir(), "stage1-p178-"));
    const core = path.join(dir, "core.json");
    const out = path.join(dir, "out.json");
    writeFileSync(core, JSON.stringify(coreDoc));
    execFileSync("python3", [writer], {
      env: {
        ...process.env,
        STAGE1_CORE_PATH: core,
        STAGE1_ROLLBACK_PATH: path.join(dir, "missing-rollback.json"),
        STAGE1_EVIDENCE_OUT: out,
        SOURCE_SHA: GOOD.SOURCE_SHA,
        IMAGE_DIGEST: GOOD.IMAGE_DIGEST,
        BACKUP_ID: GOOD.BACKUP_ID,
        BACKUP_HASH: GOOD.BACKUP_HASH,
      },
    });
    const doc = JSON.parse(readFileSync(out, "utf8"));
    rmSync(dir, { recursive: true, force: true });
    return doc;
  };
  const missingFixtureRun = completeSuccessCore();
  delete missingFixtureRun.fixture_run_id;
  assert.equal(run(missingFixtureRun).ACTIVATION_OK, false);
  const cleanupFalse = completeSuccessCore();
  cleanupFalse.fixture_cleanup = false;
  assert.equal(run(cleanupFalse).ACTIVATION_OK, false);
});

test("P1-9 stale prior-run transient evidence cannot satisfy evidence_available", () => {
  const writer = path.join(root, ".github/scripts/write-stage1-activation-artifact.py");
  const dir = mkdtempSync(path.join(tmpdir(), "stage1-p19-"));
  const core = path.join(dir, "core.json");
  const out = path.join(dir, "out.json");
  const stale = completeSuccessCore();
  stale.workflow_run_id = "1111111111";
  stale.workflow_attempt = "1";
  writeFileSync(core, JSON.stringify(stale));
  execFileSync("python3", [writer], {
    env: {
      ...process.env,
      STAGE1_CORE_PATH: core,
      STAGE1_ROLLBACK_PATH: path.join(dir, "missing-rollback.json"),
      STAGE1_EVIDENCE_OUT: out,
      WF_RUN_ID: "2222222222",
      WF_ATTEMPT: "1",
      SOURCE_SHA: GOOD.SOURCE_SHA,
      IMAGE_DIGEST: GOOD.IMAGE_DIGEST,
      BACKUP_ID: GOOD.BACKUP_ID,
      BACKUP_HASH: GOOD.BACKUP_HASH,
    },
  });
  const doc = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(doc.ACTIVATION_OK, false);
  assert.equal(doc.evidence_available, false);
  assert.equal(doc.activation_result, "evidence_unavailable");
  rmSync(dir, { recursive: true, force: true });
});



test("Stage 1 activation does not change build, predeploy, deploy or PRA workflows", () => {
  for (const name of UNTOUCHED) {
    const text = wf(name);
    assert.doesNotMatch(text, /ACTIVATE-STAGE1-PRODUCTION/);
    assert.doesNotMatch(text, /activate-rental-marketplace-stage1/);
  }
});

function postProbe(name, result, extra = {}) {
  return {
    name,
    timestamp: "2026-09-17T09:00:00.000Z",
    target: extra.target || "/api/self-listings/abc123def456/matches",
    method: "GET",
    auth: extra.auth || "other_account_session",
    status: extra.status ?? 404,
    code: extra.code || "listing_not_found",
    result,
    elapsed_ms: extra.elapsed_ms ?? 12,
    http_5xx: false,
    sqlite_busy: false,
    timed_out: false,
    ...extra.override,
  };
}

function goodSmoke() {
  const crossProbes = [
    postProbe("owner_missing_listing_opaque", "opaque_denial", { auth: "owner_session", target: "/api/self-listings/000000000000/matches" }),
    postProbe("other_account_listing_matches", "opaque_denial"),
    postProbe("other_account_listing_summary", "opaque_denial", { target: "/api/self-listings/abc123def456/matches/summary" }),
  ];
  const suppressionProbes = [
    postProbe("owner_own_listing_matches", "owner_ok", {
      auth: "owner_session",
      status: 200,
      code: "",
    }),
  ];
  return {
    source_sha: GOOD.SOURCE_SHA,
    image_digest: GOOD.IMAGE_DIGEST,
    owner_authorization_bound: true,
    phase: "post_activation",
    probed_here: true,
    authoritative_source: "post_activation_authenticated_probes",
    started_at: "2026-09-17T09:00:00.000Z",
    finished_at: "2026-09-17T09:00:01.000Z",
    probes: [...crossProbes, ...suppressionProbes],
    post_activation: {
      schema: "stage1-post-activation-probes-v1",
      phase: "post_activation",
      probed_here: true,
      authoritative_source: "post_activation_authenticated_probes",
      started_at: "2026-09-17T09:00:00.000Z",
      finished_at: "2026-09-17T09:00:01.000Z",
      probes: [...crossProbes, ...suppressionProbes],
    },
    functional_smoke: {
      aggregate_status: 200,
      exposure_enabled: true,
      summary_unauth: 401,
      detail_unauth: 401,
      unauth_match_denied: true,
      authenticated_cross_account: {
        probed_here: true,
        verified: true,
        unauth_401_is_not_cross_account: true,
        authoritative_source: "post_activation_authenticated_probes",
        probes: crossProbes,
      },
    },
    suppression: {
      probed_here: true,
      verified: true,
      checked: true,
      row_counts_are_not_verification: true,
      district_rent_heuristics_are_not_sufficient: true,
      counterfactual_eligible_required: true,
      counterfactual_engine: "evaluateMatch",
      authoritative_source: "post_activation_authenticated_probes",
      suppressed_candidate_count: 3,
      leaked_count: 0,
      lifecycles_checked: ["paused", "completed", "inactive"],
      probes: suppressionProbes,
    },
    http_5xx: {
      observed: false,
      provenance: "defined_probes",
      probes: ["http://127.0.0.1:5153/api/demand/aggregate", "/api/self-listings/abc123def456/matches"],
    },
    sqlite_busy: {
      observed: false,
      provenance: "defined_probes",
      probes: ["http://127.0.0.1:5153/api/demand/aggregate", "/api/self-listings/abc123def456/matches"],
    },
    perf_smoke: {
      aggregate_ms: 12,
      exposure_ms: 9,
      budget_ms: 5000,
      ok: true,
    },
    health: true,
    landing: true,
    login: true,
    ACTIVATION_OK: true,
  };
}

function checkEvidence(flag, doc) {
  const dir = mkdtempSync(path.join(tmpdir(), "stage1-evidence-"));
  const file = path.join(dir, "doc.json");
  writeFileSync(file, JSON.stringify(doc));
  try {
    return execFileSync("python3", [EVIDENCE_PY, flag, file], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Stage 1 5s perf budget is fail-closed and cannot sit inside ACTIVATION_OK", () => {
  const remote = readFileSync(REMOTE, "utf8");
  const text = wf(WF_NAME);
  assert.match(remote, /perf smoke exceeded 5000ms budget/);
  assert.match(remote, /EVIDENCE_SCRIPT/);
  assert.match(text, /activate-rental-marketplace-stage1-evidence\.py --check-receipt/);
  assert.match(checkEvidence("--check-receipt", goodSmoke()), /EVIDENCE_RECEIPT_OK/);
  assert.throws(
    () => checkEvidence("--check-receipt", {
      ...goodSmoke(),
      perf_smoke: { aggregate_ms: 5001, exposure_ms: 9, budget_ms: 5000, ok: false },
    }),
    /exceeded 5000ms budget|ok is not true/,
  );
  assert.throws(
    () => checkEvidence("--check-receipt", {
      ...goodSmoke(),
      perf_smoke: { aggregate_ms: 5001, exposure_ms: 9, budget_ms: 5000, ok: true },
    }),
    /exceeded 5000ms budget|contradicts measured times/,
  );
  assert.throws(
    () => checkEvidence("--check-runtime", {
      ...goodSmoke(),
      perf_smoke: { aggregate_ms: 12, exposure_ms: 9000, budget_ms: 5000, ok: false },
    }),
    /exceeded 5000ms budget|ok is not true/,
  );
});

test("Stage 1 evidence does not claim cross-account from unauth 401 or pre-activation UAT", () => {
  const remote = readFileSync(REMOTE, "utf8");
  const text = wf(WF_NAME);
  assert.doesNotMatch(remote, /"cross_account": 401/);
  assert.doesNotMatch(text, /"cross_account"/);
  assert.match(remote, /run_post_activation_probes/);
  assert.match(remote, /pre-activation PRODUCTION_UAT_PASS cannot satisfy post-activation evidence/);
  assert.match(remote, /unauth_401_is_not_cross_account/);
  assert.match(remote, /unauth_match_denied/);
  assert.match(checkEvidence("--check-runtime", goodSmoke()), /EVIDENCE_RUNTIME_OK/);
  assert.throws(
    () => checkEvidence("--check-receipt", {
      ...goodSmoke(),
      functional_smoke: {
        ...goodSmoke().functional_smoke,
        cross_account: 401,
      },
    }),
    /cross_account must not be claimed from unauth probes/,
  );
  assert.throws(
    () => checkEvidence("--check-receipt", {
      ...goodSmoke(),
      functional_smoke: {
        aggregate_status: 200,
        exposure_enabled: true,
        summary_unauth: 401,
        detail_unauth: 401,
        unauth_match_denied: true,
      },
    }),
    /authenticated_cross_account block is missing/,
  );
  assert.throws(
    () => checkEvidence("--check-receipt", {
      ...goodSmoke(),
      functional_smoke: {
        ...goodSmoke().functional_smoke,
        authenticated_cross_account: {
          probed_here: false,
          verified: false,
          unauth_401_is_not_cross_account: true,
          authoritative_source: "PRODUCTION_UAT_PASS",
          uat_attestation_bound: true,
        },
      },
    }),
    /pre-activation PRODUCTION_UAT_PASS cannot satisfy post-activation/,
  );
  assert.throws(
    () => checkEvidence("--check-receipt", {
      ...goodSmoke(),
      functional_smoke: {
        ...goodSmoke().functional_smoke,
        authenticated_cross_account: {
          ...goodSmoke().functional_smoke.authenticated_cross_account,
          unauth_401_is_not_cross_account: false,
        },
      },
    }),
    /unauthenticated 401 cannot satisfy cross-account evidence/,
  );
  assert.throws(
    () => checkEvidence("--check-receipt", {
      ...goodSmoke(),
      functional_smoke: {
        ...goodSmoke().functional_smoke,
        authenticated_cross_account: {
          ...goodSmoke().functional_smoke.authenticated_cross_account,
          probes: [
            postProbe("other_account_listing_matches", "unauth_style_401", { status: 401, code: "" }),
          ],
        },
      },
    }),
    /unauthenticated 401 cannot satisfy cross-account evidence/,
  );
});

test("cursor or cursor[bot] alone cannot activate Production without current Owner authorization", () => {
  const auth = authorizeScript();
  assert.doesNotMatch(auth, /CURSOR_DEPLOY=1/);
  assert.doesNotMatch(wf(WF_NAME), /Owner 已書面授權：Cursor Agent/);
  for (const actor of ["cursor", "cursor[bot]"]) {
    assert.throws(
      () => runAuthorize({ ...GOOD, ACTOR: actor, TRIGGERING_ACTOR: actor }),
      /not a durable Production activator|not the authorized deployer/,
    );
  }
});

test("row counts or pre-activation UAT cannot satisfy suppression and bare 5xx/busy flags cannot be synthesized", () => {
  const remote = readFileSync(REMOTE, "utf8");
  assert.match(remote, /row_counts_are_not_verification/);
  assert.match(readFileSync(path.join(root, ".github/scripts/activate-rental-marketplace-stage1-postcheck.mjs"), "utf8"), /isCounterfactuallyMatchable/);
  assert.match(readFileSync(path.join(root, ".github/scripts/activate-rental-marketplace-stage1-postcheck.mjs"), "utf8"), /district_rent_heuristics_are_not_sufficient/);
  assert.match(remote, /provenance": "defined_probes"/);
  assert.match(remote, /write_rollback_evidence/);
  assert.throws(
    () => checkEvidence("--check-receipt", {
      ...goodSmoke(),
      suppression: {
        verified: true,
        checked: true,
        row_counts_are_not_verification: true,
        district_rent_heuristics_are_not_sufficient: true,
        counterfactual_eligible_required: true,
        authoritative_source: "PRODUCTION_UAT_PASS",
        uat_attestation_bound: true,
        lifecycle_counts: [{ lifecycle: "paused", status: "open", n: 2 }],
      },
    }),
    /pre-activation PRODUCTION_UAT_PASS cannot satisfy post-activation suppression/,
  );
  assert.throws(
    () => checkEvidence("--check-receipt", {
      ...goodSmoke(),
      suppression: {
        probed_here: true,
        verified: true,
        checked: true,
        authoritative_source: "post_activation_authenticated_probes",
        suppressed_candidate_count: 3,
        leaked_count: 0,
        lifecycles_checked: ["paused", "completed", "inactive"],
      },
    }),
    /row counts alone cannot satisfy suppression verification|district\/rent overlap cannot satisfy suppression fixtures/,
  );
  assert.throws(
    () => checkEvidence("--check-receipt", {
      ...goodSmoke(),
      suppression: {
        ...goodSmoke().suppression,
        district_rent_heuristics_are_not_sufficient: false,
      },
    }),
    /district\/rent overlap cannot satisfy suppression fixtures/,
  );
  assert.throws(
    () => checkEvidence("--check-receipt", {
      ...goodSmoke(),
      suppression: {
        ...goodSmoke().suppression,
        counterfactual_eligible_required: false,
      },
    }),
    /suppression fixtures must be counterfactually eligible via evaluateMatch/,
  );
  assert.throws(
    () => checkEvidence("--check-receipt", { ...goodSmoke(), http_5xx: false }),
    /must not be a bare boolean/,
  );
  assert.throws(
    () => checkEvidence("--check-receipt", { ...goodSmoke(), sqlite_busy: false }),
    /must not be a bare boolean/,
  );
  assert.throws(
    () => checkEvidence("--check-receipt", {
      ...goodSmoke(),
      http_5xx: { observed: false, provenance: "hardcoded", probes: ["/api/health"] },
    }),
    /provenance must be defined_probes/,
  );
});

test("Stage 1 post-activation probes are required and fail-closed with compensating rollback", () => {
  const remote = readFileSync(REMOTE, "utf8");
  const text = wf(WF_NAME);
  assert.match(text, /activate-rental-marketplace-stage1-postcheck\.mjs/);
  assert.match(remote, /POSTCHECK_SCRIPT/);
  // P1-10: verify-only recovery must not roll back merely because fixtures were cleaned.
  assert.doesNotMatch(remote, /compensate_and_fail "verify-only post-activation probes failed"/);
  assert.match(remote, /hydrate_runtime_on verify-only \|\| fail "verify-only/);
  // The activate path still fails closed with the compensating rollback.
  assert.match(remote, /hydrate_runtime_on \|\| compensate_and_fail "runtime hydrate\/public flag post-check failed"/);
  assert.match(remote, /run_post_activation_probes \|\| return 1/);
  assert.match(checkEvidence("--check-receipt", goodSmoke()), /EVIDENCE_RECEIPT_OK/);
  assert.throws(
    () => checkEvidence("--check-receipt", {
      ...goodSmoke(),
      uat_attestation: "PRODUCTION_UAT_PASS:x:y",
    }),
    /pre-activation PRODUCTION_UAT_PASS cannot satisfy post-activation evidence/,
  );
  assert.throws(
    () => checkEvidence("--check-receipt", {
      ...goodSmoke(),
      post_activation: { ...goodSmoke().post_activation, probes: [] },
      probes: [],
    }),
    /probes are missing/,
  );
  assert.throws(
    () => checkEvidence("--check-receipt", {
      ...goodSmoke(),
      functional_smoke: {
        ...goodSmoke().functional_smoke,
        authenticated_cross_account: {
          ...goodSmoke().functional_smoke.authenticated_cross_account,
          probes: [postProbe("other_account_listing_matches", "timeout", { status: 0, code: "", override: { timed_out: true } })],
        },
      },
    }),
    /timed out|timeout|fail-closed/,
  );
});
test("P1-10 verify-only recovery never rolls back merely because fixtures were cleaned", () => {
  const remote = readFileSync(REMOTE, "utf8");
  const start = remote.indexOf('if [ "$PATH_KIND" = "verify-only" ]');
  assert.ok(start >= 0, "verify-only recovery block missing");
  const end = remote.indexOf("exit 0", start);
  assert.ok(end > start, "verify-only recovery block has no exit");
  const block = remote.slice(start, end);
  // Runs the current-run verification without the fixture-dependent probes.
  assert.match(block, /hydrate_runtime_on verify-only/);
  // Must NOT roll back or mutate Production on a clean, already-activated Stage 1.
  assert.doesNotMatch(block, /compensate_and_fail/);
  assert.doesNotMatch(block, /run_domain rollback/);
  assert.doesNotMatch(block, /saveRentalMarketplaceFlags/);
  // Must not depend on re-creating fixtures.
  assert.doesNotMatch(block, /run_fixture_domain/);
  // The fixture-dependent post-activation probes run only for the activate path.
  assert.match(remote, /if \[ "\$mode" = "activate" \]; then\s+run_post_activation_probes \|\| return 1/);
  // hydrate_runtime_on requires the prior durable, cleaned activation receipt.
  assert.match(remote, /verify-only prior receipt is not ACTIVATION_OK/);
  assert.match(remote, /verify-only prior receipt is missing fixture_run_id/);
  assert.match(remote, /verify-only prior receipt did not verify fixture cleanup/);
  assert.match(remote, /verify-only requires runtime wish\.owner_matching_enabled true/);
  // It retains the original authenticated post-activation evidence, marked as a verification run.
  assert.match(remote, /prior\.get\("post_activation"\)/);
  assert.match(remote, /current_run_is_verification/);
  assert.match(remote, /fixtures_cleaned_by_prior_run/);
});

test("P1-10 verify-only still fails closed on identity, runtime or UAT substitution", () => {
  const remote = readFileSync(REMOTE, "utf8");
  // Fresh current-run runtime checks still apply in verify-only.
  assert.match(remote, /verify-only requires runtime wish\.owner_matching_enabled true/);
  assert.match(remote, /if agg_ms_n >= 5000 or exp_ms_n >= 5000:/);
  assert.match(remote, /unauth summary is not fail-closed 401/);
  assert.match(remote, /unauth detail is not fail-closed 401/);
  assert.match(remote, /http_5xx observed during defined probes/);
  assert.match(remote, /sqlite_busy observed during defined probes/);
  // Wrong digest/revision/source/tree is rejected by the path classifier before verify-only.
  const pathPy = readFileSync(PATH_PY, "utf8");
  assert.match(pathPy, /receipt \{key\} does not match/);
  assert.match(pathPy, /receipt is not ACTIVATION_OK/);
  // Original authenticated evidence cannot be replaced by pre-activation UAT.
  assert.match(remote, /pre-activation PRODUCTION_UAT_PASS cannot satisfy post-activation evidence/);
});

test("P1-11 cleanup semantic-validation failure is compensated (Stage 1 never left ON)", () => {
  const remote = readFileSync(REMOTE, "utf8");
  // transport/process failure is compensated...
  assert.match(remote, /if ! run_fixture_domain cleanup-activated; then\s+compensate_and_fail "post-activation fixture cleanup failed"/);
  // ...and so is a success exit whose cleanup JSON is malformed or semantically invalid.
  assert.match(remote, /CLEANUP_SEMANTIC_RC=\$\?/);
  assert.match(remote, /if \[ "\$CLEANUP_SEMANTIC_RC" -ne 0 \]; then\s+compensate_and_fail "post-activation fixture cleanup evidence validation failed"/);
  // It runs with errexit temporarily disabled so a malformed JSON cannot bypass compensation.
  const guard = remote.indexOf("CLEANUP_SEMANTIC_RC=$?");
  assert.ok(guard > 0, "cleanup semantic guard missing");
  assert.match(remote.slice(Math.max(0, guard - 2000), guard), /set \+e/);
  // A valid cleanup result still flows on to the durable receipt.
  assert.match(remote, /write_core_and_receipt false \|\| compensate_and_fail "durable receipt write failed after mutation"/);
});

test("P2-12 repeated verify-only replays keep the original activation run", () => {
  const remote = readFileSync(REMOTE, "utf8");
  assert.match(remote, /original_run_id = prev\.get\("original_run_id"\) or prev\.get\("workflow_run_id"\) or run_id/);
  assert.match(remote, /original_attempt = prev\.get\("original_attempt"\) or prev\.get\("workflow_attempt"\) or attempt/);
});

test("P1-14 landing/login must be verified with HTTP 200 (no hardcoded PASS)", () => {
  const remote = readFileSync(REMOTE, "utf8");
  // runtime evidence derives landing/login from the probe statuses, not hardcoded true
  assert.match(remote, /land_status, _land_ms = "\$land_probe"\.split\(\)/);
  assert.match(remote, /login_status, _login_ms = "\$login_html_probe"\.split\(\)/);
  assert.match(remote, /land_ok = \(/);
  assert.match(remote, /and os\.path\.getsize\("\/tmp\/stage1-landing\.html"\) > 0/);
  assert.match(remote, /login_ok = \(/);
  assert.match(remote, /and os\.path\.getsize\("\/tmp\/stage1-login\.html"\) > 0/);
  assert.match(remote, /if not land_ok:/);
  assert.match(remote, /if not login_ok:/);
  assert.match(remote, /"landing": land_ok,/);
  assert.match(remote, /"login": login_ok,/);
  assert.doesNotMatch(remote, /"landing": True,/);
  assert.doesNotMatch(remote, /"login": True,/);
  // the evidence contract rejects unproven health/landing/login
  assert.throws(() => checkEvidence("--check-runtime", { ...goodSmoke(), health: false }), /health is not verified/);
  assert.throws(() => checkEvidence("--check-runtime", { ...goodSmoke(), landing: false }), /landing page is not verified/);
  assert.throws(() => checkEvidence("--check-runtime", { ...goodSmoke(), login: false }), /login page is not verified/);
  assert.throws(() => checkEvidence("--check-receipt", { ...goodSmoke(), landing: false }), /landing page is not verified/);
  assert.throws(() => checkEvidence("--check-receipt", { ...goodSmoke(), login: false }), /login page is not verified/);
  // both 200 with non-empty bodies => runtime evidence may pass
  assert.match(checkEvidence("--check-runtime", goodSmoke()), /EVIDENCE_RUNTIME_OK/);
  // verify-only reuses the same checks but never rolls back
  assert.match(remote, /hydrate_runtime_on verify-only \|\| fail "verify-only/);
});

test("P2-19 landing/login evidence requires the intended page markers", () => {
  const remote = readFileSync(REMOTE, "utf8");
  // landing must be the product page, not merely any 200 body
  assert.match(remote, /"<title>吉比租房物件追蹤<\/title>" in land_html/);
  // login must be the actual login form page
  assert.match(remote, /"<title>登入 · 吉比租房物件追蹤<\/title>" in login_html/);
  assert.match(remote, /'<form id="loginForm">' in login_html/);
  assert.match(remote, /'type="password"' in login_html/);
  assert.match(remote, /landing page did not serve the expected product page/);
  assert.match(remote, /login page did not serve the expected login form/);
  // verify-only still fails without rollback
  assert.match(remote, /hydrate_runtime_on verify-only \|\| fail "verify-only/);
});
