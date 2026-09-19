import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventBus, createLocalEventBus, POSTGRES_NOTIFY_SQL } from "../src/eventBus.js";
import {
  DELTA_EVENT,
  classifyDeltaEvent,
  searchMembershipChanged,
  eventRequiresRelist,
} from "../src/deltaEvents.js";

test("local event bus publishes to subscribers and unsubscribes", () => {
  const bus = createLocalEventBus();
  const seen = [];
  const off = bus.subscribe("listings", (payload) => seen.push(payload));
  bus.publish("listings", { postId: 1 });
  bus.publish("listings", { postId: 2 });
  off();
  bus.publish("listings", { postId: 3 });
  assert.deepEqual(seen, [{ postId: 1 }, { postId: 2 }]);
});

test("postgres event bus publish uses pg_notify", async () => {
  const calls = [];
  const pool = { async query(sql, params) { calls.push({ sql, params }); } };
  const bus = createEventBus({ driver: "postgres", pool });
  await bus.publish("listings", { postId: 9 });
  assert.equal(calls[0].sql, POSTGRES_NOTIFY_SQL);
  assert.deepEqual(calls[0].params, ["5151:listings", JSON.stringify({ postId: 9 })]);
  assert.match(POSTGRES_NOTIFY_SQL, /pg_notify/);
});

test("delta events classify enrichment vs membership change", () => {
  const base = { district: "士林區", total_monthly_cost: 20000, rent: 20000, kind: "電梯公寓/大樓", source: "591", offline: 0, hidden: 0, match_verdict: "", match_level: null };

  // enrichment-only (geo/route/mrt) -> patch card
  assert.equal(classifyDeltaEvent({ type: "updated", prev: base, next: { ...base, lat: 25.1 } }), DELTA_EVENT.LISTING_UPDATED);

  // price change -> membership change -> re-query
  assert.equal(classifyDeltaEvent({ type: "updated", prev: base, next: { ...base, total_monthly_cost: 25000 } }), DELTA_EVENT.SEARCH_MEMBERSHIP_CHANGED);

  // district change -> membership change
  assert.equal(classifyDeltaEvent({ type: "updated", prev: base, next: { ...base, district: "北投區" } }), DELTA_EVENT.SEARCH_MEMBERSHIP_CHANGED);

  // added / removed / commute / stats
  assert.equal(classifyDeltaEvent({ type: "added", next: base }), DELTA_EVENT.LISTING_ADDED);
  assert.equal(classifyDeltaEvent({ type: "removed", prev: base }), DELTA_EVENT.LISTING_REMOVED);
  assert.equal(classifyDeltaEvent({ type: "commute" }), DELTA_EVENT.COMMUTE_UPDATED);
  assert.equal(classifyDeltaEvent({ type: "stats" }), DELTA_EVENT.STATS_INVALIDATED);
});

test("eventRequiresRelist is true only for membership/removal/stats", () => {
  assert.equal(eventRequiresRelist(DELTA_EVENT.LISTING_UPDATED), false);
  assert.equal(eventRequiresRelist(DELTA_EVENT.COMMUTE_UPDATED), false);
  assert.equal(eventRequiresRelist(DELTA_EVENT.SEARCH_MEMBERSHIP_CHANGED), true);
  assert.equal(eventRequiresRelist(DELTA_EVENT.LISTING_ADDED), true);
  assert.equal(eventRequiresRelist(DELTA_EVENT.LISTING_REMOVED), true);
  assert.equal(eventRequiresRelist(DELTA_EVENT.STATS_INVALIDATED), true);
});

test("searchMembershipChanged treats null prev/next as changed", () => {
  assert.equal(searchMembershipChanged(null, { district: "士林區" }), true);
  assert.equal(searchMembershipChanged({ district: "士林區" }, null), true);
  assert.equal(searchMembershipChanged({ district: "士林區" }, { district: "士林區" }), false);
});
