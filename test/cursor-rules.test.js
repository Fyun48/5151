import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Cursor UI routing rules and ui-ux-pro-max skill are in the repo", () => {
  const rules = [
    ".cursor/rules/agent-routing.mdc",
    ".cursor/rules/ui-ux-workflow.mdc",
    ".cursor/rules/frontend-design-compliance.mdc",
  ];
  for (const rel of rules) {
    assert.equal(existsSync(path.join(root, rel)), true, rel);
  }
  const skill = readFileSync(path.join(root, ".cursor/skills/ui-ux-pro-max/SKILL.md"), "utf8");
  assert.match(skill, /^name:\s*ui-ux-pro-max/m);
  const routing = readFileSync(path.join(root, ".cursor/rules/agent-routing.mdc"), "utf8");
  assert.match(routing, /alwaysApply:\s*true/);
  assert.match(routing, /Playwright/);
  const workflow = readFileSync(path.join(root, ".cursor/rules/ui-ux-workflow.mdc"), "utf8");
  assert.match(workflow, /alwaysApply:\s*false/);
  assert.match(workflow, /ui-ux-pro-max/);
  const compliance = readFileSync(path.join(root, ".cursor/rules/frontend-design-compliance.mdc"), "utf8");
  assert.match(compliance, /v3\/public/);
});

test("property-platform MASTER forbids hero marketing defaults", () => {
  const master = readFileSync(path.join(root, "design-system/property-platform/MASTER.md"), "utf8");
  assert.match(master, /Quiet Luxury Property Intelligence/);
  assert.match(master, /滿版 Hero/);
  assert.match(master, /玻璃擬態/);
  assert.match(master, /v3\/public/);
  assert.equal(existsSync(path.join(root, "design-system/property-platform/pages/listings.md")), true);
});
