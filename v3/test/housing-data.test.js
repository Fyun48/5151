import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOUSING_DATA_CATEGORIES,
  defaultHousingData,
  normalizeHousingData,
  publicHousingData,
  upsertAutoEntry,
} from "../src/housingData.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(dir, rel), "utf8");

test("housing data defaults and normalization", () => {
  const d = defaultHousingData();
  assert.ok(d.entries.length >= 5);
  assert.ok(d.entries.some((e) => e.category === "vacancy"));
  assert.ok(d.entries.some((e) => e.category === "mobility"));
  assert.ok(d.entries.some((e) => e.category === "foreign"));
  assert.ok(d.entries.every((e) => HOUSING_DATA_CATEGORIES.some((c) => c.id === e.category)));
  const pub = publicHousingData(undefined);
  assert.ok(Array.isArray(pub.categories) && pub.categories.length === HOUSING_DATA_CATEGORIES.length);
  const norm = normalizeHousingData({ intro: "  嗨  ", entries: [
    { category: "population", title: "人口", value: "2300萬", sourceUrl: "javascript:evil" },
    { category: "bogus", title: "", value: "" },
    { category: "income", title: "薪資", value: "5萬", sourceUrl: "https://x.tw/a" },
  ] });
  assert.equal(norm.intro, "嗨");
  assert.equal(norm.entries.length, 2); // empty-title dropped
  assert.equal(norm.entries[0].sourceUrl, ""); // javascript: rejected
  assert.equal(norm.entries[1].sourceUrl, "https://x.tw/a");
});

test("upsertAutoEntry updates matching auto entry, keeps manual ones", () => {
  const base = normalizeHousingData({ entries: [
    { category: "vacancy", title: "空屋率", value: "手動", auto: false },
  ] });
  const once = upsertAutoEntry(base, { category: "vacancy", title: "低度用電住宅比率", value: "9.1%", asOf: "2025" });
  assert.equal(once.entries.length, 2);
  const again = upsertAutoEntry(once, { category: "vacancy", title: "低度用電住宅比率", value: "9.3%", asOf: "2026" });
  assert.equal(again.entries.length, 2); // updated in place, not duplicated
  const auto = again.entries.find((e) => e.auto);
  assert.equal(auto.value, "9.3%");
  assert.ok(again.entries.some((e) => !e.auto && e.value === "手動"));
});

test("housing data page, admin editor and API are wired", () => {
  const page = read("../public/data.html");
  assert.match(page, /居住數據/);
  assert.match(page, /fetch\("\/api\/housing-data"/);
  const admin = read("../public/admin.html");
  assert.match(admin, /id="housingRows"/);
  assert.match(admin, /\/api\/admin\/housing-data/);
  assert.match(admin, /loadHousing\(\)/);
  const server = read("../src/server.js");
  assert.match(server, /app\.get\("\/api\/housing-data"/);
  assert.match(server, /app\.put\("\/api\/admin\/housing-data", requireAdminApi/);
  const auth = read("../src/auth.js");
  assert.match(auth, /p === "\/api\/housing-data"/);
  const index = read("../public/index.html");
  assert.match(index, /href="\/data\.html">居住數據/);
});
