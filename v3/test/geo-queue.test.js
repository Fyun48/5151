import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addressVersion,
  createGeoQueue,
  inferGeoQuality,
  shouldRefreshGeo,
  watchGeoPriority,
} from "../src/geoQueue.js";

test("incomplete address is never treated as house-level quality", () => {
  assert.equal(inferGeoQuality({ address: "新北市淡水區淡金路二段173號" }), "house");
  assert.equal(inferGeoQuality({ address: "台北市士林區天玉街9巷" }), "street");
  assert.equal(inferGeoQuality({ address: "新北市淡水區淡金路二段" }), "street");
  assert.equal(inferGeoQuality({ address: "新北市淡水區" }), "district");
  assert.equal(inferGeoQuality({ address: "附近" }), "unknown");
});

test("cache is reused until address version, quality or TTL requires refresh", () => {
  const address = "新北市淡水區淡金路二段173號";
  const fresh = {
    lat: 25.16,
    lng: 121.44,
    quality: "house",
    address_version: addressVersion(address),
    updated_at: new Date().toISOString(),
  };
  assert.equal(shouldRefreshGeo(fresh, address), false);
  assert.equal(shouldRefreshGeo(fresh, "新北市淡水區中正路1號"), true);
  assert.equal(shouldRefreshGeo({ ...fresh, quality: "district" }, address), true);
  assert.equal(shouldRefreshGeo({ ...fresh, updated_at: "2010-01-01T00:00:00.000Z" }, address), true);
});

test("watched listings jump the queue and incomplete addresses are skipped", () => {
  const calls = [];
  const q = createGeoQueue({
    concurrency: 1,
    lookup: () => null,
    geocode: async (address) => {
      calls.push(address);
      return { lat: 25, lng: 121 };
    },
  });
  assert.equal(q.enqueue({ address: "附近", priority: 1 }), false);
  q.enqueue({ address: "新北市淡水區中正路1號", priority: 10 });
  q.enqueue({ address: "台北市士林區德行西路7號", watched: true });
  assert.equal(q.peek().priority, watchGeoPriority(true));
  assert.match(q.peek().address, /德行西路/);
});
