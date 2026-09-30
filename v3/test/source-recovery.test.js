import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fetchRakuyaCoveringListings, parseRakuyaListHtml, normalizeRakuyaItem, rakuyaListUrl, repairRakuyaScopes, fetchRakuyaListPage } from "../src/rakuya.js";
import { fetchHfCoveringListings, normalizeHfItem, parseHfApiBody } from "../src/housefun.js";
import { fetchDdCoveringListings, kindFromDdItem, parseDdApiBody } from "../src/ddroom.js";
import { fetchHpCoveringListings } from "../src/houseprice.js";
import { fetchHbCoveringListings } from "../src/hbhousing.js";
import { fetchSinyiCoveringListings } from "../src/sinyi.js";

const HB_FIXTURE = JSON.parse(readFileSync(new URL("fixtures/hbhousing-page.json", import.meta.url), "utf8"));
const SINYI_FIXTURE = JSON.parse(readFileSync(new URL("fixtures/sinyi-page.json", import.meta.url), "utf8"));

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

// ── 2026-09-30：來源的「第一線 fail-soft」────────────────────────────────────
//
// 事故：5168 在正式站被回 403，而 `fetchHpCoveringListings()` 沒有任何 try/catch
// ⇒ **一個 403 讓整個來源在那一輪歸零**：已經抓到的行政區與房源全部丟掉、`covered` 記 0/6，
// 於是表面上「5168 連續失敗」，實際上是「一次偶發失敗吃掉整批」。
// 這一組測試釘住：單頁／單筆明細失敗只損失那一頁，已抓到的批次一定要留下來、錯誤要能指出位置；
// 同一種形狀必須涵蓋 591、5168、住商、信義（ddroom／housefun／rakuya 已經是這樣）。

test("591：第 2 頁失敗時，第 1 頁的房源與錯誤紀錄都要留下來", async () => {
  const { fetchListings } = await import("../src/client591.js");
  // ⚠️ 欄位要用 591 清單 API 的形狀（`id`，不是 `post_id`）：第一版寫錯欄位，
  // 每一筆都在 mapKeptListings() 被濾掉 ⇒ 變成「什麼都沒抓到」而觸發整批失敗那條路。
  const items = Array.from({ length: 30 }, (_, i) => ({
    id: 900000 + i, title: `測試 ${i}`, price: "20000", kind_name: "獨立套房",
    address: "台北市大安區某路", section_name: "大安區", region_name: "台北市",
  }));
  const seenPages = [];
  const result = await fetchListings("https://rent.591.com.tw/list?region=1&section=5", 5, {
    fetchPage: async (_query, firstRow) => {
      seenPages.push(firstRow);
      if (firstRow === 0) return { total: 150, items };
      throw Object.assign(new Error("591 回應 403"), { code: "FETCH_BLOCKED" });
    },
  });
  // 第 1 頁成功、第 2～4 頁連續失敗 ⇒ 連續失敗 3 次就停手（不再打第 5 頁）。
  assert.deepEqual(seenPages, [0, 30, 60, 90], "連續失敗達上限就停，不要一路打到最後一頁");
  assert.equal(result.listings.length, 30, "第 1 頁的房源必須留下來");
  assert.equal(result.errors.length, 3);
  assert.deepEqual(result.errors.map((row) => row.page), [2, 3, 4], "錯誤要指出是哪幾頁");
  assert.equal(result.errors[0].code, "FETCH_BLOCKED");
  assert.match(result.errors[0].message, /403/);
});

test("591：連第一頁都失敗時維持「整個 job 失敗」的語意（watcher 的逾時政策靠它）", async () => {
  const { fetchListings } = await import("../src/client591.js");
  await assert.rejects(
    () => fetchListings("https://rent.591.com.tw/list?region=1&section=5", 3, {
      fetchPage: async () => { throw Object.assign(new Error("591 超過 8 秒沒回應，已放棄這次請求"), { code: "TIMEOUT" }); },
    }),
    /沒回應，已放棄/,
  );
});

