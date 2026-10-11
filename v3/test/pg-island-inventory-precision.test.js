// pg-island-inventory 精度測試（2026-10-11）。
//
// 目的：證明三處精度修正真的生效，而且**沒有把尺規弄瞎**——
//   ✅ 純函式（函式體沒有真實 SQLite 存取）不算島
//   ✅ 驅動閘門之後的死碼（`driver === "postgres"` 早退之後、`!== "postgres"` 區塊）
//     與 `?? 注入值` fallback 降為 info
//   ✅ SQLite-only 鏈（只被非 PG 分支呼叫的入口）降為 info
//   ⛔ 反向證明：PG 可達且真的 `db.prepare(…)` 的呼叫點仍然必須是 error
//
// 測試在 os.tmpdir() 造一棵合成小樹，透過 analyzeInventory({ srcDir }) 注入，
// 不讀也不寫 repo（也不會被同機其他 npm test 污染的 v3/src 影響）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeInventory, formatReport } from "../scripts/pg-island-inventory.mjs";

const DB_JS = `
const db = { prepare: () => ({ get: () => ({}), run: () => ({}), all: () => [] }) };

// 純函式：函式體完全沒有 SQLite 存取。
// 下一段常數文字剛好提到 realSql( ⇒ 舊版粗切片演算法會把 pureTarget 誤算成「會碰 SQLite」。
export function pureTarget(value) {
  return value ? value + 1 : 0;
}

export const SQL_TEXT = \`
  UPDATE listings SET lat = realSql(post_id, ?)
\`;

// 真缺陷：PG 可達且真的碰 SQLite。
export function realSql(id) {
  return db.prepare("SELECT 1 FROM listings WHERE post_id = ?").get(id);
}

// SQLite-only 入口：只被「非 PG 分支」的 dispatcher 呼叫。
export function sqlFirstOnly(args = {}) {
  return db.prepare("SELECT 1").get(args);
}

export function markListingOffline(id) {
  return db.prepare("UPDATE listings SET offline = 1 WHERE post_id = ?").run(id);
}

export function getListingSync(id) {
  return db.prepare("SELECT * FROM listings WHERE post_id = ?").get(id);
}

export function listMatchCandidates(postId, incoming) {
  return db.prepare("SELECT * FROM listings WHERE post_id <> ?").all(postId);
}

export function gatedSyncThing() {
  return db.prepare("SELECT 2").get();
}

export function mentionedInCommentOnly() {
  return 3;
}

export const SQL_MORE = \`
  UPDATE listings SET lat = realSql(post_id)
\`;

export function anotherReal(id) {
  return db.prepare("SELECT 3").get(id);
}
`;

const DB_DRIVER_JS = `
export function resolveDbDriver() { return "postgres"; }
`;

// ① 純函式：呼叫點必須落到「已排除」段，不是 error。
const PURE_JS = `
import { pureTarget, mentionedInCommentOnly } from "./db.js";

export function usesPure(value) {
  return pureTarget(value);
}

// 舊版在原始文字上比對，所以這行註解裡的 mentionedInCommentOnly() 也會被算成呼叫點。
export function usesNothing() {
  return mentionedInCommentOnly;
}
`;

// ② + ③ 閘後死碼與 SQLite-only 鏈。
const CHAIN_JS = `
import { sqlFirstOnly, getListingSync, markListingOffline } from "./db.js";
import { resolveDbDriver } from "./dbDriver.js";

export function sqliteOnlyDispatcher(args = {}) {
  return sqlFirstOnly(args);
}

export async function searchAsync(args = {}, options = {}) {
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") return sqliteOnlyDispatcher(args);
  return { via: "pg" };
}

export function watcherDeps(db, driver) {
  const base = { persist: () => {} };
  if (driver === "postgres") return base;
  return {
    ...base,
    loadListing: (id) => getListingSync(id),
    markGone: (id) => markListingOffline(id),
  };
}
`;

