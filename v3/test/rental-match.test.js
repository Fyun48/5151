import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultCatalog, deleteOrDisableCondition, upsertCondition } from "../src/rentalCatalog.js";
import {
  applyMatchCursor,
  clearMatchPageCursors,
  compareMatchRank,
  defaultMatchRulesPublic,
  encodeMatchCursor,
  evaluateCounterfactualMatch,
  evaluateMatch,
  expireMatchPageCursor,
  freshnessScoreFrom,
  isCounterfactuallyMatchable,
  inspectMatchCursorPayload,
  inspectMatchCursorState,
  isListingMatchable,
  isMatchingConditionActive,
  isWishMatchable,
  listingMatchSnapshot,
  MATCH_QUALITY_WEIGHTS,
  MATCH_SNAPSHOT_ITEMS_MAX,
  MATCH_SNAPSHOT_MAX,
  RANK_WEIGHTS,
  wishMatchSnapshot,
} from "../src/rentalMatch.js";

function listing(extra = {}) {
  return {
    id: 2100000001,
    owner_id: 1,
    status: "open",
    source: "self",
    rent: 22000,
    districts: ["1-8"],
    district_labels: ["台北市士林區"],
    rooms: 2,
    ping: 18,
    housing_type: "whole",
    listing_values: {
      need_pet: "allowed",
      need_cook: "allowed",
      need_tax: "unknown",
      elevator: "present",
    },
    ...extra,
  };
}

function wish(extra = {}) {
  return {
    id: 1,
    public_token: "a".repeat(32),
    lifecycle: "active",
    status: "open",
    districts: ["1-8"],
    district_labels: ["台北市士林區"],
    rent_min: 15000,
    rent_max: 28000,
    layout: "2",
    ping_min: 12,
    housing_type: "whole",
    choices: { need_pet: "want", need_cook: "want", elevator: "want" },
    last_confirmed_at: "2026-09-16T00:00:00.000Z",
    updated_at: "2026-09-16T00:00:00.000Z",
    ...extra,
  };
}

const now = Date.parse("2026-09-16T08:00:00.000Z");

test("district pass and fail are deterministic", () => {
  const catalog = defaultCatalog();
  const pass = evaluateMatch(listing(), wish(), { catalog, now });
  assert.equal(pass.eligible, true);
  assert.ok(pass.matched_conditions.includes("district"));
  const fail = evaluateMatch(listing({ districts: ["1-9"] }), wish(), { catalog, now });
  assert.equal(fail.eligible, false);
  assert.ok(fail.hard_conflicts.some((row) => row.code === "district"));
});

test("budget over wish max is hard conflict; missing rent is excluded", () => {
  const catalog = defaultCatalog();
  const over = evaluateMatch(listing({ rent: 40000 }), wish(), { catalog, now });
  assert.equal(over.eligible, false);
  assert.ok(over.hard_conflicts.some((row) => row.code === "budget"));
  const missing = evaluateMatch(listing({ rent: 0 }), wish(), { catalog, now });
  assert.equal(missing.eligible, false);
  assert.ok(missing.hard_conflicts.some((row) => row.code === "budget_unknown"));
});

test("pet allowed / not_allowed / unknown follow catalog polarity", () => {
  const catalog = defaultCatalog();
  const allowed = evaluateMatch(listing(), wish(), { catalog, now });
  assert.equal(allowed.eligible, true);
  assert.ok(allowed.matched_conditions.includes("need_pet"));
  const banned = evaluateMatch(listing({ listing_values: { ...listing().listing_values, need_pet: "not_allowed" } }), wish(), { catalog, now });
  assert.equal(banned.eligible, false);
  assert.ok(banned.hard_conflicts.some((row) => row.code === "condition:need_pet"));
  const unknown = evaluateMatch(listing({ listing_values: { ...listing().listing_values, need_pet: "unknown" } }), wish(), { catalog, now });
  assert.equal(unknown.eligible, true);
  assert.ok(unknown.unmet_unknowns.includes("need_pet"));
  assert.ok(!unknown.matched_conditions.includes("need_pet"));
});

