import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

test("frontend persists filter/sort/district into a versioned client state", () => {
  const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");
  assert.match(html, /CLIENT_STATE_KEY = "5151-client-state-v1"/);
  assert.match(html, /function readClientState\(\)/);
  assert.match(html, /function writeClientState\(patch\)/);
  assert.match(html, /function persistSearchState\(\)/);
  assert.match(html, /function restoreSearchState\(\)/);
  // restore on boot + persist on the three search-condition handlers.
  assert.match(html, /restoreSearchState\(\);[\s\S]*?filter = btn\.dataset\.filter;[\s\S]*?persistSearchState\(\);/);
  assert.match(html, /persistSearchState\(\);[\s\S]*?sort = btn\.dataset\.sort/);
});
