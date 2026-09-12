import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fetchRakuyaCoveringListings, parseRakuyaListHtml, normalizeRakuyaItem, rakuyaListUrl, repairRakuyaScopes, fetchRakuyaListPage } from "../src/rakuya.js";
import { fetchHfCoveringListings, normalizeHfItem, parseHfApiBody } from "../src/housefun.js";
import { fetchDdCoveringListings, kindFromDdItem, parseDdApiBody } from "../src/ddroom.js";

const fixture = name => readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");

test("Rakuya uses its own city codes and continues past the first page budget", async () => {
  assert.equal(new URL(rakuyaListUrl({ regionId: 1 })).searchParams.get("city"), "0");
  assert.equal(new URL(rakuyaListUrl({ regionId: 3 })).searchParams.get("city"), "2");
  assert.equal(rakuyaListUrl({ regionId: 99 }), "");
  const pages = [];
  const [batch] = await fetchRakuyaCoveringListings([{ regionId: 3, sectionIds: [50], searchUrl: "scope" }], {
    pages: 3, startPages: { 3: 10 }, pageGapMs: 0,
    fetchText: async url => {
      const page = Number(new URL(url).searchParams.get("page") || 1);
      pages.push(page);
      return { status: 200, text: fixture("rakuya-list.html").replaceAll("rk001", `rk001p${page}`) };
    },
  });
  assert.deepEqual(pages, [1, 10, 11]);
  assert.equal(batch.searchUrl, "scope");
  assert.equal(batch.listings.length, 3);
  assert.equal(batch.parsed.stopReason, "page_limit");
  assert.equal(batch.progress.nextPage, 12);
  assert.ok(batch.listings.every(row => row.source_key.startsWith("3|50|")));
});

test("one unparseable Rakuya city does not discard another city's successful batch", async () => {
  const batches = await fetchRakuyaCoveringListings([{ regionId: 1, sectionIds: [8] }, { regionId: 3, sectionIds: [50] }], {
    pages: 1, pageGapMs: 0,
    fetchText: async url => new URL(url).searchParams.get("city") === "0"
      ? { status: 200, text: "unrecognized template" }
      : { status: 200, text: fixture("rakuya-list.html") },
  });
  assert.equal(batches[0].errors[0].code, "PARSE_FAILED");
  assert.equal(batches[1].listings.length, 1);
  const invalid = await fetchRakuyaListPage({ url: "https://example.test", fetchText: async () => ({ status: 200, text: "找到 10 筆，但新模板無法解析" }) });
  assert.equal(invalid.code, "PARSE_FAILED");
});

test("Rakuya pauses that source for the run after a challenge, without trying other cities", async () => {
  let calls = 0;
  const batches = await fetchRakuyaCoveringListings([{ regionId: 1 }, { regionId: 3 }], {
    pages: 3, fetchText: async () => { calls++; return { status: 403, text: fixture("rakuya-cloudflare.html") }; },
  });
  assert.equal(calls, 1);
  assert.equal(batches[0].errors[0].code, "FETCH_BLOCKED");
});

test("a removed Rakuya continuation page resets coverage without losing the refreshed head", async () => {
  const [batch] = await fetchRakuyaCoveringListings([{ regionId: 3, sectionIds: [50] }], {
    pages: 3, startPages: { 3: 10 }, pageGapMs: 0,
    fetchText: async url => new URL(url).searchParams.has("page")
      ? { status: 404, text: "not found" } : { status: 200, text: fixture("rakuya-list.html") },
  });
  assert.equal(batch.listings.length, 1);
  assert.equal(batch.progress.nextPage, 2);
  assert.equal(batch.progress.resetReason, "PAGE_OUT_OF_RANGE");
  assert.equal(batch.errors[0].code, "SOURCE_UNAVAILABLE");
});

test("modern Rakuya card-shaped markup keeps type, rent and a conservative location", () => {
  // Constructed regression example from public card fields, not a captured DOM fixture.
  const rows = parseRakuyaListHtml(`<p>會員登入</p><a href="/item/abcd1234">
    <h2>採光兩房</h2><span>新店區 永安街</span><span>整層住家 公寓</span>
    <span>3房1廳1衛 3/5樓 主建25坪</span><del>30,000元</del><b>28,500元</b>
    <span>1小時前更新</span></a>`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ehid, "abcd1234");
  assert.equal(rows[0].title, "採光兩房");
  assert.equal(rows[0].price, "28,500");
  assert.equal(rows[0].kind, "整層住家 公寓");
  assert.equal(rows[0].address, "新店區");
  assert.equal(rows[0].field_status.address, "district_only");
  const first = normalizeRakuyaItem(rows[0], { regionId: 3, sectionId: 38 });
  const differentHouse = normalizeRakuyaItem({ ...rows[0], ehid: "ffff1234" }, { regionId: 3, sectionId: 38 });
  assert.notEqual(first.source_key, differentHouse.source_key);
  const misleadingTitle = parseRakuyaListHtml(`<a href="/item/abcd9999"><h2>士林區旁住宅、租補5000元、15坪生活圈</h2>
    <span>北投區中央北路</span><span>整層住家 公寓 2房1廳1衛 3/5樓 主建25坪 28,500元</span></a>`);
  assert.equal(misleadingTitle[0].address, "北投區");
  assert.equal(misleadingTitle[0].price, "28,500");
  assert.equal(misleadingTitle[0].areaName, "25坪");
});