test("cooking and tax polarity match catalog compatibility", () => {
  const catalog = defaultCatalog();
  const cookConflict = evaluateMatch(
    listing({ listing_values: { ...listing().listing_values, need_cook: "not_allowed" } }),
    wish(),
    { catalog, now },
  );
  assert.equal(cookConflict.eligible, false);
  const taxUnknown = evaluateMatch(listing(), wish({ choices: { ...wish().choices, need_tax: "want" } }), { catalog, now });
  assert.equal(taxUnknown.eligible, true);
  assert.ok(taxUnknown.unmet_unknowns.includes("need_tax"));
});

test("wish avoid conflicts when listing has the feature; unknown is not safe negative", () => {
  const catalog = defaultCatalog();
  const avoidParking = wish({ choices: { parking_car: "avoid" } });
  const hasParking = evaluateMatch(listing({ listing_values: { ...listing().listing_values, parking_car: "present" } }), avoidParking, { catalog, now });
  assert.equal(hasParking.eligible, false);
  const unknownParking = evaluateMatch(listing(), avoidParking, { catalog, now });
  assert.equal(unknownParking.eligible, true);
  assert.ok(unknownParking.unmet_unknowns.includes("parking_car"));
});

test("unspecified wish action is ignored and never treated as compatible", () => {
  const catalog = defaultCatalog();
  const result = evaluateMatch(listing(), wish({ choices: { elevator: "unspecified", need_pet: "want" } }), { catalog, now });
  assert.equal(result.eligible, true);
  assert.ok(!result.matched_conditions.includes("elevator"));
});

test("disabled matching condition is not used as new matching input", () => {
  let catalog = upsertCondition(defaultCatalog(), { label: "烘衣機", category_id: "appliance", matching_enabled: true });
  const dryer = catalog.conditions.find((row) => row.id === "dryer" || row.label === "烘衣機");
  const before = evaluateMatch(
    listing({ listing_values: { ...listing().listing_values, [dryer.id]: "absent" } }),
    wish({ choices: { ...wish().choices, [dryer.id]: "want" } }),
    { catalog, now },
  );
  assert.equal(before.eligible, false);
  catalog = deleteOrDisableCondition(catalog, dryer.id, { wish: 1 }).catalog;
  const disabled = catalog.conditions.find((row) => row.id === dryer.id);
  assert.equal(isMatchingConditionActive(disabled, catalog.categories), false);
  const after = evaluateMatch(
    listing({ listing_values: { ...listing().listing_values, [dryer.id]: "absent" } }),
    wish({ choices: { ...wish().choices, [dryer.id]: "want" } }),
    { catalog, now },
  );
  assert.equal(after.eligible, true);
  assert.ok(!after.hard_conflicts.some((row) => String(row.code).includes(dryer.id)));
});

test("legacy trait mapping still resolves pet/cook/tax", () => {
  const snap = listingMatchSnapshot({
    post_id: 2100000002,
    listed_by_user_id: 1,
    self_status: "open",
    source: "self",
    price_num: 20000,
    source_key: "1|8||台北市士林區中正路|3|18坪|2房1廳1衛",
    address: "台北市士林區中正路100號",
    area_name: "18坪",
    layout: "2房1廳1衛",
    kind_name: "整層住家",
    self_traits: JSON.stringify(["pet", "cook", "elevator"]),
  }, { catalog: defaultCatalog() });
  assert.equal(snap.districts[0], "1-8");
  assert.equal(snap.listing_values.need_pet, "allowed");
  assert.equal(snap.listing_values.need_cook, "allowed");
  assert.equal(snap.listing_values.elevator, "present");
});

