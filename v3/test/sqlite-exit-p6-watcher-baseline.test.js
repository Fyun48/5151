// sqlite-exit P6：把 baseline 判定（watcher.js runWatch 的 `isBaseline`）摘掉最後一個可達的同步
// SQLite 讀點。
//
// 修前的形狀（watcher.js）：
//   const isBaseline = settings.hasBaseline !== true && listingCount() === 0;
// 而 db.js 的 listingCount() 是裸的同步讀：
//   return Number(db.prepare("SELECT COUNT(*) AS n FROM listings").get().n || 0);
// `hasBaseline !== true` 不只出現在「全新庫」——db.js 的 resetListings() 會寫回
// RESET_LISTINGS_SETTINGS = Object.freeze({ hasBaseline: false })（後台「清除物件」之後、或新節點
// 都是這個狀態）。於是使用者只要清過資料，開閘（PG_NO_SQLITE_OPEN=1）就整輪跑不動：
//   business SQLite is closed (PG_NO_SQLITE_OPEN=1, DB_DRIVER=postgres): synchronous SQLite ...
// 今天正式站不觸發，只是因為旗標已經是 true（watcher 收尾會寫回），不是因為這條路徑安全。
//
// 修後的形狀（裁定 (c)：存在性查詢，不是 COUNT(*)）：
//   const isBaseline = settings.hasBaseline !== true && !(await listingExistsAsync());
//   crawlerReads.js 的 listingExistsAsync()：PG 走 `SELECT 1 FROM listings LIMIT 1`（不讀本機
//   SQLite），非 PG 才委派 db.js 的同步 listingCount()。沒有 try/catch、沒有 fail-open——baseline
//   判錯會靜默濫發或靜默漏發通知，比讓 PG 錯誤浮現更糟。
//
// 這個檔案不連任何真實 PG、不碰共用庫、更不會把 hasBaseline 改成 false：
//   • 開閘情境用「子行程」（db.js 的閘在 import 階段生效，且 ESM 快取會污染同一個 process），
//     島上 db.js 的 handle 本身就是「碰 method 就拋」的 proxy —— 它就是最嚴格的間諜。
//   • PG 分支一律用離線注入的 options.exec 夾具。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcFile = (name) => join(repoRoot, "src", name);
const srcUrl = (name) => pathToFileURL(srcFile(name)).href;

const CLOSED_MARKER = "business SQLite is closed";

// 子行程探針：在同一個 process 裡先走「修前的同步路徑」（必須拋），再走「修後的 PG 分支」（必須不拋）。
const PROBE = `
const { writeFileSync } = await import("node:fs");
const out = {};
const dbMod = await import(process.env.DB_JS_URL);
const { sqliteHandleIsUsable } = await import(process.env.SQLITE_HANDLE_URL);
const reads = await import(process.env.CRAWLER_READS_URL);

out.driver = process.env.DB_DRIVER;
out.noSqliteOpen = process.env.PG_NO_SQLITE_OPEN;
out.handleUsable = sqliteHandleIsUsable(dbMod.sqliteHandle());
out.listingExistsAsyncType = typeof reads.listingExistsAsync;

// ① before-red：逐字重現修前 watcher.js 那條表達式的右半邊（同步 SQLite 讀）。
try {
  out.beforeRed = { threw: false, value: dbMod.listingCount() === 0 };
} catch (error) {
  out.beforeRed = { threw: true, message: error.message };
}

// ② after-green：同一座開閘島上，PG 分支靠注入的 exec 回答，不碰本機 SQLite。
const calls = [];
const execReturning = (rows) => async (sql) => { calls.push(String(sql)); return rows; };
const EMPTY = [];
const ONE_ROW = [{ "?column?": 1 }];
const settingsHasBaselineFalse = { hasBaseline: false };
const settingsHasBaselineTrue = { hasBaseline: true };
try {
  const emptyRows = await reads.listingExistsAsync({ driver: "postgres", exec: execReturning(EMPTY) });
  const oneRow = await reads.listingExistsAsync({ driver: "postgres", exec: execReturning(ONE_ROW) });
  const isBaselineEmpty = settingsHasBaselineFalse.hasBaseline !== true
    && !(await reads.listingExistsAsync({ driver: "postgres", exec: execReturning(EMPTY) }));
  const isBaselineNonEmpty = settingsHasBaselineFalse.hasBaseline !== true
    && !(await reads.listingExistsAsync({ driver: "postgres", exec: execReturning(ONE_ROW) }));
  const isBaselineAlreadyTrue = settingsHasBaselineTrue.hasBaseline !== true
    && !(await reads.listingExistsAsync({ driver: "postgres", exec: execReturning(EMPTY) }));
  out.afterGreen = { threw: false, emptyRows, oneRow, isBaselineEmpty, isBaselineNonEmpty, isBaselineAlreadyTrue, calls };
} catch (error) {
  out.afterGreen = { threw: true, message: error.message, calls };
}
writeFileSync(process.env.RESULT_FILE, JSON.stringify(out));
`;

