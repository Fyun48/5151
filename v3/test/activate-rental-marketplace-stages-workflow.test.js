import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WF_NAME = "activate-rental-marketplace-stages.yml";
const UNTOUCHED = [
  "build-production-image.yml",
  "production-predeploy-check.yml",
  "deploy-v3.yml",
  "activate-rental-marketplace-pra.yml",
  "activate-rental-marketplace-stage1.yml",
];
const DOMAIN = path.join(root, ".github/scripts/activate-rental-marketplace-stages-domain.mjs");
const REMOTE = path.join(root, ".github/scripts/activate-rental-marketplace-stages-remote.sh");
const PATH_PY = path.join(root, ".github/scripts/activate-rental-marketplace-stages-path.py");
const EVIDENCE_PY = path.join(root, ".github/scripts/activate-rental-marketplace-stages-evidence.py");
const POSTCHECK = path.join(root, ".github/scripts/activate-rental-marketplace-stages-postcheck.mjs");

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

function wf(name) {
  // Checkouts on Windows may carry CRLF; every workflow/script assertion here is
  // written against the LF content that CI and the git index always use.
  return readText(path.join(root, ".github/workflows", name));
}

function readText(target) {
  return readFileSync(target, "utf8").replace(/\r\n/g, "\n");
}

function onBlock(text) {
  const m = text.match(/\non:\n([\s\S]*?)\n[a-zA-Z]/);
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
  return pipeRunScript(namedStep(wf(WF_NAME), "Authorize staged production activation (fail-closed)"));
}