// ②' `??` 注入值 fallback。
const FALLBACK_JS = `
import { listMatchCandidates } from "./db.js";

export function classifyThing(incoming, existing, siblings = null, candidates = null) {
  if (existing) return { type: "same" };
  const pool = candidates ?? listMatchCandidates(incoming.post_id, incoming);
  return { type: "new", pool };
}
`;

// ②'' 同檔定義的 isPg() 謂詞也要被認成閘門。
const ISPG_JS = `
import { gatedSyncThing } from "./db.js";
import { resolveDbDriver } from "./dbDriver.js";

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

export async function viaIsPg(options = {}) {
  if (!isPg(options)) {
    return gatedSyncThing();
  }
  return null;
}
`;

// 反向證明：PG 可達的同步 SQLite 呼叫必須留在 error。
// 另外 `options.driver !== "postgres"` **不算**有效閘門（未傳 options.driver 時它仍是 true）。
const LIVE_JS = `
import { realSql, gatedSyncThing } from "./db.js";
import { resolveDbDriver } from "./dbDriver.js";

function fetchPg(id) {
  return { id, via: "pg" };
}

export function livePgPath(id) {
  return realSql(id);
}

export function mixedPath(driver, id) {
  if (driver === "postgres") return fetchPg(id);
  return realSql(id);
}

export function guardedByOptionsOnly(options = {}) {
  if (options.driver !== "postgres") return gatedSyncThing();
  return null;
}

export function upstreamApi(options = {}) {
  const driver = options.driver || resolveDbDriver();
  if (driver === "postgres") return fetchPg(1);
  return gatedSyncThing();
}
`;

const SERVER_JS = `
export function createServer() {
  return {};
}
`;

function makeFixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pg-island-precision-"));
  mkdirSync(dir, { recursive: true });
  const files = {
    "db.js": DB_JS,
    "dbDriver.js": DB_DRIVER_JS,
    "pure.js": PURE_JS,
    "chain.js": CHAIN_JS,
    "fallback.js": FALLBACK_JS,
    "ispg.js": ISPG_JS,
    "live.js": LIVE_JS,
    "server.js": SERVER_JS,
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text, "utf8");
  return dir;
}

function analyze() {
  const dir = makeFixture();
  try {
    const result = analyzeInventory({ srcDir: dir });
    return { dir, result, report: formatReport(result) };
  } finally {
    // result 已經是純資料，目錄可以立刻清掉
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清不掉不影響斷言 */ }
  }
}

const pairs = (list) => list.map((x) => `${x.file}: ${x.symbol}`);
const find = (list, file, symbol) => list.find((x) => x.file === file && x.symbol === symbol);

test("① 純函式不被報成島（落到已排除段）", () => {
  const { result } = analyze();
  assert.equal(find(result.errors, "pure.js", "pureTarget"), undefined, "pureTarget 不該是 error");
  assert.equal(find(result.infos, "pure.js", "pureTarget"), undefined, "pureTarget 不該是 info");
  const excluded = find(result.excluded, "pure.js", "pureTarget");
  assert.ok(excluded, "pureTarget 必須列在已排除段（不准憑空消失）");
  assert.match(excluded.reason, /沒有真實 SQLite 存取/);
});

test("① 舊版在註解／字串裡命中的符號，列入已排除段而不是消失", () => {
  const { result } = analyze();
  const excluded = find(result.excluded, "pure.js", "mentionedInCommentOnly");
  assert.ok(excluded, "只能被註解提到的符號必須有去處");
  assert.match(excluded.reason, /註解／字串/);
  assert.equal(find(result.errors, "pure.js", "mentionedInCommentOnly"), undefined);
});

test("② 閘後死碼：driver === postgres 早退之後的呼叫降為 info", () => {
  const { result } = analyze();
  for (const sym of ["getListingSync", "markListingOffline"]) {
    assert.equal(find(result.errors, "chain.js", sym), undefined, `${sym} 不該是 error`);
    const info = find(result.infos, "chain.js", sym);
    assert.ok(info, `${sym} 必須列在 info 段`);
    assert.match(info.reasons.join("|"), /gate:driver/);
  }
});

