import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 靜態檢查 Deploy OPS：只同步 ops/、只重建 5151-ops，不得變成 v3 第四條路徑。

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, ".github/workflows/deploy-ops.yml");
const text = () => readFileSync(file, "utf8");

function onBlock(src) {
  const m = src.match(/\non:\n([\s\S]*?)\n[a-zA-Z]/);
  return m ? m[1] : "";
}

test("deploy-ops.yml exists and is dispatch-only", () => {
  assert.equal(existsSync(file), true);
  const src = text();
  const block = onBlock(src);
  assert.match(block, /workflow_dispatch:/);
  assert.doesNotMatch(block, /(^|\n)\s*push:/);
  assert.doesNotMatch(block, /(^|\n)\s*pull_request:/);
});

test("deploy-ops requires master workflow ref, SHA ancestry, and DEPLOY-OPS", () => {
  const src = text();
  assert.match(src, /WF_REF:\s*\$\{\{\s*github\.ref\s*\}\}/);
  assert.match(src, /"\$WF_REF"\s*!=\s*"refs\/heads\/master"/);
  assert.match(src, /\[0-9a-f\]\{40\}/);
  assert.match(src, /merge-base --is-ancestor "\$DEPLOY_SHA" origin\/master/);
  assert.match(src, /git checkout --force "\$DEPLOY_SHA"/);
  assert.match(src, /"\$\{CONFIRM:-\}"\s*!=\s*"DEPLOY-OPS"/);
  assert.doesNotMatch(src, /"\$\{CONFIRM:-\}"\s*!=\s*"DEPLOY-PRODUCTION"/);
  assert.doesNotMatch(src, /inputs:\s*[\s\S]*image_digest:/);
});

test("deploy-ops uses the same allowlist and checks both actors", () => {
  const src = text();
  assert.match(src, /vars\.PRODUCTION_DEPLOY_ALLOWED_ACTOR/);
  assert.match(src, /-z\s*"\$\{ALLOWED_ACTOR:-\}"/);
  assert.match(src, /ACTOR:\s*\$\{\{\s*github\.actor\s*\}\}/);
  assert.match(src, /TRIGGERING_ACTOR:\s*\$\{\{\s*github\.triggering_actor\s*\}\}/);
  assert.match(src, /"\$ACTOR"\s*!=\s*"\$ALLOWED_ACTOR"/);
  assert.match(src, /"\$TRIGGERING_ACTOR"\s*!=\s*"\$ALLOWED_ACTOR"/);
});

test("deploy-ops concurrency is ops-deploy, not production-deploy", () => {
  const src = text();
  assert.match(src, /concurrency:\s*\n\s*group:\s*ops-deploy/);
  assert.match(src, /cancel-in-progress:\s*false/);
  assert.doesNotMatch(src, /group:\s*production-deploy/);
});

test("deploy-ops copies only ops/ and recreates only 5151-ops", () => {
  const src = text();
  assert.match(src, /source:\s*"ops"/);
  assert.match(src, /up -d --no-build --no-deps --force-recreate 5151-ops/);
  assert.match(src, /127\.0\.0\.1:5154\/ops\/api\/health/);
  assert.doesNotMatch(src, /source:\s*"[^"]*v3\//);
  assert.doesNotMatch(src, /force-recreate 591-tracker-v3/);
  assert.doesNotMatch(src, /force-recreate 591-tracker-v2/);
  assert.doesNotMatch(src, /docker compose[^\n]*up[^\n]*591-tracker/);
});

test("deploy-ops authorize precedes NAS secrets; production env; read-only contents", () => {
  const src = text();
  const authIdx = src.indexOf("Authorize OPS deployment");
  assert.ok(authIdx > 0);
  const nasIdx = src.indexOf("secrets.NAS_");
  assert.ok(nasIdx > authIdx);
  assert.match(src, /environment:\s*production/);
  assert.match(src, /contents:\s*read/);
  assert.doesNotMatch(src, /contents:\s*write/);
  assert.doesNotMatch(src, /packages:\s*write/);
});

test("deploy-safety PROD list does not treat deploy-ops as a v3 production path", () => {
  const safety = readFileSync(path.join(root, "test/deploy-safety.test.js"), "utf8");
  assert.match(safety, /const PROD = \["deploy-v3\.yml", "docker\.yml", "deploy-v2\.yml"\]/);
  assert.doesNotMatch(safety, /deploy-ops\.yml/);
});
