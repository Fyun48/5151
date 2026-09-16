import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultCatalog, deleteOrDisableCondition, upsertCondition } from "../src/rentalCatalog.js";
import {
  applyMatchCursor,
  compareMatchRank,
  defaultMatchRulesPublic,
  encodeMatchCursor,
  evaluateMatch,
  freshnessScoreFrom,
  isListingMatchable,
  isMatchingConditionActive,
  isWishMatchable,
  listingMatchSnapshot,
  MATCH_QUALITY_WEIGHTS,
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
  const first = applyMatchCursor(rows, null, 1);
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].wish_ref, "aa");
  assert.ok(first.next_cursor);
  const second = applyMatchCursor(rows, { rank_score: first.items[0].rank_score, wish_ref: first.items[0].wish_ref }, 1);
  assert.equal(second.items[0].wish_ref, "bb");
  assert.equal(encodeMatchCursor(rows[0]).length > 4, true);
  assert.ok(freshnessScoreFrom(wish(), now) > 0);
});

test("default rules stay read-only and do not mention listing ranking", () => {
  const rules = defaultMatchRulesPublic();
  assert.equal(rules.editable, false);
  assert.match(rules.note, /找房排序/);
  assert.equal(rules.privacy_threshold, 3);
});
