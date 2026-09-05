import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { listingFitFields, listingFitLabel, listingFitScore } from "../src/listingScore.js";
import { getCrawlSources, sortListingsRows } from "../src/db.js";

const settings = {
  priceMin: 15000,
  priceMax: 30000,
  wholeFloorOnly: true,
  excludeLowFloors: true,
  minBuildingFloors: 4,
  commuteKm: 8,
  workLat: 25.09,
  workLng: 121.52,
};

test("fit score rewards in-budget whole-floor homes and penalizes suites over rent", () => {
  const good = listingFitScore({
    price_num: 25000,
    kind_name: "整層住家",
    floor_name: "5/10",
    commute_km: 3,
    tags: '["有電梯"]',
  }, settings);
  const poor = listingFitScore({
    price_num: 45000,
    kind_name: "獨立套房",
    floor_name: "1/3",
    commute_km: 20,
  }, settings);
  assert.ok(good >= 75, `expected high fit, got ${good}`);
  assert.ok(poor <= 40, `expected low fit, got ${poor}`);
  assert.equal(listingFitLabel(82), "較適合");
  assert.equal(listingFitLabel(60), "尚可");
  assert.equal(listingFitLabel(20), "較不合");
  const fields = listingFitFields({
    price_num: 25000,
    kind_name: "整層住家",
    floor_name: "5/10",
    commute_km: 3,
  }, settings);
  assert.equal(fields.fit_label, listingFitLabel(fields.fit_score));
});

test("fit_desc sorts higher scores first", () => {
  const rows = sortListingsRows(
    [
      { post_id: 1, fit_score: 40, price_num: 10000 },
      { post_id: 2, fit_score: 90, price_num: 28000 },
      { post_id: 3, fit_score: 70, price_num: 22000 },
    ],
    "fit_desc",
  );
  assert.deepEqual(rows.map((row) => row.post_id), [2, 3, 1]);
});

test("decorateListing strips model_score and attaches fit fields", () => {
  const dbSrc = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/db.js"), "utf8");
  assert.match(dbSrc, /listingFitFields/);
  assert.match(dbSrc, /model_score: _modelScore/);
  assert.match(dbSrc, /\.\.\.fit/);
  assert.doesNotMatch(dbSrc, /fit_score:\s*row\.model_score/);
});

test("listListings cheap-filters then attaches same-house only on the page slice", () => {
  const dbSrc = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/db.js"), "utf8");
  const listFn = dbSrc.slice(dbSrc.indexOf("export function listListings"), dbSrc.indexOf("export function sourceHistory"));
  assert.match(listFn, /decorateListingLite/);
  assert.match(listFn, /finalizeListingDecorate/);
  assert.match(listFn, /sameHouse: true/);
  assert.doesNotMatch(listFn, /\.map\(\(row\) => decorateListing\(/);
  assert.match(listFn, /attachSameHouseRoles/);
  assert.match(listFn, /needFit \? row : decorateListingLite/);
  assert.doesNotMatch(listFn, /applyListingFilter\([\s\S]*?\)\.map\(\(row\) => decorateListingLite/);
  assert.ok(listFn.indexOf("attachSameHouseRoles") < listFn.indexOf("listingMatchesListFilter"));
  assert.ok(listFn.indexOf("listingMatchesListFilter") < listFn.indexOf("sortListingsRows"));
  assert.ok(listFn.indexOf("sortListingsRows") < listFn.indexOf("finalizeListingDecorate"));
  assert.ok(listFn.indexOf("rows.slice(0, limit)") < listFn.indexOf("finalizeListingDecorate"));
});

test("getCrawlSources is wired so listing lists can load", () => {
  const { items } = getCrawlSources();
  assert.ok(items.some((row) => row.id === "591" && row.enabled));
});
