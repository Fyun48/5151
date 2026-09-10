import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WISH_CONDITIONS,
  WISH_FORBIDDEN_CONDITION_IDS,
  normalizeWishConditionItems,
  mergeWishConditions,
  publicWishConditions,
  setWishConditionCatalog,
  activeWishConditions,
} from "../src/wishConditions.js";
import { demandMeta, listingCompatibilityForWish } from "../src/demand.js";

test("default catalog stays renter-intent and forbids listing negatives", () => {
  const ids = DEFAULT_WISH_CONDITIONS.map((row) => row.id);
  for (const bad of WISH_FORBIDDEN_CONDITION_IDS) assert.ok(!ids.includes(bad));
  assert.ok(ids.includes("need_cook"));
  const compat = listingCompatibilityForWish(["need_cook"]);
  assert.ok(compat.listing_incompatible.includes("nocook"));
});

test("admin can add rename and disable conditions", () => {
  const items = normalizeWishConditionItems([
    { id: "elevator", label: "有電梯" },
    { id: "need_washer", label: "洗衣機" },
    { id: "female", label: "限女性" },
    { id: "", label: "" },
  ]);
  assert.ok(items.some((row) => row.id === "need_washer" && row.label === "洗衣機"));
  assert.equal(items.find((row) => row.id === "elevator")?.label, "有電梯");
  assert.ok(!items.some((row) => row.id === "female"));
  const merged = mergeWishConditions({ items: [{ id: "need_cook", label: "要能煮飯", enabled: false }] });
  assert.equal(merged.find((row) => row.id === "need_cook")?.enabled, false);
  assert.ok(merged.some((row) => row.id === "need_pet"));
  const pub = publicWishConditions(merged);
  assert.ok(!pub.active.some((row) => row.id === "need_cook"));
  try {
    setWishConditionCatalog(merged);
    assert.ok(!activeWishConditions().some((row) => row.id === "need_cook"));
    assert.ok(!demandMeta().conditions.some((row) => row.id === "need_cook"));
  } finally {
    setWishConditionCatalog(DEFAULT_WISH_CONDITIONS);
  }
});