test("orphan scope repair is conservative and preserves timestamps and user state", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE listings(post_id INTEGER PRIMARY KEY, source TEXT, search_key TEXT, source_key TEXT, address TEXT, first_seen_at TEXT, watched INTEGER);
    INSERT INTO listings VALUES(1,'rakuya','','3|市淡水區||address','新北市淡水區淡金路1號','original',1);
    INSERT INTO listings VALUES(2,'rakuya','','3|市淡水區||unknown','','original',1);
    INSERT INTO listings VALUES(3,'591','','3|50||other','新北市淡水區淡金路3號','original',1);`);
  const jobs = [{ regionId: 3, sectionIds: [50], searchUrl: "scope" }];
  assert.equal(repairRakuyaScopes(db, jobs), 1);
  assert.deepEqual({ ...db.prepare("SELECT search_key, source_key, first_seen_at, watched FROM listings WHERE post_id=1").get() },
    { search_key: "scope", source_key: "3|50||address", first_seen_at: "original", watched: 1 });
  assert.equal(repairRakuyaScopes(db, jobs), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM listings WHERE search_key='' ").get().n, 2);
  db.close();
});

test("parking amenities do not delete Housefun homes or override DD structured rental type", () => {
  for (const title of ["天東四房車", "高樓景觀3＋1房雙車位"]) {
    const row = normalizeHfItem({ id: "12345", title, layout: "4房2廳2衛", text: "118,000 元/月 (含車位)", price: 118000 });
    assert.equal(row.kind_name, "整層住家");
  }
  assert.equal(kindFromDdItem({ type_space: "whole", title: "三房含車位" }), "整層住家");
  assert.equal(kindFromDdItem({ type_space: "office", title: "三房含車位" }), "");
  assert.equal(parseHfApiBody({ Status: "1", Data: { HouseCount: "12", SearchContent: "new template" } }).ok, false);
  assert.equal(parseHfApiBody({ Status: "1", Data: { SearchContent: "new template" } }).ok, false);
  assert.equal(parseDdApiBody({ code: 500, message: "upstream failure" }).ok, false);
});

test("Housefun and DD retain successful districts when a later district fails", async () => {
  const jobs = [{ regionId: 1, sectionIds: [8, 10], searchUrl: "scope" }];
  const hf = JSON.parse(fixture("housefun-page.json"));
  let calls = 0;
  const [homeBatch] = await fetchHfCoveringListings(jobs, { pages: 1, gapMs: 0, postForm: async () => {
    if (++calls === 2) throw Object.assign(new Error("rate limit"), { code: "RATE_LIMITED" });
    return hf;
  } });
  assert.ok(homeBatch.listings.length > 0);
  assert.equal(homeBatch.errors[0].code, "RATE_LIMITED");
  const dd = JSON.parse(fixture("ddroom-page.json"));
  calls = 0;
  const [ddBatch] = await fetchDdCoveringListings(jobs, { pages: 1, objectDetail: false, gapMs: 0, getJson: async () => {
    if (++calls === 2) return { code: 500 };
    return dd;
  } });
  assert.ok(ddBatch.listings.length > 0);
  assert.equal(ddBatch.errors[0].code, "PARSE_FAILED");
});

test("DD detail rate limiting stops further requests but retains the fetched list", async () => {
  const dd = JSON.parse(fixture("ddroom-page.json"));
  let detailCalls = 0;
  let listCalls = 0;
  const [batch] = await fetchDdCoveringListings([{ regionId: 1, sectionIds: [8, 10], searchUrl: "scope" }], {
    pages: 3, objectDetail: true, detailGapMs: 0, gapMs: 0,
    getJson: async url => {
      if (url.includes("/objects/")) {
        detailCalls++;
        throw Object.assign(new Error("rate limit"), { code: "RATE_LIMITED" });
      }
      listCalls++;
      return dd;
    },
  });
  assert.equal(detailCalls, 1);
  assert.equal(listCalls, 1);
  assert.ok(batch.listings.length > 0);
  assert.equal(batch.errors[0].stage, "detail");
});
