import { test } from "node:test";
import assert from "node:assert/strict";
import { districtNameFromListing } from "../src/regions.js";

test("resolves New Taipei district from source_key even without 區 in address", () => {
  assert.equal(
    districtNameFromListing({
      address: "將捷之森",
      source_key: "3|50|c101675|將捷之森|11|15.5|2房",
    }),
    "淡水區",
  );
  assert.equal(
    districtNameFromListing({
      address: "五股成泰路一段",
      source_key: "3|48||五股成泰路一段|2|30|3房",
    }),
    "五股區",
  );
  assert.equal(
    districtNameFromListing({
      address: "蘆洲區永樂街",
      source_key: "3|47||蘆洲區永樂街|3|20|2房",
    }),
    "蘆洲區",
  );
});

test("resolves Taipei district from source_key and address", () => {
  assert.equal(
    districtNameFromListing({
      address: "士林區文林路",
      source_key: "1|8||士林區文林路|4|20|2房",
    }),
    "士林區",
  );
  assert.equal(
    districtNameFromListing({
      regionid: 1,
      sectionid: 9,
      address: "奇岩路",
    }),
    "北投區",
  );
});

test("matches short road address without 區 suffix", () => {
  assert.equal(
    districtNameFromListing({
      address: "八里龍形路一段",
      source_key: "",
    }),
    "八里區",
  );
});
