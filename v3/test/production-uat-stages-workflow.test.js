import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WF_NAME = "production-uat-stages-functional.yml";
const DOMAIN = path.join(root, ".github/scripts/production-uat-stages-domain.mjs");
const WIRING = path.join(root, ".github/scripts/production-uat-stages-wiring.mjs");
const REMOTE = path.join(root, ".github/scripts/production-uat-stages-remote.sh");

function readText(target) {
  return readFileSync(target, "utf8").replace(/\r\n/g, "\n");
}

function wf(name) {
  return readText(path.join(root, ".github/workflows", name));
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
  return step
    .slice(runIdx + marker.length)
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n")
    .replace(/\s+$/, "");
}

const SHA = "e4ced0018f1994640ca7da02014cabfbfb6d8445";
const DIGEST = `sha256:${"d209658c".padEnd(64, "0")}`;
const BACKUP = "/DATA/AppData/591-tracker-v3-backups/predeploy-20260918-063424";
const BACKUP_HASH = `sha256:${"bbd31a04".padEnd(64, "0")}`;
const AUTH = `AUTHORIZE-UAT-STAGE1-4:${SHA}:${DIGEST}:${BACKUP}:${BACKUP_HASH}`;

function authorizeScript() {
  return pipeRunScript(namedStep(wf(WF_NAME), "Authorize production UAT (fail-closed)"));
}

function good(overrides = {}) {
  return {
    WF_REF: "refs/heads/master",
    ACTOR: "Fyun48",
    TRIGGERING_ACTOR: "Fyun48",
    ALLOWED_ACTOR: "Fyun48",
    CONFIRM: "UAT-STAGE1-4-PRODUCTION",
    OWNER_AUTHORIZATION: AUTH,
    SOURCE_SHA: SHA,
    IMAGE_DIGEST: DIGEST,
    BACKUP_ID: BACKUP,
    BACKUP_HASH: BACKUP_HASH,
    ...overrides,
  };
}

function runAuthorize(env) {
  const dir = mkdtempSync(path.join(tmpdir(), "uat-auth-"));
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


test("Production UAT is workflow_dispatch only and accepts the bound authorization", () => {
  const text = wf(WF_NAME);
  const on = onBlock(text);
  assert.match(on, /workflow_dispatch:/);
  assert.ok(!/^\s{2}(push|pull_request|schedule):/m.test(on), "the UAT must not run automatically");
  assert.match(text, /group: production-deploy/);
  assert.match(text, /environment: production/);
  const out = runAuthorize(good());
  assert.match(out, /authorized=true/);
});

test("Production UAT authorization fails closed on every mismatch", () => {
  const cases = [
    [{ WF_REF: "refs/heads/cursor/x" }, /must run from the master workflow definition/],
    [{ ALLOWED_ACTOR: "" }, /PRODUCTION_DEPLOY_ALLOWED_ACTOR is not configured/],
    [{ ACTOR: "cursor" }, /is not the authorized deployer/],
    [{ TRIGGERING_ACTOR: "cursor" }, /is not the authorized deployer/],
    [{ CONFIRM: "ACTIVATE-STAGE4-PRODUCTION" }, /confirmation must be exactly UAT-STAGE1-4-PRODUCTION/],
    [{ SOURCE_SHA: "abc" }, /source_sha must be a full 40-character commit SHA/],
    [{ IMAGE_DIGEST: "latest" }, /image_digest must be exactly sha256:/],
    [{ BACKUP_HASH: "sha256:short" }, /backup_hash must be exactly sha256:/],
    [{ OWNER_AUTHORIZATION: AUTH.replace("UAT-STAGE1-4", "UAT-STAGE2-4") }, /owner_authorization must be exactly AUTHORIZE-UAT-STAGE1-4/],
    [{ OWNER_AUTHORIZATION: AUTH.replace(BACKUP, "/DATA/AppData/591-tracker-v3-backups/predeploy-20260101-000000") }, /owner_authorization must be exactly AUTHORIZE-UAT-STAGE1-4/],
  ];
  for (const [override, pattern] of cases) {
    assert.throws(() => runAuthorize(good(override)), pattern, JSON.stringify(override));
  }
});

test("Production UAT remote pins identity, runs in the container and pulls evidence", () => {
  const remote = readText(REMOTE);
  assert.match(remote, /CONTAINER="\$\{CONTAINER:-591-tracker-v3\}"/);
  assert.match(remote, /EXPECTED_SRC_MOUNT/);
  assert.match(remote, /\[ "\$OCI_REVISION" = "\$SOURCE_SHA" \]/);
  assert.match(remote, /running image is not the expected digest/);
  assert.match(remote, /docker cp "\$DOMAIN_SCRIPT" "\$CONTAINER:/);
  assert.match(remote, /docker cp "\$WIRING_SCRIPT" "\$CONTAINER:/);
  assert.match(remote, /docker exec -w \/app/);
  assert.match(remote, /docker cp "\$CONTAINER:\$CONTAINER_DIR\/evidence.json"/);
  assert.match(remote, /docker exec "\$CONTAINER" rm -rf "\$CONTAINER_DIR"/);
  // The UAT must never deploy, restart or write flags.
  assert.ok(!/docker (compose|restart|stop|rm )/.test(remote), "the UAT must not restart or recreate the container");
  assert.ok(!/saveRentalMarketplaceFlags|writeSettingKey/.test(remote), "the UAT must not write flags");
  execFileSync("bash", ["-c", `bash -n ${JSON.stringify(REMOTE)}`], { encoding: "utf8" });
});

test("Production UAT wiring imports the domain sibling and never writes flags", () => {
  const wiring = readText(WIRING);
  assert.match(wiring, /from "\.\/production-uat-stages-domain\.mjs"/);
  assert.match(wiring, /createUatFixtures/);
  assert.match(wiring, /cleanupUatFixtures/);
  assert.match(wiring, /doc\.problems\.push\(`fixture cleanup failed/);
  assert.match(wiring, /doc\.conclusion = ""/);
  assert.ok(!/saveRentalMarketplaceFlags|writeSettingKey/.test(wiring), "the UAT must not write flags");
  assert.match(readText(DOMAIN), /ISSUE333_FINAL_UAT_PASS/);
});

test("Production UAT conclusion fails closed on the evidence document", () => {
  const conclude = pipeRunScript(namedStep(wf(WF_NAME), "Conclude the UAT (fail-closed)"));
  assert.match(conclude, /refusing PASS/);
  assert.match(conclude, /doc\.get\("problems"\)/);
  assert.match(conclude, /flags_mutated/);
  assert.match(conclude, /ISSUE333_FINAL_UAT_PASS/);
  assert.match(conclude, /cleanup was not verified|cleanup\.get\("ok"\) is not True/);
  for (const key of ["owner_matching_enabled", "offer_enabled", "public_share_v2_enabled", "owner_notifications_enabled", "notifications_enabled"]) {
    assert.ok(conclude.includes(key), `conclusion must assert ${key}`);
  }
  for (const key of ["digest_enabled", "outbound_mail_enabled", "outbound_push_enabled"]) {
    assert.ok(conclude.includes(key), `conclusion must assert ${key}`);
  }
});
