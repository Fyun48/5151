import { test } from "node:test";
import assert from "node:assert/strict";
import { isAtOrBelowFirstFloor, isRooftopAddition, passesDisplayFilters } from "../src/floors.js";

// Regression：非 591 來源（住商/信義/5168/租租通）樓層常寫成 "current/total" 且不帶 F/樓，
// 例如 "1/4"、"1/12" 或裸數字 "1"，過去導致「排除 1F 及地下室」失效仍出現 1 樓。
test("excludes 1F written without F/樓 suffix (multi-source formats)", () => {
  for (const f of ["1/4", "1/12", "1/5", "1", "1-2/2", "1~3F/10F", "1F/5F", "1樓/4樓", "一樓/4樓", "騎樓/4F", "地面/4F"]) {
    assert.equal(isAtOrBelowFirstFloor(f), true, `expected ${f} to be treated as 1F/低樓`);
  }
});

test("excludes basement floors", () => {
  for (const f of ["B1/5F", "B2/4F", "B1-1/6", "地下/5F", "半地下/3F", "B1"]) {
    assert.equal(isAtOrBelowFirstFloor(f), true, `expected ${f} to be basement`);
  }
});

test("does NOT misclassify 10F / 11F / 21F and other higher floors", () => {
  for (const f of ["10F", "11F", "21F", "10F/12F", "11F/14F", "21F/30F", "5/12", "4/8", "6/12", "12/12", "整棟", "", "夾層/5F"]) {
    assert.equal(isAtOrBelowFirstFloor(f), false, `expected ${f} NOT to be 1F/低樓`);
  }
});

test("passesDisplayFilters excludes 1F '1/4' when excludeLowFloors on; keeps 10F", () => {
  const low = { kind_name: "整層住家", floor_name: "1/4", area_name: "18坪" };
  const high = { kind_name: "整層住家", floor_name: "10/12", area_name: "18坪" };
  const settings = { excludeLowFloors: true, excludeRooftop: true, minBuildingFloors: 0 };
  assert.equal(passesDisplayFilters(low, settings), false);
  assert.equal(passesDisplayFilters(high, settings), true);
  // 關閉排除時，1F 應可出現
  assert.equal(passesDisplayFilters(low, { excludeLowFloors: false, excludeRooftop: true, minBuildingFloors: 0 }), true);
});

test("rooftop addition (頂樓加蓋/頂加) still excluded via text signals", () => {
  assert.equal(isRooftopAddition({ floor_name: "頂樓加蓋" }), true);
  assert.equal(isRooftopAddition({ floor_name: "5/12", title: "頂加出租" }), true);
  assert.equal(isRooftopAddition({ floor_name: "5F/12F" }), false);
  const settings = { excludeLowFloors: true, excludeRooftop: true, minBuildingFloors: 0 };
  assert.equal(passesDisplayFilters({ kind_name: "套房", floor_name: "頂樓加蓋", area_name: "8坪" }, settings), false);
});
