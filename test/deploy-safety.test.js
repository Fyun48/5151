import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Phase 3.5 — Production Deployment Safety Gate 的守護測試。
// 目的：確保「合併/push 到 master」不會自動部署正式站；正式部署一律需明確 workflow_dispatch。
// 這是靜態的 workflow 檢查（讀 .github/workflows/*.yml 文字），不觸發任何實際部署。

const dir = path.dirname(fileURLToPath(import.meta.url));
const wf = (name) => readFileSync(path.join(dir, "..", ".github", "workflows", name), "utf8");

// 取出 `on:` 區塊（到下一個頂層鍵之前）。
function onBlock(text) {
  const m = text.match(/\non:\n([\s\S]*?)\n[a-zA-Z]/);
  return m ? m[1] : "";
}

const PROD_DEPLOY_WORKFLOWS = ["deploy-v3.yml", "docker.yml", "deploy-v2.yml", "deploy.yml"];

test("production-capable workflows are NOT triggered by push/PR", () => {
  for (const name of PROD_DEPLOY_WORKFLOWS) {
    const block = onBlock(wf(name));
    assert.doesNotMatch(block, /(^|\n)\s*push:/, `${name} must not trigger on push`);
    assert.doesNotMatch(block, /(^|\n)\s*pull_request:/, `${name} must not trigger on pull_request`);
    assert.match(block, /workflow_dispatch:/, `${name} must be manually dispatchable`);
  }
});

test("production deploy workflows require an explicit ref input and production environment", () => {
  for (const name of PROD_DEPLOY_WORKFLOWS) {
    const text = wf(name);
    assert.match(text, /inputs:\s*\n\s*ref:/, `${name} should accept an explicit ref input`);
    assert.match(text, /environment:\s*production/, `${name} should bind Production secrets to the 'production' environment`);
    assert.match(text, /ref:\s*\$\{\{\s*inputs\.ref\s*\}\}/, `${name} should checkout the requested ref`);
  }
});

test("merge/CI workflow does not trigger any production deploy", () => {
  const text = wf("test.yml");
  assert.doesNotMatch(text, /gh workflow run deploy/, "test.yml must not trigger deploy workflows");
  assert.doesNotMatch(text, /appleboy\/(scp|ssh)-action/, "test.yml must not SCP/SSH to production");
  assert.match(text, /npm test/, "test.yml must still run tests automatically");
});

test("normal CI (test.yml) does not reference production/NAS secrets", () => {
  const text = wf("test.yml");
  assert.doesNotMatch(text, /secrets\.NAS_/, "normal CI must not have access to NAS/production secrets");
  assert.doesNotMatch(text, /NAS_SSH_KEY|NAS_HOST/, "normal CI must not reference production SSH/host secrets");
});

test("production secrets stay only in production-capable, manually-dispatched workflows", () => {
  for (const name of PROD_DEPLOY_WORKFLOWS) {
    const text = wf(name);
    if (text.includes("secrets.NAS_")) {
      // 使用 NAS 密鑰者必須是 workflow_dispatch + production environment
      assert.match(onBlock(text), /workflow_dispatch:/, `${name} uses NAS secrets → must be manual`);
      assert.match(text, /environment:\s*production/, `${name} uses NAS secrets → must scope to production environment`);
    }
  }
});
