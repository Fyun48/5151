import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addressHasPrecisePart,
  addressPrecision,
  communityMapsQuery,
  communityMapsUrl,
  extractTaiwanStreetAddress,
  pickRicherAddress,
  preferListingAddress,
  sourceCommunityLinked,
} from "../src/location.js";

test("alley addresses beat street-only list addresses", () => {
  assert.ok(addressPrecision("台北市士林區天玉街9巷") > addressPrecision("台北市士林區天玉街"));
  assert.equal(addressHasPrecisePart("台北市士林區天玉街9巷"), true);
  assert.equal(addressHasPrecisePart("台北市士林區天玉街"), false);
  assert.equal(
    pickRicherAddress(["台北市士林區天玉街", "台北市士林區天玉街9巷", "士林區天玉街"]),
    "台北市士林區天玉街9巷",
  );
  assert.equal(
    preferListingAddress("台北市士林區天玉街", "台北市士林區天玉街9巷"),
    "台北市士林區天玉街9巷",
  );
  assert.match(extractTaiwanStreetAddress("位於台北市士林區天玉街9巷租金28000"), /天玉街9巷/);
});

test("alley plus lane beats street-only and is not truncated at 巷", () => {
  assert.ok(addressPrecision("台北市士林區中山北路六段172巷22弄") > addressPrecision("台北市士林區中山北路六段"));
  assert.equal(addressHasPrecisePart("台北市士林區中山北路六段172巷22弄"), true);
  assert.equal(
    pickRicherAddress(["台北市士林區中山北路六段", "台北市士林區中山北路六段172巷", "台北市士林區中山北路六段172巷22弄"]),
    "台北市士林區中山北路六段172巷22弄",
  );
  assert.equal(
    preferListingAddress("台北市士林區中山北路六段", "台北市士林區中山北路六段172巷22弄", "community"),
    "台北市士林區中山北路六段172巷22弄",
  );
  assert.equal(
    preferListingAddress("台北市士林區中山北路六段172巷22弄", "台北市士林區中山北路六段", "community"),
    "台北市士林區中山北路六段172巷22弄",
  );
  assert.match(extractTaiwanStreetAddress("地址／台北市士林區中山北路六段172巷22弄"), /172巷22弄/);
});

test("community Google Maps query uses city plus district plus name", () => {
  assert.equal(communityMapsQuery("御陽明", "台北市士林區格致路"), "台北市士林區御陽明");
  assert.match(communityMapsUrl("御陽明", "台北市士林區格致路"), /maps\/search/);
  assert.equal(sourceCommunityLinked({ communityId: 28702 }), true);
  assert.equal(sourceCommunityLinked({ hasAnchor: true }), true);
  assert.equal(sourceCommunityLinked({ communityId: 0, hasAnchor: false }), false);
});
