import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCoverFromSearchUrl,
  coverContains,
  mergeCovers,
  uncoveredMembers,
} from "../src/covering.js";

test("a 40000 cover in the same districts contains a 20000 member search", () => {
  const existing = {
    regionId: 1,
    sectionIds: [8, 9],
    priceMin: 0,
    priceMax: 40000,
  };
  const member = parseCoverFromSearchUrl(
    "https://rent.591.com.tw/?regionid=1&section=8,9&price=0_20000",
  );
  assert.equal(member.regionId, 1);
  assert.deepEqual(member.sectionIds, [8, 9]);
  assert.equal(member.priceMax, 20000);
  assert.equal(coverContains(existing, member), true);
});

test("a cheaper-only cover does not satisfy a higher rent ceiling", () => {
  const existing = { regionId: 1, sectionIds: [8], priceMin: 0, priceMax: 20000 };
  const member = { regionId: 1, sectionIds: [8], priceMin: 0, priceMax: 40000 };
  assert.equal(coverContains(existing, member), false);
});

test("another city or extra district is not covered", () => {
  const taipei = { regionId: 1, sectionIds: [8], priceMin: 0, priceMax: 40000 };
  assert.equal(coverContains(taipei, { regionId: 3, sectionIds: [8], priceMin: 0, priceMax: 20000 }), false);
  assert.equal(coverContains(taipei, { regionId: 1, sectionIds: [8, 9], priceMin: 0, priceMax: 20000 }), false);
});

test("mergeCovers unions districts and widens rent in the same city", () => {
  const jobs = mergeCovers([
    { regionId: 1, sectionIds: [8], priceMin: 0, priceMax: 20000 },
    { regionId: 1, sectionIds: [9], priceMin: 0, priceMax: 40000 },
    { regionId: 3, sectionIds: [26], priceMin: 0, priceMax: 30000 },
  ]);
  assert.equal(jobs.length, 2);
  const taipei = jobs.find((item) => item.regionId === 1);
  const newTaipei = jobs.find((item) => item.regionId === 3);
  assert.deepEqual(taipei.sectionIds, [8, 9]);
  assert.equal(taipei.priceMax, 40000);
  assert.deepEqual(newTaipei.sectionIds, [26]);
  assert.equal(newTaipei.priceMax, 30000);
});

test("20 members in taipei/new taipei collapse to two crawl jobs", () => {
  const members = [
    ...Array.from({ length: 12 }, () => ({ regionId: 1, sectionIds: [8, 3], priceMin: 0, priceMax: 25000 })),
    ...Array.from({ length: 8 }, () => ({ regionId: 3, sectionIds: [26, 38], priceMin: 0, priceMax: 32000 })),
  ];
  const jobs = mergeCovers(members);
  assert.equal(jobs.length, 2);
  assert.equal(uncoveredMembers(members, jobs).length, 0);
});
