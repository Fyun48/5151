import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listingFitScore } from "../src/listingScore.js";
import { preferPrimaryListing } from "../src/match.js";
import { sortListingsRows } from "../src/db.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(dir, rel), "utf8");

const FORBIDDEN = /rentalMatch|rentalMatchQuery|demand_posts|owner_matching|wishLifecycle/;

test("listingScore never imports matching domain", () => {
  const src = read("../src/listingScore.js");
  assert.doesNotMatch(src, FORBIDDEN);
});

test("same-house match.js never imports matching domain", () => {
  const src = read("../src/match.js");
  assert.doesNotMatch(src, FORBIDDEN);
});

test("sortListingsRows body never reads matching domain", () => {
  const src = read("../src/db.js");
  const start = src.indexOf("export function sortListingsRows");
  const end = src.indexOf("const LIST_CANDIDATE_COLUMNS");
  assert.doesNotMatch(src.slice(start, end), /rentalMatch|demand_posts|owner_matching|wishLifecycle/);
});

test("matching flag and wish volume do not change listing fit, sort, or primary", () => {
  const settings = { priceMin: 10000, priceMax: 30000, wholeFloorOnly: true };
  const a = {
    post_id: 1,
    price_num: 18000,
    kind_name: "整層住家",
    floor_name: "5/10",
    commute_km: 3,
    tags: '["有電梯"]',
    last_seen_at: "2026-09-01T00:00:00.000Z",
    first_seen_at: "2026-08-01T00:00:00.000Z",
    wish_count: 0,
    owner_matching_enabled: false,
  };
  const b = {
    ...a,
    post_id: 2,
    price_num: 24000,
    wish_count: 999,
    owner_matching_enabled: true,
    match_score: 100,
    rank_score: 9999,
  };
  assert.equal(listingFitScore(a, settings), listingFitScore({ ...a, wish_count: 88, owner_matching_enabled: true }, settings));
  const sortedOff = sortListingsRows([
    { ...a, fit_score: 40 },
    { ...b, fit_score: 90 },
  ], "fit_desc");
  const sortedOn = sortListingsRows([
    { ...a, fit_score: 40, owner_matching_enabled: true, rank_score: 1 },
    { ...b, fit_score: 90, owner_matching_enabled: true, rank_score: 9999 },
  ], "fit_desc");
  assert.deepEqual(sortedOff.map((row) => row.post_id), [2, 1]);
  assert.deepEqual(sortedOn.map((row) => row.post_id), [2, 1]);
  const newest = sortListingsRows([
    { ...a, last_seen_at: "2026-09-02T00:00:00.000Z" },
    { ...b, last_seen_at: "2026-09-01T00:00:00.000Z", rank_score: 9999 },
  ], "newest");
  assert.equal(newest[0].post_id, 1);
  assert.equal(preferPrimaryListing(a, b, Date.parse("2026-09-15T00:00:00.000Z")), a);
});
