import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPublicKitPath, publicPath } from "../src/auth.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

test("v3 tokens.css is the CasaOS regret path and does not fetch OPS", () => {
  const tokens = readFileSync(path.join(dir, "../public/tokens.css"), "utf8");
  assert.match(tokens, /:root\s*\{/);
  assert.match(tokens, /--bg:\s*#f3efe8/);
  assert.match(tokens, /--paper:\s*#faf8f4/);
  assert.match(tokens, /--accent:\s*#0f6f6a/);
  assert.doesNotMatch(tokens, /@import/);
  assert.doesNotMatch(tokens, /localhost:5154/);
  assert.doesNotMatch(tokens, /c5151\.reversalplay\.me/);
  assert.match(tokens, /第 9 包反悔路徑/);
});

test("guest pages may load kit snapshots but not arbitrary kit paths", () => {
  assert.equal(publicPath({ path: "/tokens.css" }), true);
  assert.equal(isPublicKitPath("/kit/tokens.css"), true);
  assert.equal(isPublicKitPath("/kit/themes/v3.css"), true);
  assert.equal(publicPath({ path: "/kit/tokens.css" }), true);
  assert.equal(isPublicKitPath("/kit/../admin.html"), false);
  assert.equal(isPublicKitPath("/kit/secret.js"), false);
  assert.equal(publicPath({ path: "/kit/../admin.html" }), false);
});
