import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

test("K: member listListings filter contract is still the baseline file", () => {
  const regression = readFileSync(path.join(dir, "list-query-regression.test.js"), "utf8");
  assert.match(regression, /every sorted page uses the complete filtered set/);
  assert.match(regression, /personal merge, flags and notes stay isolated/);
  assert.match(regression, /attribute filtering before route lookup/);
  assert.match(regression, /district candidates preserve legacy keys/);
  const listFn = readFileSync(path.join(dir, "../src/db.js"), "utf8");
  const member = listFn.slice(listFn.indexOf("export function listListings"), listFn.indexOf("export function publicSearchSettings"));
  assert.match(member, /memberRegionDistrictNames/);
  assert.match(member, /passesDisplayFilters/);
  assert.match(member, /applyListingFilter/);
  assert.doesNotMatch(member, /listPublicListings/);
  const pub = listFn.slice(listFn.indexOf("export function listPublicListings"), listFn.indexOf("export function runSameHouseBackfill"));
  assert.match(pub, /searchWhere\(\[\]/);
  assert.doesNotMatch(pub, /defaultUserId\(/);
  assert.doesNotMatch(pub, /resolveUserId/);
});
