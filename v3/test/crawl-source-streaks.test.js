// 抓取來源的連續失敗與放行政策（2026-09-30，第九十二批）。
//
// 症狀（正式站 2026-09-27～09-30 實查）：`crawl_covers.last_run_at` 38 列全部凍結在 09-27T04:05:35Z、
// `settings.lastCoveringAt` 停在 09-27T04:08:05Z、`crawlScheduleV1.completed` 是空的，
// 但 `lastSystemCoveringAt` 持續更新、591 房源持續落地 ⇒ 輪次有在跑，只是完成紀錄永遠寫不進去。
//
// 根因：完成判定是「該覆蓋條件在**每一個啟用來源**都成功」，任何一個來源／分頁失敗就讓
// `successfulJobs` 變成空集合（連第九十一批的逐批記錄也一樣被同一個條件擋住）。
//
// 這一包（Owner 當次同意政策變更）把「來源連續失敗」變成可容忍且有聲音的狀態：
//   1. 每一輪記錄各來源成敗 → `crawlScheduleV1.sourceStreaks`（連續失敗輪數、最後錯誤樣本、最後成功時間）。
//   2. 連續失敗達門檻（3 輪）的來源不再阻擋完成紀錄，但一定留下 warning 並在後台看得見。
//   3. 來源恢復成功 ⇒ 連續失敗歸零、照舊從嚴。
//   4. 安全閥：所有來源都在容忍名單時（全滅）仍然不記完成紀錄。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "crawl-source-streaks-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const read = (file) => readFileSync(path.join(SRC, file), "utf8");

const {
  SOURCE_FAILURE_ROUNDS_BEFORE_TOLERATED,
  SOURCE_ERROR_SAMPLE_MAX,
  applySourceRound,
  blockingCrawlSources,
  isCoveredRound,
  jobCoveredByBlockingSources,
  sourceRoundWarnings,
  toleratedCrawlSources,
} = await import("../src/crawlSourceStreaks.js");
const { sqliteHandle } = await import("../src/db.js");
const {
  recordCrawlSourceRoundAsync,
  readCrawlSourceStreaksAsync,
  reserveCoveringPlan,
  completeCoveringPlan,
} = await import("../src/crawlScheduleAsync.js");
const { sourceHealthFromRow } = await import("../src/adminOverview.js");
const { crawlSourceHealthAsync } = await import("../src/adminOverviewAsync.js");

const at = "2026-09-30T07:00:00.000Z";
const failing = (source, error = "HTTP 403 Forbidden") => ({ source, covered: 0, total: 6, error });
const ok = (source) => ({ source, covered: 6, total: 6, error: "" });

test("門檻 3 輪：前兩輪仍阻擋，第三輪起放行且只警告一次", () => {
  assert.equal(SOURCE_FAILURE_ROUNDS_BEFORE_TOLERATED, 3, "政策門檻是 3 輪（Owner 同意的版本）");
  let state = {};
  const steps = [];
  for (let round = 0; round < 4; round += 1) {
    const applied = applySourceRound(state, [failing("sinyi")], { at });
    state = applied.streaks;
    steps.push(applied);
  }
  assert.deepEqual(steps.map((s) => s.streaks.sinyi.fails), [1, 2, 3, 4], "連續失敗要逐輪累加");
  assert.deepEqual(steps.map((s) => s.tolerated), [[], [], ["sinyi"], ["sinyi"]], "第 3 輪才進容忍名單");
  assert.deepEqual(steps.map((s) => s.toleratedNow), [[], [], ["sinyi"], []], "越過門檻的那一輪才發一次警告");
  // 最後錯誤樣本與時間要留著（後台看得見）。
  assert.equal(state.sinyi.lastError, "HTTP 403 Forbidden");
  assert.equal(state.sinyi.lastFailureAt, at);
});

test("恢復成功立刻歸零、退出容忍名單（照舊從嚴）", () => {
  const three = applySourceRound({}, [
    { ...failing("sinyi"), covered: 0 },
  ], { at });
  const tolerated = applySourceRound({ sinyi: { fails: 3, lastError: "HTTP 403" } }, [ok("sinyi")], { at });
  assert.equal(tolerated.streaks.sinyi.fails, 0);
  assert.deepEqual(tolerated.tolerated, [], "恢復後不再放行");
  assert.deepEqual(tolerated.recovered, ["sinyi"]);
  assert.equal(tolerated.streaks.sinyi.lastSuccessAt, at);
  assert.equal(tolerated.streaks.sinyi.lastError, "HTTP 403", "最後錯誤樣本留作歷史，不影響判定");
  // 沒有失敗過的來源成功時不該產生「恢復」訊息（避免每輪都印）。
  assert.deepEqual(applySourceRound({}, [ok("sinyi")], { at }).recovered, []);
  // 部分成功仍然算失敗輪（保守）：6 組條件只覆蓋 5 組。
  const partial = applySourceRound({}, [{ source: "sinyi", covered: 5, total: 6, error: "第 3 頁逾時" }], { at });
  assert.equal(partial.streaks.sinyi.fails, 1, "部分成功要算一次失敗輪");
  assert.equal(isCoveredRound({ covered: 5, total: 6 }), false);
  assert.equal(isCoveredRound({ covered: 0, total: 0 }), false, "沒有 job 的輪次不算成功");
  assert.equal(three.streaks.sinyi.fails, 1);
});

