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
  SUITE_LITE_CONDITION_IDS,
  deleteOrDisableCondition,
  generateSystemId,
  isProtectedPersonalAttribute,
  listingValuesFromTraits,
  mergeHistoricalWishChoices,
  mergeListingConditionValues,
  resolveWishChoices,
  mergeDefaultCatalog,
  moveCondition,
  normalizeCatalog,
  normalizeConditionLabel,
  sanitizeWishChoices,
  traitsFromListingValues,
  upsertCategory,
  upsertCondition,
  wishChoicesFromLegacy,
  countCatalogReferences,
  isSystemCatalogTemplate,
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
  const liteIds = new Set(SUITE_LITE_CONDITION_IDS);
  assert.ok(applied.draft.conditions.some((row) => liteIds.has(row.id) && row.enabled !== false));
  assert.ok(applied.draft.conditions.some((row) => !liteIds.has(row.id) && row.enabled === false));
  const reloaded = mergeDefaultCatalog(applied.draft);
  assert.equal(reloaded.conditions.find((row) => !liteIds.has(row.id))?.enabled, false);
  assert.ok(reloaded.conditions.filter((row) => !liteIds.has(row.id)).every((row) => row.enabled === false));
});

test("hard-deleted unused default does not resurrect on merge", () => {
  const fresh = upsertCondition(defaultCatalog(), { label: "全新測試條件乙" });
  const created = fresh.conditions.find((row) => row.label === "全新測試條件乙");
  const gone = deleteOrDisableCondition(fresh, created.id, {});
  assert.equal(gone.action, "deleted");
  const unusedDefault = defaultCatalog().conditions.find((row) => row.id === "sofa");
  const deletedDefault = deleteOrDisableCondition(defaultCatalog(), unusedDefault.id, {});
  assert.equal(deletedDefault.action, "deleted");
  assert.ok(deletedDefault.catalog.removed_ids.includes("sofa"));
  const merged = mergeDefaultCatalog(deletedDefault.catalog);
  assert.equal(merged.conditions.some((row) => row.id === "sofa"), false);
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
  const washer = merged.conditions.find((row) => row.id === "washer");
  assert.ok(washer);
  assert.equal(washer.enabled, false);
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

test("catalog rejects protected personal-attribute labels and aliases", () => {
  assert.equal(isProtectedPersonalAttribute("限女性"), true);
  assert.equal(isProtectedPersonalAttribute("國籍"), true);
  assert.equal(isProtectedPersonalAttribute("宗教"), true);
  assert.equal(isProtectedPersonalAttribute("無障礙設施"), false);
  assert.equal(isProtectedPersonalAttribute("冰箱"), false);
  assert.throws(() => upsertCondition(defaultCatalog(), { label: "限女性" }), /敏感屬性/);
  assert.throws(() => upsertCondition(defaultCatalog(), { label: "社區門禁", aliases: ["限本國人"] }), /敏感屬性/);
});

test("sanitize keeps disabled historical choices only when resolving", () => {
  const created = upsertCondition(defaultCatalog(), { label: "烘衣機", category_id: "appliance" });
  const dryer = created.conditions.find((row) => row.label === "烘衣機");
  const disabled = deleteOrDisableCondition(created, dryer.id, { wish: 1 });
  const dropped = sanitizeWishChoices(disabled.catalog, { [dryer.id]: "want", fridge: "want" });
  assert.equal(dropped[dryer.id], undefined);
  assert.equal(dropped.fridge, "want");
  const kept = resolveWishChoices(disabled.catalog, { [dryer.id]: "want", fridge: "want" });
  assert.equal(kept[dryer.id], "want");
  const merged = mergeHistoricalWishChoices(disabled.catalog, { fridge: "want" }, { [dryer.id]: "want" });
  assert.equal(merged[dryer.id], "want");
  assert.equal(merged.fridge, "want");
});

test("listing polarity values persist allowed separately from not_allowed", () => {
  const catalog = defaultCatalog();
  const groups = catalogAsSelfTraitGroups(catalog);
  const cook = groups.flatMap((group) => group.items).find((item) => item.canonical_id === "need_cook");
  assert.equal(cook.input, "polarity");
  assert.equal(cook.id, "need_cook");
  const allowed = mergeListingConditionValues(catalog, { need_pet: "allowed" }, [], {}, []);
  assert.equal(allowed.need_pet, "allowed");
  assert.ok(traitsFromListingValues(allowed, catalog).includes("pet"));
  const denied = mergeListingConditionValues(catalog, { need_pet: "not_allowed" }, [], {}, []);
  assert.equal(denied.need_pet, "not_allowed");
  assert.ok(traitsFromListingValues(denied, catalog).includes("nopet"));
  const unknown = listingValuesFromTraits([], catalog);
  assert.equal(unknown.need_pet, "unknown");
});

test("disabled category gates new wish and listing input but keeps historical", () => {
  const catalog = upsertCategory(defaultCatalog(), { id: "appliance", label: "家電", enabled: false });
  const dropped = sanitizeWishChoices(catalog, { fridge: "want", elevator: "want" });
  assert.equal(dropped.fridge, undefined);
  assert.equal(dropped.elevator, "want");
  const kept = resolveWishChoices(catalog, { fridge: "want", elevator: "want" });
  assert.equal(kept.fridge, "want");
  const wishIds = catalogAsWishConditions(catalog).map((row) => row.id);
  assert.equal(wishIds.includes("fridge"), false);
  const listing = catalogAsSelfTraitGroups(catalog);
  assert.equal(listing.some((group) => group.id === "appliance"), false);
  const historical = catalogAsSelfTraitGroups(catalog, { includeInactive: true });
  assert.equal(historical.some((group) => group.id === "appliance"), true);
  const bulk = applyBulkWishActions(catalog, "appliance", "want", {});
  assert.equal(bulk.fridge, undefined);
});

test("catalog references count listing_condition_values and legacy polarity tokens", () => {
  assert.equal(countCatalogReferences([
    { listing_condition_values: JSON.stringify({ need_pet: "allowed" }) },
  ], "need_pet"), 1);
  assert.equal(countCatalogReferences([
    { self_traits: JSON.stringify(["pet"]) },
  ], "need_pet"), 1);
  assert.equal(countCatalogReferences([
    { self_traits: JSON.stringify(["fridge"]) },
  ], "need_pet"), 0);
  assert.equal(countCatalogReferences([
    { condition_choices: JSON.stringify({ fridge: "want" }) },
  ], "fridge"), 1);
});

test("system catalog templates are readonly identifiers", () => {
  assert.equal(isSystemCatalogTemplate("jibby_full"), true);
  assert.equal(isSystemCatalogTemplate("suite_lite"), true);
  assert.equal(isSystemCatalogTemplate("custom_formal"), false);
});

test("bulk avoid leaves disallow-avoid conditions unspecified", () => {
  const catalog = upsertCondition(defaultCatalog(), {
    label: "法定用途",
    category_id: "living_lease",
    wish_allow_avoid: false,
  });
  const row = catalog.conditions.find((item) => item.label === "法定用途");
  const next = applyBulkWishActions(catalog, row.category_id, "avoid", {});
  assert.equal(next[row.id], undefined);
});
