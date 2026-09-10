import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Phase 3.5 / 3.5.1 — Production Deployment Safety Gate 的守護測試。
// 目的：確保「合併/push 到 master」不會自動部署；正式部署一律需明確 workflow_dispatch，
// 且必須通過 fail-closed 授權（master 定義、部署者 allowlist、確認字串、不可變 SHA、master 祖先驗證、並發鎖）。
// 這是靜態 workflow 檢查（讀 .github/workflows/*.yml 文字），不觸發任何實際部署。

const dir = path.dirname(fileURLToPath(import.meta.url));
const wf = (name) => readFileSync(path.join(dir, "..", ".github", "workflows", name), "utf8");

function onBlock(text) {
  const m = text.match(/\non:\n([\s\S]*?)\n[a-zA-Z]/);
  return m ? m[1] : "";
}

const PROD = ["deploy-v3.yml", "docker.yml", "deploy-v2.yml"];

test("1. production workflows are dispatch-only (no push/pull_request)", () => {
  for (const name of PROD) {
    const block = onBlock(wf(name));
    assert.doesNotMatch(block, /(^|\n)\s*push:/, `${name} must not trigger on push`);
    assert.doesNotMatch(block, /(^|\n)\s*pull_request:/, `${name} must not trigger on pull_request`);
    assert.match(block, /workflow_dispatch:/, `${name} must be manually dispatchable`);
  }
});

test("2. deployment refuses to run unless launched from master workflow definition", () => {
  for (const name of PROD) {
    const text = wf(name);
    assert.match(text, /WF_REF:\s*\$\{\{\s*github\.ref\s*\}\}/, `${name} should read github.ref`);
    assert.match(text, /"\$WF_REF"\s*!=\s*"refs\/heads\/master"/, `${name} must reject non-master workflow ref`);
  }
});

test("3+4. explicit deployer allowlist checked; missing config fails closed; wrong actor rejected", () => {
  for (const name of PROD) {
    const text = wf(name);
    assert.match(text, /vars\.PRODUCTION_DEPLOY_ALLOWED_ACTOR/, `${name} must consult the allowlist variable`);
    assert.match(text, /-z\s*"\$\{ALLOWED_ACTOR:-\}"/, `${name} must fail closed when allowlist unset`);
    assert.match(text, /"\$ACTOR"\s*!=\s*"\$ALLOWED_ACTOR"/, `${name} must reject non-allowed actor`);
  }
});

// Phase 3.5.2：re-run 時 github.actor 仍是初始觸發者，須同時檢查 github.triggering_actor，
// 以免他人 re-run Owner 建立的 workflow 而繞過授權。
test("3.5.2 both github.actor and github.triggering_actor must match the allowlist", () => {
  for (const name of PROD) {
    const text = wf(name);
    assert.match(text, /TRIGGERING_ACTOR:\s*\$\{\{\s*github\.triggering_actor\s*\}\}/, `${name} must read github.triggering_actor`);
    assert.match(text, /ACTOR:\s*\$\{\{\s*github\.actor\s*\}\}/, `${name} must read github.actor`);
    assert.match(text, /"\$TRIGGERING_ACTOR"\s*!=\s*"\$ALLOWED_ACTOR"/, `${name} must reject re-run by a non-allowed triggering actor`);
    assert.match(text, /"\$ACTOR"\s*!=\s*"\$ALLOWED_ACTOR"/, `${name} must reject non-allowed initial actor`);
  }
});

test("6. exact confirmation value DEPLOY-PRODUCTION is required", () => {
  for (const name of PROD) {
    const text = wf(name);
    assert.match(text, /inputs:\s*[\s\S]*confirmation:/, `${name} must have a confirmation input`);
    assert.match(text, /"\$\{CONFIRM:-\}"\s*!=\s*"DEPLOY-PRODUCTION"/, `${name} must require exact confirmation`);
  }
});

test("7. deployment target must be a full 40-char commit SHA", () => {
  for (const name of PROD) {
    const text = wf(name);
    assert.match(text, /inputs:\s*[\s\S]*sha:/, `${name} must accept a sha input`);
    assert.match(text, /\[0-9a-f\]\{40\}/, `${name} must validate 40-char SHA format`);
    // 不得以移動式分支名作為部署目標輸入
    assert.doesNotMatch(text, /ref:\s*\$\{\{\s*inputs\.ref\s*\}\}/, `${name} must not deploy a moving ref input`);
  }
});

test("8+9. deployment SHA must be an ancestor of origin/master (unmerged feature commit refused)", () => {
  for (const name of PROD) {
    const text = wf(name);
    assert.match(text, /merge-base --is-ancestor "\$DEPLOY_SHA" origin\/master/, `${name} must verify master ancestry`);
    assert.match(text, /git checkout --force "\$DEPLOY_SHA"/, `${name} must check out the validated commit`);
  }
});

test("10. production deployments share a serial concurrency lock", () => {
  for (const name of PROD) {
    const text = wf(name);
    assert.match(text, /concurrency:\s*\n\s*group:\s*production-deploy/, `${name} must use the production-deploy concurrency group`);
    assert.match(text, /cancel-in-progress:\s*false/, `${name} must not cancel in-progress deploys`);
  }
});

test("11. normal CI (test.yml) does not reference NAS/production secrets and does not deploy", () => {
  const text = wf("test.yml");
  assert.doesNotMatch(text, /secrets\.NAS_/);
  assert.doesNotMatch(text, /gh workflow run deploy/);
  assert.doesNotMatch(text, /appleboy\/(scp|ssh)-action/);
  assert.match(text, /npm test/);
});

test("12. production workflows declare minimal permissions (no contents: write)", () => {
  for (const name of PROD) {
    const text = wf(name);
    assert.match(text, /permissions:/, `${name} must declare explicit permissions`);
    assert.match(text, /contents:\s*read/, `${name} should use contents: read`);
    assert.doesNotMatch(text, /contents:\s*write/, `${name} must not request contents: write`);
  }
  // docker 需要 packages: write 才能推映像；其餘不得有
  assert.match(wf("docker.yml"), /packages:\s*write/);
  for (const name of ["deploy-v3.yml", "deploy-v2.yml"]) {
    assert.doesNotMatch(wf(name), /packages:\s*write/, `${name} should not request packages: write`);
  }
});

test("13. production secrets only referenced by dispatch-only production workflows bound to production env", () => {
  for (const name of PROD) {
    const text = wf(name);
    if (text.includes("secrets.NAS_")) {
      assert.match(onBlock(text), /workflow_dispatch:/, `${name} uses NAS secrets → must be manual`);
      assert.match(text, /environment:\s*production/, `${name} uses NAS secrets → must bind production environment`);
    }
  }
});

test("authorize step runs before any SCP/SSH/secret access (fail-closed ordering)", () => {
  for (const name of PROD) {
    const text = wf(name);
    const authIdx = text.indexOf("Authorize production deployment");
    assert.ok(authIdx > 0, `${name} must have an authorize step`);
    const scpIdx = text.search(/appleboy\/(scp|ssh)-action|build-push-action/);
    if (scpIdx > 0) assert.ok(authIdx < scpIdx, `${name} authorize must precede any production action`);
    const nasIdx = text.indexOf("secrets.NAS_");
    if (nasIdx > 0) assert.ok(authIdx < nasIdx, `${name} authorize must precede NAS secret usage`);
  }
});