test("安全閥：所有來源都被放行時，沒有任何 job 算完成", () => {
  const entries = [
    { source: "591", urls: new Set(["u1", "u2"]) },
    { source: "sinyi", urls: new Set() },
  ];
  const blocking = blockingCrawlSources(entries, ["sinyi"]);
  assert.deepEqual(blocking.map((row) => row.source), ["591"], "容忍名單裡的來源不再阻擋");
  assert.equal(jobCoveredByBlockingSources({ searchUrl: "u1" }, blocking), true);
  assert.equal(jobCoveredByBlockingSources({ searchUrl: "u3" }, blocking), false);
  assert.equal(
    jobCoveredByBlockingSources({ searchUrl: "u1" }, blockingCrawlSources(entries, ["591", "sinyi"])),
    false,
    "全體來源都在容忍名單（全滅）時不得記成完成",
  );
  assert.deepEqual(toleratedCrawlSources({ 591: { fails: 3 }, sinyi: { fails: 2 } }), ["591"]);
});

test("輪次 warning：要寫出標籤、輪數、錯誤樣本與恢復訊息", () => {
  const rounds = [failing("sinyi", `HTTP 403 ${"x".repeat(SOURCE_ERROR_SAMPLE_MAX * 2)}`)];
  // 先讓它失敗兩輪，第三輪才會越過門檻（warning 只發一次）。
  const applied = applySourceRound({ sinyi: { fails: 2 } }, rounds, { at });
  const lines = sourceRoundWarnings(applied, rounds);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /信義房屋/);
  assert.match(lines[0], /已連續失敗 3 輪/);
  assert.match(lines[0], /這一輪起不再阻擋覆蓋完成紀錄/);
  assert.match(lines[0], /後台「抓取來源」卡片可見/);
  assert.ok(lines[0].length < 700, "錯誤樣本要截短（狀態寫進 settings 的單一 JSON 值）");
  assert.ok(applied.streaks.sinyi.lastError.length <= SOURCE_ERROR_SAMPLE_MAX);
  const back = applySourceRound(applied.streaks, [ok("sinyi")], { at });
  assert.match(sourceRoundWarnings(back, [ok("sinyi")])[0], /恢復成功，連續失敗已歸零/);
});

test("落 PG／SQLite 的排程狀態：只加 sourceStreaks，其他欄位不能被蓋掉", async () => {
  const db = sqliteHandle();
  db.exec("DELETE FROM settings");
  const seed = { counter: 7, attempts: { "1|2|0|0": 7 }, completed: { "1|2|0|0": { at, cover: {} } } };
  db.prepare("INSERT INTO settings(key,value) VALUES (?,?)").run("crawlScheduleV1", JSON.stringify(seed));
  // 空陣列＝這一輪沒有來源結果（例如全部來源都關掉），不可動狀態。
  await recordCrawlSourceRoundAsync({ rounds: [], at }, { driver: "sqlite" });
  assert.deepEqual(await readCrawlSourceStreaksAsync({ driver: "sqlite" }), { streaks: {}, tolerated: [] });
  for (let round = 0; round < 3; round += 1) {
    await recordCrawlSourceRoundAsync({
      rounds: [failing("houseprice", "5168 第 1 頁 [FETCH_FAILED]：timeout"), ok("591")],
      at,
    }, { driver: "sqlite" });
  }
  const stored = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='crawlScheduleV1'").get().value);
  assert.equal(stored.counter, 7, "排程游標不能被蓋掉");
  assert.deepEqual(stored.attempts, seed.attempts);
  assert.deepEqual(stored.completed, seed.completed);
  assert.equal(stored.sourceStreaks["591"].fails, 0, "成功的來源要歸零");
  assert.equal(stored.sourceStreaks.houseprice.fails, 3);
  assert.match(stored.sourceStreaks.houseprice.lastError, /timeout/);
  const back = await readCrawlSourceStreaksAsync({ driver: "sqlite" });
  assert.deepEqual(back.tolerated, ["houseprice"]);
});

