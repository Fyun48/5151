import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extraMonthlyAmount,
  feeFieldsFromBlob,
  listingCompareCost,
  parseTwdAmount,
  passesPriceFilter,
  rentAmount,
} from "../src/listingCost.js";
import { passesAttributeFilters } from "../src/floors.js";
import { listingTotalCost } from "../src/match.js";

test("591 extra_fee plus rent exceeds cap when extras are included", () => {
  const listing = {
    price_num: 34000,
    extra_fee: 3500,
    extra_fee_text: "管理費另計 3,500元/月",
    extra_fees: [{ name: "額外費用", value: "管理費另計 3,500元/月", key: "extra", amount: 3500 }],
  };
  assert.equal(extraMonthlyAmount(listing), 3500);
  assert.equal(listingCompareCost(listing, { includeExtras: false }), 34000);
  assert.equal(listingCompareCost(listing, { includeExtras: true }), 37500);
  assert.equal(passesPriceFilter(listing, { priceMax: 36000 }), true);
  assert.equal(passesPriceFilter(listing, { priceMax: 36000, priceMaxIncludesExtras: true }), false);
  assert.equal(passesAttributeFilters(listing, { priceMax: 36000, priceMaxIncludesExtras: true }), false);
  assert.equal(passesAttributeFilters(listing, { priceMax: 36000 }), true);
});

test("included utilities and deposits are not monthly extras", () => {
  const included = {
    price_num: 28000,
    extra_fee: 0,
    price_contain_text: "已含管理費、水、網路",
    extra_fees: [{ name: "租金含", value: "已含管理費", key: "contain" }],
    title: "含水電瓦斯",
  };
  assert.equal(extraMonthlyAmount(included), 0);
  const deposit = {
    price_num: 20000,
    extra_fee: 0,
    extra_fees: [{ name: "押金", value: "兩個月份 40000", amount: 40000 }],
  };
  assert.equal(extraMonthlyAmount(deposit), 0);
  assert.equal(listingTotalCost(deposit), 20000);
});

test("other portals parse 管理費另計 from listing text", () => {
  const fields = feeFieldsFromBlob({ blob: "採光佳。管理費另計 2,000元/月。停車費另計1000" });
  assert.equal(fields.extra_fee, 3000);
  const listing = { price_num: 25000, ...fields };
  assert.equal(listingCompareCost(listing, { includeExtras: true }), 28000);
  assert.equal(parseTwdAmount("３，５００元"), 3500);
});

test("unstructured ads without 另計 do not invent extra monthly fees", () => {
  const fields = feeFieldsFromBlob({ blob: "近捷運停車方便、網路通暢、管理完善、車位可詢問" });
  assert.equal(fields.extra_fee, 0);
  assert.equal(extraMonthlyAmount({ price_num: 34000, title: "管理費只要2000", fee_blob: "管理費只要2000" }), 0);
});

test("591 extra_fee column is enough without extra_fees amounts", () => {
  const listing = {
    price_num: 34000,
    extra_fee: 3500,
    extra_fee_text: "管理費 3,500元/月",
  };
  assert.equal(extraMonthlyAmount(listing), 3500);
  assert.equal(passesPriceFilter(listing, { priceMax: 36000, priceMaxIncludesExtras: true }), false);
});

test("deposit-only extra_fees still count extra_fee column", () => {
  const listing = {
    price_num: 34000,
    extra_fee: 3500,
    extra_fees: [{ name: "押金", value: "二個月" }],
  };
  assert.equal(extraMonthlyAmount(listing), 3500);
  assert.equal(listingCompareCost(listing, { includeExtras: true }), 37500);
});

test("price min/max without extras still hide over-budget rent", () => {
  const listing = { price_num: 38000, extra_fee: 0 };
  assert.equal(passesPriceFilter(listing, { priceMax: 36000 }), false);
  assert.equal(passesPriceFilter(listing, { priceMax: 0 }), true);
  assert.equal(passesPriceFilter({ price_num: 12000 }, { priceMin: 15000, priceMax: 36000 }), false);
});

test("wan-style prices count as tens of thousands of TWD", () => {
  assert.equal(rentAmount({ price_num: 21000.6, price: "3.8萬" }), 21001);
  assert.equal(rentAmount({ price_num: 3.8, price: "42,000" }), 42000);
  assert.equal(rentAmount({ price_num: Infinity, price: "3.8萬" }), 38000);
  assert.equal(rentAmount({ price_num: 3.8, price: "3.8萬" }), 38000);
  assert.equal(rentAmount({ price_num: 3.8, price: "" }), 38000);
  assert.equal(rentAmount({ price_num: 0, price: "38,000" }), 38000);
  assert.equal(passesPriceFilter({ price_num: 3.8, price: "3.8萬" }, { priceMax: 36000 }), false);
  assert.equal(passesPriceFilter({ price_num: 8500, price: "8,500" }, { priceMax: 36000 }), true);
});

test("R2：費用推論不得過度概括（水電要兩項、第四台不等於網路）", async () => {
  const { feeInclusionStates } = await import("../src/listingCost.js");
  const states = (listing) => feeInclusionStates(listing);
  // 只有水費已含 ⇒ 不足以說「含水電」
  assert.equal(states({ price_contain_text: "含水費" }).utilities, "unknown");
  // 只有電費已含 ⇒ 同樣不足以
  assert.equal(states({ price_contain_text: "含電費" }).utilities, "unknown");
  // 水電合寫、或水與電都寫出來 ⇒ 才是已含
  assert.equal(states({ price_contain_text: "含水電" }).utilities, "present");
  assert.equal(states({ extra_fee_text: "水費已含，電費已含" }).utilities, "present");
  // 任何一項明確另計 ⇒ 這個要求不成立
  assert.equal(states({ extra_fee_text: "水費 300 另計" }).utilities, "absent");
  assert.equal(states({ extra_fee_text: "水電 500 另計" }).utilities, "absent");
  // 只有第四台已含 ⇒ 不足以說「含網路」
  assert.equal(states({ price_contain_text: "含第四台" }).internet, "unknown");
  assert.equal(states({ price_contain_text: "含有線電視" }).internet, "unknown");
  // 明確寫網路才判定
  assert.equal(states({ price_contain_text: "含網路" }).internet, "present");
  assert.equal(states({ extra_fee_text: "網路費 500 另計" }).internet, "absent");
  // 站內刊登自己填的三態優先於任何文字推論
  assert.equal(states({ fee_includes: JSON.stringify({ utilities: 1 }), price_contain_text: "含水費" }).utilities, "present");
  assert.equal(states({ fee_includes: JSON.stringify({ internet: 0 }), price_contain_text: "含第四台" }).internet, "absent");
});