function probeIsland() {
  const dataDir = mkdtempSync(join(tmpdir(), "p6-baseline-"));
  const resultFile = join(dataDir, "result.json");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", PROBE], {
    env: {
      ...process.env,
      DB_DRIVER: "postgres",
      PG_NO_SQLITE_OPEN: "1",
      DATA_DIR: dataDir,
      DB_JS_URL: srcUrl("db.js"),
      SQLITE_HANDLE_URL: srcUrl("sqliteHandle.js"),
      CRAWLER_READS_URL: srcUrl("crawlerReads.js"),
      RESULT_FILE: resultFile,
    },
    encoding: "utf8",
  });
  let result = null;
  try {
    result = JSON.parse(readFileSync(resultFile, "utf8"));
  } catch {
    result = null;
  }
  return { child, result, dataDir };
}

test("before-red：開閘島上，修前的同步讀點 listingCount() 必拋 business SQLite is closed", () => {
  const { child, result, dataDir } = probeIsland();
  try {
    assert.equal(child.status, 0, `探針子行程失敗：\n${child.stderr}`);
    assert.ok(result, "探針沒有寫出結果檔");
    // 先證明閘真的開了（否則這條 before-red 是假的）
    assert.equal(result.driver, "postgres", "探針必須跑在 DB_DRIVER=postgres");
    assert.equal(result.noSqliteOpen, "1", "探針必須跑在 PG_NO_SQLITE_OPEN=1");
    assert.equal(result.handleUsable, false, "PG_NO_SQLITE_OPEN=1 時 sqliteHandle() 必須是「不可用」的拋錯 proxy");
    // 修前的路徑
    assert.equal(result.beforeRed.threw, true, "修前的同步 listingCount() 必須在開閘時拋錯");
    assert.match(result.beforeRed.message, /business SQLite is closed/, "錯誤訊息必須是開閘訊息");
    assert.match(result.beforeRed.message, /PG_NO_SQLITE_OPEN=1/, "錯誤訊息必須點名開閘旗標");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("after-green：開閘島上 PG 分支回空陣列 ⇒ listingExistsAsync()===false、isBaseline===true", () => {
  const { child, result, dataDir } = probeIsland();
  try {
    assert.equal(child.status, 0, `探針子行程失敗：\n${child.stderr}`);
    assert.ok(result, "探針沒有寫出結果檔");
    assert.equal(result.listingExistsAsyncType, "function", "crawlerReads.js 必須匯出 listingExistsAsync");
    const g = result.afterGreen;
    assert.equal(g.threw, false, `PG 分支不得拋錯：${g.message || ""}`);
    // 空目錄 ⇒ 沒有既有資料 ⇒ 這一輪是 baseline
    assert.equal(g.emptyRows, false, "注入空陣列時 listingExistsAsync() 必須是 false");
    assert.equal(g.isBaselineEmpty, true, "hasBaseline=false 且目錄為空 ⇒ isBaseline 必須是 true");
    // 有一筆 ⇒ 不是 baseline
    assert.equal(g.oneRow, true, "注入一筆時 listingExistsAsync() 必須是 true");
    assert.equal(g.isBaselineNonEmpty, false, "hasBaseline=false 但目錄已有資料 ⇒ isBaseline 必須是 false");
    // 旗標已是 true ⇒ 不管目錄如何都不是 baseline（與修前行為逐字相同）
    assert.equal(g.isBaselineAlreadyTrue, false, "hasBaseline=true ⇒ isBaseline 必須是 false");
    // 查詢形狀：存在性查詢，不是 COUNT(*)
    assert.ok(g.calls.length >= 1, "PG 分支必須真的打了一次查詢");
    for (const sql of g.calls) {
      assert.equal(sql, "SELECT 1 FROM listings LIMIT 1", `PG 分支只准送存在性查詢，實際：${sql}`);
      assert.doesNotMatch(sql, /COUNT\s*\(/i, "不得再用 COUNT(*)（本包裁定 (c) 是存在性查詢）");
    }
    // 整段 after-green 過程中不得出現開閘訊息
    assert.doesNotMatch(JSON.stringify(g), new RegExp(CLOSED_MARKER), "after-green 過程中不得觸碰同步 SQLite handle");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("after-green：PG 分支從不觸碰 SQLite（間諜只看到存在性查詢，且與 COUNT 版結果可以不一致）", async () => {
  const seen = [];
  const { listingExistsAsync } = await import("../src/crawlerReads.js");
  const exec = async (sql) => {
    seen.push(String(sql));
    return [];
  };
  assert.equal(await listingExistsAsync({ driver: "postgres", exec }), false);
  assert.equal(await listingExistsAsync({ driver: "postgres", exec }), false);
  assert.deepEqual(seen, ["SELECT 1 FROM listings LIMIT 1", "SELECT 1 FROM listings LIMIT 1"],
    "PG 分支只能送存在性查詢（沒有 COUNT、沒有 fallback 讀）");
  assert.doesNotMatch(seen.join("\n"), new RegExp(CLOSED_MARKER));
});

test("after-green：非 PG 分支委派 db.js listingCount() 且不拋", async () => {
  assert.notEqual(process.env.PG_NO_SQLITE_OPEN, "1",
    "這條測試需要可用的本機 SQLite handle（不是開閘島）");
  const dataDir = mkdtempSync(join(tmpdir(), "p6-baseline-lite-"));
  process.env.DATA_DIR = dataDir;
  try {
    const { listingExistsAsync } = await import("../src/crawlerReads.js");
    const { listingCount } = await import("../src/db.js");
    // 明確指定 sqlite
    assert.equal(await listingExistsAsync({ driver: "sqlite" }), false, "空目錄 ⇒ 存在性 false");
    assert.equal(listingCount(), 0, "同步版在同一個庫上必須給出同樣的答案");
    // 不指定 driver ⇒ 走 resolveDbDriver()（這裡是預設 sqlite）
    assert.equal(await listingExistsAsync(), false, "預設 driver 也必須委派同步版且不拋");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("source：watcher.js 的 baseline 判定已改成 await listingExistsAsync()，且死 import 已清掉", () => {
  const watcher = readFileSync(srcFile("watcher.js"), "utf8");
  assert.match(watcher,
    /const isBaseline = settings\.hasBaseline !== true && !\(await listingExistsAsync\(\)\);/,
    "watcher.js 必須用新的等待式判定");
  assert.doesNotMatch(watcher, /listingCount\(\)\s*===\s*0/,
    "watcher.js 不得再留著同步的 listingCount() === 0");
  assert.match(watcher, /\n  listingExistsAsync,\n/, "watcher.js 必須 import listingExistsAsync");
  assert.doesNotMatch(watcher, /\n  listingCount,\n/, "watcher.js 不得再 import listingCount");
  assert.doesNotMatch(watcher, /\n  getSettings,\n/, "watcher.js 的死 import getSettings 必須移除（真呼叫全走 getSettingsAsync）");
  // runWatch 必須仍是 async 且該行前面有 await 可用
  assert.match(watcher, /export async function runWatch\(options = \{\}\) \{/, "runWatch 必須維持 async");
});

test("source：listingExistsAsync 沒有 try/catch、沒有 fail-open、沒有對閘失明的守衛", () => {
  const crawlerReads = readFileSync(srcFile("crawlerReads.js"), "utf8");
  const start = crawlerReads.indexOf("export async function listingExistsAsync");
  assert.ok(start > 0, "找不到 listingExistsAsync");
  const end = crawlerReads.indexOf("\n}", start);
  const body = crawlerReads.slice(start, end);
  assert.match(body, /const driver = options\.driver \|\| resolveDbDriver\(\);/);
  assert.match(body, /if \(driver !== "postgres"\) return listingCount\(\) > 0;/);
  assert.match(body, /const exec = await postgresExec\(options\);/);
  assert.match(body, /const rows = await exec\("SELECT 1 FROM listings LIMIT 1"\);/);
  assert.match(body, /return rows\.length > 0;/);
  assert.doesNotMatch(body, /try\s*\{|catch\s*\(/, "不准有 try/catch（不接受 fail-open）");
  assert.doesNotMatch(body, /sqliteFallbackAllowed/, "不准用對閘失明的判斷當守衛");
});
