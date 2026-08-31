import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyExistingUpdate,
  listingLastEvent,
  listingPriceNum,
  shouldDockNotify,
  shouldWebhookNotify,
} from "../src/notify.js";

const listing = { title: "士林二房", price: "28000", price_num: 28000, hidden: 0, offline: 0 };
const hookSettings = {
  discordWebhook: "https://discord.com/api/webhooks/1/abc",
  webhookNotifyNew: true,
  webhookNotifyPriceDrop: true,
  webhookNotifyTitleUpdate: true,
};

test("detects a rent drop and ignores a rent increase for webhook type", () => {
  const drop = classifyExistingUpdate(
    { ...listing, price: "25000", price_num: 25000 },
    listing,
  );
  assert.equal(drop.type, "price_drop");
  assert.match(drop.detail, /28000 → 25000/);

  const up = classifyExistingUpdate(
    { ...listing, price: "30000", price_num: 30000 },
    listing,
  );
  assert.equal(up.type, "update");
  assert.equal(shouldWebhookNotify(hookSettings, listing, up), false);
});

test("detects a title change", () => {
  const change = classifyExistingUpdate(
    { ...listing, title: "士林二房可寵" },
    listing,
  );
  assert.equal(change.type, "title_update");
  assert.equal(change.detail, "標題變更");
});

test("price drop plus title change still notifies if only title webhook is on", () => {
  const change = classifyExistingUpdate(
    { ...listing, title: "士林二房可寵", price: "25000", price_num: 25000 },
    listing,
  );
  assert.equal(change.type, "price_drop");
  assert.match(change.detail, /標題變更/);
  assert.equal(
    shouldWebhookNotify({ ...hookSettings, webhookNotifyPriceDrop: false }, listing, change),
    true,
  );
  assert.equal(
    shouldWebhookNotify(
      { ...hookSettings, webhookNotifyPriceDrop: false, webhookNotifyTitleUpdate: false },
      listing,
      change,
    ),
    false,
  );
});

test("webhook new / drop / title flags are independent", () => {
  assert.equal(shouldWebhookNotify(hookSettings, listing, { type: "new" }), true);
  assert.equal(
    shouldWebhookNotify({ ...hookSettings, webhookNotifyNew: false }, listing, { type: "new" }),
    false,
  );
  assert.equal(
    shouldWebhookNotify(
      { ...hookSettings, webhookNotifyPriceDrop: false },
      listing,
      { type: "price_drop", detail: "價格 28000 → 25000" },
    ),
    false,
  );
  assert.equal(
    shouldWebhookNotify(
      { ...hookSettings, webhookNotifyTitleUpdate: false },
      listing,
      { type: "title_update", detail: "標題變更" },
    ),
    false,
  );
  assert.equal(shouldWebhookNotify({ ...hookSettings, discordWebhook: "" }, listing, { type: "new" }), false);
});

test("in-app dock still uses the original new / same-source switches", () => {
  const settings = { notifyNew: true, notifySameSource: false, notifyViewed: false, notifyWatchedAlways: false };
  assert.equal(shouldDockNotify(settings, listing, "new"), true);
  assert.equal(shouldDockNotify(settings, listing, "price_drop"), false);
  assert.equal(shouldDockNotify({ ...settings, notifySameSource: true }, listing, "title_update"), true);
});

test("list last_event maps price drop and title to update", () => {
  assert.equal(listingLastEvent("price_drop", listing), "update");
  assert.equal(listingLastEvent("title_update", listing), "update");
  assert.equal(listingLastEvent("new", listing), "new");
  assert.equal(listingPriceNum({ price: "28,000" }), 28000);
});
