// 背景逐筆讀取的 settings 瘦身（2026-10-12）：**當輪快照往下傳**，不是逐筆重讀。
//
// 為什麼要這一檔：`SELECT key, value FROM settings`（全域設定）在正式站 140 秒窗口內
// 被讀 1,113 次（≈8 次/秒），而且兩個窗口的速率一樣 ⇒ 是常態的背景迴圈，不是尖峰。
// 歸因（`v3/scripts/pg-callsite-trace.mjs` 的 pool／driver 插樁）指出：主要來源是
// `watcher.js` 的**逐筆**迴圈（下架掃描、明細補抓、來源套件、待通知定位、落地時逐筆重讀），
// 每一筆都透過 `listingForWatchAsync()` → `listingDetailAsync.getListingAsync()` 各讀一次
// 全域設定（`listingDetailAsync.js:60`）＋裝飾資料再讀一次（`db.js:3371`）。
//
// 契約（不准鬆）：
//   1. `getSettingsAsync()` 認 `options.globalRows`、裝飾資料認 `options.requestContext`
//      ⇒ 同一輪把那一批列傳下去，逐筆就是 0 條全域設定讀取。
//   2. 這是**同一輪呼叫鏈**的傳遞，不是跨輪快取：`runWatch()` 每一輪從
//      `crawlRuntimeAsync()` 拿到新的一批列，管理頁改了下一輪就看得到。
//   3. 逐筆的**個人**設定（user_settings／users）照舊逐筆讀，語意不變。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-sethot-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const PG = { driver: "postgres" };
const UID = 910000000001;
const POST_ID = 910000000002;

const GLOBAL_ROWS = [
  { key: "crawlSources", value: JSON.stringify([{ id: "591", enabled: true }]) },
  { key: "systemCrawlIntervalMinutes", value: JSON.stringify(20) },
];
const REQUEST_CONTEXT = {
  crawlSources: [{ id: "591", enabled: true }],
  systemCrawl: { intervalMinutes: 20 },
};

// 逐筆路徑唯一需要的列：一筆**非 591** 的房源（`ingestListingGeo()` 直接短路，不打外站）。
function fixture() {
  const calls = [];
  const exec = async (sql, params = []) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (/FROM listings/i.test(text)) {
      return [{
        post_id: POST_ID, source: "houseprice", title: "夾具物件", url: "https://example.test/l",
        price: "20000", price_num: 20000, lat: 25.11, lng: 121.52, geo_source: "geocode",
        location_class: "street", coord_version: 1, offline: 0, content_seq: 1,
        created_at: "2026-10-01T00:00:00.000Z",
        first_seen_at: "2026-10-01T00:00:00.000Z", last_seen_at: "2026-10-01T00:00:00.000Z",
      }];
    }
    if (/FROM users/i.test(text)) {
      return [{ id: UID, email: "member@example.test", role: "admin", plan: "free", created_at: "2026-01-01T00:00:00.000Z" }];
    }
    if (/FROM settings/i.test(text)) return [...GLOBAL_ROWS];
    if (/FROM user_settings/i.test(text)) return [];
    return [];
  };
  const pgDriver = {
    query: async (sql, params = []) => ({ rows: await exec(sql, params), rowCount: 0 }),
    exec: async () => undefined,
    withTransaction: (fn) => fn(pgDriver),
  };
  return { exec, pgDriver, calls };
}

const globalReads = (calls) => calls.filter((row) => /^\s*SELECT key, value FROM settings\s*$/i.test(row.sql));

test("getListingAsync：帶了當輪快照（globalRows＋requestContext）就不得再讀一次全域設定", async () => {
  const { getListingAsync } = await import("../src/listingDetailAsync.js");
  const withSnapshot = fixture();
  await getListingAsync(POST_ID, UID, {
    ...PG, exec: withSnapshot.exec, pgDriver: withSnapshot.pgDriver, strict: true,
    globalRows: GLOBAL_ROWS, requestContext: REQUEST_CONTEXT,
  });
  assert.equal(globalReads(withSnapshot.calls).length, 0,
    `逐筆讀取帶了快照就不准再讀全域設定，實際 ${globalReads(withSnapshot.calls).length} 次：${JSON.stringify(globalReads(withSnapshot.calls).map((r) => r.sql))}`);

  // 沒有快照時「本來就會讀」——這條同時證明上面的 0 不是因為夾具壞掉（什麼都沒讀）。
  const withoutSnapshot = fixture();
  await getListingAsync(POST_ID, UID, { ...PG, exec: withoutSnapshot.exec, pgDriver: withoutSnapshot.pgDriver, strict: true });
  assert.ok(globalReads(withoutSnapshot.calls).length >= 1, "沒有快照時逐筆本來就會讀全域設定（夾具要有能力觀測到）");
});

