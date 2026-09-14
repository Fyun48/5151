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
  listingIsUnspecifiedAppearance,
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
import { normalizeListing } from "../src/client591.js";
import { enrichHpListingFromDetail, normalizeHpItem, parseHpDetailJson } from "../src/houseprice.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

test("unspecified 整層住家 belongs to 大樓/公寓 and 大樓+電梯, not title-less 店面/倉庫", () => {
  const bare = { kind_name: "整層住家" };
  const wholeOnly = { kind_name: "整層" };
  assert.equal(listingIsUnspecifiedWholeFloor(bare), true);
  assert.equal(listingIsUnspecifiedWholeFloor(wholeOnly), true);
  assert.equal(listingIsUnspecifiedWholeFloor({ kind_name: "整層住家／公寓" }), false);
  assert.equal(listingIsUnspecifiedWholeFloor({ kind_name: "整層住家／大樓" }), false);
  assert.equal(listingIsBuilding(bare), true);
  assert.equal(listingIsApartment(bare), true);
  assert.equal(listingIsShop(bare), false);
  assert.equal(listingIsWarehouse(bare), false);
  assert.equal(matchesHousingKind(bare, "building"), true);
  assert.equal(matchesHousingKind(bare, "building,elevator"), true);
  assert.equal(matchesHousingKind(bare, "apartment_huaxia"), true);
  assert.equal(matchesHousingKind(bare, "shop"), false);
  assert.equal(matchesHousingKind(bare, "warehouse"), false);
  assert.equal(matchesHousingKind({ kind_name: "整層住家／公寓" }, "building"), false);
  assert.equal(matchesHousingKind({ kind_name: "整層住家／大樓" }, "building"), true);
  assert.equal(matchesHousingKind({ kind_name: "整層住家", tags: ["無電梯"] }, "building,elevator"), false);
  assert.equal(listingIsBuilding({ title: "社區垃圾大樓服務", kind_name: "整層住家／公寓" }), false);
});

test("only 整層 or only 套房 implies 大樓 OR 公寓/華廈; elevator stays AND", () => {
  const bareWhole = { kind_name: "整層住家" };
  const walkup = { title: "無電梯公寓", kind_name: "整層住家／公寓", tags: ["無電梯"] };
  const suiteBare = { kind_name: "獨立套房" };
  const villa = { kind_name: "整層住家／透天" };
  assert.equal(matchesHousingKind(bareWhole, "whole"), true);
  assert.equal(matchesHousingKind(walkup, "whole"), true);
  assert.equal(matchesHousingKind(walkup, "whole,elevator"), false);
  assert.equal(matchesHousingKind(villa, "whole"), false);
  assert.equal(matchesHousingKind(suiteBare, "suite_shared"), true);
  assert.equal(matchesHousingKind(suiteBare, "whole"), false);
  assert.equal(matchesHousingKind(walkup, "whole,building"), false);
  assert.equal(matchesHousingKind(bareWhole, "whole,building"), true);
  assert.equal(matchesHousingKind(bareWhole, "whole,apartment_huaxia"), true);
  assert.deepEqual(toggleHousingKind(["whole"], "suite_shared"), ["suite_shared"]);
  assert.deepEqual(toggleHousingKind(["building"], "apartment_huaxia"), ["building", "apartment_huaxia"]);
});

test("F05 elevator is AND; shop and warehouse are title-only and exclusive", () => {
  const walkup = { title: "無電梯公寓", kind_name: "整層住家／公寓", tags: ["無電梯"] };
  assert.equal(matchesHousingKind(walkup, "elevator,apartment_huaxia"), false);
  assert.equal(matchesHousingKind({ kind_name: "整層住家／店面" }, "whole,shop"), false);
  assert.equal(matchesHousingKind({ title: "黃金店面", kind_name: "整層住家／店面" }, "whole,shop"), true);
  assert.equal(matchesHousingKind({ title: "倉庫出租", kind_name: "整層住家" }, "warehouse"), true);
  assert.deepEqual(toggleHousingKind(["whole"], "shop"), ["whole", "shop"]);
  assert.deepEqual(toggleHousingKind(["suite_shared"], "warehouse"), ["suite_shared", "warehouse"]);
  assert.deepEqual(toggleHousingKind(["shop"], "warehouse"), ["warehouse"]);
  const afterWarehouse = applyHousingQueryChip(kindsToQuery(["shop"]), "warehouse");
  assert.equal(afterWarehouse.hint, "已取消店面");
  assert.equal(elevatorRequired(kindsToQuery(["building"])), true);
  assert.equal(elevatorRequired(kindsToQuery(["whole", "elevator"])), true);
  assert.equal(matchesHousingKind({ title: "電梯大樓", kind_name: "整層住家／電梯大樓" }, "elevator,apartment_huaxia"), false);
  assert.equal(matchesHousingKind({ title: "電梯大樓", kind_name: "整層住家／電梯大樓" }, "building"), true);
});

