import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WF_NAME = "prepare-rental-marketplace-stage1-fixtures.yml";

function wf(name = WF_NAME) {
  return readFileSync(path.join(root, ".github/workflows", name), "utf8");
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
  return pipeRunScript(namedStep(wf(), "Authorize Stage 1 fixture operation (fail-closed)"));
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
  CONFIRM: "STAGE1-FIXTURES-PRODUCTION",
  FIXTURE_MODE: "verify",
  SOURCE_SHA: "b9c6347660defb26cbc3948b1ed8c65725793a7a",
  IMAGE_DIGEST: "sha256:eb90e49ca1fe8caff155d47cec865f26fbb345b3402246a2d9235f1bdc7dd8aa",
  BACKUP_ID: "/DATA/AppData/591-tracker-v3-backups/predeploy-20260917-105925",
  BACKUP_HASH: "sha256:4fab759ab6ffb1daa2a607e4dc0e597007b9e9017be31d5c10db356053c9f6e3",
  OWNER_AUTHORIZATION: "AUTHORIZE-STAGE1-FIXTURES:verify:b9c6347660defb26cbc3948b1ed8c65725793a7a:sha256:eb90e49ca1fe8caff155d47cec865f26fbb345b3402246a2d9235f1bdc7dd8aa:/DATA/AppData/591-tracker-v3-backups/predeploy-20260917-105925:sha256:4fab759ab6ffb1daa2a607e4dc0e597007b9e9017be31d5c10db356053c9f6e3",
};

test("Stage 1 fixture workflow remains workflow_dispatch only", () => {
  const text = wf();
  const block = onBlock(text);
  assert.match(block, /workflow_dispatch:/);
  assert.doesNotMatch(block, /(^|\n)\s*push:/);
  assert.doesNotMatch(block, /(^|\n)\s*pull_request:/);
  assert.doesNotMatch(block, /(^|\n)\s*schedule:/);
  assert.match(text, /group: production-deploy/);
  assert.match(text, /cancel-in-progress:\s*false/);
  assert.match(text, /environment: production/);
});

test("Stage 1 fixture authorize is owner-bound and mode-bound", () => {
  runAuthorize(GOOD);
  assert.throws(() => runAuthorize({ ...GOOD, CONFIRM: "ACTIVATE-STAGE1-PRODUCTION" }), /STAGE1-FIXTURES-PRODUCTION/);
  assert.throws(() => runAuthorize({ ...GOOD, ACTOR: "cursor", TRIGGERING_ACTOR: "cursor[bot]" }), /not a durable Production fixture operator|not the authorized deployer/);
  assert.throws(() => runAuthorize({ ...GOOD, FIXTURE_MODE: "activate" }), /prepare, verify, cleanup, or reap-stale/);
  assert.throws(
    () => runAuthorize({ ...GOOD, OWNER_AUTHORIZATION: GOOD.OWNER_AUTHORIZATION.replace(":verify:", ":prepare:") }),
    /AUTHORIZE-STAGE1-FIXTURES/,
  );
});

test("Stage 1 fixture helpers never mutate flags or deploy", () => {
  const remote = readFileSync(path.join(root, ".github/scripts/stage1-fixture-remote.sh"), "utf8");
  const domain = readFileSync(path.join(root, ".github/scripts/stage1-fixture-domain.mjs"), "utf8");
  const text = wf();
  for (const blob of [remote, domain, text]) {
    assert.doesNotMatch(blob, /saveRentalMarketplaceFlags/);
    assert.doesNotMatch(blob, /owner_matching_enabled:\s*true/);
    assert.doesNotMatch(blob, /DEPLOY-PRODUCTION/);
    assert.doesNotMatch(blob, /docker\s+pull\b/);
    assert.doesNotMatch(blob, /compose\s+up/);
  }
  const pull = namedStep(text, "Pull NAS fixture evidence");
  const authorize = namedStep(text, "Authorize Stage 1 fixture operation (fail-closed)");
  assert.match(authorize, /id: authorize/);
  assert.match(authorize, /authorized=true/);
  assert.match(pull, /always\(\)/);
  assert.match(pull, /steps.authorize.outputs.authorized == 'true'/);
  assert.match(pull, /steps.operate.outcome/);
  assert.match(namedStep(text, "Write Stage 1 fixture evidence"), /if: \$\{\{ always\(\) \}\}/);
});

test("P1-5 unauthorized fixture actor cannot take the NAS evidence pull path", () => {
  const text = wf();
  assert.match(namedStep(text, "Pull NAS fixture evidence"), /NAS_SSH_KEY/);
  assert.match(namedStep(text, "Pull NAS fixture evidence"), /steps.authorize.outputs.authorized == 'true'/);
  assert.doesNotMatch(namedStep(text, "Write Stage 1 fixture evidence"), /NAS_SSH_KEY/);
  assert.doesNotMatch(namedStep(text, "Copy Stage 1 fixture helpers to NAS /tmp"), /if: \$\{\{ always\(\) \}\}/);
  assert.doesNotMatch(namedStep(text, "Run Stage 1 fixture operation on running v3"), /if: \$\{\{ always\(\) \}\}/);
  assert.throws(() => runAuthorize({ ...GOOD, ACTOR: "cursor", TRIGGERING_ACTOR: "cursor[bot]" }), /not a durable Production fixture operator|not the authorized deployer/);
  assert.throws(() => runAuthorize({ ...GOOD, CONFIRM: "NO" }), /STAGE1-FIXTURES-PRODUCTION/);
  assert.throws(
    () => runAuthorize({ ...GOOD, OWNER_AUTHORIZATION: GOOD.OWNER_AUTHORIZATION.replace(":verify:", ":prepare:") }),
    /AUTHORIZE-STAGE1-FIXTURES/,
  );
});