test("watcher 接線：每個來源帶 id、逐輪記錄的位置、warning 進輪次結果", () => {
  const src = read("watcher.js");
  // 來源 id 要跟著集合一起送進去（原本只有集合，出錯時看不出是哪個來源）。
  for (const id of ["591", "hbhousing", "sinyi", "houseprice", "ddroom", "housefun", "rakuya"]) {
    assert.match(src, new RegExp(`"${id}"`), `watcher 必須認得來源 ${id}`);
  }
  assert.match(src, /sourceSuccess\.push\(\{ source: "591", urls: successful \}\)/);
  assert.match(src, /async function collectExternal\(source, label, run\)/);
  // 逐輪記錄必須在收集階段之後、`!collected.length` 之前（全部來源都失敗的輪次也要累積）。
  const recordAt = src.indexOf("sourcePolicy = await recordCrawlSourceRoundAsync({ rounds: sourceRounds, at: nowIso() });");
  const emptyAt = src.indexOf("if (!collected.length) {");
  assert.ok(recordAt > 0 && recordAt < emptyAt, "記錄要在「這一輪什麼都沒抓到」之前（否則永遠失敗的來源不會被放行）");
  // 記錄失敗要維持從嚴，而且不能讓整輪掛掉。
  assert.match(src.slice(recordAt, recordAt + 400), /catch \(error\) \{/);
  assert.match(src.slice(recordAt, recordAt + 400), /這一輪維持從嚴/);
  // warning：console 一則 ＋ 輪次結果帶 warnings（兩條回傳路徑：正常結束、以及「全部來源都沒抓到」）。
  assert.match(src, /for \(const warning of sourceWarnings\) console\.warn\(warning\);/);
  assert.equal(src.split("warnings: sourceWarnings,").length - 1, 2, "輪次結果的兩條回傳路徑都要帶 warnings");
  assert.match(src, /tolerated: sourcePolicy\.tolerated\.includes\(round\.source\),/);
  // 排程狀態的預設形狀要含 sourceStreaks（舊狀態沒有這個鍵時才不會壞）。
  assert.match(read("crawlScheduleAsync.js"), /return \{counter:0,attempts:\{\},completed:\{\},sourceStreaks:\{\},\.\.\.state\};/);
  // 容忍名單一定要交給完成判定（政策變更的接點；忽略它就等於回到永遠從嚴）。
  assert.match(src, /const blockingSources = blockingCrawlSources\(sourceSuccess, sourcePolicy\.tolerated\);/);
  assert.match(src, /const isCoveredJob = \(job\) => jobCoveredByBlockingSources\(job, blockingSources\);/);
});

test("後台可見：連續失敗要出現在來源健康度（含已放行字樣）", () => {
  const enabled = { id: "houseprice", label: "5168 租屋", enabled: true };
  const fresh = sourceHealthFromRow(enabled, { lastSeen: "2026-09-26T09:01:00.000Z", todayNew: 0 });
  assert.equal(fresh.status, "unchecked", "沒有 streak 時行為不變");
  assert.equal(fresh.consecutiveFailures, 0);
  assert.equal(fresh.tolerated, false);
  const two = sourceHealthFromRow(enabled, {
    streak: { fails: 2, lastFailureAt: at, lastError: "timeout" },
  });
  assert.equal(two.status, "retrying");
  assert.equal(two.tolerated, false);
  assert.match(two.statusLabel, /連續失敗 2 輪/);
  assert.match(two.statusLabel, /還在阻擋完成紀錄/);
  const three = sourceHealthFromRow(enabled, {
    streak: { fails: 3, lastFailureAt: at, lastError: "timeout" },
  });
  assert.equal(three.status, "failing");
  assert.equal(three.tolerated, true);
  assert.match(three.statusLabel, /連續失敗 3 輪（已放行完成紀錄）/);
  assert.match(three.reason, /不再阻擋覆蓋完成紀錄/);
  assert.match(three.reason, /最後錯誤樣本：timeout/);
  // 關掉的來源仍以「已關閉」為主（不要被 streak 蓋掉）。
  assert.equal(sourceHealthFromRow({ ...enabled, enabled: false }, { streak: { fails: 9 } }).status, "disabled");
});

test("後台端點：crawlSourceHealthAsync 會把 streak 併進來源清單", async () => {
  const db = sqliteHandle();
  const items = [
    { id: "591", label: "591 租屋", stub: false, enabled: true },
    { id: "sinyi", label: "信義房屋", stub: false, enabled: true },
  ];
  db.prepare("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run("crawlSources", JSON.stringify(items));
  db.prepare("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run("crawlScheduleV1", JSON.stringify({ sourceStreaks: { sinyi: { fails: 3, lastError: "HTTP 403", lastFailureAt: at } } }));
  // 不連 PG：注入式 exec 直接回空集合（sourceListingStatsAsync 的既有注入點）。
  const exec = async () => [];
  const rows = await crawlSourceHealthAsync({ driver: "sqlite", exec });
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.equal(byId.sinyi.consecutiveFailures, 3);
  assert.equal(byId.sinyi.tolerated, true);
  assert.match(byId.sinyi.statusLabel, /已放行完成紀錄/);
  assert.equal(byId["591"].consecutiveFailures, 0);
  assert.equal(byId["591"].tolerated, false);
});

test("政策鏈：連續失敗 3 輪之後，覆蓋完成紀錄才真的寫得進去（crawl_covers 前進）", async () => {
  const db = sqliteHandle();
  db.exec("DELETE FROM user_settings; DELETE FROM users; DELETE FROM settings; DELETE FROM crawl_covers;");
  const due = "2026-09-30T00:00:00.000Z";
  db.prepare("INSERT INTO users(id,email,role,created_at) VALUES (?,?,?,?)").run(101, "streak@example.test", "admin", due);
  db.prepare("INSERT INTO settings(key,value) VALUES (?,?)").run("crawlSources", JSON.stringify([
    { id: "591", enabled: false },
    { id: "sinyi", enabled: true },
  ]));
  const urls = Array.from({ length: 19 }, (_, i) => `https://rent.591.com.tw/list?region=${i + 1}`);
  for (const [key, value] of Object.entries({ searchUrls: urls, memberFetchDueAt: due, notificationsPaused: false })) {
    db.prepare("INSERT INTO user_settings(user_id,key,value) VALUES (?,?,?)").run(101, key, JSON.stringify(value));
  }
  const options = { driver: "sqlite" };
  const plan = await reserveCoveringPlan({ now: Date.parse(due), includeSystem: false }, options);
  assert.equal(plan.jobs.length, 6);
  // 正式站的形狀：591（此處以 sinyi 代表「一直成功的那一個」）成功、另一個來源每輪都失敗。
  const entries = [
    { source: "sinyi", urls: new Set(plan.jobs.map((job) => job.searchUrl)) },
    { source: "houseprice", urls: new Set() },
  ];
  const rounds = [
    { source: "sinyi", covered: plan.jobs.length, total: plan.jobs.length, error: "" },
    { source: "houseprice", covered: 0, total: plan.jobs.length, error: "第 1 頁 [FETCH_FAILED]：timeout" },
  ];
  const counts = [];
  for (let round = 1; round <= 3; round += 1) {
    const applied = await recordCrawlSourceRoundAsync({ rounds, at }, options);
    const blocking = blockingCrawlSources(entries, applied.tolerated);
    const done = await completeCoveringPlan({
      successfulJobs: plan.jobs.filter((job) => jobCoveredByBlockingSources(job, blocking)),
      memberRequirements: plan.memberRequirements,
      at,
    }, options);
    counts.push(db.prepare("SELECT COUNT(*) AS n FROM crawl_covers").get().n);
    // 前兩輪：失敗來源還在阻擋 ⇒ 沒有任何完成紀錄（＝正式站 2026-09-27～09-30 的凍結狀態）。
    if (round < 3) assert.equal(done.coversTouched, false, `第 ${round} 輪不該記完成`);
    else assert.equal(done.coversTouched, true, "第 3 輪（放行後）要記完成");
  }
  assert.deepEqual(counts, [0, 0, 6], "只有第 3 輪之後 crawl_covers 才長出紀錄");
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='lastCoveringAt'").get()?.value, JSON.stringify(at));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM crawl_covers WHERE last_run_at=?").get(at).n, 6);
  // 對照組：同一批來源若永遠從嚴（容忍名單空），再跑十輪也不會留下任何完成紀錄。
  db.exec("DELETE FROM crawl_covers; DELETE FROM settings WHERE key='lastCoveringAt';");
  for (let round = 0; round < 10; round += 1) {
    const blocking = blockingCrawlSources(entries, []);
    await completeCoveringPlan({
      successfulJobs: plan.jobs.filter((job) => jobCoveredByBlockingSources(job, blocking)),
      memberRequirements: plan.memberRequirements,
      at,
    }, options);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM crawl_covers").get().n, 0, "沒有放行政策時就是原本的凍結狀態");
});
