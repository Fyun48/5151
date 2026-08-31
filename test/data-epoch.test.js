import { test } from "node:test";
import assert from "node:assert/strict";
import { DATA_EPOCH, shouldResetForEpoch } from "../src/dataEpoch.js";

test("missing epoch does not wipe existing data", () => {
  assert.equal(shouldResetForEpoch("", DATA_EPOCH), false);
  assert.equal(shouldResetForEpoch(null, DATA_EPOCH), false);
});

test("matching epoch does not wipe", () => {
  assert.equal(shouldResetForEpoch(DATA_EPOCH, DATA_EPOCH), false);
});

test("a different non-empty epoch still wipes", () => {
  assert.equal(shouldResetForEpoch("wipe-old", DATA_EPOCH), true);
});
