import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listingRedirectTarget,
  publicBaseUrl,
  rent591Url,
  trackedListingPath,
  trackedListingUrl,
} from "../src/openLink.js";

test("rent591Url builds canonical listing page", () => {
  assert.equal(rent591Url(12345678), "https://rent.591.com.tw/12345678");
  assert.equal(rent591Url("bad"), "https://rent.591.com.tw/0");
});

test("trackedListingPath is relative /go/:id", () => {
  assert.equal(trackedListingPath(99), "/go/99");
});

test("trackedListingUrl prefers PUBLIC_BASE_URL when set", () => {
  const prev = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = "https://a5151.reversalplay.me/";
  try {
    assert.equal(publicBaseUrl(), "https://a5151.reversalplay.me");
    assert.equal(
      trackedListingUrl(123, "https://rent.591.com.tw/123"),
      "https://a5151.reversalplay.me/go/123",
    );
  } finally {
    if (prev === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = prev;
  }
});

test("trackedListingUrl falls back to 591 when base unset", () => {
  const prevBase = process.env.PUBLIC_BASE_URL;
  const prevApp = process.env.APP_URL;
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.APP_URL;
  try {
    assert.equal(
      trackedListingUrl(456, "https://rent.591.com.tw/456"),
      "https://rent.591.com.tw/456",
    );
    assert.equal(trackedListingUrl(789), "https://rent.591.com.tw/789");
  } finally {
    if (prevBase === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = prevBase;
    if (prevApp === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = prevApp;
  }
});

test("listingRedirectTarget keeps self on-site and 住商 on stored url", () => {
  assert.equal(listingRedirectTarget({ source: "self" }, 2100000001), "/?self=2100000001");
  assert.equal(
    listingRedirectTarget({
      source: "hbhousing",
      url: "https://www.hbhousing.com.tw/detail?sn=ZR204342",
    }, 2200000001),
    "https://www.hbhousing.com.tw/detail?sn=ZR204342",
  );
  assert.equal(listingRedirectTarget(null, 15801234), "https://rent.591.com.tw/15801234");
});
