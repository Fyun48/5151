import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyNaturalGas,
  listingHasBalcony,
  listingHasNaturalGas,
  listingKitFrom,
  mergeKitColumns,
  parseFurnishItems,
} from "../src/listingKit.js";
import {
  applyHousingQueryChip,
  defaultHousingQuery,
  elevatorRequired,
  kindsToQuery,
  migrateHousingKinds,
  normalizeDistrictSelection,
  queryToKinds,
  toggleHousingKind,
} from "../src/housingQuery.js";
import {
  listingHasElevator,
  listingIsApartment,
  listingIsBuilding,
  listingIsUnspecifiedWholeFloor,
  listingIsShop,
  listingIsWarehouse,
  matchesHousingKind,
  normalizeListQuery,
} from "../src/floors.js";
import {
  hasListingMainContent,
  looksLikeCaptchaOrLogin,
  looksLikeUnavailable,
} from "../src/importSanitize.js";
import { interpretRakuyaResponse, normalizeRakuyaItem } from "../src/rakuya.js";

test("F01 natural gas uses negation and does not treat 有瓦斯 as 天然瓦斯", () => {
  assert.equal(listingHasNaturalGas({ text: "無天然瓦斯" }), false);
  assert.equal(classifyNaturalGas({ text: "無天然瓦斯" }).state, "known");
  assert.equal(listingHasNaturalGas({ text: "有瓦斯" }), false);
  assert.equal(classifyNaturalGas({ text: "有瓦斯" }).state, "unknown");
  assert.equal(listingHasNaturalGas({ text: "可開伙" }), false);
  assert.equal(listingHasNaturalGas({ tags: ["天然瓦斯"] }), true);
  assert.equal(listingHasNaturalGas({ text: "瓦斯：有" }), false);
});

test("F02 furnish scan ignores negated appliances", () => {
  assert.deepEqual(parseFurnishItems({ text: "不附冰箱，無冷氣" }), []);
  assert.deepEqual(parseFurnishItems({ title: "洗衣機可自行購買" }), []);
  assert.deepEqual(parseFurnishItems({ title: "附冰箱與洗衣機，可開伙" }), ["冰箱", "洗衣機"]);
});

test("F03 gas stove and heater stay as furnish and do not imply natural gas", () => {
  const kit = listingKitFrom({ furnish: ["瓦斯爐", "瓦斯熱水器", "電熱水器"], kit_complete: true });
  assert.deepEqual(kit.furnish_items, ["瓦斯爐", "瓦斯熱水器", "電熱水器"]);
  assert.equal(kit.has_natural_gas, false);
  assert.equal(kit.furnish_items.includes("熱水器"), false);
});

test("F04 elevator and 華廈 classification", () => {
  assert.equal(listingHasElevator({ kind_name: "整層住家／電梯大廈" }), true);
  assert.equal(listingHasElevator({ kind_name: "整層住家／電梯華廈" }), true);
  assert.equal(listingIsApartment({ kind_name: "整層住家／華廈" }), true);
  assert.equal(listingIsApartment({ kind_name: "整層住家／電梯華廈" }), true);
  assert.equal(listingIsBuilding({ kind_name: "整層住家／大樓" }), true);
  assert.equal(listingHasElevator({ kind_name: "整層住家／大樓" }), true);
  assert.equal(listingHasElevator({ title: "社區垃圾大樓服務", kind_name: "整層住家／公寓" }), false);
  assert.equal(listingHasElevator({ kind_name: "公寓", tags: ["無電梯"] }), false);
  assert.equal(listingIsBuilding({ title: "電梯大樓", kind_name: "整層住家", tags: ["電梯大樓"] }), true);
});

test("unspecified 整層住家 belongs to 大樓/公寓/店面/倉庫 and 大樓+電梯", () => {
  const bare = { kind_name: "整層住家" };
  const wholeOnly = { kind_name: "整層" };
  assert.equal(listingIsUnspecifiedWholeFloor(bare), true);
  assert.equal(listingIsUnspecifiedWholeFloor(wholeOnly), true);
  assert.equal(listingIsUnspecifiedWholeFloor({ kind_name: "整層住家／公寓" }), false);
  assert.equal(listingIsUnspecifiedWholeFloor({ kind_name: "整層住家／大樓" }), false);
  assert.equal(listingIsBuilding(bare), true);
  assert.equal(listingIsApartment(bare), true);
  assert.equal(listingIsShop(bare) || listingIsUnspecifiedWholeFloor(bare), true);
  assert.equal(listingIsWarehouse(bare) || listingIsUnspecifiedWholeFloor(bare), true);
  assert.equal(matchesHousingKind(bare, "building"), true);
  assert.equal(matchesHousingKind(bare, "building,elevator"), true);
  assert.equal(matchesHousingKind(bare, "apartment_huaxia"), true);
  assert.equal(matchesHousingKind(bare, "shop"), true);
  assert.equal(matchesHousingKind(bare, "warehouse"), true);
  assert.equal(matchesHousingKind({ kind_name: "整層住家／公寓" }, "building"), false);
  assert.equal(matchesHousingKind({ kind_name: "整層住家／大樓" }, "building"), true);
  assert.equal(matchesHousingKind({ kind_name: "整層住家", tags: ["無電梯"] }, "building,elevator"), false);
  assert.equal(listingIsBuilding({ title: "社區垃圾大樓服務", kind_name: "整層住家／公寓" }), false);
});

