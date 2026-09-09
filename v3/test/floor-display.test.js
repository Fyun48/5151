import { test } from "node:test";
import assert from "node:assert/strict";
import { formatFloorDisplay } from "../src/floors.js";

test("floor display unifies to ( 3F / 8F )", () => {
  assert.equal(formatFloorDisplay("3/8"), "( 3F / 8F )");
  assert.equal(formatFloorDisplay("3F/8F"), "( 3F / 8F )");
  assert.equal(formatFloorDisplay("3樓/8樓"), "( 3F / 8F )");
  assert.equal(formatFloorDisplay("出租 4樓／共 4樓"), "( 4F / 4F )");
  assert.equal(formatFloorDisplay("5F/5F"), "( 5F / 5F )");
  assert.equal(formatFloorDisplay("22/24"), "( 22F / 24F )");
  assert.equal(formatFloorDisplay("B1/5F"), "( B1 / 5F )");
  assert.equal(formatFloorDisplay("4F"), "( 4F )");
  assert.equal(formatFloorDisplay(""), "");
});