test("5168：被擋（403）時只暫停這家，已抓到的行政區與房源照樣回報", async () => {
  // ⚠️ 一定要有**第三個**行政區：只有兩個的話，「被擋後暫停」與「不暫停」的呼叫次數一樣，
  // 變異測試實測會活下來（第一版就是這樣漏掉的）。
  const jobs = [{ regionId: 1, sectionIds: [8, 10, 12], searchUrl: "scope" }];
  const listCalls = [];
  const [batch] = await fetchHpCoveringListings(jobs, {
    pages: 1,
    detailGapMs: 0,
    gapMs: 0,
    getHtml: async (url) => {
      if (!String(url).includes("/list/")) return fixture("houseprice-list.html"); // 明細走 HTML 版
      listCalls.push(String(url));
      // 第二個行政區的列表頁被擋（正式站 08:24 的 403 就是發生在列表頁）。
      if (listCalls.length === 2) {
        throw Object.assign(new Error(`5168 暫時無法抓取（HTTP 403；${url}）`), { code: "FETCH_BLOCKED" });
      }
      return fixture("houseprice-list.html");
    },
  });
  assert.ok(batch.listings.length > 0, "第一個行政區抓到的房源不可以被 403 吃掉");
  assert.equal(listCalls.length, 2, "被擋之後不該再打同一家（sourcePaused；第三個行政區也不可以打）");
  assert.equal(batch.errors.length, 1);
  assert.equal(batch.errors[0].code, "FETCH_BLOCKED");
  assert.equal(batch.errors[0].page, 1);
  assert.ok(batch.errors[0].district, "錯誤要指出是哪個行政區");
  assert.match(batch.errors[0].message, /https:\/\/rent\.houseprice\.tw\/list\//, "錯誤樣本一定要帶出事的網址");
});

test("住商：第二個來源請求失敗時，第一個行政區的房源要留下來", async () => {
  const jobs = [{ regionId: 1, sectionIds: [8, 10, 12], searchUrl: "scope" }];
  let calls = 0;
  const [batch] = await fetchHbCoveringListings(jobs, {
    pages: 1, gapMs: 0,
    postJson: async () => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error("住商暫時無法抓取（HTTP 403）"), { code: "FETCH_BLOCKED" });
      return HB_FIXTURE;
    },
  });
  assert.ok(batch.listings.length > 0);
  assert.equal(batch.errors[0].code, "FETCH_BLOCKED");
  assert.equal(batch.errors[0].page, 1);
  assert.ok(batch.errors[0].district, "錯誤要指出是哪個行政區");
  assert.equal(calls, 2, "被擋之後不該再打同一家（sourcePaused）");
});

test("信義：第二個來源請求失敗時，第一個行政區的房源要留下來", async () => {
  const jobs = [{ regionId: 1, sectionIds: [8, 10, 12], searchUrl: "scope" }];
  let calls = 0;
  const [batch] = await fetchSinyiCoveringListings(jobs, {
    pages: 1, gapMs: 0,
    postForm: async () => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error("信義暫時無法抓取（HTTP 429）"), { code: "RATE_LIMITED" });
      return SINYI_FIXTURE;
    },
  });
  assert.ok(batch.listings.length > 0);
  assert.equal(batch.errors[0].code, "RATE_LIMITED");
  assert.ok(batch.errors[0].district);
  assert.equal(calls, 2, "被限速之後不該再打同一家（sourcePaused）");
});