test("F05 elevator is AND; whole and shop can coexist", () => {
  const walkup = { title: "無電梯公寓", kind_name: "整層住家／公寓", tags: ["無電梯"] };
  assert.equal(matchesHousingKind(walkup, "elevator,apartment_huaxia"), false);
  assert.equal(matchesHousingKind({ kind_name: "整層住家／店面" }, "whole,shop"), true);
  assert.deepEqual(toggleHousingKind(["whole"], "shop"), ["whole", "shop"]);
  assert.deepEqual(toggleHousingKind(["suite_shared"], "warehouse"), ["warehouse"]);
  const afterWarehouse = applyHousingQueryChip(kindsToQuery(["suite_shared"]), "warehouse");
  assert.equal(afterWarehouse.hint, "已取消套房/分租");
  assert.equal(elevatorRequired(kindsToQuery(["building"])), true);
  assert.equal(matchesHousingKind({ title: "電梯大樓", kind_name: "整層住家／電梯大樓" }, "elevator,apartment_huaxia"), false);
  assert.equal(matchesHousingKind({ title: "電梯大樓", kind_name: "整層住家／電梯大樓" }, "building"), true);
});

test("housing query default and empty are distinct", () => {
  assert.deepEqual(queryToKinds(defaultHousingQuery()), ["whole"]);
  assert.deepEqual(migrateHousingKinds(["suite", "yafang"]), ["suite_shared"]);
  assert.deepEqual(migrateHousingKinds(["suite_shared", "warehouse"]), ["warehouse"]);
  assert.deepEqual(normalizeListQuery("all", "building"), {
    filter: "all",
    kind: "building",
    kinds: ["building"],
    sources: [],
  });
});

test("F11 known false can retract stale true kit values", () => {
  const merged = mergeKitColumns(
    { has_natural_gas: 1, has_balcony: 1, furnish_items: '["冰箱"]' },
    listingKitFrom({ text: "無天然瓦斯 無陽台", furnish: [], kit_complete: true }),
  );
  assert.equal(merged.has_natural_gas, 0);
  assert.equal(merged.has_balcony, 0);
  assert.deepEqual(merged.furnish_items, []);
  const keep = mergeKitColumns(
    { has_natural_gas: 1, has_balcony: 1, furnish_items: '["冰箱"]' },
    listingKitFrom({ title: "芝山兩房" }),
  );
  assert.equal(keep.has_natural_gas, 1);
  assert.deepEqual(keep.furnish_items, ["冰箱"]);
});

test("F17 selecting every district collapses to all", () => {
  assert.deepEqual(normalizeDistrictSelection(["中正區", "大同區"], ["中正區", "大同區"]), []);
  assert.deepEqual(normalizeDistrictSelection(["中正區"], ["中正區", "大同區"]), ["中正區"]);
});

test("F18 login UI on a usable listing page is not a whole-page block", () => {
  const usable = "<article data-ehid='abc'>物件詳情 租金 20000 會員登入 驗證碼</article>";
  assert.equal(hasListingMainContent(usable), true);
  assert.equal(looksLikeCaptchaOrLogin(usable), false);
  const judged = interpretRakuyaResponse({ status: 200, text: usable });
  assert.equal(judged.ok, true);
  const challenge = "<html>Just a moment cf-browser-verification 請稍候</html>";
  assert.equal(interpretRakuyaResponse({ status: 200, text: challenge }).code, "FETCH_BLOCKED");
  const recaptchaContact = "<h1>淡水河岸</h1><p>格局：2房</p><form>recaptcha 聯絡屋主</form>";
  assert.equal(looksLikeCaptchaOrLogin(recaptchaContact), false);
  assert.equal(looksLikeUnavailable(`${usable} 已下架`, 200), false);
});

test("rakuya list items do not invent whole-floor kind", () => {
  const row = normalizeRakuyaItem({ ehid: "rk001", title: "店面", address: "林口區文化路", price: "60000" }, { regionId: 1 });
  assert.equal(row.kind_name, "");
  assert.match(row.source_key, /林口區/);
});
