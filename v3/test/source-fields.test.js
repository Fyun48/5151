import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FIELD_STATUS,
  SOURCE_FIELD_MATRIX,
  fieldStatus,
  preferKeptValue,
} from "../src/sourceFields.js";

test("source-field matrix covers the live source keys", () => {
  const keys = SOURCE_FIELD_MATRIX.map((row) => row.source);
  for (const key of ["591", "hbhousing", "sinyi", "houseprice", "ddroom", "housefun", "self", "rakuya"]) {
    assert.ok(keys.includes(key), key);
  }
  const rakuya = SOURCE_FIELD_MATRIX.find((row) => row.source === "rakuya");
  assert.equal(rakuya.fields.address, "parsed");
  assert.equal(rakuya.fields.contact, "not_provided");
});

test("empty incoming values do not wipe richer stored values", () => {
  assert.equal(preferKeptValue("", "新北市淡水區淡金路二段173號"), "新北市淡水區淡金路二段173號");
  assert.equal(preferKeptValue("台北市士林區中正路1號", "舊址"), "台北市士林區中正路1號");
  assert.deepEqual(preferKeptValue([], ["a.jpg"]), ["a.jpg"]);
});

test("field status distinguishes missing, not fetched and parse failed", () => {
  assert.equal(fieldStatus("淡水", { fetched: true }), FIELD_STATUS.PARSED);
  assert.equal(fieldStatus("", { fetched: true }), FIELD_STATUS.NOT_PROVIDED);
  assert.equal(fieldStatus("", { fetched: false }), FIELD_STATUS.NOT_FETCHED);
  assert.equal(fieldStatus("", { parseFailed: true }), FIELD_STATUS.PARSE_FAILED);
});
