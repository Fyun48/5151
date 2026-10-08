// `runWatch()` 的**整輪整合測試**（2026-09-30，第九十六批追加）。
//
// 為什麼要這一支：在這之前 `runWatch`（真的抓取路徑）完全沒有被任何測試執行過——
// 爬蟲相關的測試不是純函式、就是比對原始碼文字。第九十六批因此在 `collectExternal()` 裡
// 留下一個 `ReferenceError: batches is not defined`：文字斷言看得到那一行、卻看不到它在作用域外。
// **沙盒第一輪就把它打出來**（落地 0 筆、錯誤 `batches is not defined`），這一支就是把那個情境
// 變成離線測試：讓 `runWatch` 真的跑完一輪（收集 → 逐輪記錄 → 落地 → 完成紀錄）。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-crawl-round-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const { sqliteHandle } = await import("../src/db.js");
const { runWatch } = await import("../src/watcher.js");
const { readCrawlSourceStreaksAsync } = await import("../src/crawlScheduleAsync.js");

const HB_FIXTURE = JSON.parse(readFileSync(new URL("fixtures/hbhousing-page.json", import.meta.url), "utf8"));

function seed() {
  const db = sqliteHandle();
  db.exec("DELETE FROM settings; DELETE FROM listings; DELETE FROM crawl_covers; DELETE FROM user_settings; DELETE FROM users;");
  // 只開住商：591 與其他外部來源都不會被打（整輪只剩一條可注入的來源）。
  db.prepare("INSERT INTO settings(key,value) VALUES (?,?)").run("crawlSources", JSON.stringify([
    { id: "591", enabled: false },
    { id: "hbhousing", enabled: true },
  ]));
  db.prepare("INSERT INTO settings(key,value) VALUES (?,?)").run("hasBaseline", JSON.stringify(true));
  return db;
}

test("runWatch 真的跑完一輪：來源狀態要記進排程狀態、房源要落地（第九十六批的 RReferenceError 回歸鎖）", async () => {
  const db = seed();
  const jobs = [{ regionId: 1, sectionIds: [8], priceMin: 0, priceMax: 0, searchUrl: "https://example.test/scope" }];
  const result = await runWatch({
    jobs,
    memberRequirements: [],
    includeSystem: false,
    skipHeavyGeo: true,
    silent: true,
    hbPostJson: async () => HB_FIXTURE,
  });

  // 整輪不可以丟錯（`batches is not defined` 會讓整輪在收集階段就炸掉，這裡會直接 reject）。
  assert.ok(result, "runWatch 必須回傳結果");
  assert.equal(result.error, undefined, `不該有輪次錯誤：${result.error}`);
  assert.ok(result.fetched > 0, `應該要有房源落地，實際 ${result.fetched}`);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM listings").get().n, result.fetched, "落地筆數要與 DB 相符");

  // 逐輪記錄（第九十二批）要在真的一輪裡生效：來源狀態寫得進去。
  assert.equal(result.sources.length, 1, "這一輪只有住商一個來源");
  assert.equal(result.sources[0].source, "hbhousing");
  assert.equal(result.sources[0].total, 1, "一組覆蓋條件");
  const { streaks } = await readCrawlSourceStreaksAsync({ driver: "sqlite" });
  assert.ok(streaks.hbhousing, `來源狀態必須寫進 crawlScheduleV1，實際 ${JSON.stringify(streaks)}`);
  assert.equal(streaks.hbhousing.fails, 0, "沒有任何錯誤 ⇒ 不算失敗輪");
  assert.ok(streaks.hbhousing.lastSuccessAt, "要有最後成功時間");
  assert.equal(streaks.hbhousing.blockedUntil, "", "沒被擋就不該有冷卻期");
});