function runAuthorize(env) {
  const dir = mkdtempSync(path.join(tmpdir(), "stages-auth-"));
  const outFile = path.join(dir, "github_output");
  writeFileSync(outFile, "");
  try {
    execFileSync("bash", ["-c", authorizeScript()], {
      env: { ...process.env, ...env, GITHUB_OUTPUT: outFile },
      encoding: "utf8",
    });
    return readFileSync(outFile, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SHA = "e4ced00111111111111111111111111111111111";
const DIGEST = `sha256:${"d209658c".padEnd(64, "0")}`;
const BACKUP = "/DATA/AppData/591-tracker-v3-backups/predeploy-20260918-063424";
const BACKUP_HASH = `sha256:${"bbd31a00".padEnd(64, "0")}`;
const TREE = `sha256:${"a".repeat(64)}`;

function good(stage) {
  return {
    WF_REF: "refs/heads/master",
    ACTOR: "Fyun48",
    TRIGGERING_ACTOR: "Fyun48",
    ALLOWED_ACTOR: "Fyun48",
    TARGET_STAGE: String(stage),
    CONFIRM: `ACTIVATE-STAGE${stage}-PRODUCTION`,
    OWNER_AUTHORIZATION: `AUTHORIZE-STAGE${stage}:${SHA}:${DIGEST}:${BACKUP}:${BACKUP_HASH}`,
    SOURCE_SHA: SHA,
    IMAGE_DIGEST: DIGEST,
    BACKUP_ID: BACKUP,
    BACKUP_HASH,
  };
}

function flags({ stage = 0, later = {}, extra = {} } = {}) {
  return {
    rental_catalog_v2: { enabled: true },
    wish: {
      lifecycle_enabled: true,
      owner_matching_enabled: stage >= 1,
      offer_enabled: stage >= 2,
      public_share_v2_enabled: stage >= 3,
      owner_notifications_enabled: stage >= 4,
      notifications_enabled: stage >= 4,
      digest_enabled: false,
      outbound_mail_enabled: false,
      outbound_push_enabled: false,
      ...later,
      ...extra,
    },
  };
}

function classify(stage, rawFlags, receiptPath) {
  const dir = mkdtempSync(path.join(tmpdir(), "stages-path-"));
  const flagsFile = path.join(dir, "flags.json");
  writeFileSync(flagsFile, JSON.stringify({ mode: "inspect", raw_flags: rawFlags }));
  try {
    return execFileSync("python3", [
      PATH_PY,
      flagsFile,
      receiptPath,
      String(stage),
      SHA,
      DIGEST,
      BACKUP,
      BACKUP_HASH,
      TREE,
    ], { encoding: "utf8" }).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function receipt(stage, overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "stages-receipt-"));
  const receiptPath = path.join(dir, `stage${stage}-activation-receipt.json`);
  writeFileSync(receiptPath, JSON.stringify({
    source_sha: SHA,
    image_digest: DIGEST,
    backup_id: BACKUP,
    backup_hash: BACKUP_HASH,
    src_tree_sha256: TREE,
    target_stage: stage,
    ACTIVATION_OK: true,
    ...overrides,
  }));
  return { receiptPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("Staged activation remains workflow_dispatch only", () => {
  const block = onBlock(wf(WF_NAME));
  assert.match(block, /workflow_dispatch:/);
  assert.doesNotMatch(block, /(^|\n)\s*push:/);
  assert.doesNotMatch(block, /(^|\n)\s*schedule:/);
});

test("Staged activation requires a target stage and per-stage confirmation input", () => {
  const text = wf(WF_NAME);
  assert.match(text, /target_stage:/);
  assert.match(text, /ACTIVATE-STAGE\$\{TARGET_STAGE\}-PRODUCTION/);
  assert.match(text, /AUTHORIZE-STAGE\$\{TARGET_STAGE\}:\$\{SOURCE_SHA\}:\$\{IMAGE_DIGEST\}:\$\{BACKUP_ID\}:\$\{BACKUP_HASH\}/);
});

test("Staged activation authorize script accepts each stage and rejects mismatched bindings", () => {
  for (const stage of [2, 3, 4]) {
    assert.match(runAuthorize(good(stage)), /authorized=true/);
  }
  assert.throws(() => runAuthorize({ ...good(2), TARGET_STAGE: "5" }), /target_stage must be 2, 3 or 4/);
  assert.throws(() => runAuthorize({ ...good(2), CONFIRM: "ACTIVATE-STAGE3-PRODUCTION" }), /confirmation must be exactly/);
  assert.throws(() => runAuthorize({ ...good(3), CONFIRM: "ACTIVATE-STAGE2-PRODUCTION" }), /confirmation must be exactly/);
  assert.throws(() => runAuthorize({ ...good(3), OWNER_AUTHORIZATION: good(2).OWNER_AUTHORIZATION }), /owner_authorization must be exactly/);
  assert.throws(() => runAuthorize({ ...good(2), ALLOWED_ACTOR: "" }), /PRODUCTION_DEPLOY_ALLOWED_ACTOR is not configured/);
  assert.throws(() => runAuthorize({ ...good(2), WF_REF: "refs/heads/cursor/x" }), /must run from the master workflow definition/);
  assert.throws(() => runAuthorize({ ...good(2), ACTOR: "cursor" }), /not a durable Production activator|not the authorized deployer/);
  assert.throws(() => runAuthorize({ ...good(2), TRIGGERING_ACTOR: "cursor[bot]" }), /not a durable Production activator|not the authorized deployer/);
  assert.throws(() => runAuthorize({ ...good(2), ACTOR: "someone-else" }), /is not the authorized deployer/);
  assert.throws(() => runAuthorize({ ...good(2), SOURCE_SHA: "abc" }), /source_sha must be a full 40-character commit SHA/);
  assert.throws(() => runAuthorize({ ...good(2), IMAGE_DIGEST: "sha256:zz" }), /image_digest must be exactly/);
  assert.throws(() => runAuthorize({ ...good(2), BACKUP_ID: "/tmp/evil" }), /backup_id must be/);
  assert.throws(() => runAuthorize({ ...good(2), BACKUP_ID: "/DATA/AppData/591-tracker-v3-backups/predeploy-20260918-063424/.." }), /backup_id must be/);
  assert.throws(() => runAuthorize({ ...good(2), BACKUP_HASH: "nope" }), /backup_hash must be exactly/);
});

test("Staged activation keeps master, actor, triggering_actor and SHA ancestry guards", () => {
  const script = authorizeScript();
  assert.match(script, /refs\/heads\/master/);
  assert.match(script, /ACTOR.*ALLOWED_ACTOR/);
  assert.match(script, /TRIGGERING_ACTOR.*ALLOWED_ACTOR/);
  const text = wf(WF_NAME);
  assert.match(text, /git merge-base --is-ancestor "\$SOURCE_SHA" origin\/master/);
  assert.match(text, /not reachable from origin\/master; refusing/);
});

test("Staged activation pins the workflow-definition SHA and never checks out the candidate onto the NAS", () => {
  const text = wf(WF_NAME);
  assert.match(text, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(text, /trusted checkout HEAD \$HEAD_SHA != workflow execution SHA \$EXPECTED_WF_SHA/);
  assert.match(text, /manifest step moved HEAD/);
  const scp = namedStep(text, "Copy staged activation helpers to NAS /tmp");
  assert.doesNotMatch(scp, /v3\/src/);
  assert.doesNotMatch(scp, /\$\{\{ inputs\.source_sha \}\}/);
  assert.match(scp, /target: \/tmp\/5151-stages-activate-helpers/);
});

test("Staged domain mutates only the target stage through saveRentalMarketplaceFlags", () => {
  const domain = readText(DOMAIN);
  assert.match(domain, /saveRentalMarketplaceFlags\(\{ wish \}\)/);
  assert.doesNotMatch(domain, /UPDATE settings|INSERT INTO settings|db\.prepare\(/);
  assert.match(domain, /earlier-stage flag \$\{flag\} must be true before Stage \$\{target\}/);
  assert.match(domain, /later-stage flag \$\{flag\} must be false for Stage \$\{target\}/);
  assert.match(domain, /outbound flag \$\{flag\} must be false/);
  assert.match(domain, /PRODUCTION_STATE_UNKNOWN/);
  assert.match(domain, /activate-already-on/);
  assert.match(domain, /rollback-already-off/);
});

test("Staged remote guards digest, OCI, src manifest, backup and compensating rollback", () => {
  const remote = readText(REMOTE);
  assert.match(remote, /Config\.Image is not the requested digest pin/);
  assert.match(remote, /RepoDigest does not include the requested digest/);
  assert.match(remote, /RepoDigest does not exactly equal input image_digest/);
  assert.match(remote, /OCI revision '\$OCI_REVISION' != source_sha/);
  assert.match(remote, /does not match source_sha v3\/src manifest \(fail-before-save\)/);
  assert.match(remote, /backup db sha256 does not match input backup_hash/);
  assert.match(remote, /rollback_target_stage/);
  assert.match(remote, /domain rollback failed \(PRODUCTION_STATE_UNKNOWN; no raw SQL repair\)/);
  assert.match(remote, /running server hydrate is inconsistent \(PRODUCTION_STATE_UNKNOWN\)/);
  assert.match(remote, /raw_sql_repair_used": False/);
  assert.match(remote, /AUTHORIZE-STAGE\$\{TARGET_STAGE\}:/);
  assert.doesNotMatch(remote, /docker compose|docker pull|docker restart/);
  assert.doesNotMatch(remote, /rm -rf/);
});


test("Staged remote keeps every outbound channel OFF and never touches later stages", () => {
  const remote = readText(REMOTE);
  assert.match(remote, /for key in \("digest_enabled", "outbound_mail_enabled", "outbound_push_enabled"\)/);
  assert.match(remote, /outbound flag \{key\} changed or is true/);
  assert.match(remote, /later-stage flag \{key\} changed or is true/);
  const domain = readText(DOMAIN);
  assert.doesNotMatch(domain, /digest_enabled: true|outbound_mail_enabled: true|outbound_push_enabled: true/);
});

test("Staged activation always uploads evidence and fails closed on conclusion", () => {
  const text = wf(WF_NAME);
  const upload = namedStep(text, "Upload staged activation evidence");
  assert.match(upload, /if: \$\{\{ always\(\) \}\}/);
  assert.match(upload, /if-no-files-found: error/);
  const pull = namedStep(text, "Pull NAS staged activation evidence");
  assert.match(pull, /steps\.activate\.outcome == 'success' \|\| steps\.activate\.outcome == 'failure'/);
  const conclude = namedStep(text, "Conclude staged activation (fail-closed)");
  assert.match(conclude, /refusing PASS/);
  assert.match(conclude, /earlier stage flags are not all ON/);
  assert.match(conclude, /a later stage flag is ON/);
  assert.match(conclude, /an outbound channel flag is ON/);
  assert.match(conclude, /staged post-activation probes did not pass/);
});

test("Staged activation leaves build, predeploy, deploy, PR A and Stage 1 workflows untouched", () => {
  for (const name of UNTOUCHED) {
    assert.doesNotMatch(wf(name), /activate-rental-marketplace-stages/);
  }
});

pythonTest("Staged path classifier allows monotonic activation for stages 2, 3 and 4", () => {
  assert.equal(classify(2, flags({ stage: 1 }), "/tmp/no-such-receipt.json"), "activate");
  assert.equal(classify(3, flags({ stage: 2 }), "/tmp/no-such-receipt.json"), "activate");
  assert.equal(classify(4, flags({ stage: 3 }), "/tmp/no-such-receipt.json"), "activate");
});

pythonTest("Staged path classifier fail-closes out-of-order, later-ON, outbound-ON and PR A off", () => {
  assert.throws(() => classify(3, flags({ stage: 1 }), "/tmp/none.json"), /requires earlier flag offer_enabled ON/);
  assert.throws(() => classify(4, flags({ stage: 2 }), "/tmp/none.json"), /requires earlier flag public_share_v2_enabled ON/);
  assert.throws(
    () => classify(2, flags({ stage: 1, later: { public_share_v2_enabled: true } }), "/tmp/none.json"),
    /requires later flag public_share_v2_enabled OFF/,
  );
  assert.throws(
    () => classify(2, flags({ stage: 1, later: { outbound_mail_enabled: true } }), "/tmp/none.json"),
    /outbound channel flag is already true/,
  );
  assert.throws(
    () => classify(2, flags({ stage: 1, extra: { lifecycle_enabled: false } }), "/tmp/none.json"),
    /lifecycle_enabled is not true/,
  );
  assert.throws(
    () => classify(2, { rental_catalog_v2: { enabled: false }, wish: { lifecycle_enabled: true, owner_matching_enabled: true } }, "/tmp/none.json"),
    /rental_catalog_v2.enabled is not true/,
  );
  assert.throws(() => classify(9, flags({ stage: 3 }), "/tmp/none.json"), /is not 2, 3 or 4/);
});

pythonTest("Staged path classifier verify-only needs a matching durable receipt", () => {
  const good2 = receipt(2);
  try {
    assert.equal(classify(2, flags({ stage: 2 }), good2.receiptPath), "verify-only");
  } finally {
    good2.cleanup();
  }
  assert.throws(
    () => classify(2, flags({ stage: 2 }), "/tmp/definitely-absent-receipt.json"),
    /durable receipt is missing/,
  );
  const cases = [
    { stage: 2, override: { source_sha: "b".repeat(40) }, pattern: /receipt source_sha does not match/ },
    { stage: 2, override: { target_stage: 3 }, pattern: /receipt target_stage does not match/ },
    { stage: 2, override: { ACTIVATION_OK: false }, pattern: /is not ACTIVATION_OK/ },
    { stage: 3, override: { src_tree_sha256: "sha256:dead" }, pattern: /receipt src_tree_sha256 does not match/ },
  ];
  for (const item of cases) {
    const r = receipt(item.stage, item.override);
    try {
      assert.throws(() => classify(item.stage, flags({ stage: item.stage }), r.receiptPath), item.pattern);
    } finally {
      r.cleanup();
    }
  }
});


function postcheckDoc(stage, overrides = {}) {
  return {
    schema: "rental-marketplace-stages-post-activation/v1",
    phase: "post_activation",
    probed_here: true,
    authoritative_source: "post_activation_authenticated_probes",
    stage,
    source_sha: SHA,
    ok: true,
    checks: {
      pr_a_flags_on: true,
      stage1_on: true,
      target_stage_on: true,
      later_stages_off: true,
      outbound_off: true,
      privacy_redaction: true,
    },
    redaction: {
      probe_bodies_without_pii: true,
      closed_gate_responses_are_opaque: true,
      authenticated_probe_requires_session: true,
    },
    ...overrides,
  };
}

function writeJson(dir, name, doc) {
  const target = path.join(dir, name);
  writeFileSync(target, JSON.stringify(doc, null, 2));
  return target;
}

function runEvidence({ stage, klass, inspect, result, status, postcheck }) {
  const dir = mkdtempSync(path.join(tmpdir(), "stages-evidence-"));
  const evidencePath = path.join(dir, "evidence.json");
  const receiptPath = path.join(dir, "receipt.json");
  const args = [
    EVIDENCE_PY,
    "--stage", String(stage),
    "--class", klass,
    "--inspect", writeJson(dir, "inspect.json", inspect),
    "--result", writeJson(dir, "result.json", result),
    "--status", writeJson(dir, "status.json", status),
    "--postcheck", writeJson(dir, "postcheck.json", postcheck),
    "--evidence", evidencePath,
    "--receipt", receiptPath,
    "--run-id", "35316208975",
    "--workflow", "activate-rental-marketplace-stages.yml",
    "--source-sha", SHA,
    "--tree-sha", TREE,
    "--image-digest", DIGEST,
    "--backup-id", BACKUP,
    "--backup-hash", BACKUP_HASH,
  ];
  const readEvidence = () => (existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, "utf8")) : {});
  try {
    const stdout = execFileSync("python3", args, { encoding: "utf8" });
    return { ok: true, stdout, evidence: readEvidence(), hasReceipt: existsSync(receiptPath) };
  } catch (error) {
    return {
      ok: false,
      stdout: `${error.stdout || ""}${error.stderr || ""}`,
      evidence: readEvidence(),
      hasReceipt: existsSync(receiptPath),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

pythonTest("Staged evidence contract accepts a clean activation and writes a receipt", () => {
  const out = runEvidence({
    stage: 2,
    klass: "activate",
    inspect: { mode: "inspect", raw_flags: flags({ stage: 1 }) },
    result: { mode: "activate", before_raw_flags: flags({ stage: 1 }), after_raw_flags: flags({ stage: 2 }) },
    status: { phase: "after-verify", mutated: true },
    postcheck: postcheckDoc(2),
  });
  assert.equal(out.ok, true, out.stdout);
  assert.deepEqual(out.evidence.problems, []);
  assert.equal(out.evidence.class, "activate");
  assert.equal(out.evidence.identity.target_stage, 2);
  assert.deepEqual(out.evidence.mutation_kinds, ["settings:rental-marketplace"]);
  assert.equal(out.hasReceipt, true);
});

pythonTest("Staged evidence contract accepts a verify-only replay without a mutation", () => {
  const out = runEvidence({
    stage: 3,
    klass: "verify-only",
    inspect: { mode: "inspect", raw_flags: flags({ stage: 3 }) },
    result: { mode: "inspect", raw_flags: flags({ stage: 3 }) },
    status: { phase: "inspect", mutated: false },
    postcheck: postcheckDoc(3),
  });
  assert.equal(out.ok, true, out.stdout);
  assert.deepEqual(out.evidence.mutation_kinds, []);
  assert.equal(out.hasReceipt, true);
});


pythonTest("Staged evidence contract fail-closes later-ON, outbound-ON, wrong phase and postcheck gaps", () => {
  const base = {
    stage: 2,
    klass: "activate",
    inspect: { mode: "inspect", raw_flags: flags({ stage: 1 }) },
    result: { mode: "activate", before_raw_flags: flags({ stage: 1 }), after_raw_flags: flags({ stage: 2 }) },
    status: { phase: "after-verify", mutated: true },
    postcheck: postcheckDoc(2),
  };
  const laterOn = runEvidence({
    ...base,
    result: {
      mode: "activate",
      before_raw_flags: flags({ stage: 1 }),
      after_raw_flags: flags({ stage: 2, later: { public_share_v2_enabled: true } }),
    },
  });
  assert.equal(laterOn.ok, false);
  assert.ok(laterOn.evidence.problems.some((p) => /later flag public_share_v2_enabled/.test(p)));
  assert.equal(laterOn.hasReceipt, false);

  const outboundOn = runEvidence({
    ...base,
    result: {
      mode: "activate",
      before_raw_flags: flags({ stage: 1 }),
      after_raw_flags: flags({ stage: 2, later: { outbound_push_enabled: true } }),
    },
  });
  assert.equal(outboundOn.ok, false);
  assert.ok(outboundOn.evidence.problems.some((p) => /outbound flag outbound_push_enabled/.test(p)));

  const wrongPhase = runEvidence({ ...base, status: { phase: "rolled-back-in-process", mutated: false } });
  assert.equal(wrongPhase.ok, false);
  assert.ok(wrongPhase.evidence.problems.some((p) => /instead of 'after-verify'/.test(p)));

  const unknown = runEvidence({ ...base, status: { phase: "PRODUCTION_STATE_UNKNOWN", mutated: true } });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.evidence.problems.some((p) => /PRODUCTION_STATE_UNKNOWN/.test(p)));

  const postcheckGap = runEvidence({
    ...base,
    postcheck: postcheckDoc(2, { checks: { ...postcheckDoc(2).checks, later_stages_off: false } }),
  });
  assert.equal(postcheckGap.ok, false);
  assert.ok(postcheckGap.evidence.problems.some((p) => /postcheck later_stages_off did not pass/.test(p)));

  const wrongStage = runEvidence({ ...base, postcheck: postcheckDoc(3) });
  assert.equal(wrongStage.ok, false);
  assert.ok(wrongStage.evidence.problems.some((p) => /postcheck stage does not match/.test(p)));

  const wrongSha = runEvidence({ ...base, postcheck: postcheckDoc(2, { source_sha: "c".repeat(40) }) });
  assert.equal(wrongSha.ok, false);
  assert.ok(wrongSha.evidence.problems.some((p) => /postcheck ran against a different source SHA/.test(p)));

  const noRedaction = runEvidence({ ...base, postcheck: postcheckDoc(2, { redaction: {} }) });
  assert.equal(noRedaction.ok, false);
  assert.ok(noRedaction.evidence.problems.some((p) => /privacy redaction evidence missing/.test(p)));
});

pythonTest("Staged evidence contract refuses a verify-only run that started a mutation", () => {
  const out = runEvidence({
    stage: 3,
    klass: "verify-only",
    inspect: { mode: "inspect", raw_flags: flags({ stage: 3 }) },
    result: { mode: "inspect", raw_flags: flags({ stage: 3 }) },
    status: { phase: "after-save", mutated: true },
    postcheck: postcheckDoc(3),
  });
  assert.equal(out.ok, false);
  assert.ok(out.evidence.problems.some((p) => /verify-only class started a mutation/.test(p)));
});


test("Staged postcheck derives per-stage flag checks and rejects a later-stage leak", async () => {
  const mod = await import("../../.github/scripts/activate-rental-marketplace-stages-postcheck.mjs");
  assert.deepEqual(mod.buildFlagChecks({ flags: flags({ stage: 2 }), stage: 2 }), {
    pr_a_flags_on: true,
    stage1_on: true,
    earlier_stages_on: true,
    target_stage_on: true,
    later_stages_off: true,
    outbound_off: true,
  });
  const leaky = mod.buildFlagChecks({ flags: flags({ stage: 2, later: { owner_notifications_enabled: true } }), stage: 2 });
  assert.equal(leaky.later_stages_off, false);
  const outbound = mod.buildFlagChecks({ flags: flags({ stage: 2, later: { digest_enabled: true } }), stage: 2 });
  assert.equal(outbound.outbound_off, false);
  const noStage1 = mod.buildFlagChecks({ flags: flags({ stage: 0 }), stage: 2 });
  assert.equal(noStage1.stage1_on, false);
  assert.equal(noStage1.target_stage_on, false);
  assert.throws(() => mod.buildFlagChecks({ flags: flags({ stage: 2 }), stage: 5 }), /unsupported target stage/);
});

test("Staged postcheck classifies live gates and keeps later gates closed", async () => {
  const mod = await import("../../.github/scripts/activate-rental-marketplace-stages-postcheck.mjs");
  const gatesFor = (stage, { shareRefused = stage < 3, notifyEnabled = stage >= 4 } = {}) => ({
    aggregate: { status: 200, code: "", body: { enabled: true } },
    offers: { status: stage >= 2 ? 401 : 404, code: stage >= 2 ? "" : "wish_offer_disabled", body: {} },
    shares: { status: shareRefused ? 404 : 400, code: shareRefused ? "share_disabled" : "", body: {} },
    notifications: { status: 200, code: "", body: { enabled: notifyEnabled } },
    notifications_anonymous: { status: 401, code: "", body: {} },
  });
  const s2 = mod.classifyGates({ gates: gatesFor(2), stage: 2 });
  assert.equal(s2.target_serving, true);
  assert.equal(s2.later_gates_closed, true);
  assert.equal(s2.target_signal, "wish_offer_gate_open");
  const s3 = mod.classifyGates({ gates: gatesFor(3), stage: 3 });
  assert.equal(s3.target_serving, true);
  assert.equal(s3.later_gates_closed, true);
  assert.equal(s3.target_signal, "share_v2_gate_open");
  const s4 = mod.classifyGates({ gates: gatesFor(4), stage: 4 });
  assert.equal(s4.target_serving, true);
  assert.equal(s4.later_gates_closed, true);
  assert.equal(s4.target_signal, "rental_notify_enabled");
  const s4closed = mod.classifyGates({ gates: gatesFor(4, { notifyEnabled: false }), stage: 4 });
  assert.equal(s4closed.target_serving, false);
  const s2leak = mod.classifyGates({ gates: gatesFor(2, { shareRefused: false, notifyEnabled: true }), stage: 2 });
  assert.equal(s2leak.later_gates_closed, false);
});

test("Staged postcheck redaction is fail-closed and phone detection stays boundary-anchored (P1-22)", async () => {
  const mod = await import("../../.github/scripts/activate-rental-marketplace-stages-postcheck.mjs");
  const clean = mod.buildRedactionChecks({
    gates: {
      aggregate: { status: 404, code: "owner_matching_disabled", body: { error: "x", code: "owner_matching_disabled" } },
      offers: { status: 404, code: "wish_offer_disabled", body: { error: "y", code: "wish_offer_disabled" } },
      shares: { status: 404, code: "share_disabled", body: { error: "z", code: "share_disabled" } },
      notifications: { status: 200, code: "", body: { enabled: false } },
      notifications_anonymous: { status: 401, code: "", body: {} },
    },
  });
  assert.equal(clean.probe_bodies_without_pii, true);
  assert.equal(clean.closed_gate_responses_are_opaque, true);
  assert.equal(clean.authenticated_probe_requires_session, true);

  const leaky = mod.buildRedactionChecks({
    gates: {
      offers: { status: 200, code: "", body: { owner_email: "owner@example.com", phone: "0912345678" } },
      notifications_anonymous: { status: 200, code: "", body: {} },
    },
  });
  assert.equal(leaky.probe_bodies_without_pii, false);
  assert.equal(leaky.authenticated_probe_requires_session, false);
  assert.ok(leaky.leak_report.length >= 1);

  const compact = mod.buildRedactionChecks({
    gates: { offers: { status: 200, code: "", body: { run_id: "stage2:20260918064529:35316208975" } } },
  });
  assert.equal(compact.probe_bodies_without_pii, true);

  const secret = mod.buildRedactionChecks({
    gates: { offers: { status: 200, code: "", body: { session: "SESSION_SECRET" } } },
  });
  assert.equal(secret.probe_bodies_without_pii, false);
});

