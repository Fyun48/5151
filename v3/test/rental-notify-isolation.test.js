import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(dir, rel), "utf8");

test("listingScore and same-house match never import notify domain", () => {
  assert.doesNotMatch(read("../src/listingScore.js"), /rentalNotify|rentalShareGrowth|rentalSurvey/);
  assert.doesNotMatch(read("../src/match.js"), /rentalNotify|rentalShareGrowth|rentalSurvey/);
});

test("sortListingsRows body never reads notify domain", () => {
  const src = read("../src/db.js");
  const start = src.indexOf("export function sortListingsRows");
  const end = src.indexOf("const LIST_CANDIDATE_COLUMNS");
  assert.doesNotMatch(src.slice(start, end), /rentalNotify|rentalShareGrowth|rentalSurvey|rentalOpsAnalytics/);
});

test("notify orchestrator does not import ranking or offer transitions", () => {
  const src = read("../src/rentalNotify.js");
  assert.doesNotMatch(src, /listingScore|sortListingsRows|wishOfferTransitions|preferPrimaryListing/);
  const worker = read("../src/rentalNotifyWorker.js");
  assert.doesNotMatch(worker, /listingScore|sortListingsRows|wishOfferTransitions/);
});

test("PR B/C source files do not import notify orchestrator", () => {
  assert.doesNotMatch(read("../src/rentalMatch.js"), /rentalNotify|rentalShareGrowth|rentalSurvey/);
  assert.doesNotMatch(read("../src/wishOfferTransitions.js"), /rentalNotify|rentalShareGrowth|rentalSurvey/);
  assert.doesNotMatch(read("../src/wishOffers.js"), /rentalNotify|rentalShareGrowth|rentalSurvey/);
});
