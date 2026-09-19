import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLIENT_STATE_VERSION,
  defaultClientState,
  normalizeClientState,
  serializeClientState,
  deserializeClientState,
} from "../src/clientState.js";

test("defaultClientState includes all persisted fields", () => {
  const s = defaultClientState();
  assert.equal(s.version, CLIENT_STATE_VERSION);
  assert.equal(s.filter, "all");
  assert.deepEqual(s.district, []);
  assert.equal(s.sort, "newest");
  assert.deepEqual(s.panel, { collapsed: false, filterCompact: false });
  assert.deepEqual(s.moreCondition, { expanded: false });
  assert.equal(s.currentProfile, "");
  assert.deepEqual(s.pagination, { cursor: null, offset: 0 });
  assert.deepEqual(s.scroll, { top: 0 });
});

test("normalizeClientState coerces bad types and fills defaults", () => {
  const s = normalizeClientState({ filter: 42, district: "not-an-array", sort: "price_asc" });
  assert.equal(s.filter, "all"); // bad type -> default
  assert.deepEqual(s.district, []); // bad type -> default
  assert.equal(s.sort, "price_asc"); // valid -> kept
  assert.deepEqual(s.panel, { collapsed: false, filterCompact: false });
});

test("normalizeClientState migrates a version-less (v0) payload", () => {
  const migrated = normalizeClientState({ filter: "all", sort: "newest", cursor: "abc" });
  assert.equal(migrated.version, 1);
  assert.deepEqual(migrated.pagination, { cursor: "abc", offset: 0 });
});

test("serialize/deserialize round-trips", () => {
  const s = { filter: "all", district: ["士林區"], sort: "newest", pagination: { cursor: { updatedAt: 1, postId: 9 }, offset: 0 } };
  const json = serializeClientState(s);
  const back = deserializeClientState(json);
  assert.deepEqual(back.district, ["士林區"]);
  assert.deepEqual(back.pagination.cursor, { updatedAt: 1, postId: 9 });
});

test("deserialize of corrupt JSON returns default", () => {
  assert.deepEqual(deserializeClientState("{not json"), defaultClientState());
  assert.deepEqual(deserializeClientState(""), defaultClientState());
});
