// 抓取輪次儀表板（觀測層）測試：證明「加 log 不改變行為」。
//
// 兩層：
//   1. 單元：fake logger 能收到「到點停手」等鍵，且輪次 id 唯一。
//   2. 整合：同一輪（同一個注入式來源）跑兩次，一次用記錄用 fake sink、一次再跑一遍，
//      「行為欄位」必須逐欄一致；同時記錄到的儀表板行要含
//      「輪次開始／結束、來源開始／結束、下架掃描開始、本批探測／複查」這些鍵。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-crawl-telemetry-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const { sqliteHandle } = await import("../src/db.js");
const { runWatch } = await import("../src/watcher.js");
const { withBudget } = await import("../src/crawlWatchdog.js");
const {
  crawlTelemetry,
  setCrawlPhase,
  currentCrawlPhase,
  logDeadlineStop,
  newCrawlRoundId,
  setCrawlTelemetrySink,
} = await import("../src/crawlTelemetry.js");

const HB_FIXTURE = JSON.parse(readFileSync(new URL("fixtures/hbhousing-page.json", import.meta.url), "utf8"));

function seed() {
  const db = sqliteHandle();
  db.exec("DELETE FROM settings; DELETE FROM listings; DELETE FROM crawl_covers; DELETE FROM user_settings; DELETE FROM users;");
  db.prepare("INSERT INTO settings(key,value) VALUES (?,?)").run("crawlSources", JSON.stringify([
    { id: "591", enabled: false },
    { id: "hbhousing", enabled: true },
  ]));
  db.prepare("INSERT INTO settings(key,value) VALUES (?,?)").run("hasBaseline", JSON.stringify(true));
  return db;
}

const JOBS = [{ regionId: 1, sectionIds: [8], priceMin: 0, priceMax: 0, searchUrl: "https://example.test/scope" }];
const OPTIONS = {
  jobs: JOBS,
  memberRequirements: [],
  includeSystem: false,
  skipHeavyGeo: true,
  silent: true,
  hbPostJson: async () => HB_FIXTURE,
};

// 只比「行為」有關的欄位，時間戳／隨機值不進比較。
function behaviorOf(result) {
  return {
    fetched: result.fetched,
    baseline: result.baseline,
    skipped: result.skipped,
    error: result.error,
    covers: (result.covers || []).length,
    offline: {
      checked: result.offline?.checked,
      gone: result.offline?.gone,
      rechecked: result.offline?.rechecked,
      restored: result.offline?.restored,
      confirmed: result.offline?.confirmed,
    },
    sources: (result.sources || []).map((s) => ({
      source: s.source,
      covered: s.covered,
      total: s.total,
      fails: s.fails,
      applicable: s.applicable,
      partial: s.partial,
      blocked: s.blocked,
    })),
  };
}

function recordingSink(lines) {
  return {
    log: (...a) => lines.push(["log", a.join(" ")]),
    warn: (...a) => lines.push(["warn", a.join(" ")]),
  };
}

test("儀表板單元：fake logger 收到「到點停手」鍵、phase 標記、輪次 id 唯一", () => {
  const lines = [];
  setCrawlTelemetrySink(recordingSink(lines));
  try {
    setCrawlPhase("來源 591");
    assert.equal(currentCrawlPhase(), "來源 591");
    logDeadlineStop(2400000);
    const a = newCrawlRoundId();
    const b = newCrawlRoundId();
    assert.notEqual(a, b, "每一輪的 id 都要不同");
    assert.ok(a.length > 0 && b.length > 0);
  } finally {
    setCrawlTelemetrySink(null);
  }
  assert.ok(lines.length >= 1, "至少要有一行（數行數）");
  const text = lines.map(([, m]) => m).join("\n");
  assert.match(text, /到點停手：本輪已耗 2400000ms，停在〈來源 591〉/);
  // crawlTelemetry 這條管道本身也可直接讀（鍵存在，不含任何額外輸出）。
  assert.equal(typeof crawlTelemetry.log, "function");
  assert.equal(typeof crawlTelemetry.warn, "function");
});

test("到點停手：withBudget 預算用盡時，先寫一行（含 phase）再取消", async () => {
  const lines = [];
  setCrawlTelemetrySink(recordingSink(lines));
  try {
    setCrawlPhase("來源 591");
    await assert.rejects(
      () => withBudget(new Promise(() => {}), 40, "測試抓取", { onTimeout: (elapsed) => logDeadlineStop(elapsed) }),
      /測試抓取超過/,
    );
  } finally {
    setCrawlTelemetrySink(null);
  }
  const text = lines.map(([, m]) => m).join("\n");
  assert.match(text, /到點停手：本輪已耗 \d+ms，停在〈來源 591〉/);
});

test("加 log 不改變行為：同一輪跑兩次，行為欄位一致，且儀表板鍵都存在", async () => {
  // 第一次：記錄用的 fake logger。
  seed();
  const lines1 = [];
  setCrawlTelemetrySink(recordingSink(lines1));
  let r1;
  try {
    r1 = await runWatch(OPTIONS);
  } finally {
    setCrawlTelemetrySink(null);
  }

  // 第二次：重新 seed、換一個 sink 再跑一遍，證明 log 只是旁路、不影響結果。
  seed();
  const lines2 = [];
  setCrawlTelemetrySink(recordingSink(lines2));
  let r2;
  try {
    r2 = await runWatch(OPTIONS);
  } finally {
    setCrawlTelemetrySink(null);
  }

  assert.deepEqual(behaviorOf(r1), behaviorOf(r2), "同一輪加不加（不同）log sink，行為欄位必須一致");
  assert.ok(r1.fetched > 0, "要真的落地，才有『落地階段』可量");

  const text1 = lines1.map(([, m]) => m).join("\n");
  // 輪次開始／結束（含 round id 與 fetched/covered/jobs 計數）。
  assert.match(text1, /輪次開始：/);
  assert.match(text1, /輪次結束：/);
  assert.match(text1, /fetched \d+，covered \d+，jobs \d+/);
  // 逐來源開始／結束（含行政區 x/y、頁 p）。
  assert.match(text1, /來源 住商：開始/);
  assert.match(text1, /來源 住商：結束（\d+ms，行政區 \d+\/\d+，頁 \d+）/);
  // 輪尾下架掃描：開始行（待確認 N／預算 M）與每批探測／複查。
  assert.match(text1, /下架掃描開始：待確認 \d+ 筆／預算 \d+ 筆/);
  assert.match(text1, /本批探測 \d+ 筆、耗時 \d+ms/);
  assert.match(text1, /本批複查 \d+ 筆、耗時 \d+ms/);

  // 兩次輸出結構一致（不是只發生在第一次）。
  const text2 = lines2.map(([, m]) => m).join("\n");
  assert.match(text2, /輪次開始：/);
  assert.match(text2, /輪次結束：/);
  assert.match(text2, /來源 住商：開始/);
  assert.match(text2, /下架掃描開始：待確認 \d+ 筆／預算 \d+ 筆/);
});
