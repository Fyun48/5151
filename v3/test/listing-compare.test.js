import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareListingDiffs,
  compareListingNotes,
  costChangePayload,
  feeChangeDetail,
  feeFieldsChanged,
  feeSignature,
  incomingHasFeePayload,
  isCostChangeType,
  sameHouseBundle,
} from "../src/listingCompare.js";
import { classifyExistingUpdate, listingLastEvent } from "../src/notify.js";
import { preferPrimaryListing } from "../src/match.js";

const cheap = {
  post_id: 11,
  title: "南港整層 低價",
  price: "32,000元",
  price_num: 32000,
  extra_fee: 0,
  extra_fees: [],
  source: "591",
  source_label: "591",
  floor_name: "5F/12F",
  area_name: "20坪",
  layout: "2房1廳",
  url: "https://rent.591.com.tw/11",
};

const pricey = {
  post_id: 22,
  title: "南港整層 高價",
  price: "34,000元",
  price_num: 34000,
  extra_fee: 3500,
  extra_fee_text: "管理費另計 3,500元/月",
  extra_fees: [{ name: "管理費", value: "另計 3500", amount: 3500 }],
  source: "hbhousing",
  source_label: "住商",
  floor_name: "5F/12F",
  area_name: "20坪",
  layout: "2房1廳",
  url: "https://www.hbhousing.com.tw/22",
  match_verdict: "yes",
  hidden: 1,
};

test("fee signature treats service-fee text as a cost change even when monthly extra is 0", () => {
  const before = { price_num: 28000, extra_fees: [{ name: "服務費", value: "一個月", key: "once" }] };
  const after = { price_num: 28000, extra_fees: [{ name: "服務費", value: "半個月", key: "once" }] };
  assert.notEqual(feeSignature(before), feeSignature(after));
  assert.equal(feeFieldsChanged(after, before), true);
  assert.match(feeChangeDetail(before, after), /費用說明|服務費/);
});

test("list crawl without fee payload does not look like a fee wipe", () => {
  const existing = { ...cheap, extra_fee: 3500, extra_fee_text: "管理費另計" };
  const incoming = { post_id: 11, price_num: 32000, title: "南港整層 低價" };
  assert.equal(incomingHasFeePayload(incoming), false);
  assert.equal(feeFieldsChanged(incoming, existing), false);
  assert.equal(classifyExistingUpdate(incoming, existing).type, "seen");
});

test("classifyExistingUpdate records fee_update and maps last_event to update", () => {
  const existing = { ...cheap, extra_fee: 0, extra_fees: [] };
  const incoming = { ...cheap, extra_fee: 3500, extra_fee_text: "管理費另計 3500", extra_fees: [{ name: "管理費", value: "另計 3500", amount: 3500 }] };
  const change = classifyExistingUpdate(incoming, existing);
  assert.equal(change.type, "fee_update");
  assert.match(change.detail, /額外月費|費用說明/);
  assert.equal(listingLastEvent(change.type, existing), "update");
  assert.equal(isCostChangeType(change.type), true);
});

test("title-only edits are not cost changes", () => {
  const change = classifyExistingUpdate({ ...cheap, title: "新標題" }, cheap);
  assert.equal(change.type, "title_update");
  assert.equal(isCostChangeType(change.type), false);
  assert.equal(change.cost_change_type, undefined);
});

test("same-house bundle keeps lowest total as primary and notes the surcharge", () => {
  const bundle = sameHouseBundle(pricey, [cheap]);
  assert.equal(bundle.status, "confirmed");
  assert.equal(bundle.is_primary, false);
  assert.equal(bundle.primary_id, 11);
  assert.equal(bundle.cheaper_exists, true);
  assert.equal(bundle.cheaper_gap, 5500);
  assert.equal(bundle.peers[0].role, "primary");
  assert.ok(bundle.peers[0].notes.some((note) => /便宜 5,500/.test(note)));
  const diffs = compareListingDiffs(pricey, cheap);
  assert.ok(diffs.some((row) => row.field === "total"));
  assert.ok(diffs.some((row) => row.field === "source"));
  assert.ok(compareListingNotes(pricey, cheap).some((note) => /來源不同/.test(note)));
});

test("preferPrimaryListing still prefers lower total monthly cost", () => {
  assert.equal(preferPrimaryListing(cheap, pricey).post_id, 11);
  assert.equal(preferPrimaryListing(pricey, cheap).post_id, 11);
});

test("cost change payload is omitted when nothing was recorded", () => {
  assert.equal(costChangePayload({}), null);
  assert.deepEqual(costChangePayload({
    cost_changed_at: "2026-09-04T14:20:00.000Z",
    cost_change_type: "price_update",
    cost_change_detail: "價格 32000 → 34000",
  }), {
    at: "2026-09-04T14:20:00.000Z",
    type: "price_update",
    detail: "價格 32000 → 34000",
  });
});
