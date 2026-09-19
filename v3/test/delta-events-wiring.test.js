import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

test("geo/route backfill emits commute_updated + stats_invalidated delta events", () => {
  const server = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  assert.match(server, /type: "commute_updated", postIds: commutePostIds, fingerprint/);
  assert.match(server, /broadcast\(\{ type: "stats_invalidated" \}\)/);
});

test("frontend SSE handles commute_updated and stats_invalidated deltas", () => {
  const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");
  assert.match(html, /data\.type === "commute_updated"[\s\S]*?refreshCommuteSnapshot\(\)/);
  assert.match(html, /data\.type === "stats_invalidated"[\s\S]*?loadList\(\{ silent: true, keep: true \}\)/);
});
