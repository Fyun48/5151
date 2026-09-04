import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CITIES, lookupDistrict } from "../src/regions.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const pub = (rel) => readFileSync(path.join(dir, "../public", rel), "utf8");

test("cities.json matches server CITIES and embed script", () => {
  const fromJson = JSON.parse(pub("cities.json"));
  assert.deepEqual(CITIES, fromJson);
  const embed = pub("cities-embed.js").trim();
  assert.match(embed, /^window\.CITIES_EMBEDDED = /);
  const parsed = Function("window", `"use strict"; ${embed}; return window.CITIES_EMBEDDED;`)({});
  assert.deepEqual(parsed, fromJson);
  assert.equal(CITIES.length, 22);
  assert.deepEqual(
    CITIES.map((city) => city.name),
    [
      "台北市", "新北市", "基隆市", "桃園市", "新竹市", "新竹縣", "苗栗縣", "台中市",
      "彰化縣", "南投縣", "雲林縣", "嘉義市", "嘉義縣", "台南市", "高雄市", "屏東縣",
      "宜蘭縣", "花蓮縣", "台東縣", "澎湖縣", "金門縣", "連江縣",
    ],
  );
  assert.equal(lookupDistrict("1-8")?.name, "士林區");
  assert.equal(lookupDistrict("3-50")?.name, "淡水區");
  assert.equal(lookupDistrict("6-73")?.name, "桃園區");
  assert.equal(lookupDistrict("8-103")?.name, "北屯區");
  assert.equal(lookupDistrict("17-268")?.name, "鳳山區");
  const keys = new Set();
  for (const city of CITIES) {
    for (const district of city.districts) {
      const key = `${city.id}-${district.id}`;
      assert.equal(keys.has(key), false, `duplicate ${key}`);
      keys.add(key);
    }
  }
  assert.ok(keys.size > 300);
});

test("filter menu lists cities and toggles districts by city name", () => {
  const html = pub("index.html");
  assert.match(html, /src="\/cities-embed\.js"/);
  assert.match(html, /data-city-toggle/);
  assert.match(html, /district-city-toggle/);
  assert.match(html, /function bindCityAccordion/);
  assert.match(html, /function cityAccordionHtml/);
  assert.match(html, /cityAccordionClosed/);
  assert.match(html, /apply\(!el\.closest\("\.district-city"\)\?\.classList\.contains\("is-open"\)\)/);
  assert.match(html, /id="districtPicker"/);
  assert.doesNotMatch(html, /<div id="districtPicker"[^>]*>\s*<div class="district-city">/);
});
