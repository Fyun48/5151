import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultNotifyMatrix,
  eventMatrixKey,
  normalizeNotifyMatrix,
  notifyChannelOn,
} from "../src/notifyMatrix.js";

test("event types map onto matrix rows", () => {
  assert.equal(eventMatrixKey("price_drop"), "price");
  assert.equal(eventMatrixKey("price_update"), "price");
  assert.equal(eventMatrixKey("title_update"), "title");
  assert.equal(eventMatrixKey("new"), "new");
  assert.equal(eventMatrixKey("seen"), "");
});

test("legacy webhook flags migrate when matrix is absent", () => {
  const matrix = normalizeNotifyMatrix({
    webhookNotifyNew: false,
    webhookNotifyPriceDrop: false,
    notifyNew: true,
  });
  assert.equal(matrix.new.webhook, false);
  assert.equal(matrix.price.webhook, false);
  assert.equal(matrix.new.dock, true);
  assert.equal(matrix.update.dock, true);
});

test("explicit matrix false is kept", () => {
  const matrix = normalizeNotifyMatrix({
    notifyMatrix: { new: { dock: false, webhook: true } },
  });
  assert.equal(matrix.new.dock, false);
  assert.equal(matrix.new.webhook, true);
  assert.equal(matrix.offline.dock, true);
});

test("notifyChannelOn defaults on and respects uncheck", () => {
  assert.equal(notifyChannelOn({}, "dock", "new"), true);
  assert.equal(
    notifyChannelOn({ notifyMatrix: { new: { dock: false, webhook: true } } }, "dock", "new"),
    false,
  );
  assert.equal(notifyChannelOn({ notifyMatrix: defaultNotifyMatrix() }, "webhook", "update"), true);
});
