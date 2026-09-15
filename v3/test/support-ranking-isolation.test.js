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

const FORBIDDEN = /supportDomain|supportProviders|support\.js|support_sponsor|support_transaction|from ["']\.\/support/;

test("listing fit score source never imports Support domain", () => {
  const src = read("../src/listingScore.js");
  assert.doesNotMatch(src, FORBIDDEN);
  assert.doesNotMatch(src, /sponsor_amount|corporate_sponsor/);
});

test("duplicate primary selection source never imports Support domain", () => {
  const src = read("../src/match.js");
  assert.doesNotMatch(src, FORBIDDEN);
  const start = src.indexOf("export function preferPrimaryListing");
  const end = src.indexOf("export function sortGroupListings");
  assert.doesNotMatch(src.slice(start, end), /sponsor|support/i);
});

test("listing sort function does not read Support or Sponsor fields", () => {
  const src = read("../src/db.js");
  assert.doesNotMatch(src, /from ["']\.\/support\.js["']/);
  assert.doesNotMatch(src, /from ["']\.\/supportDomain/);
  assert.doesNotMatch(src, /from ["']\.\/supportProviders/);
  const start = src.indexOf("export function sortListingsRows");
  const end = src.indexOf("const LIST_CANDIDATE_COLUMNS");
  const fn = src.slice(start, end);
  assert.doesNotMatch(fn, /support_|sponsor_/);
  assert.match(src, /ensureSupportSchema/);
});

test("Support amounts on a listing do not change fit, sort, or primary choice", () => {
  const settings = { priceMin: 10000, priceMax: 30000, wholeFloorOnly: true };
  const base = {
    post_id: 1,
    price_num: 20000,
    kind_name: "整層住家",
    floor_name: "5/10",
    commute_km: 3,
    tags: '["有電梯"]',
    last_seen_at: "2026-09-01T00:00:00.000Z",
  };
  const boosted = { ...base, sponsor_amount: 99999, support_net: 8888, corporate_sponsor: true };
  assert.equal(listingFitScore(base, settings), listingFitScore(boosted, settings));
  const sorted = sortListingsRows([
    { ...base, post_id: 2, fit_score: 40, sponsor_amount: 99999 },
    { ...base, post_id: 3, fit_score: 90, sponsor_amount: 0 },
  ], "fit_desc");
  assert.deepEqual(sorted.map((row) => row.post_id), [3, 2]);
  const cheap = { ...base, post_id: 10, price_num: 18000 };
  const expensiveSponsored = { ...base, post_id: 11, price_num: 24000, sponsor_amount: 50000 };
  assert.equal(preferPrimaryListing(cheap, expensiveSponsored, Date.parse("2026-09-15T00:00:00.000Z")), cheap);
});
