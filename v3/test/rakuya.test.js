import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchRakuyaCoveringListings,
  fetchRakuyaListPage,
  interpretRakuyaResponse,
  isRakuyaListingId,
  normalizeRakuyaItem,
  parseRakuyaDetailHtml,
  parseRakuyaListHtml,
  rakuyaPostIdFromEhid,
} from "../src/rakuya.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const readFix = (name) => readFileSync(path.join(dir, "fixtures", name), "utf8");

test("rakuya list fixture extracts public cards", () => {
  const items = parseRakuyaListHtml(readFix("rakuya-list.html"));
  assert.equal(items.length, 2);
  assert.equal(items[0].ehid, "rk001");
  assert.match(items[0].title, /淡水河岸/);
  assert.match(items[0].address, /淡金路二段173號/);
  assert.match(items[0].price, /18,000/);
  assert.equal(items[0].field_status.address, "parsed");
});

test("rakuya detail fixture keeps raw and normalized fields", () => {
  const detail = parseRakuyaDetailHtml(readFix("rakuya-detail.html"), "https://www.rakuya.com.tw/rent_item/info?ehid=rk001");
  assert.equal(detail.ehid, "rk001");
  assert.match(detail.address, /淡金路二段173號/);
  assert.equal(detail.community, "河岸花園");
  assert.equal(detail.age, "8年");
  assert.equal(detail.elevator, "有");
  assert.equal(detail.lat, 25.18252);
  assert.equal(detail.lng, 121.44921);
  assert.ok(detail.photos.some((url) => /detail-a/.test(url)));
  const row = normalizeRakuyaItem({ ...detail, cover: detail.photos[0], refresh: "2026-09-01" }, { regionId: 3, sectionId: 50 });
  assert.equal(row.source, "rakuya");
  assert.equal(row.source_id, "rk001");
  assert.equal(row.address_raw, row.address);
  assert.equal(row.price_num, 18000);
  assert.equal(row.geo_source, "rakuya");
  assert.equal(row.lat, 25.18252);
  assert.equal(isRakuyaListingId(row.post_id), true);
  assert.equal(row.post_id, rakuyaPostIdFromEhid("rk001"));
});

test("missing fields are marked missing, not invented", () => {
  const detail = parseRakuyaDetailHtml(readFix("rakuya-missing.html"), "https://www.rakuya.com.tw/rent_item/info?ehid=rk009");
  assert.equal(detail.address, "");
  assert.equal(detail.price, "");
  assert.equal(detail.field_status.address, "missing");
  assert.equal(detail.field_status.price, "missing");
});

test("cloudflare / captcha / 429 stay blocked and retryable only for rate limit", () => {
  const blocked = interpretRakuyaResponse({ status: 200, text: readFix("rakuya-cloudflare.html") });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "FETCH_BLOCKED");
  assert.equal(blocked.retryable, false);
  const limited = interpretRakuyaResponse({ status: 429, text: "slow down" });
  assert.equal(limited.code, "RATE_LIMITED");
  assert.equal(limited.retryable, true);
  const gone = interpretRakuyaResponse({ status: 404, text: "not found" });
  assert.equal(gone.code, "SOURCE_UNAVAILABLE");
});

test("fetchRakuyaListPage does not pretend success when Cloudflare blocks", async () => {
  const got = await fetchRakuyaListPage({
    url: "https://www.rakuya.com.tw/rent_search/index",
    fetchText: async () => ({ status: 200, text: readFix("rakuya-cloudflare.html") }),
  });
  assert.equal(got.ok, false);
  assert.equal(got.code, "FETCH_BLOCKED");
  assert.deepEqual(got.items, []);
});

test("covering fetch uses injected fetcher and normalizes listings", async () => {
  const batches = await fetchRakuyaCoveringListings(
    [{ regionId: 3, sectionIds: [50] }],
    {
      fetchText: async () => ({ status: 200, text: readFix("rakuya-list.html") }),
      pageGapMs: 0,
    },
  );
  assert.equal(batches[0].listings.length, 1);
  assert.equal(batches[0].listings[0].source, "rakuya");
  assert.match(batches[0].listings[0].url, /\/item\/rk001/);
  assert.match(batches[0].searchUrl, /region=3&section=50/);
  assert.match(batches[0].listings[0].source_key, /^3\|50\|/);
});
