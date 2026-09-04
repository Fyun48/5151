import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extraMonthlyAmount,
  feeFieldsFromBlob,
  listingCompareCost,
  parseTwdAmount,
  passesPriceFilter,
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
