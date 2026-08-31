import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyExistingUpdate,
  listingLastEvent,
  listingPriceNum,
  shouldDockNotify,
  shouldNotify,
  shouldWebhookNotify,
} from "../src/notify.js";

const listing = { title: "士林二房", price: "28000", price_num: 28000, hidden: 0, offline: 0, watched: 0 };
const watched = { ...listing, watched: 1 };
const hookSettings = { discordWebhook: "https://discord.com/api/webhooks/1/abc" };

test("new listings always notify", () => {
  assert.equal(shouldNotify(hookSettings, listing, { type: "new" }), true);
  assert.equal(shouldDockNotify(hookSettings, listing, { type: "new" }), true);
  assert.equal(shouldWebhookNotify(hookSettings, listing, { type: "new" }), true);
});

test("non-watched updates do not notify except new", () => {
  assert.equal(shouldNotify(hookSettings, listing, { type: "price_drop", detail: "x" }), false);
  assert.equal(shouldNotify(hookSettings, listing, { type: "title_update", detail: "x" }), false);
  assert.equal(shouldNotify(hookSettings, listing, { type: "same_source", detail: "重刊" }), false);
});

test("watched same_source relist can notify; non-watched cannot", () => {
  assert.equal(shouldNotify(hookSettings, watched, { type: "same_source", detail: "指紋相同" }), true);
  assert.equal(shouldNotify(hookSettings, listing, { type: "same_source", detail: "指紋相同" }), false);
});

test("watched listings notify on price, title, content, offline, relist", () => {
  assert.equal(shouldNotify(hookSettings, watched, { type: "price_drop", detail: "28000 → 25000" }), true);
  assert.equal(shouldNotify(hookSettings, watched, { type: "price_update", detail: "28000 → 30000" }), true);
  assert.equal(shouldNotify(hookSettings, watched, { type: "title_update", detail: "標題變更" }), true);
  assert.equal(shouldNotify(hookSettings, watched, { type: "update", detail: "格局 2房 → 3房" }), true);
  assert.equal(shouldNotify(hookSettings, { ...watched, offline: 1 }, { type: "offline", detail: "gone" }), true);
  assert.equal(shouldNotify(hookSettings, watched, { type: "relist", detail: "重新上架" }), true);
});

test("detects content diff and price changes", () => {
  const drop = classifyExistingUpdate(
    { ...listing, price: "25000", price_num: 25000 },
    listing,
  );
  assert.equal(drop.type, "price_drop");

  const up = classifyExistingUpdate(
    { ...listing, price: "30000", price_num: 30000 },
    listing,
  );
  assert.equal(up.type, "price_update");

  const layout = classifyExistingUpdate(
    { ...listing, layout: "3房2廳" },
    listing,
  );
  assert.equal(layout.type, "update");
  assert.match(layout.detail, /格局/);

  const relist = classifyExistingUpdate(listing, { ...listing, offline: 1, offline_confirmed: 0 });
  assert.equal(relist.type, "relist");
});

test("webhook requires URL", () => {
  assert.equal(shouldWebhookNotify({ discordWebhook: "" }, listing, { type: "new" }), false);
});

test("list last_event maps price drop and title to update", () => {
  assert.equal(listingLastEvent("price_drop", listing), "update");
  assert.equal(listingLastEvent("relist", listing), "same_source");
  assert.equal(listingPriceNum({ price: "28,000" }), 28000);
});
