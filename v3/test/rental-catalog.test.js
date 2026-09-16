import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CATALOG_CONDITIONS,
  applyBulkWishActions,
  applyTemplateDraft,
  canHardDeleteCondition,
  canonicalId,
  catalogAsSelfTraitGroups,
  catalogAsWishConditions,
  catalogDiff,
  compatibilityForChoice,
  defaultCatalog,
  defaultTemplates,
  deleteOrDisableCondition,
  generateSystemId,
  listingValuesFromTraits,
  mergeDefaultCatalog,
  moveCondition,
  normalizeCatalog,
  normalizeConditionLabel,
  sanitizeWishChoices,
  upsertCategory,
  upsertCondition,
  wishChoicesFromLegacy,
} from "../src/rentalCatalog.js";
import { DEFAULT_WISH_CONDITIONS } from "../src/wishConditions.js";
import { SELF_TRAIT_GROUPS } from "../src/selfTraits.js";
import { listingFitScore } from "../src/listingScore.js";
import { normalizeRentalMarketplaceFlags, isRentalCatalogV2Enabled } from "../src/rentalMarketplaceFlags.js";

test("flags default false and only true is on", () => {
  const flags = normalizeRentalMarketplaceFlags({});
  assert.equal(flags.rental_catalog_v2.enabled, false);
  assert.equal(flags.wish.lifecycle_enabled, false);
  assert.equal(flags.wish.owner_matching_enabled, false);
  assert.equal(isRentalCatalogV2Enabled({ rental_catalog_v2: { enabled: "true" } }), false);
  assert.equal(isRentalCatalogV2Enabled({ rental_catalog_v2: { enabled: true } }), true);
});

test("normalized labels collapse spaces and full-width blanks", () => {
  assert.equal(normalizeConditionLabel("冰 箱"), normalizeConditionLabel("冰箱"));
  assert.equal(normalizeConditionLabel("冰　箱"), normalizeConditionLabel("冰箱"));
});

test("system id is stable and immutable after create", () => {
  const id = generateSystemId("烘衣機", []);
  const again = generateSystemId("乾衣機", [id]);
  assert.notEqual(id, again);
  const catalog = upsertCondition(defaultCatalog(), { label: "烘衣機" });
  const created = catalog.conditions.find((row) => row.label === "烘衣機");
  const renamed = upsertCondition(catalog, { id: created.id, label: "乾衣機" });
  assert.equal(renamed.conditions.find((row) => row.label === "乾衣機")?.id, created.id);
});

test("duplicate labels are rejected", () => {
  const catalog = defaultCatalog();
  assert.throws(() => upsertCondition(catalog, { label: "冰箱" }), /相同名稱/);
  assert.throws(() => upsertCondition(catalog, { label: "電冰箱" }), /相同名稱/);
});

test("seed keeps legacy wish and self trait ids", () => {
  const ids = defaultCatalog().conditions.map((row) => row.id);
  for (const row of DEFAULT_WISH_CONDITIONS) assert.ok(ids.includes(canonicalId(row.id)), row.id);
  for (const group of SELF_TRAIT_GROUPS) {
    for (const item of group.items) {
      if (["nocook", "nopet", "notax", "parking"].includes(item.id)) continue;
      assert.ok(ids.includes(canonicalId(item.id)), item.id);
    }
  }
  assert.equal(canonicalId("parking"), "parking_car");
  assert.equal(canonicalId("nocook"), "need_cook");
});

test("pet/cook listing values stay tri-state", () => {
  const catalog = defaultCatalog();
  const none = listingValuesFromTraits([], catalog);
  assert.equal(none.need_pet, "unknown");
  assert.equal(listingValuesFromTraits(["nopet"], catalog).need_pet, "not_allowed");
  assert.equal(listingValuesFromTraits(["pet"], catalog).need_pet, "allowed");
  assert.equal(compatibilityForChoice({}, "want", "allowed"), "compatible");
  assert.equal(compatibilityForChoice({}, "want", "not_allowed"), "conflict");
});

test("legacy nice_to_have does not become want", () => {
  const mapped = wishChoicesFromLegacy(["need_cook"], ["fridge"], ["parking_car"]);
  assert.equal(mapped.choices.need_cook, "want");
  assert.equal(mapped.choices.parking_car, "avoid");
  assert.equal(mapped.choices.fridge, undefined);
  assert.ok(mapped.nice_to_have_legacy.includes("fridge"));
});

