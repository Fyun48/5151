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

test("5168：連續被擋達門檻兩次才停工，之前抓到的行政區與房源照樣回報", async () => {
  // 第九十六批 B 之後的完整語意：
  //   第 2 次連續被擋 → **先冷卻重試**（cooledDown），計數歸零；
  //   再連續 2 次被擋 → 才真的讓這一家這一輪停工。
  // 所以要有六個行政區：1 成功、2/3 被擋（冷卻）、4/5 被擋（停工）、6 不可以再打。
  const jobs = [{ regionId: 1, sectionIds: [8, 10, 12, 5, 7, 3], searchUrl: "scope" }];
  const listCalls = [];
  const [batch] = await fetchHpCoveringListings(jobs, {
    pages: 1,
    detailGapMs: 0,
    gapMs: 0,
    blockCooldownMs: 0,
    getHtml: async (url) => {
      if (!String(url).includes("/list/")) return fixture("houseprice-list.html"); // 明細走 HTML 版
      listCalls.push(String(url));
      if (listCalls.length >= 2 && listCalls.length <= 5) {
        throw Object.assign(new Error(`5168 暫時無法抓取（HTTP 403；${url}）`), { code: "FETCH_BLOCKED" });
      }
      return fixture("houseprice-list.html");
    },
  });
  assert.equal(listCalls.length, 5, "冷卻重試一次之後仍連續被擋 ⇒ 第六個行政區不可以再打");
  assert.equal(batch.blocked, true, "批次要標記「這一輪被擋到停工」（watcher 據此記冷卻期）");
  assert.ok(batch.listings.length > 0, "被擋之前抓到的房源不可以被 403 吃掉");
  assert.equal(batch.errors.length, 4);
  assert.equal(batch.errors[0].code, "FETCH_BLOCKED");
  assert.ok(batch.errors[0].district, "錯誤要指出是哪個行政區");
  assert.match(batch.errors[0].message, /https:\/\/rent\.houseprice\.tw\/list\//, "錯誤樣本一定要帶出事的網址");
});

test("5168：達門檻不放棄整輪（同一輪剩下的部分就是重試），且不需要空等（第九十六批 B）", async () => {
  const jobs = [{ regionId: 1, sectionIds: [8, 10, 12, 5], searchUrl: "scope" }];
  const listCalls = [];
  const [batch] = await fetchHpCoveringListings(jobs, {
    pages: 1, detailGapMs: 0, gapMs: 0, blockCooldownMs: 0,
    getHtml: async (url) => {
      if (!String(url).includes("/list/")) return fixture("houseprice-list.html");
      listCalls.push(String(url));
      // 第 2、3 次被擋（達門檻 → 冷卻重試），第 4 個行政區恢復成功。
      if (listCalls.length === 2 || listCalls.length === 3) {
        throw Object.assign(new Error("5168 暫時無法抓取（HTTP 403）"), { code: "FETCH_BLOCKED" });
      }
      return fixture("houseprice-list.html");
    },
  });
  assert.equal(listCalls.length, 4, "冷卻之後要繼續抓後面的行政區（不可以整輪放棄）");
  assert.equal(batch.blocked, false, "冷卻後恢復成功 ⇒ 不算被擋到停工");
  assert.equal(batch.errors.length, 2);
});

test("5168：同一輪重複的覆蓋條件只抓同一頁一次（第九十六批 A）", async () => {
  // 覆蓋條件本來就會重疊（系統全區 `1|1..12` ＋ 會員子集 `1|2,3,8,9`）：
  // 沒有快取時同一頁會被重複打，既浪費流量、也讓同一區的同一筆錯誤重複出現。
  const jobs = [
    { regionId: 1, sectionIds: [8, 10], searchUrl: "job-a" },
    { regionId: 1, sectionIds: [8, 10], searchUrl: "job-b" },
  ];
  const listCalls = [];
  const batches = await fetchHpCoveringListings(jobs, {
    pages: 1, detailGapMs: 0, gapMs: 0, detailLimit: 0, addressDetailLimit: 0,
    getHtml: async (url) => {
      if (!String(url).includes("/list/")) return fixture("houseprice-list.html");
      listCalls.push(String(url));
      return fixture("houseprice-list.html");
    },
  });
  assert.equal(listCalls.length, 2, `兩個 job 用到同樣兩個行政區 ⇒ 只該打兩頁，實際 ${listCalls.length}`);
  assert.equal(new Set(listCalls).size, 2, "兩個行政區各一頁");
  assert.equal(batches.length, 2, "兩個 job 仍然各自回報一個批次");
  // ⚠️ 第二個批次可以是空的：同一批房源在第一個 job 已經收進 `seen`（post_id 去重），
  // 這是原本就有的行為，不是快取造成的。要驗的是「總共有房源、而且頁面沒有被重打」。
  assert.ok(batches.reduce((n, batch) => n + batch.listings.length, 0) > 0, "快取的結果要照樣產生房源");
});

test("住商：連續被擋達門檻兩次才停工，之前抓到的行政區要留下來", async () => {
  const jobs = [{ regionId: 1, sectionIds: [8, 10, 12, 5, 7, 3], searchUrl: "scope" }];
  let calls = 0;
  const [batch] = await fetchHbCoveringListings(jobs, {
    pages: 1, gapMs: 0, blockCooldownMs: 0,
    postJson: async () => {
      calls += 1;
      if (calls >= 2) throw Object.assign(new Error("住商暫時無法抓取（HTTP 403）"), { code: "FETCH_BLOCKED" });
      return HB_FIXTURE;
    },
  });
  assert.ok(batch.listings.length > 0);
  assert.equal(batch.blocked, true);
  assert.equal(batch.errors.length, 4, "第 2/3 次先冷卻重試，第 4/5 次才停工");
  assert.equal(batch.errors[0].code, "FETCH_BLOCKED");
  assert.ok(batch.errors[0].district, "錯誤要指出是哪個行政區");
  assert.equal(calls, 5, "停工之後第六個行政區不可以再打");
});

test("信義：連續被限速達門檻兩次才停工，之前抓到的行政區要留下來", async () => {
  const jobs = [{ regionId: 1, sectionIds: [8, 10, 12, 5, 7, 3], searchUrl: "scope" }];
  let calls = 0;
  const [batch] = await fetchSinyiCoveringListings(jobs, {
    pages: 1, gapMs: 0, blockCooldownMs: 0,
    postForm: async () => {
      calls += 1;
      if (calls >= 2) throw Object.assign(new Error("信義暫時無法抓取（HTTP 429）"), { code: "RATE_LIMITED" });
      return SINYI_FIXTURE;
    },
  });
  assert.ok(batch.listings.length > 0);
  assert.equal(batch.blocked, true);
  assert.equal(batch.errors.length, 4);
  assert.equal(batch.errors[0].code, "RATE_LIMITED");
  assert.ok(batch.errors[0].district);
  assert.equal(calls, 5);
});

test("單次被擋不可以讓整個來源停工（第九十五批：正式站就是這樣整輪 0 筆）", async () => {
  // 關鍵是「**不連續**的被擋」：第 2、4 個行政區各被擋一次、中間夾一次成功。
  // 這樣才驗得出「成功一頁就把計數歸零」——被擋計數若只累加不歸零，第 4 次就會誤觸門檻而停工。
  const hp = [{ regionId: 1, sectionIds: [8, 10, 12, 5, 7], searchUrl: "scope" }];
  const listCalls = [];
  const [hpBatch] = await fetchHpCoveringListings(hp, {
    pages: 1, detailGapMs: 0, gapMs: 0, blockCooldownMs: 0,
    getHtml: async (url) => {
      if (!String(url).includes("/list/")) return fixture("houseprice-list.html");
      listCalls.push(String(url));
      if (listCalls.length === 2 || listCalls.length === 4) {
        throw Object.assign(new Error("5168 暫時無法抓取（HTTP 403）"), { code: "FETCH_BLOCKED" });
      }
      return fixture("houseprice-list.html");
    },
  });
  assert.equal(listCalls.length, 5, "偶發被擋（不連續）時，五個行政區都要照抓");
  assert.equal(hpBatch.errors.length, 2);
  assert.ok(hpBatch.listings.length > 0);
  // 住商／信義同一組政策。
  let hbCalls = 0;
  const [hbBatch] = await fetchHbCoveringListings([{ regionId: 1, sectionIds: [8, 10, 12], searchUrl: "scope" }], {
    pages: 1, gapMs: 0, blockCooldownMs: 0,
    postJson: async () => {
      hbCalls += 1;
      if (hbCalls === 2) throw Object.assign(new Error("住商暫時無法抓取（HTTP 403）"), { code: "FETCH_BLOCKED" });
      return HB_FIXTURE;
    },
  });
  assert.equal(hbCalls, 3, "住商只被擋一次也要繼續跑後面的行政區");
  assert.equal(hbBatch.errors.length, 1);
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

test("noteSourceBlock：連續兩次才暫停、成功一頁就歸零", async () => {
  const { noteSourceBlock, SOURCE_BLOCK_PAUSE_LIMIT } = await import("../src/crawlWatchdog.js");
  assert.equal(SOURCE_BLOCK_PAUSE_LIMIT, 2);
  const blocked = Object.assign(new Error("5168 暫時無法抓取（HTTP 403）"), { code: "FETCH_BLOCKED" });
  const first = noteSourceBlock(0, blocked);
  assert.deepEqual(first, { consecutive: 1, pause: false }, "第一次被擋只跳過那一頁");
  const second = noteSourceBlock(first.consecutive, blocked);
  assert.deepEqual(second, { consecutive: 2, pause: true }, "連續第二次才暫停這一家");
  // 中間成功一頁 ⇒ 歸零（WAF 偶發阻擋不該讓整輪停工）。
  assert.deepEqual(noteSourceBlock(second.consecutive, new Error("ok")), { consecutive: 0, pause: false });
  // 非「被擋」的錯誤不算（逾時／解析失敗有自己的規則）。
  assert.deepEqual(noteSourceBlock(0, Object.assign(new Error("591 回應 500"), { code: "FETCH_FAILED" })), { consecutive: 0, pause: false });
  // 門檻可覆寫（沙盒 A/B 用）。
  assert.equal(noteSourceBlock(0, blocked, 1).pause, true);
});

test("5168 明細量：預設從 280 筆降到 60 筆，且可用 options／環境變數覆寫", async () => {
  // 預設值用原始碼釘住（功能上很難用夾具造出 280 筆的差別）：原本 80＋200，第九十五批改成 20＋40。
  const sourceText = readFileSync(new URL("../src/houseprice.js", import.meta.url), "utf8");
  assert.match(sourceText, /options\.detailLimit \?\? process\.env\.HP_DETAIL_LIMIT \?\? 20/,
    "其他明細上限預設 20（原本 80）");
  assert.match(sourceText, /options\.addressDetailLimit \?\? process\.env\.HP_ADDRESS_DETAIL_LIMIT \?\? 40/,
    "地址明細上限預設 40（原本 200）");
  // 功能：覆寫要真的生效（沙盒 A/B 靠它）。
  const jobs = [{ regionId: 1, sectionIds: [8], searchUrl: "scope" }];
  const detailCalls = [];
  const [batch] = await fetchHpCoveringListings(jobs, {
    pages: 1, gapMs: 0, detailGapMs: 0,
    detailLimit: 1, addressDetailLimit: 1,
    getHtml: async (url) => {
      if (String(url).includes("/list/")) return fixture("houseprice-list.html");
      detailCalls.push(String(url));
      return readFileSync(new URL("fixtures/houseprice-detail-api.json", import.meta.url), "utf8");
    },
  });
  assert.ok(detailCalls.length > 0, "還是要抓明細（只是有上限）");
  assert.ok(detailCalls.length <= 4, `上限 1＋1 時最多兩筆明細（API＋HTML 各一次），實際 ${detailCalls.length}`);
  assert.ok(batch.listings.length > 0, "明細有上限不影響列表頁的房源落地");
});

test("冷卻期：被擋到停工的來源會記住冷卻到什麼時候，下一輪跳過（第九十六批 B）", async () => {
  const { applySourceRound } = await import("../src/crawlSourceStreaks.js");
  const { isSourceCoolingDown, sourceBlockedUntil, SOURCE_BLOCK_COOLDOWN_MS } = await import("../src/crawlWatchdog.js");
  const at = "2026-09-30T12:00:00.000Z";
  assert.ok(SOURCE_BLOCK_COOLDOWN_MS > 0, "預設要有冷卻時間（0 只是測試用的覆寫）");
  // 這一輪被擋到停工 ⇒ 記下 blockedUntil。
  const blocked = applySourceRound({}, [{ source: "houseprice", covered: 0, total: 6, blocked: true, cooldownMs: 60000, error: "403" }], { at });
  assert.deepEqual(blocked.blocked, ["houseprice"]);
  assert.equal(blocked.streaks.houseprice.blockedUntil, "2026-09-30T12:01:00.000Z");
  assert.equal(isSourceCoolingDown(blocked.streaks.houseprice, Date.parse(at) + 30_000), true, "冷卻期內要跳過");
  assert.equal(isSourceCoolingDown(blocked.streaks.houseprice, Date.parse(at) + 90_000), false, "冷卻期過了就照常嘗試");
  // 沒有被擋（一般逾時／解析失敗）不該產生冷卻期。
  const plain = applySourceRound({}, [{ source: "houseprice", covered: 0, total: 6, error: "timeout" }], { at });
  assert.equal(plain.streaks.houseprice.blockedUntil, "");
  assert.equal(isSourceCoolingDown(plain.streaks.houseprice, Date.parse(at)), false);
  // 恢復成功要清掉冷卻期（照舊從嚴、不留殘影）。
  const recovered = applySourceRound(blocked.streaks, [{ source: "houseprice", covered: 6, total: 6 }], { at: "2026-09-30T12:02:00.000Z" });
  assert.equal(recovered.streaks.houseprice.blockedUntil, "");
  assert.equal(sourceBlockedUntil("壞掉的字串", 60000), "", "時間解析不出來就不要寫冷卻期");
  assert.equal(sourceBlockedUntil(at, 0), "");
});

test("冷卻預設改 30 分鐘（跨 2 輪）：預設 1800s、env 覆寫仍生效、跨過下一輪 15 分鐘邊界仍在冷卻", async () => {
  const { applySourceRound } = await import("../src/crawlSourceStreaks.js");
  const { isSourceCoolingDown, SOURCE_BLOCK_COOLDOWN_MS } = await import("../src/crawlWatchdog.js");
  // (a) 預設值：30 分鐘＝1800000ms。env 在模組載入時就解析，本行程沒設 env ⇒ 直接驗常數，
  // 並用原始碼釘住「return 1800 * 1000」防退步（與「5168 明細量」測試同風格）。
  const watchdogSrc = readFileSync(new URL("../src/crawlWatchdog.js", import.meta.url), "utf8");
  assert.match(watchdogSrc, /return 1800 \* 1000;/, "預設冷卻要寫成 1800 秒");
  assert.equal(SOURCE_BLOCK_COOLDOWN_MS, 1_800_000, "預設冷卻 30 分鐘＝1800000ms");

  // (c) 被擋到停工（沒帶 cooldownMs ⇒ 吃預設）：blockedUntil ≈ now + 30 分鐘，
  // 且下一輪（15 分鐘後）開頭仍在冷卻，代表冷卻真正跨過輪間隔、有實質效果。
  const at = "2026-09-30T12:00:00.000Z";
  const blocked = applySourceRound({}, [{ source: "houseprice", covered: 0, total: 6, blocked: true, error: "403" }], { at });
  assert.equal(blocked.streaks.houseprice.blockedUntil, "2026-09-30T12:30:00.000Z", "blockedUntil = 該輪時間 + 30 分鐘");
  assert.equal(isSourceCoolingDown(blocked.streaks.houseprice, Date.parse(at) + 15 * 60 * 1000), true,
    "下一輪（15 分鐘後）開頭仍在冷卻，要跳過");
  assert.equal(isSourceCoolingDown(blocked.streaks.houseprice, Date.parse(at) + 30 * 60 * 1000), false,
    "30 分鐘到期就照常嘗試");

  // (b) env 覆寫仍生效：模組已以預設值載入，改用子行程（新行程、重解析 env）驗證。
  const { spawnSync } = await import("node:child_process");
  const moduleUrl = new URL("../src/crawlWatchdog.js", import.meta.url).href;
  const script = `
    process.env.CRAWL_SOURCE_BLOCK_COOLDOWN_SECONDS = "45";
    const { SOURCE_BLOCK_COOLDOWN_MS } = await import(${JSON.stringify(moduleUrl)});
    console.log(SOURCE_BLOCK_COOLDOWN_MS);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "45000", "env CRAWL_SOURCE_BLOCK_COOLDOWN_SECONDS 覆寫要真的生效");
});

test("watcher：還在冷卻期的來源這一輪要跳過，並在輪次結果留 warning", () => {
  const src = readFileSync(new URL("../src/watcher.js", import.meta.url), "utf8");
  assert.match(src, /const cooling = new Set\(\);/);
  assert.match(src, /if \(isSourceCoolingDown\(row\)\) cooling\.add\(id\);/);
  assert.match(src, /cooling\.has\("591"\)/, "591 仍要就地冷卻判斷（它不参与外站輪轉）");
  // 2026-10-08：六家外站的冷卻判斷改由輪轉統一處理（`cooling` 傳進 `pickExternalSources`，
  // 冷卻中的家既不進 running 也不進 deferred ⇒ 不會被誤記成失敗輪）。
  // 這條行為現在由 crawl-external-rotation.test.js 用真的純函式驗，不再是比對文字。
  assert.match(src, /\{ perRun: externalSourcesPerRun\(process\.env\), cooling \}/, "外站的冷卻名單要傳進輪轉，不能漏");
  assert.match(src, /const externalTasks = \[[\s\S]{0,2200}?id: "rakuya"[\s\S]{0,900}?\];/, "六家都要留在輪轉清單裡（少一家就是悄悄停擺）");
  // 讀不到狀態時不可以讓整輪掛掉。
  assert.match(src, /const \{ streaks \} = await readCrawlSourceStreaksAsync\(\);/);
  assert.match(src, /catch \{\n    cooling\.clear\(\);\n  \}/);
  // 跳過要留紀錄（輪次結果 warnings）。
  assert.match(src, /仍在冷卻期（跳過這一家，讓對方的封鎖窗口過期）/);
  // 逐輪記錄要把 blocked 帶進狀態（否則永遠不會有冷卻期）。
  assert.match(src, /blocked: blocked === true,/);
  // 這一條刻意盯「用純函式而不是行內運算式」：2026-09-30 沙盒第一輪就是因為行內用到
  // try 區塊內的 `batches` 而 `ReferenceError`（文字斷言看不到作用域，整合測試才看得到）。
  assert.match(src, /noteSourceRound\(source, successful, sourceErrors, sourceRoundBlocked\(batches\), applicable, partial\);/);
  assert.match(src, /let batches = \[\];\n    try \{\n      batches = await run\(\);/);
});

test("不適用：這一輪沒有可抓行政區的來源不算失敗、也不可以擋住完成紀錄（第九十六批追加）", async () => {
  const { applySourceRound, blockingCrawlSources, jobCoveredByBlockingSources } = await import("../src/crawlSourceStreaks.js");
  const at = "2026-09-30T13:00:00.000Z";
  // 5168 只有台北／新北的 sid：其他縣市的覆蓋條件對它「不適用」。
  const round = applySourceRound(
    { houseprice: { fails: 2, lastError: "舊的 403" } },
    [{ source: "houseprice", covered: 0, total: 6, applicable: false }],
    { at },
  );
  assert.equal(round.streaks.houseprice.fails, 2, "不適用不可以累積失敗輪（原本會被記成第 3 輪失敗）");
  assert.deepEqual(round.notApplicable, ["houseprice"]);
  assert.deepEqual(round.recovered, [], "不適用也不是恢復成功");
  // 不適用的來源不可以擋住完成紀錄（它的 urls 是空的）。
  const entries = [
    { source: "591", urls: new Set(["u1"]) },
    { source: "houseprice", urls: new Set(), applicable: false },
  ];
  const blocking = blockingCrawlSources(entries, []);
  assert.deepEqual(blocking.map((row) => row.source), ["591"], "不適用的來源不得進阻擋名單");
  assert.equal(jobCoveredByBlockingSources({ searchUrl: "u1" }, blocking), true);
  // 有錯誤的失敗輪仍然要照舊累積（不能被這條放寬）。
  const failed = applySourceRound({ houseprice: { fails: 2 } }, [{ source: "houseprice", covered: 0, total: 6, error: "403" }], { at });
  assert.equal(failed.streaks.houseprice.fails, 3);
});

test("整輪被放棄時，落地階段要真的停下來（第九十六批追加；原本會把上萬筆寫完才結束）", () => {
  const src = readFileSync(new URL("../src/watcher.js", import.meta.url), "utf8");
  // 批次開頭檢查一次：否則預算用盡後整批（上萬筆）仍會寫完，下一輪又開始 ⇒ 兩輪重疊。
  assert.match(src, /throwIfCrawlCancelled\(\);\n    const isSearchBaseline = listingCountForSearch\(batch\.searchUrl\) === 0;/,
    "落地迴圈的批次開頭要有 throwIfCrawlCancelled()");
  // 同一批之內每 20 筆再檢查一次（用既有的 upserts 計數）。
  assert.match(src, /if \(upserts % 20 === 0\) throwIfCrawlCancelled\(\);/,
    "落地的房源迴圈要定期檢查取消");
  // 逐批完成記錄仍然要在（被放棄的輪次要留下已完成的覆蓋條件）。
  assert.match(src, /await completeCoveringPlan\(\{ successfulJobs: \[job\], memberRequirements: \[\], at: nowIso\(\) \}\);/);
});

test("被擋時不可以在同一輪空等（第九十六批踩點：90 秒 × 五個來源會把收集階段拖過預算）", () => {
  for (const file of ["../src/houseprice.js", "../src/hbhousing.js", "../src/sinyi.js"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    // 同一輪的「重試」就是這一輪剩下的部分；跨輪才需要冷卻（blockedUntil）。
    assert.doesNotMatch(src, /setTimeout\(resolve, cooldownMs\)/,
      `${file} 不該在逐頁 fail-soft 裡空等冷卻時間`);
    assert.match(src, /blocked: sourcePaused/, `${file} 仍要把「被擋到停工」往上回報`);
  }
});

test("每輪行政區上限＋輪詢（第九十七批）：一輪只抓上限個行政區，其餘下一輪再抓", async () => {
  const hp = await import("../src/houseprice.js");
  const { rotateSourceTargets } = await import("../src/crawlPolicy.js");
  // 純函式：上限 3、12 個行政區 ⇒ 每輪取 3 個，而且窗口會隨時間推進（輪詢）。
  const targets = Array.from({ length: 12 }, (_, i) => ({ sid: i + 1, sectionId: i + 1 }));
  const step = 20 * 60 * 1000;
  const first = rotateSourceTargets(targets, { limit: 3, now: 0, intervalMs: step }).map((t) => t.sid);
  const next = rotateSourceTargets(targets, { limit: 3, now: step, intervalMs: step }).map((t) => t.sid);
  assert.equal(first.length, 3);
  assert.equal(next.length, 3);
  assert.notDeepEqual(first, next, "下一個時間窗要換一批（輪詢，不是每輪都抓前三個）");
  assert.deepEqual(rotateSourceTargets(targets, { limit: 99, now: 0, intervalMs: step }).length, 12, "上限大於總數時全部回傳");

  // 功能：台北市 12 個行政區、上限 4 ⇒ 只打 4 頁（每區 1 頁），且標記 partial。
  const jobs = [{ regionId: 1, sectionIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], priceMin: 0, priceMax: 0, searchUrl: "scope" }];
  const listCalls = [];
  const [batch] = await hp.fetchHpCoveringListings(jobs, {
    pages: 1, gapMs: 0, detailGapMs: 0, detailLimit: 0, addressDetailLimit: 0,
    targetLimit: 4, now: 0,
    getHtml: async (url) => {
      if (!String(url).includes("/list/")) return fixture("houseprice-list.html");
      listCalls.push(String(url));
      return fixture("houseprice-list.html");
    },
  });
  assert.equal(listCalls.length, 4, `上限 4 ⇒ 只該打 4 頁，實際 ${listCalls.length}`);
  assert.equal(batch.partial, true, "沒抓完的輪次要標記 partial（不算這一組完成、也不算失敗）");
  assert.ok(batch.listings.length > 0, "抓到的部分還是要回報");

  // 上限夠大時不標 partial（一輪抓完）。
  const full = await hp.fetchHpCoveringListings([{ regionId: 1, sectionIds: [3], priceMin: 0, priceMax: 0, searchUrl: "s" }], {
    pages: 1, gapMs: 0, detailLimit: 0, addressDetailLimit: 0, targetLimit: 12,
    getHtml: async () => fixture("houseprice-list.html"),
  });
  assert.equal(full[0].partial, false);
});

test("partial 的輪次不算失敗也不算恢復（狀態原封不動）", async () => {
  const { applySourceRound } = await import("../src/crawlSourceStreaks.js");
  const at = "2026-10-01T01:00:00.000Z";
  const round = applySourceRound({ houseprice: { fails: 4 } }, [
    { source: "houseprice", covered: 0, total: 6, applicable: true, partial: true },
  ], { at });
  assert.equal(round.streaks.houseprice.fails, 4, "到達每輪上限不是失敗");
  assert.deepEqual(round.partial, ["houseprice"]);
  assert.deepEqual(round.failed, []);
  assert.deepEqual(round.recovered, []);
  // watcher 也要標記 partial（否則這一組會被誤記成已完成）。
  const watcherSrc = readFileSync(new URL("../src/watcher.js", import.meta.url), "utf8");
  assert.match(watcherSrc, /batch\.partial !== true\) successful\.add\(batch\.searchUrl\)/);
  assert.match(watcherSrc, /const partial = batches\.some\(\(batch\) => batch\?\.partial === true\);/);
});

test("每輪上限要平均分給每個 job（後面的 job 不能被前面的吃光）＋輪詢要推進", async () => {
  const hp = await import("../src/houseprice.js");
  const jobs = [
    { regionId: 1, sectionIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], priceMin: 0, priceMax: 0, searchUrl: "a" },
    { regionId: 3, sectionIds: [20, 21, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38], priceMin: 0, priceMax: 0, searchUrl: "b" },
  ];
  const run = async (now) => {
    const sids = [];
    const batches = await hp.fetchHpCoveringListings(jobs, {
      pages: 1, gapMs: 0, detailLimit: 0, addressDetailLimit: 0, targetLimit: 12, now,
      getHtml: async (url) => { if (String(url).includes("/list/")) sids.push(String(url).match(/(\d+)_zip/)?.[1]); return ""; },
    });
    return { sids: sids.join(","), partial: batches.map((b) => b.partial) };
  };
  const first = await run(0);
  const next = await run(20 * 60 * 1000);
  const firstSids = first.sids ? first.sids.split(",") : [];
  const nextSids = next.sids ? next.sids.split(",") : [];
  // 期望值從資料推導（不要硬編）：每個 job 的 distinct sid 數 → 每個 job 分到 perJob = floor(12/2) = 6。
  const sidsOf = (regionId, sections) => [...new Set(sections.map((s) => hp.hpSidForDistrict(regionId, s)).filter(Boolean))];
  const all1 = sidsOf(1, jobs[0].sectionIds);
  const all2 = sidsOf(3, jobs[1].sectionIds);
  const perJob = Math.floor(12 / 2);
  const expected = Math.min(perJob, all1.length) + Math.min(perJob, all2.length);
  assert.equal(firstSids.length, expected, `上限 12、兩個 job 各分 6 ⇒ 應為 ${expected} 個行政區，實際 ${firstSids.length}`);
  // 兩個 job 都要有批次（額度用完的那個要推 partial 批次，不能被當成失敗）。
  assert.equal(first.partial.length, 2);
  assert.deepEqual(first.partial, [true, true]);
  // 台北 12 個目標 > 每 job 額度 6 ⇒ 只有它的視窗需要輪詢推進。
  assert.notDeepEqual(firstSids.slice(0, 6), nextSids.slice(0, 6), "台北的視窗要往後推進");
  // 新北只有 5 個目標 < 額度 ⇒ 每一輪都全部抓到（不需要輪詢）。
  assert.equal(all2.length <= perJob, true);
  assert.deepEqual(nextSids.slice(6).sort(), all2.map(String).sort(), "目標數少於額度的 job 每輪都要全部抓到");

  // 極端情形：job 數比額度還多 ⇒ 額度用完的那個 job 要推一個 partial 批次（不能被當成失敗輪）。
  const many = [
    { regionId: 1, sectionIds: [3], priceMin: 0, priceMax: 0, searchUrl: "j1" },
    { regionId: 1, sectionIds: [5], priceMin: 0, priceMax: 0, searchUrl: "j2" },
    { regionId: 1, sectionIds: [8], priceMin: 0, priceMax: 0, searchUrl: "j3" },
  ];
  const fetched = [];
  const batches = await hp.fetchHpCoveringListings(many, {
    pages: 1, gapMs: 0, detailLimit: 0, addressDetailLimit: 0, targetLimit: 2, now: 0,
    getHtml: async (url) => { if (String(url).includes("/list/")) fetched.push(url); return ""; },
  });
  assert.equal(fetched.length, 2, `額度 2 ⇒ 只打 2 個行政區，實際 ${fetched.length}`);
  assert.equal(batches.length, 3, "三個 job 都要有批次（第三個是額度用完的 partial 批次）");
  assert.equal(batches[2].partial, true);
  assert.equal(batches[2].listings.length, 0);
});

test("額度只分給「有目標的 job」（正式站一輪常常只有 1～2 組是 5168 能抓的）", async () => {
  const hp = await import("../src/houseprice.js");
  // 6 個 job，只有台北（region 1）有 5168 的 sid；其餘 5 個縣市不適用。
  const jobs = [
    { regionId: 1, sectionIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], priceMin: 0, priceMax: 0, searchUrl: "taipei" },
    { regionId: 19, sectionIds: [295, 296, 297], priceMin: 0, priceMax: 0, searchUrl: "r19" },
    { regionId: 17, sectionIds: [243, 244, 245], priceMin: 0, priceMax: 0, searchUrl: "r17" },
    { regionId: 15, sectionIds: [206, 207, 208], priceMin: 0, priceMax: 0, searchUrl: "r15" },
    { regionId: 13, sectionIds: [167, 168, 169], priceMin: 0, priceMax: 0, searchUrl: "r13" },
    { regionId: 14, sectionIds: [185, 186, 187], priceMin: 0, priceMax: 0, searchUrl: "r14" },
  ];
  const sids = [];
  const batches = await hp.fetchHpCoveringListings(jobs, {
    pages: 1, gapMs: 0, detailLimit: 0, addressDetailLimit: 0, now: 0, targetLimit: 12,
    getHtml: async (url) => { if (String(url).includes("/list/")) sids.push(String(url).match(/(\d+)_zip/)?.[1]); return ""; },
  });
  // 只有一個 job 需要額度 ⇒ 12 個行政區全部給它（台北一輪掃完），不會被其他 5 個不適用的 job 稀釋。
  assert.equal(sids.length, 12, `只有一個適用的 job ⇒ 額度 12 全給它，實際 ${sids.length}`);
  assert.equal(batches.length, 6, "六個 job 都要有批次（不適用的帶 applicable:false）");
  assert.equal(batches.filter((b) => b.applicable === false).length, 5, "五個不適用的 job 要標 applicable:false");
  assert.equal(batches[0].partial, false, "12 個目標剛好用完額度 ⇒ 不算 partial");
});