test("② 閘後死碼：!== postgres 區塊（isPg 謂詞）降為 info", () => {
  const { result } = analyze();
  const info = find(result.infos, "ispg.js", "gatedSyncThing");
  assert.ok(info, "isPg(options) 閘門內的呼叫必須是 info");
  assert.match(info.reasons.join("|"), /gate:driver/);
});

test("② ?? 注入值 fallback 降為 info", () => {
  const { result } = analyze();
  assert.equal(find(result.errors, "fallback.js", "listMatchCandidates"), undefined);
  const info = find(result.infos, "fallback.js", "listMatchCandidates");
  assert.ok(info, "?? fallback 必須列在 info 段");
  assert.match(info.reasons.join("|"), /fallback/);
});

test("③ SQLite-only 鏈：只被非 PG 分支呼叫的入口降為 info", () => {
  const { result } = analyze();
  assert.equal(find(result.errors, "chain.js", "sqlFirstOnly"), undefined);
  const info = find(result.infos, "chain.js", "sqlFirstOnly");
  assert.ok(info, "SQLite-only 鏈必須列在 info 段");
  assert.match(info.reasons.join("|"), /chain/);
});

test("⛔ 反向證明：PG 可達且真的 db.prepare() 的呼叫點仍是 error", () => {
  const { result } = analyze();
  assert.ok(find(result.errors, "live.js", "realSql"), "PG 可達的 realSql 必須是 error");
  assert.ok(pairs(result.errors).includes("live.js: realSql"));
  // 同一支函式同時有「活」與「死」的呼叫點時，只要有一個可達就必須維持 error。
  const realSql = find(result.errors, "live.js", "realSql");
  assert.equal(realSql.hops, 1, "只有 mixedPath 的早退之後那個呼叫點是死的");
});

test("⛔ 反向證明：options.driver 的比較不算有效閘門（保守留在 error）", () => {
  const { result } = analyze();
  assert.ok(
    find(result.errors, "live.js", "gatedSyncThing"),
    "options.driver !== \"postgres\" 不是有效閘門，呼叫點必須留在 error",
  );
});

test("⛔ 反向證明：driver 早退之後、但 PG 分支內的呼叫仍算 error", () => {
  const { result } = analyze();
  assert.ok(find(result.errors, "live.js", "gatedSyncThing"));
  assert.ok(find(result.errors, "live.js", "realSql"));
  assert.equal(find(result.errors, "live.js", "fetchPg"), undefined, "fetchPg 不是 db.js 的 SQLite 函式");
});

test("摘要行 PG-REACHABLE-SYNC-SQLITE 的 n 與 error 段條目數一致", () => {
  const { result, report } = analyze();
  const m = /^PG-REACHABLE-SYNC-SQLITE: (\d+)$/m.exec(report);
  assert.ok(m, "報告必須有 machine-readable 摘要行");
  assert.equal(Number(m[1]), result.counts.error);
  const errorSection = report.slice(report.indexOf("【PG 可達"), report.indexOf("（共", report.indexOf("【PG 可達")));
  const rows = errorSection.split("\n").filter((line) => /^[A-Za-z0-9_.-]+\.js: /.test(line));
  assert.equal(rows.length, result.counts.error, "error 段列出的條目數必須等於摘要 n");
});

test("三段輸出齊全且有 machine-readable 摘要行", () => {
  const { report } = analyze();
  assert.match(report, /【PG 可達・仍碰同步 SQLite（error）】/);
  assert.match(report, /【PG 不可達（死碼／早退之後）（info）】/);
  assert.match(report, /【純函式／非 SQLite 存取（已排除）（info）】/);
  assert.match(report, /\nPG-REACHABLE-SYNC-SQLITE: \d+\n?$/);
});

test("注入 srcDir 不會去讀／寫 repo（可重跑且與 repo 現況無關）", () => {
  const first = analyze().result;
  const second = analyze().result;
  assert.deepEqual(first.counts, second.counts);
  assert.deepEqual(pairs(first.errors).sort(), pairs(second.errors).sort());
});