test("runWatch：來源被擋到停工時，輪次要標記 blocked 並記下冷卻期（第九十六批 B）", async () => {
  const db = seed();
  const jobs = [{ regionId: 1, sectionIds: [8, 10, 12, 5, 7, 3], priceMin: 0, priceMax: 0, searchUrl: "https://example.test/scope" }];
  let calls = 0;
  const result = await runWatch({
    jobs,
    memberRequirements: [],
    includeSystem: false,
    skipHeavyGeo: true,
    silent: true,
    // 除了第一個行政區以外全部被擋、而且不冷卻（避免測試等 90 秒）：
    // 第 2/3 次達門檻先冷卻重試，第 4/5 次再達門檻 ⇒ 這一家這一輪停工。
    hbPostJson: async () => {
      calls += 1;
      if (calls >= 2) throw Object.assign(new Error("住商暫時無法抓取（HTTP 403）"), { code: "FETCH_BLOCKED" });
      return HB_FIXTURE;
    },
  });
  assert.equal(result.sources[0].source, "hbhousing");
  assert.ok(result.errors.some((line) => /FETCH_BLOCKED/.test(String(line))), `要有被擋的錯誤紀錄：${JSON.stringify(result.errors.slice(0, 3))}`);
  // 冷卻重試讓停工延後（不是第一次被擋就整輪放棄）：錯誤樣本會有多筆。
  assert.ok(result.errors.filter((line) => /FETCH_BLOCKED/.test(String(line))).length >= 2, "達門檻兩次才停工");

  const { streaks } = await readCrawlSourceStreaksAsync({ driver: "sqlite" });
  assert.ok(streaks.hbhousing, "來源狀態要寫進去");
  assert.ok(streaks.hbhousing.fails >= 1, "被擋 ⇒ 這一輪算失敗輪");
  // 預設冷卻 30 分鐘（跨 2 輪）：停工之後要留下冷卻期，讓下一輪跳過這一家。
  assert.ok(streaks.hbhousing.blockedUntil, `被擋到停工要記冷卻期，實際 ${JSON.stringify(streaks.hbhousing)}`);
  assert.ok(Date.parse(streaks.hbhousing.blockedUntil) > Date.now() - 1000, "冷卻期必須是未來時間");
});

// 2026-10-08：一家外站就能吃光整輪（實測 591 花 13 分鐘、5168 一家花 27 分鐘零落地，
// 整輪 40 分鐘被砍）。所以现在每家有自己的「階段預算」，用盡時這一輪對這家是
// 「只跑了一半」（partial），**不可以**被記成連續失敗，也不可以讓整輪跟著爆。
// 這條用注入的 400ms 預算＋會睡 2.5 秒的 fake，把同一條路跑成離線測試。
test("階段預算用盡：這家算 partial（不算失敗）、要蓋 lastAttemptAt、整輪照樣收尾", async () => {
  const db = seed();
  const jobs = [{ regionId: 1, sectionIds: [8], priceMin: 0, priceMax: 0, searchUrl: "https://example.test/hb-1" }];
  const result = await runWatch({
    jobs,
    memberRequirements: [],
    includeSystem: false,
    skipHeavyGeo: true,
    silent: true,
    externalPhaseBudgetMs: 400,
    hbPostJson: async () => {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      return HB_FIXTURE;
    },
  });
  const hb = (result.sources || []).find((row) => row.source === "hbhousing");
  assert.ok(hb, "hbhousing 要出現在這一輪的來源記錄裡（partial 也要有記錄，才蓋得到章）");
  assert.equal(hb.partial, true, `階段預算用盡要標成 partial，實際 ${JSON.stringify(hb)}`);
  assert.match(result.errors.join("｜"), /階段預算[\s\S]{0,40}用盡/, "日誌要看得懂是我們的預算停的手，不是對方擋");
  const { streaks } = await readCrawlSourceStreaksAsync();
  assert.equal(streaks.hbhousing?.fails, 0, "partial 不可以累加 fails（否則三家會變成『連續失敗 117 輪』那種假案情）");
  assert.ok(String(streaks.hbhousing?.lastAttemptAt || "") , "排過就要蓋章，下一輪輪轉才會換人");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key='crawlScheduleV1'").get().n, 1);
});
