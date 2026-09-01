import { test } from "node:test";
import assert from "node:assert/strict";
import { isListingGoneResponse, ListingGoneError, isListingGoneError } from "../src/client591.js";

test("treats 591 物件不存在 JSON as gone", () => {
  assert.equal(isListingGoneResponse({ status: 0, msg: "物件不存在", data: "" }, 200), true);
});

test("treats HTTP 404 as gone", () => {
  assert.equal(isListingGoneResponse({}, 404), true);
});

test("does not treat a live listing payload as gone", () => {
  assert.equal(
    isListingGoneResponse({ status: 1, msg: "", data: { status: "open", title: "Park99" } }, 200),
    false,
  );
});

test("does not treat a temporary 591 error as gone", () => {
  assert.equal(isListingGoneResponse({ status: 0, msg: "請稍後再試", data: "" }, 200), false);
  assert.equal(isListingGoneResponse({ status: 0, msg: "591 詳情失敗" }, 500), false);
});

test("ListingGoneError is detectable after catch", () => {
  const err = new ListingGoneError("物件不存在");
  assert.equal(isListingGoneError(err), true);
  assert.equal(isListingGoneError(new Error("591 詳情 503")), false);
});
