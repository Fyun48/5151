import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(dir, "../public/console.html"), "utf8");
const js = readFileSync(path.join(dir, "../public/console.js"), "utf8");

test("console covers inbox, issues, gates and webhook test", () => {
  assert.match(html, /回饋收件匣/);
  assert.match(html, /議題與投票/);
  assert.match(html, /核准開發/);
  assert.match(html, /測試 webhook/);
  assert.doesNotMatch(html, /Phase 1（骨架/);
  assert.match(js, /\/ops\/api\/dashboard/);
  assert.match(js, /\/ops\/api\/feedback/);
  assert.match(js, /\/ops\/api\/notify\/test/);
  assert.match(html, /APPROVE_DEVELOPMENT/);
});