test("逐頁 fail-soft 不可以吞掉整輪取消（預算用盡要立刻停手）", async () => {
  const { withCrawlExecution } = await import("../src/crawlExecution.js");
  const controller = new AbortController();
  controller.abort(new Error("這輪抓取超過 40 分鐘沒結束，已自動放棄"));
  const context = { controller, signal: controller.signal, deadline: Date.now() - 1 };
  await assert.rejects(
    () => withCrawlExecution(context, () => fetchHpCoveringListings(
      [{ regionId: 1, sectionIds: [8], searchUrl: "scope" }],
      { pages: 3, gapMs: 0, getHtml: async () => { throw Object.assign(new Error("boom"), { code: "FETCH_BLOCKED" }); } },
    )),
    /boom/,
    "被取消時要往上丟，不能當成「只是這一頁失敗」而繼續打站台",
  );
  const { fetchListings } = await import("../src/client591.js");
  let calls591 = 0;
  await assert.rejects(
    () => withCrawlExecution(context, () => fetchListings("https://rent.591.com.tw/list?region=1&section=8", 3, {
      fetchPage: async () => { calls591 += 1; throw Object.assign(new Error("boom-591"), { code: "FETCH_BLOCKED" }); },
    })),
    /boom-591/,
    "591 的逐頁 fail-soft 同樣不可以吞掉整輪取消",
  );
  // ⚠️ 只驗「有沒有丟」不夠：吞掉取消的版本最後仍會因為整批失敗而丟錯，測試會誤判為通過。
  assert.equal(calls591, 1, "被取消就立刻停手，不可以再打第二次（變異測試實測過這個盲點）");
  await assert.rejects(
    () => withCrawlExecution(context, () => fetchHbCoveringListings(
      [{ regionId: 1, sectionIds: [8], searchUrl: "scope" }],
      { pages: 3, gapMs: 0, postJson: async () => { throw Object.assign(new Error("boom-hb"), { code: "FETCH_BLOCKED" }); } },
    )),
    /boom-hb/,
  );
  await assert.rejects(
    () => withCrawlExecution(context, () => fetchSinyiCoveringListings(
      [{ regionId: 1, sectionIds: [8], searchUrl: "scope" }],
      { pages: 3, gapMs: 0, postForm: async () => { throw Object.assign(new Error("boom-sinyi"), { code: "FETCH_BLOCKED" }); } },
    )),
    /boom-sinyi/,
  );
});

test("來源 HTTP 錯誤要帶代碼與出事的網址（否則 403 之後查不出是哪一頁）", async () => {
  const { sourceHttpError, isSourceBlocked, SOURCE_BLOCKED_CODES } = await import("../src/crawlWatchdog.js");
  const url = "https://rent.houseprice.tw/list/住宅_usage/5_zip/?p=2";
  const blocked = sourceHttpError("5168 ", 403, url);
  assert.equal(blocked.code, "FETCH_BLOCKED");
  assert.equal(blocked.status, 403);
  assert.match(blocked.message, /HTTP 403/);
  assert.ok(blocked.message.includes(url), `訊息必須帶出事的網址，實際：${blocked.message}`);
  assert.equal(sourceHttpError("信義", 429, "u").code, "RATE_LIMITED");
  assert.equal(sourceHttpError("住商", 503, "u").code, "SOURCE_UNAVAILABLE");
  assert.equal(sourceHttpError("住商", 500, "u").code, "FETCH_FAILED");
  assert.match(sourceHttpError("住商", 500, "u").message, /住商搜尋 500/);
  // 暫停條件：被擋／限速才暫停這一家，其他錯誤只跳過那一頁。
  assert.equal(isSourceBlocked(blocked), true);
  assert.equal(isSourceBlocked(sourceHttpError("住商", 500, "u")), false);
  assert.equal(isSourceBlocked(new Error("住商暫時無法抓取（HTTP 403）")), true, "沒有 code 的舊訊息也要判得出來");
  assert.equal(isSourceBlocked(new Error("591 回應 500")), false);
  assert.equal(isSourceBlocked(Object.assign(new Error("x"), { code: "RATE_LIMITED" })), true);
  assert.deepEqual([...SOURCE_BLOCKED_CODES], ["FETCH_BLOCKED", "RATE_LIMITED", "SOURCE_UNAVAILABLE"]);
});
