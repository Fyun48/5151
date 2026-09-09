import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addressHasPrecisePart,
  addressPrecision,
  extractTaiwanStreetAddress,
  pickRicherAddress,
  preferListingAddress,
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