test("ingestListingGeo：呼叫端把當輪快照傳進來 ⇒ 逐筆 0 條全域設定讀取", async () => {
  const { ingestListingGeo } = await import("../src/watcher.js");
  const withSnapshot = fixture();
  const result = await ingestListingGeo(POST_ID, {
    ...PG, exec: withSnapshot.exec, pgDriver: withSnapshot.pgDriver,
    globalRows: GLOBAL_ROWS, requestContext: REQUEST_CONTEXT,
  });
  assert.equal(result?.error, undefined, `非 591 的房源應該直接短路，不該有錯誤：${result?.error}`);
  assert.equal(globalReads(withSnapshot.calls).length, 0,
    `逐筆 0 條全域設定讀取，實際 ${JSON.stringify(globalReads(withSnapshot.calls).map((r) => r.sql))}`);

  const withoutSnapshot = fixture();
  await ingestListingGeo(POST_ID, { ...PG, exec: withoutSnapshot.exec, pgDriver: withoutSnapshot.pgDriver });
  assert.ok(globalReads(withoutSnapshot.calls).length >= 1, "少了快照就會逐筆讀（這條是上面那條的對照組）");
});

// ── 接線（原始碼層）：逐筆迴圈一定要把當輪快照帶下去 ─────────────────────────
const read = (rel) => readFileSync(path.join(dir, rel), "utf8");
const fnBody = (src, header, stopAt = "\n}\n") => {
  const start = src.indexOf(header);
  assert.notEqual(start, -1, `找不到 ${header}`);
  const end = src.indexOf(stopAt, start);
  assert.notEqual(end, -1, `找不到 ${header} 的結尾`);
  // 註解裡會直接寫到函式名（`listingForWatchAsync()`），先剝掉才不會誤判。
  return src.slice(start, end).replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
};

test("crawlRuntimeAsync 要把當輪讀到的原始列（globalRows）回傳", () => {
  const src = read("../src/crawlScheduleAsync.js");
  const body = fnBody(src, "export async function crawlRuntimeAsync");
  assert.match(body, /await exec\('SELECT key,value FROM settings'\)/, "仍然是這一輪讀一次那一批列");
  assert.match(body, /globalRows:rows};/, "必須把當輪的列往下傳（不然逐筆會各自重讀）");
});

test("runWatch 逐筆讀取一律帶當輪快照（roundOptions／listingOptions）", () => {
  const src = read("../src/watcher.js");
  const body = fnBody(src, "export async function runWatch");
  assert.match(body, /const roundOptions = roundRows/, "runWatch 要在這一輪組一次 roundOptions");
  assert.match(body, /decorationRequestContextFromRows\(roundRows\)/, "裝飾資料要沿用同一批列");
  // 逐筆的 `listingForWatchAsync()` 一律要帶第三個參數（當輪快照），不得回到「每筆自己讀」。
  const calls = [...body.matchAll(/listingForWatchAsync\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 4, `runWatch 裡的逐筆讀取應該有數處，實際 ${calls.length}`);
  for (const args of calls) {
    assert.equal(args.split(",").length >= 3, true,
      `runWatch 裡的 listingForWatchAsync(${args}) 少了當輪快照參數`);
  }
  // 下架掃描與批次定位也要帶下去。
  assert.match(body, /listingOptions: roundOptions/, "下架掃描要帶 listingOptions");
  assert.match(body, /ingestListingGeoBatch\(freshIds, roundOptions\)/, "批次定位要帶當輪快照");
});

test("resolvePendingNotifyLocations／sweepOfflineListings 也走同一份快照", () => {
  const src = read("../src/watcher.js");
  const resolveBody = fnBody(src, "async function resolvePendingNotifyLocations");
  assert.match(resolveBody, /listingForWatchAsync\(event\.post_id, userId \|\| undefined, options\)/,
    "待通知定位的逐筆讀取要帶 options（當輪快照就在裡面）");
  assert.match(resolveBody, /ingestListingGeoBatch\(ids, options\)/, "批次定位要轉發 options");
  const sweepBody = fnBody(src, "async function sweepOfflineListings");
  assert.match(sweepBody, /listingOptions/, "下架掃描要用呼叫端給的當輪快照");
  for (const args of [...sweepBody.matchAll(/listingForWatchAsync\(([^)]*)\)/g)].map((m) => m[1])) {
    assert.equal(args.split(",").length >= 3, true,
      `下架掃描裡的 listingForWatchAsync(${args}) 少了當輪快照參數`);
  }
});
