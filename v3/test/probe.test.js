import { test } from "node:test";
import assert from "node:assert/strict";
import { probeHtmlListingAlive, probeListingAliveBySource } from "../src/probe.js";

function mockFetch(fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = fn;
  return () => { globalThis.fetch = orig; };
}
const resp = ({ status = 200, url = "", body = "" }) => ({ status, ok: status >= 200 && status < 300, url, text: async () => body });

test("probeHtmlListingAlive: 404/410 → gone; other statuses conservative → alive", async () => {
  let restore = mockFetch(async () => resp({ status: 404 }));
  assert.equal(await probeHtmlListingAlive("https://x/detail"), false);
  restore();
  restore = mockFetch(async () => resp({ status: 410 }));
  assert.equal(await probeHtmlListingAlive("https://x/detail"), false);
  restore();
  for (const status of [403, 429, 500, 503]) {
    restore = mockFetch(async () => resp({ status }));
    assert.equal(await probeHtmlListingAlive("https://x/detail"), true, `status ${status} must be conservative alive`);
    restore();
  }
});

test("probeHtmlListingAlive: normal 200 → alive; explicit gone text → gone", async () => {
  let restore = mockFetch(async () => resp({ status: 200, url: "https://x/detail", body: "<html>正常出租物件 3房2廳</html>" }));
  assert.equal(await probeHtmlListingAlive("https://x/detail"), true);
  restore();
  restore = mockFetch(async () => resp({ status: 200, url: "https://x/detail", body: "<html>物件已下架</html>" }));
  assert.equal(await probeHtmlListingAlive("https://x/detail"), false);
  restore();
});

test("probeHtmlListingAlive: redirect to a 'gone' marker page → gone (housefun noobject)", async () => {
  const restore = mockFetch(async () => resp({ status: 200, url: "https://rent.housefun.com.tw/nosupport/noobject.aspx", body: "" }));
  assert.equal(await probeHtmlListingAlive("https://rent.housefun.com.tw/rent/house/1/", { redirectGoneMarkers: ["noobject"] }), false);
  restore();
});

test("probeHtmlListingAlive: network error/timeout → conservative alive", async () => {
  const restore = mockFetch(async () => { throw new Error("timeout"); });
  assert.equal(await probeHtmlListingAlive("https://x/detail"), true);
  restore();
});

test("probeListingAliveBySource: self and unknown sources are unsupported (no false offline)", async () => {
  assert.deepEqual(await probeListingAliveBySource({ source: "self", url: "#self-1" }), { supported: false, alive: null });
  assert.deepEqual(await probeListingAliveBySource({ source: "weird", url: "https://x/y" }), { supported: false, alive: null });
});

test("probeListingAliveBySource: external HTML platforms dispatch (404 → gone; 200 → alive)", async () => {
  for (const source of ["hbhousing", "sinyi", "ddroom", "housefun"]) {
    let restore = mockFetch(async () => resp({ status: 404 }));
    assert.deepEqual(await probeListingAliveBySource({ source, url: "https://x/detail" }), { supported: true, alive: false }, `${source} 404`);
    restore();
    restore = mockFetch(async () => resp({ status: 200, url: "https://x/detail", body: "<html>出租中</html>" }));
    assert.deepEqual(await probeListingAliveBySource({ source, url: "https://x/detail" }), { supported: true, alive: true }, `${source} 200`);
    restore();
  }
});

test("probeListingAliveBySource: housefun redirect to noobject → gone", async () => {
  const restore = mockFetch(async () => resp({ status: 200, url: "https://rent.housefun.com.tw/nosupport/noobject.aspx" }));
  assert.deepEqual(await probeListingAliveBySource({ source: "housefun", url: "https://rent.housefun.com.tw/rent/house/1/" }), { supported: true, alive: false });
  restore();
});
