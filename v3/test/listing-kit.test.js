import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  kitFrom591Detail,
  listingHasBalcony,
  listingHasNaturalGas,
  listingKitFields,
  listingKitFrom,
  parseFurnishItems,
  parseStoredFurnish,
} from "../src/listingKit.js";

test("natural gas is only marked when the source says so", () => {
  assert.equal(listingHasNaturalGas({ title: "含瓦斯熱水器" }), false);
  assert.equal(listingHasNaturalGas({ extra_fee_text: "瓦斯費另計" }), false);
  assert.equal(listingHasNaturalGas({ tags: ["天然瓦斯"] }), true);
  assert.equal(listingHasNaturalGas({ text: "瓦斯：有" }), false);
  assert.equal(listingHasNaturalGas({ text: "無天然瓦斯" }), false);
  assert.equal(listingHasNaturalGas({ has_natural_gas: 1 }), true);
});

test("furnish items come from source tags and never invent extras", () => {
  assert.deepEqual(parseFurnishItems({}), []);
  assert.deepEqual(parseFurnishItems({ furnish: ["冰箱", "冷氣", "熱水器", "無"] }), ["冰箱", "冷氣", "熱水器"]);
  assert.deepEqual(parseFurnishItems({ title: "附冰箱與洗衣機，可開伙" }), ["冰箱", "洗衣機"]);
  assert.deepEqual(parseStoredFurnish('["沙發","電視"]'), ["沙發", "電視"]);
  assert.deepEqual(parseStoredFurnish("not-json"), []);
  assert.deepEqual(parseFurnishItems({ furnish_items: '["冰箱","冷氣"]' }), ["冰箱", "冷氣"]);
});

test("listingKitFields persist captured kit and stay empty when unknown", () => {
  const empty = listingKitFields({ title: "芝山兩房" });
  assert.equal(empty.has_natural_gas, 0);
  assert.equal(empty.has_balcony, 0);
  assert.equal(empty.furnish_items, "[]");
  const kit = listingKitFrom({
    title: "天然瓦斯整層",
    tags: { furnish: ["冰箱", "冷氣"] },
  });
  assert.equal(kit.has_natural_gas, true);
  assert.deepEqual(kit.furnish_items, ["冰箱", "冷氣"]);
});

test("591 detail only keeps ticked facilities and maps 桌椅 to 桌子", () => {
  const fixture = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/591-detail-kit.json"), "utf8"));
  const kit = kitFrom591Detail(fixture);
  assert.equal(kit.has_natural_gas, true);
  assert.equal(kit.has_balcony, true);
  assert.deepEqual(kit.furnish_items, ["洗衣機", "冷氣", "熱水器", "衣櫃", "沙發", "桌子"]);
  assert.equal(kit.furnish_items.includes("冰箱"), false);
  assert.equal(kit.furnish_items.includes("床"), false);
  assert.equal(listingHasBalcony({ facility: ["1陽台"] }), true);
  assert.equal(listingHasBalcony({ text: "無陽台" }), false);
  assert.deepEqual(parseFurnishItems({ furnish: ["桌椅", "天然瓦斯", "1陽台"] }), ["桌子"]);
});