test("category bulk actions respect capability", () => {
  const catalog = defaultCatalog();
  const want = applyBulkWishActions(catalog, "living_lease", "want", {});
  assert.equal(want.need_cook, "want");
  const avoid = applyBulkWishActions(catalog, "living_lease", "avoid", {});
  assert.equal(avoid.need_cook, undefined);
  assert.equal(avoid.short_ok, "avoid");
  const cleared = applyBulkWishActions(catalog, "living_lease", "clear", want);
  assert.equal(cleared.need_cook, undefined);
});

test("sanitize drops illegal avoid", () => {
  const out = sanitizeWishChoices(defaultCatalog(), { need_cook: "avoid", fridge: "want" });
  assert.equal(out.need_cook, undefined);
  assert.equal(out.fridge, "want");
});

test("referenced condition cannot hard delete", () => {
  assert.equal(canHardDeleteCondition("fridge", { wish: 1 }), false);
  const disabled = deleteOrDisableCondition(defaultCatalog(), "fridge", { listing: 2 });
  assert.equal(disabled.action, "disabled");
  assert.equal(disabled.catalog.conditions.find((row) => row.id === "fridge")?.enabled, false);
  const fresh = upsertCondition(defaultCatalog(), { label: "全新測試條件甲" });
  const created = fresh.conditions.find((row) => row.label === "全新測試條件甲");
  const gone = deleteOrDisableCondition(fresh, created.id, {});
  assert.equal(gone.action, "deleted");
});

test("template apply is draft plus diff", () => {
  const templates = defaultTemplates();
  const lite = templates.find((row) => row.id === "suite_lite");
  const applied = applyTemplateDraft(defaultCatalog(), lite);
  assert.ok(applied.diff.disabled > 0);
  assert.ok(applied.draft.conditions.every((row) => ["need_cook", "need_pet", "short_ok", "elevator", "fridge", "washer", "ac", "bed", "net"].includes(row.id)));
  const published = defaultCatalog();
  assert.notEqual(published.conditions.length, applied.draft.conditions.length);
});

test("category sort disable and move", () => {
  let catalog = upsertCategory(defaultCatalog(), { id: "appliance", label: "家電設備", enabled: false });
  assert.equal(catalog.categories.find((row) => row.id === "appliance")?.enabled, false);
  catalog = moveCondition(catalog, "fridge", "furniture");
  assert.equal(catalog.conditions.find((row) => row.id === "fridge")?.category_id, "furniture");
});

test("compat projections keep existing domain shapes", () => {
  const wish = catalogAsWishConditions(defaultCatalog());
  assert.ok(wish.some((row) => row.id === "need_cook" && row.listing_incompatible.includes("nocook")));
  const groups = catalogAsSelfTraitGroups(defaultCatalog());
  assert.ok(groups.some((group) => group.items.some((item) => item.id === "fridge")));
});

test("merge keeps stored disable and fills missing defaults", () => {
  const stored = normalizeCatalog({
    categories: [{ id: "appliance", label: "家電", enabled: true, sort_order: 1 }],
    conditions: [{ id: "fridge", label: "冰箱", category_id: "appliance", enabled: false }],
  });
  const merged = mergeDefaultCatalog(stored);
  assert.equal(merged.conditions.find((row) => row.id === "fridge")?.enabled, false);
  assert.ok(merged.conditions.some((row) => row.id === "washer"));
});

test("catalog module never changes listing fit score inputs", () => {
  const score = listingFitScore({ rent: 20000, kind: "整層住家" }, { maxRent: 25000 });
  assert.ok(Number.isFinite(score));
});

test("catalogDiff counts add change disable", () => {
  const from = defaultCatalog();
  const to = upsertCondition(from, { id: "fridge", label: "雙門冰箱", enabled: false });
  const extra = upsertCondition(to, { label: "烘衣機" });
  const diff = catalogDiff(from, extra);
  assert.ok(diff.added >= 1);
  assert.ok(diff.changed >= 1);
  assert.ok(diff.disabled >= 1);
});

test("seed condition count covers spec first-wave", () => {
  assert.ok(DEFAULT_CATALOG_CONDITIONS.length >= 20);
});
