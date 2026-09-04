import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCoverFromSearchUrl,
  coverContains,
  mergeCovers,
  uncoveredMembers,
  coversFromMemberSettings,
  coversFromWatchDistricts,
  coverToListUrl,
  coveringJobsFromMembers,
  coveringJobsFromSettings,
  listingInMemberScope,
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

test("coverToListUrl builds a newest-first 591 list search", () => {
  const url = coverToListUrl({
    regionId: 1,
    sectionIds: [9, 8],
    priceMin: 0,
    priceMax: 40000,
  });
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, "https://rent.591.com.tw/list");
  assert.equal(parsed.searchParams.get("region"), "1");
  assert.equal(parsed.searchParams.get("section"), "8,9");
  assert.equal(parsed.searchParams.get("price"), "_40000");
  assert.equal(parsed.searchParams.get("notice"), "not_cover");
  assert.equal(parsed.searchParams.get("order"), "posttime");
  assert.equal(parsed.searchParams.get("orderType"), "desc");
});

test("covering jobs collapse many member URLs into few newest list fetches", () => {
  const members = [
    ...Array.from({ length: 12 }, (_, i) => ({
      regionId: 1,
      sectionIds: i % 2 === 0 ? [8] : [9],
      priceMin: 0,
      priceMax: 20000 + i * 1000,
    })),
    ...Array.from({ length: 8 }, (_, i) => ({
      regionId: 3,
      sectionIds: i % 2 === 0 ? [26] : [38],
      priceMin: 0,
      priceMax: 18000 + i * 500,
    })),
  ];
  const jobs = coveringJobsFromMembers(members);
  assert.equal(jobs.length, 2);
  assert.equal(uncoveredMembers(members, jobs).length, 0);

  const taipei = jobs.find((item) => item.regionId === 1);
  const newTaipei = jobs.find((item) => item.regionId === 3);
  assert.deepEqual(taipei.sectionIds, [8, 9]);
  assert.equal(taipei.priceMax, 31000);
  assert.deepEqual(newTaipei.sectionIds, [26, 38]);
  assert.equal(newTaipei.priceMax, 21500);

  for (const job of jobs) {
    const parsed = new URL(job.searchUrl);
    assert.equal(parsed.searchParams.get("order"), "posttime");
    assert.equal(parsed.searchParams.get("orderType"), "desc");
    assert.equal(parsed.searchParams.get("region"), String(job.regionId));
    assert.equal(parsed.searchParams.get("section"), job.sectionIds.join(","));
  }
});

test("single-admin settings become one cover per city, not duplicated searchUrls", () => {
  const settings = {
    searchUrls: [
      "https://rent.591.com.tw/list?region=1&section=8&price=0_20000",
      "https://rent.591.com.tw/list?region=1&section=9&price=0_40000",
      "https://rent.591.com.tw/list?region=3&section=26&price=0_30000",
    ],
    watchDistricts: ["1-8", "1-9", "3-26"],
    priceMin: 0,
    priceMax: 40000,
    excludeRooftop: true,
  };
  const memberCovers = coversFromMemberSettings(settings);
  assert.ok(memberCovers.length >= 3);
  const jobs = coveringJobsFromSettings(settings);
  assert.equal(jobs.length, 2);
  const taipei = jobs.find((item) => item.regionId === 1);
  assert.deepEqual(taipei.sectionIds, [8, 9]);
  assert.equal(taipei.priceMax, 40000);
  assert.match(taipei.searchUrl, /order=posttime/);
  assert.match(taipei.searchUrl, /orderType=desc/);
});

test("listingInMemberScope only matches that member's city, district, and rent cap", () => {
  const settings = {
    watchDistricts: ["1-8"],
    priceMin: 0,
    priceMax: 25000,
  };
  const inScope = { source_key: "1|8|x", price_num: 22000 };
  const otherDistrict = { source_key: "1|9|x", price_num: 22000 };
  const tooExpensive = { source_key: "1|8|x", price_num: 40000 };
  const noSearch = { source_key: "1|8|x", price_num: 18000 };
  assert.equal(listingInMemberScope(inScope, settings), true);
  assert.equal(listingInMemberScope(otherDistrict, settings), false);
  assert.equal(listingInMemberScope(tooExpensive, settings), false);
  assert.equal(listingInMemberScope(noSearch, { watchDistricts: [], searchUrls: [] }), false);
});

test("system watch districts become covering jobs the same way as member picks", () => {
  const covers = coversFromWatchDistricts({ watchDistricts: ["1-8", "3-50"] });
  const jobs = coveringJobsFromMembers(covers, { excludeRooftop: true });
  assert.equal(covers.length, 2);
  assert.ok(jobs.some((job) => job.regionId === 1 && job.sectionIds.includes(8)));
  assert.ok(jobs.some((job) => job.regionId === 3 && job.sectionIds.includes(50)));
});
