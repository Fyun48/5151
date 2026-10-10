// SQLite 退場 P5b 門禁：開閘（PG_NO_SQLITE_OPEN=1）＋ PG_SQLITE_FALLBACK=closed 的**生產語意**下，
// PG 的原始錯誤不得被回退路徑的「business SQLite is closed」蓋掉。
//
// 為什麼一定要用子行程：`v3/src/db.js` 在 **module 載入時**就決定要不要開業務 SQLite
// （`const PG_NO_SQLITE_OPEN = resolveDbDriver() === "postgres" && process.env.PG_NO_SQLITE_OPEN === "1"`），
// 開閘後的 `sqliteHandle()` 回傳值（帶 marker 的拋錯 proxy）在載入後就固定了。要驗「閘真的關著」的
// 語意，只能在 import 之前把環境變數準備好 —— 也就是另開一個行程。
//
// 為什麼一定要 PG_SQLITE_FALLBACK=closed（不是 strict）：
//   - 閘關（未設 PG_NO_SQLITE_OPEN）         ：測不到（handle 可用，走的是回退，本來就不該拋）
//   - 閘開 ＋ fallback=strict               ：`sqliteFallbackAllowed()` 就先擋掉了，回退點根本沒被走到
//   - 閘開 ＋ fallback=closed（本測試）      ：寫入 fail-closed、**讀取仍允許回退** ⇒ 回退點必須自己
//     判斷「有沒有可用的 handle」並把 PG 錯誤丟出來。這才是正式站的行為（closed 是預設值）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const srcUrl = (rel) => pathToFileURL(path.join(ROOT, "v3", "src", rel)).href;

// 子行程：注入一個一定會 ECONNREFUSED 的假 exec（不連任何真的 PG），逐一呼叫修好的 dispatch 點，
// 把「拋了什麼」印成 JSON。deps 只給最小可用的計畫物件：第一個 exec 呼叫就會是我們的假錯誤。
const CHILD = `
const cases = {};
const boom = () => {
  const error = new Error("connect ECONNREFUSED 127.0.0.1:25433");
  error.code = "ECONNREFUSED";
  throw error;
};
async function capture(name, fn) {
  try { cases[name] = { threw: false, value: await fn() }; }
  catch (error) { cases[name] = { threw: true, message: String((error && error.message) || error), code: (error && error.code) || null }; }
}
const db = await import(${JSON.stringify(srcUrl("db.js"))});
const conn = db.sqliteHandle(); // 開閘時＝帶 marker 的拋錯 proxy（取得它本身不拋）
const reads = await import(${JSON.stringify(srcUrl("crawlerReads.js"))});
const writes = await import(${JSON.stringify(srcUrl("crawlerWrites.js"))});
const enrich = await import(${JSON.stringify(srcUrl("listingEnrichQueueAsync.js"))});
const pg = { driver: "postgres", exec: boom };
await capture("crawlerReads.needingRouteAsync", () => reads.needingRouteAsync({ limit: 1 }, {
  ...pg,
  deps: {
    routeScanPlan: () => ({ jobs: [{}], priorityIds: [], cap: 10, cursor: 0, pageSize: 10, maxPages: 1 }),
    routeWatchedScanQuery: () => ({ sql: "SELECT 1", params: [] }),
  },
}));
await capture("crawlerReads.matchCandidatesAsync", () => reads.matchCandidatesAsync(1, null, { ...pg, deps: {} }));
await capture("crawlerWrites.setListingDetailAsync", () => writes.setListingDetailAsync(1, { contact: "x" }, {
  ...pg,
  deps: { listingDetailPlan: () => ({ postId: 1, updates: [{ sql: "SELECT 1" }] }) },
  listing: { post_id: 1 },
}));
await capture("crawlerWrites.persistHpListingFieldsAsync", () => writes.persistHpListingFieldsAsync(1, { title: "t" }, {
  ...pg,
  deps: { hpFieldsPlan: () => ({ postId: 1, attempts: [{ sql: "SELECT 1" }], followUps: [] }) },
  listing: { post_id: 1 },
}));
await capture("listingEnrichQueueAsync.getListingPrepAsync", () => enrich.getListingPrepAsync(conn, 1, pg));
process.stdout.write(JSON.stringify(cases));
`;

// 生產語意的三鍵：DB_DRIVER=postgres、閘開、fallback 維持預設 closed。
// 父行程若剛好帶著 PG 連線變數，會讓「有 PG env 就必須開閘」的推論歪掉；這裡明確刪掉。
const PG_ENV_KEYS = ["PG_URL", "DATABASE_URL", "POSTGRES_URL", "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"];

function childEnv(dataDir) {
  const env = { ...process.env, DB_DRIVER: "postgres", PG_NO_SQLITE_OPEN: "1", PG_SQLITE_FALLBACK: "closed", DATA_DIR: dataDir };
  for (const key of PG_ENV_KEYS) delete env[key];
  return env;
}

const CASES = [
  "crawlerReads.needingRouteAsync",
  "crawlerReads.matchCandidatesAsync",
  "crawlerWrites.setListingDetailAsync",
  "crawlerWrites.persistHpListingFieldsAsync",
  "listingEnrichQueueAsync.getListingPrepAsync",
];

test("閘開＋fallback=closed：PG 錯誤必須原樣往上丟（不得變成 business SQLite is closed）", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-gate-"));
  try {
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", CHILD], {
      cwd: ROOT,
      env: childEnv(dataDir),
      encoding: "utf8",
      timeout: 120000,
    });
    assert.equal(res.status, 0, `子行程要成功結束（status=${res.status}）\nstderr: ${res.stderr}`);
    const cases = JSON.parse(res.stdout);
    for (const name of CASES) {
      const got = cases[name];
      assert.ok(got && got.threw === true, `${name} 應該拋錯，實得 ${JSON.stringify(got)}`);
      assert.equal(got.code, "ECONNREFUSED", `${name} 要保留原始 PG 錯誤的 code`);
      assert.match(got.message, /ECONNREFUSED/, `${name} 要拿到原始 PG 錯誤，實得：${got.message}`);
      assert.doesNotMatch(got.message, /business SQLite is closed/, `${name} 不得被開閘 proxy 的錯誤蓋掉`);
    }
  } finally {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// 前提檢查：上一個測試必須真的在「閘關著」的環境下跑，否則就是假陽性。
test("前提：同一組 env 下 sqliteHandle() 碰任何方法都會拋 business SQLite is closed", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-gate-"));
  try {
    const child = `const db = await import(${JSON.stringify(srcUrl("db.js"))});
const conn = db.sqliteHandle();
try { conn.prepare("SELECT 1"); process.stdout.write("no-throw"); }
catch (error) { process.stdout.write(String(error.message)); }`;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", child], {
      cwd: ROOT,
      env: childEnv(dataDir),
      encoding: "utf8",
      timeout: 120000,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /business SQLite is closed/, `閘沒關著，整包測試的意義就沒了：${res.stdout}`);
  } finally {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