test("hard conflict excludes the pair; quality score is deterministic", () => {
  const catalog = defaultCatalog();
  const a = evaluateMatch(listing(), wish(), { catalog, now });
  const b = evaluateMatch(listing(), wish(), { catalog, now });
  assert.deepEqual(a, b);
  assert.ok(a.match_score > 0 && a.match_score <= 100);
  assert.deepEqual(a.explanation, b.explanation);
  const blocked = evaluateMatch(listing({ listing_values: { ...listing().listing_values, need_pet: "not_allowed" } }), wish(), { catalog, now });
  assert.equal(blocked.eligible, false);
  assert.equal(blocked.match_score, 0);
});

test("activity and freshness stay separate from match_score", () => {
  const catalog = defaultCatalog();
  const fresh = evaluateMatch(listing(), wish({ last_confirmed_at: "2026-09-16T00:00:00.000Z" }), { catalog, now });
  const stale = evaluateMatch(listing(), wish({ last_confirmed_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" }), { catalog, now });
  assert.equal(fresh.match_score, stale.match_score);
  assert.ok(fresh.freshness_score > stale.freshness_score);
  assert.ok(fresh.rank_score > stale.rank_score);
  assert.equal(MATCH_QUALITY_WEIGHTS.layout, 18);
  assert.equal(RANK_WEIGHTS.match, 70);
});

test("login view and watch signals change activity_score not match_score", () => {
  const catalog = defaultCatalog();
  const quiet = evaluateMatch(listing(), wish(), {
    catalog,
    now,
    activity: { last_confirmed_at: "2026-08-01T00:00:00.000Z", wish_edited_at: "2026-08-01T00:00:00.000Z" },
  });
  const busy = evaluateMatch(listing(), wish(), {
    catalog,
    now,
    activity: {
      last_confirmed_at: "2026-08-01T00:00:00.000Z",
      wish_edited_at: "2026-08-01T00:00:00.000Z",
      last_login_at: "2026-09-16T07:00:00.000Z",
      listing_viewed_at: "2026-09-16T06:00:00.000Z",
      watched_at: "2026-09-16T05:00:00.000Z",
    },
  });
  assert.equal(quiet.match_score, busy.match_score);
  assert.ok(busy.activity_score > quiet.activity_score);
  assert.ok(busy.rank_score > quiet.rank_score);
});

test("counterfactual eligibility uses evaluateMatch after normalizing only lifecycle/status", () => {
  const listingRow = {
    post_id: 2100000002,
    listed_by_user_id: 1,
    self_status: "open",
    source: "self",
    price_num: 20000,
    source_key: "1|8||台北市士林區中正路|3|18坪|2房1廳1衛",
    address: "台北市士林區中正路100號",
    area_name: "18坪",
    layout: "2房1廳1衛",
    kind_name: "整層住家",
    listing_condition_values: JSON.stringify({
      need_pet: "not_allowed",
      need_cook: "allowed",
    }),
  };
  const lifecycleOnly = {
    public_token: "paused-lifecycle-only",
    lifecycle: "paused",
    status: "closed",
    districts: ["1-8"],
    rent_max: 30000,
  };
  const conditionConflict = {
    ...lifecycleOnly,
    public_token: "paused-pet-conflict",
    condition_choices: { need_pet: "want" },
  };
  const catalog = defaultCatalog();
  const unmodified = evaluateMatch(
    listingMatchSnapshot(listingRow, { catalog }),
    wishMatchSnapshot(lifecycleOnly, { catalog }),
    { catalog, now },
  );
  assert.equal(unmodified.eligible, false);
  assert.ok(unmodified.hard_conflicts.some((row) => row.code === "lifecycle"));
  const counterfactual = evaluateCounterfactualMatch(listingRow, lifecycleOnly, { catalog, now });
  assert.equal(counterfactual.eligible, true);
  assert.equal(isCounterfactuallyMatchable(listingRow, lifecycleOnly, { catalog, now }), true);
  const conflicting = evaluateCounterfactualMatch(listingRow, conditionConflict, { catalog, now });
  assert.equal(conflicting.eligible, false);
  assert.ok(conflicting.hard_conflicts.some((row) => row.code === "condition:need_pet"));
  assert.equal(isCounterfactuallyMatchable(listingRow, conditionConflict, { catalog, now }), false);
});

test("lifecycle contract: active and needs_confirmation match; others do not", () => {
  assert.equal(isWishMatchable(wish({ lifecycle: "active" })), true);
  assert.equal(isWishMatchable(wish({ lifecycle: "needs_confirmation", status: "open" })), true);
  for (const lifecycle of ["paused", "completed", "expired", "blocked", "draft"]) {
    assert.equal(isWishMatchable(wish({ lifecycle, status: lifecycle === "blocked" ? "hidden" : "closed" })), false);
  }
  assert.equal(isListingMatchable(listing({ status: "closed" })), false);
  assert.equal(isListingMatchable(listing({ status: "open", expires_at: "2020-01-01T00:00:00.000Z" }), now), false);
});

test("wish snapshot keeps historical choices without inventing unspecified matches", () => {
  const snap = wishMatchSnapshot({
    id: 9,
    public_token: "b".repeat(32),
    status: "open",
    lifecycle: "active",
    districts: JSON.stringify(["1-8"]),
    rent_max: 25000,
    must_have: JSON.stringify(["need_pet"]),
    avoid: JSON.stringify(["parking_car"]),
    condition_choices: JSON.stringify({ need_pet: "want", parking_car: "avoid" }),
  }, { catalog: defaultCatalog() });
  assert.equal(snap.choices.need_pet, "want");
  assert.equal(snap.choices.parking_car, "avoid");
  assert.equal(snap.choices.elevator, undefined);
});

test("rank sort and cursor pagination are stable", () => {
  const rows = [
    { rank_score: 8000, match_score: 90, wish_ref: "bb", wish_id: 2 },
    { rank_score: 8000, match_score: 90, wish_ref: "aa", wish_id: 1 },
    { rank_score: 1000, match_score: 40, wish_ref: "cc", wish_id: 3 },
  ].sort(compareMatchRank);
  assert.deepEqual(rows.map((row) => row.wish_ref), ["aa", "bb", "cc"]);
  const first = applyMatchCursor(rows, null, 1, { listingId: "L1" });
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].wish_ref, "aa");
  assert.ok(first.next_cursor);
  assert.equal(inspectMatchCursorPayload(first.next_cursor).reversible_json, false);
  const second = applyMatchCursor(rows, first.next_cursor, 1, { listingId: "L1" });
  assert.equal(second.items[0].wish_ref, "bb");
  assert.equal(encodeMatchCursor(rows[0]).length > 4, true);
  assert.ok(freshnessScoreFrom(wish(), now) > 0);
});

test("opaque cursor keeps snapshot order after live rank mutation", () => {
  const rows = [
    { rank_score: 8000, match_score: 90, wish_ref: "aa" },
    { rank_score: 7000, match_score: 80, wish_ref: "bb" },
    { rank_score: 7000, match_score: 50, wish_ref: "cc" },
  ];
  const first = applyMatchCursor(rows, null, 1, { listingId: "L2" });
  rows.splice(0, 1);
  rows.unshift({ rank_score: 7000, match_score: 99, wish_ref: "zz" });
  rows.sort(compareMatchRank);
  const second = applyMatchCursor(rows, first.next_cursor, 1, { listingId: "L2" });
  assert.equal(second.items[0].wish_ref, "bb");
  assert.equal(second.items[0].match_score, 80);
  expireMatchPageCursor(first.next_cursor);
  assert.throws(() => applyMatchCursor(rows, first.next_cursor, 1, { listingId: "L2" }), (err) => {
    assert.equal(err.code, "cursor_expired");
    return true;
  });
  const legacy = Buffer.from(JSON.stringify({ r: 8000, t: "aa", i: 1 }), "utf8").toString("base64url");
  assert.equal(inspectMatchCursorPayload(legacy).reversible_json, true);
  assert.throws(() => applyMatchCursor(rows, legacy, 1, { listingId: "L2" }), (err) => {
    assert.equal(err.code, "cursor_expired");
    return true;
  });
});

test("opaque cursor reuses one snapshot and consumed tokens cannot replay", () => {
  clearMatchPageCursors();
  const rows = Array.from({ length: 12 }, (_, i) => ({
    rank_score: 1000 - i,
    match_score: 80,
    wish_ref: `w${String(i).padStart(2, "0")}`,
  }));
  const seen = [];
  let cursor = "";
  for (let page = 0; page < 6; page += 1) {
    const result = applyMatchCursor(rows, cursor || null, 2, { listingId: "L3" });
    seen.push(...result.items.map((row) => row.wish_ref));
    const state = inspectMatchCursorState();
    if (result.next_cursor) {
      assert.equal(state.snapshots, 1);
      assert.equal(state.item_arrays, 1);
      assert.equal(state.cursors, 1);
      assert.equal(state.total_items, 12);
    }
    if (cursor) {
      assert.throws(() => applyMatchCursor(rows, cursor, 2, { listingId: "L3" }), (err) => {
        assert.equal(err.code, "cursor_expired");
        return true;
      });
    }
    cursor = result.next_cursor;
  }
  assert.equal(seen.length, 12);
  assert.equal(new Set(seen).size, 12);
  assert.equal(inspectMatchCursorState().snapshots, 0);
  assert.equal(inspectMatchCursorState().cursors, 0);
});

test("oldest snapshot eviction expires leftover cursors", () => {
  clearMatchPageCursors();
  const cursors = [];
  for (let i = 0; i < MATCH_SNAPSHOT_MAX + 2; i += 1) {
    const rows = Array.from({ length: 4 }, (_, n) => ({
      rank_score: 10,
      match_score: 10,
      wish_ref: `e${i}-${n}`,
    }));
    const page = applyMatchCursor(rows, null, 1, { listingId: `E${i}` });
    cursors.push(page.next_cursor);
  }
  const state = inspectMatchCursorState();
  assert.ok(state.snapshots <= MATCH_SNAPSHOT_MAX);
  assert.ok(state.total_items <= MATCH_SNAPSHOT_MAX * 4);
  assert.throws(() => applyMatchCursor([], cursors[0], 1, { listingId: "E0" }), (err) => {
    assert.equal(err.code, "cursor_expired");
    return true;
  });
  clearMatchPageCursors();
});

test("single snapshot over the item cap fails closed without storing", () => {
  clearMatchPageCursors();
  const before = inspectMatchCursorState();
  const rows = Array.from({ length: MATCH_SNAPSHOT_ITEMS_MAX + 1 }, (_, i) => ({
    rank_score: 1,
    match_score: 1,
    wish_ref: `big${i}`,
  }));
  assert.throws(() => applyMatchCursor(rows, null, 1, { listingId: "BIG" }), (err) => {
    assert.equal(err.code, "match_snapshot_too_large");
    assert.equal(err.status, 503);
    return true;
  });
  const after = inspectMatchCursorState();
  assert.equal(after.snapshots, before.snapshots);
  assert.equal(after.total_items, before.total_items);
  assert.ok(after.total_items <= MATCH_SNAPSHOT_ITEMS_MAX);
  clearMatchPageCursors();
});

test("default rules stay read-only and do not mention listing ranking", () => {
  const rules = defaultMatchRulesPublic();
  assert.equal(rules.editable, false);
  assert.match(rules.note, /找房排序/);
  assert.equal(rules.privacy_threshold, 3);
});