test("housing query default and empty are distinct", () => {
  assert.deepEqual(queryToKinds(defaultHousingQuery()), ["whole"]);
  assert.deepEqual(migrateHousingKinds(["suite", "yafang"]), ["suite_shared"]);
  assert.deepEqual(migrateHousingKinds(["suite_shared", "warehouse"]), ["suite_shared", "warehouse"]);
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

test("whole+building+elevator excludes 公寓 even when title omits 公寓", () => {
  const zhishan = {
    title: "⭐MRT芝山站❤️超值三房.生活機能佳❤️巷弄寧靜不吵雜",
    kind_name: "整層住家",
    floor_name: "4/5",
    tags: [],
  };
  assert.equal(listingIsUnspecifiedAppearance(zhishan), false);
  assert.equal(listingIsBuilding(zhishan), false);
  assert.equal(listingIsApartment(zhishan), true);
  assert.equal(listingHasElevator(zhishan), false);
  assert.equal(matchesHousingKind(zhishan, "whole,building,elevator"), false);
  assert.equal(matchesHousingKind(zhishan, "whole,apartment_huaxia"), true);
  assert.equal(matchesHousingKind({
    title: zhishan.title,
    kind_name: "整層住家",
    tags: ["公寓"],
  }, "whole,building,elevator"), false);
  assert.equal(matchesHousingKind({
    title: "芝山站三房公寓生活機能佳",
    kind_name: "整層住家",
  }, "whole,building"), false);
  assert.equal(listingIsBuilding({
    title: "社區垃圾大樓服務",
    kind_name: "整層住家",
    floor_name: "4/5",
  }), false);
  const taggedTower = { title: zhishan.title, kind_name: "整層住家", floor_name: "4/4", tags: ["大樓"] };
  assert.equal(listingIsBuilding(taggedTower), true);
  assert.equal(matchesHousingKind(taggedTower, "whole,building,elevator"), true);
  assert.equal(matchesHousingKind({ kind_name: "整層住家", floor_name: "8/12" }, "whole,building"), true);
});

test("591 shape and 5168 caseTypeName persist into tags for housing kind", () => {
  const row = normalizeListing({
    id: 21960001,
    title: "⭐MRT芝山站❤️超值三房.生活機能佳❤️巷弄寧靜不吵雜",
    kind_name: "整層住家",
    shape: "公寓",
    tags: ["近捷運"],
    floor_name: "4F/5F",
    price: "32000",
  });
  assert.match(row.tags, /公寓/);
  assert.equal(matchesHousingKind(row, "whole,building,elevator"), false);
  assert.equal(matchesHousingKind(row, "whole,apartment_huaxia"), true);
  const hp = normalizeHpItem({
    id: "16692013",
    kind: "整層住家",
    title: "⭐MRT芝山站❤️超值三房.生活機能佳❤️巷弄寧靜不吵雜",
    price: 32000,
    areaName: "17坪",
    layout: "2房2廳1衛",
    floorName: "3/4",
    address: "台北市士林區福華路",
    community: "",
    buildingType: "公寓",
  }, { regionId: 1, sectionId: 8 });
  assert.match(hp.tags, /公寓/);
  const fixture = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/houseprice-detail-16692013.json"),
    "utf8",
  );
  const enriched = enrichHpListingFromDetail(hp, parseHpDetailJson(fixture), { regionId: 1, sectionId: 8 });
  assert.match(enriched.tags, /公寓/);
  assert.equal(matchesHousingKind(enriched, "whole,building,elevator"), false);
});

test("rakuya list items do not invent whole-floor kind", () => {
  const row = normalizeRakuyaItem({ ehid: "rk001", title: "店面", address: "林口區文化路", price: "60000" }, { regionId: 1 });
  assert.equal(row.kind_name, "");
  assert.match(row.source_key, /林口區/);
});
