import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchRisPopulation, refreshHousingData, rocYearNow } from "../src/housingFetch.js";
import { normalizeHousingData } from "../src/housingData.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

function villageRow(site, persons) {
  const half = Math.floor(persons / 2);
  return {
    site_id: site,
    household_ordinary_m: String(half),
    household_ordinary_f: String(persons - half),
    household_business_m: "0", household_business_f: "0",
    household_single_m: "0", household_single_f: "0",
    household_ordinary_total: String(Math.round(persons / 2)),
    household_business_total: "0", household_single_total: "0",
  };
}

test("rocYearNow converts to ROC year", () => {
  assert.equal(rocYearNow(new Date("2026-01-01")), 115);
});

test("fetchRisPopulation aggregates Taipei/New Taipei/national from paged data", async () => {
  const pages = {
    1: { responseCode: "OD-0101-S", totalPage: "2", responseData: [villageRow("臺北市中正區A里", 1000), villageRow("新北市板橋區B里", 2000)] },
    2: { responseCode: "OD-0101-S", totalPage: "2", responseData: [villageRow("臺北市大安區C里", 500), villageRow("桃園市D里", 300)] },
  };
  const getJson = async (url) => {
    if (/\/115\?/.test(url)) return { responseCode: "OD-0102-S", responseMessage: "查無資料" };
    const m = url.match(/page=(\d+)/);
    return pages[Number(m ? m[1] : 1)];
  };
  const entries = await fetchRisPopulation({ getJson, now: new Date("2026-01-01") });
  const byTitle = Object.fromEntries(entries.map((e) => [e.title, e.value]));
  assert.equal(byTitle["臺北市 戶籍人口"], "1,500 人");
  assert.equal(byTitle["新北市 戶籍人口"], "2,000 人");
  assert.equal(byTitle["全國 戶籍人口"], "3,800 人");
  assert.equal(byTitle["臺北市 平均每戶人口"], "2.00 人/戶");
  assert.equal(byTitle["全國 平均每戶人口"], "2.00 人/戶");
  assert.ok(entries.every((e) => e.category === "population" && e.source === "內政部戶政司"));
  assert.match(entries[0].asOf, /民國114年/);
});

test("refreshHousingData upserts auto entries and stamps updatedAt", async () => {
  let stored = normalizeHousingData({ entries: [{ category: "vacancy", title: "手動筆", value: "x", auto: false }] });
  const fakeFetcher = async () => [{ category: "population", title: "全國 戶籍人口", value: "23,000,000 人", source: "內政部戶政司" }];
  const summary = await refreshHousingData({
    fetchers: [fakeFetcher],
    getData: () => stored,
    writeData: (d) => { stored = d; },
    now: new Date("2026-09-06T00:00:00.000Z"),
  });
  assert.equal(summary.count, 1);
  assert.equal(summary.errors.length, 0);
  assert.ok(stored.entries.some((e) => e.auto && e.title === "全國 戶籍人口"));
  assert.ok(stored.entries.some((e) => !e.auto && e.title === "手動筆"));
  assert.equal(stored.updatedAt, "2026-09-06T00:00:00.000Z");
  // second run updates in place, no duplicate
  const again = await refreshHousingData({ fetchers: [fakeFetcher], getData: () => stored, writeData: (d) => { stored = d; } });
  assert.equal(again.count, 1);
  assert.equal(stored.entries.filter((e) => e.title === "全國 戶籍人口").length, 1);
});

test("a failing fetcher is recorded but does not throw", async () => {
  let stored = normalizeHousingData({});
  const boom = async () => { throw new Error("網路壞了"); };
  const summary = await refreshHousingData({ fetchers: [boom], getData: () => stored, writeData: (d) => { stored = d; } });
  assert.equal(summary.count, 0);
  assert.equal(summary.errors.length, 1);
  assert.match(summary.errors[0], /網路壞了/);
});

test("refresh endpoint, schedule and admin button are wired", () => {
  const server = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  assert.match(server, /app\.post\("\/api\/admin\/housing-data\/refresh", requireAdminApi/);
  assert.match(server, /setInterval\(runHousingRefresh/);
  const admin = readFileSync(path.join(dir, "../public/admin.html"), "utf8");
  assert.match(admin, /id="housingRefresh"/);
  assert.match(admin, /\/api\/admin\/housing-data\/refresh/);
});
