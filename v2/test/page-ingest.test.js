import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMapFromHtml, isTaiwanMapPin } from "../src/location.js";
import { clampConcurrency, mapPool } from "../src/pool.js";
import { LIST_PAGE_SIZE } from "../src/client591.js";

test("591 search pages are ingested in list-sized batches, not 40 browser windows", () => {
  assert.equal(LIST_PAGE_SIZE, 30);
  assert.equal(clampConcurrency(40, { fallback: 4, max: 8 }), 8);
  assert.equal(clampConcurrency("nope", { fallback: 4, max: 8 }), 4);
});

test("extracts Taiwan map pins and community addresses from listing HTML", () => {
  const html = `
    <html><body>
      <script>window.house = {"lat":"25.18252","lng":"121.44921"};</script>
      <div>地址 : 新北市淡水區淡金路二段173號</div>
    </body></html>
  `;
  const pin = extractMapFromHtml(html);
  assert.equal(pin.lat, 25.18252);
  assert.equal(pin.lng, 121.44921);
  assert.equal(pin.address, "新北市淡水區淡金路二段173號");
});

test("reads swapped lng/lat JSON and ignores non-Taiwan pins", () => {
  const html = `"lng":121.533,"lat":25.068 data-lat="40.7128" data-lng="-74.0060"`;
  const pin = extractMapFromHtml(html);
  assert.equal(pin.lat, 25.068);
  assert.equal(pin.lng, 121.533);
  assert.equal(isTaiwanMapPin(40.71, -74.0), false);
});

test("mapPool keeps at most N workers in flight", async () => {
  let current = 0;
  let max = 0;
  const out = await mapPool([1, 2, 3, 4, 5, 6], { concurrency: 3, gapMs: 0 }, async (n) => {
    current += 1;
    max = Math.max(max, current);
    await new Promise((resolve) => setTimeout(resolve, 20));
    current -= 1;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12]);
  assert.equal(max, 3);
});
