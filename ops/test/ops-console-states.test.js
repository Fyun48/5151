import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REQUIRED_STATES = ["loading", "empty", "normal", "error", "retry", "blocked", "cancelled", "unknown", "completed"];
const REQUIRED_WIDTHS = [375, 768, 1440];

test("checked-in console-states evidence is 27/27 green", () => {
  const doc = JSON.parse(readFileSync(path.join(ROOT, "ops/evidence/final-integration-20260919/ops-console-states.json"), "utf8"));
  const results = doc.results || [];
  assert.equal(results.length, REQUIRED_STATES.length * REQUIRED_WIDTHS.length, "expect 9 states x 3 widths = 27 observations");
  const seen = new Set(results.map((r) => `${r.state}@${r.width}`));
  for (const state of REQUIRED_STATES) {
    for (const width of REQUIRED_WIDTHS) {
      assert.ok(seen.has(`${state}@${width}`), `missing observation ${state}@${width}`);
    }
  }
  const failed = results.filter((r) => r.ok !== true).map((r) => `${r.state}@${r.width}`);
  assert.deepEqual(failed, [], `console states not all green: ${failed.join(", ")}`);
});
