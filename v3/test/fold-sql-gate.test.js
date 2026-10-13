// 開閘前檢（Owner 2026-10-12 R3，fail-closed）的離線測試。
//
// 這裡釘住四件事：
//   1. `foldSqlGateReady()` 的八種結果（缺欄／缺戳記／戳記有差／戳記沒有資料版本／戳記與
//      當前資料版本不符／戳記沒有寫入世代鍵／戳記的世代鍵過時／就緒）。
//   2. 關閘時舊路徑的隔離：`PUBLIC_LISTINGS_SQL_FIRST !== "1"` 的 return 必須在**開閘前檢之前**
//      （新路徑的任何失敗都不得影響舊路徑）。
//   3. 缺欄探測用的查詢是「不會失敗的查詢」（`pg_attribute` ＋ `to_regclass('listings')`，跟著
//      search_path 解析）——它在交易內失敗會讓整個交易 aborted（25P02）。**不用**
//      `information_schema`：那是跨 schema 的（同庫別的 schema 有同名表就誤判，L-0869）。
//      真正的交易存活驗證在 fold-gate-transaction-live-pg.test.js（真 PG）。
//   4. 快取語意：成功只記 TTL（資料一變就要在 TTL 內失效）、失敗永久記憶（fail-closed 快路徑）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  foldSqlGateReady, resetFoldSqlGate, resetFoldRootRefreshProbe,
  FOLD_SQL_GATE_REASON, FOLD_DRIFT_STAMP_KEY, FOLD_WRITE_GEN_KEY,
} from "../src/foldComponentRoot.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readRepo = (rel) => readFileSync(path.join(REPO, rel), "utf8");

// 假的 PG exec：只認得探測、戳記、世代鍵、資料版本四條查詢（其他一律拋錯 ⇒ 任何多餘查詢都會讓測試紅）。
// `gen` 預設 0：**沒有寫入過**的庫就是 0（戳記也要寫 0 才對得上）。
function fakeExec({ column = true, stamp = undefined, live = undefined, gen = 0 } = {}) {
  const seen = [];
  const exec = async (sql, params = []) => {
    seen.push({ sql, params });
    if (/FROM pg_attribute/.test(sql)) return column ? [{ ok: 1 }] : [];
    if (/FROM settings WHERE key/.test(sql)) {
      if (params[0] === FOLD_WRITE_GEN_KEY) return [{ value: String(gen) }];
      return stamp === undefined ? [] : [{ value: typeof stamp === "string" ? stamp : JSON.stringify(stamp) }];
    }
    if (/FROM listings/.test(sql)) return [{ n: Number(live?.rows ?? 0), max_post_id: Number(live?.maxPostId ?? 0) }];
    throw new Error(`unexpected sql: ${sql}`);
  };
  exec.seen = seen;
  return exec;
}

// 戳記的形狀（2026-10-13 起 `writeGen` 是**必要**欄位，缺它一律 fail-closed）。
const stamped = (dataVersion, writeGen = 0) => ({
  at: "2026-10-12T00:00:00Z", rows: dataVersion?.rows ?? 10, mismatches: 0, writeGen, dataVersion,
});

test("開閘前檢：欄位不存在 ⇒ 拒開閘（reason=fold_component_root_missing）", async () => {
  resetFoldRootRefreshProbe(); resetFoldSqlGate();
  const exec = fakeExec({ column: false });
  const gate = await foldSqlGateReady(exec);
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, FOLD_SQL_GATE_REASON.NO_COLUMN);
  // 只查了資訊綱要，沒有碰 listings（缺欄時不會送任何會失敗的查詢）
  assert.equal(exec.seen.filter((s) => /FROM listings/.test(s.sql)).length, 0);
  assert.equal(exec.seen.length, 1);
});

test("開閘前檢：欄位存在但沒有 drift 戳記 ⇒ 拒開閘", async () => {
  resetFoldRootRefreshProbe(); resetFoldSqlGate();
  const exec = fakeExec({ column: true, stamp: undefined });
  const gate = await foldSqlGateReady(exec);
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, FOLD_SQL_GATE_REASON.NO_DRIFT_STAMP);
  assert.deepEqual(exec.seen[1].params, [FOLD_DRIFT_STAMP_KEY]);
});

test("開閘前檢：戳記 mismatch≠0 ⇒ 拒開閘（附筆數）", async () => {
  resetFoldRootRefreshProbe(); resetFoldSqlGate();
  const exec = fakeExec({ column: true, stamp: { at: "2026-10-12T00:00:00Z", rows: 10, mismatches: 3 } });
  const gate = await foldSqlGateReady(exec);
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, FOLD_SQL_GATE_REASON.DRIFT_STAMP_DIRTY);
  assert.equal(gate.detail.mismatches, 3);
});

test("開閘前檢：戳記零差、資料版本相符、世代鍵相符 ⇒ 就緒", async () => {
  resetFoldRootRefreshProbe(); resetFoldSqlGate();
  const stamp = stamped({ rows: 184754, maxPostId: 22164313, rootsMd5: "abc" }, 0);
  const exec = fakeExec({ column: true, stamp, live: { rows: 184754, maxPostId: 22164313 }, gen: 0 });
  const gate = await foldSqlGateReady(exec);
  assert.equal(gate.ok, true);
  assert.equal(gate.reason, null);
  assert.equal(gate.detail.rows, 184754);
  assert.equal(gate.detail.maxPostId, 22164313);
  assert.equal(gate.detail.rootsMd5, "abc");
  assert.equal(gate.detail.writeGen, 0);
});

// 升級層 2026-10-12 21:24：「僅有 stamp 不足」⇒ 戳記必須綁資料版本，資料一變就失效。
test("開閘前檢：戳記零差但資料版本變了（max(post_id) 變）⇒ 拒開閘（reason=fold_root_drift_stamp_stale）", async () => {
  resetFoldRootRefreshProbe(); resetFoldSqlGate();
  const stamp = stamped({ rows: 184754, maxPostId: 22164313 });
  const exec = fakeExec({ column: true, stamp, live: { rows: 184754, maxPostId: 22999999 } });
  const gate = await foldSqlGateReady(exec);
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, FOLD_SQL_GATE_REASON.DRIFT_STAMP_STALE);
  assert.deepEqual(gate.detail.stamped, { rows: 184754, maxPostId: 22164313 });
  assert.deepEqual(gate.detail.live, { rows: 184754, maxPostId: 22999999 });
});

test("開閘前檢：戳記零差但列數變了 ⇒ 拒開閘（stale）", async () => {
  resetFoldRootRefreshProbe(); resetFoldSqlGate();
  const stamp = stamped({ rows: 184754, maxPostId: 22164313 });
  const exec = fakeExec({ column: true, stamp, live: { rows: 184755, maxPostId: 22164313 } });
  const gate = await foldSqlGateReady(exec);
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, FOLD_SQL_GATE_REASON.DRIFT_STAMP_STALE);
});

// 升級層 2026-10-13：只在原地 UPDATE root（rows／maxPostId 都不變）時，上面兩條都抓不到
// ⇒ 必須另外綁「寫入世代鍵」。缺鍵（升級前寫的戳記）與鍵不符都一律 fail-closed。
test("開閘前檢：戳記缺 writeGen（舊式戳記）⇒ 拒開閘（reason=fold_root_drift_stamp_gen_missing）", async () => {
  resetFoldRootRefreshProbe(); resetFoldSqlGate();
  const stamp = { at: "2026-10-13T00:00:00Z", rows: 10, mismatches: 0, dataVersion: { rows: 10, maxPostId: 5, rootsMd5: "abc" } };
  const exec = fakeExec({ column: true, stamp, live: { rows: 10, maxPostId: 5 }, gen: 4 });
  const gate = await foldSqlGateReady(exec);
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, FOLD_SQL_GATE_REASON.DRIFT_STAMP_GEN_MISSING);
  assert.equal(gate.detail.missing, "writeGen");
  assert.equal(gate.detail.liveWriteGen, 4);
});

test("開閘前檢：原地 UPDATE 後戳記的 writeGen 過時 ⇒ 拒開閘（reason=fold_root_drift_stamp_gen_stale）", async () => {
  resetFoldRootRefreshProbe(); resetFoldSqlGate();
  const stamp = stamped({ rows: 10, maxPostId: 5 }, 4);
  const exec = fakeExec({ column: true, stamp, live: { rows: 10, maxPostId: 5 }, gen: 5 });
  const gate = await foldSqlGateReady(exec);
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, FOLD_SQL_GATE_REASON.DRIFT_STAMP_GEN_STALE);
  assert.equal(gate.detail.stampedWriteGen, 4);
  assert.equal(gate.detail.liveWriteGen, 5);
});

test("開閘前檢：更舊式戳記（沒有 dataVersion）⇒ 拒開閘（stale，附修法）", async () => {
  resetFoldRootRefreshProbe(); resetFoldSqlGate();
  const exec = fakeExec({ column: true, stamp: { at: "2026-10-12T00:00:00Z", rows: 184754, mismatches: 0, writeGen: 0 } });
  const gate = await foldSqlGateReady(exec);
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, FOLD_SQL_GATE_REASON.DRIFT_STAMP_STALE);
  assert.equal(gate.detail.missing, "dataVersion");
  assert.match(gate.detail.fix, /--stamp/);
});

test("開閘前檢：成功結果有 TTL（且以世代鍵為鍵），失敗永久記憶（fail-closed 快路徑）", async () => {
  resetFoldRootRefreshProbe(); resetFoldSqlGate();
  const stamp = stamped({ rows: 10, maxPostId: 5 }, 2);
  const okExec = fakeExec({ column: true, stamp, live: { rows: 10, maxPostId: 5 }, gen: 2 });
  assert.equal((await foldSqlGateReady(okExec)).ok, true);
  // 第二次呼叫（未 reset）：同一個 gen、TTL 內吃快取 ⇒ 不再查 listings 的資料版本
  // （只多讀一條 `settings.foldRootWriteGen`，那是快取鍵的一部分）。
  const listingsBefore = okExec.seen.filter((s) => /FROM listings/.test(s.sql)).length;
  assert.equal((await foldSqlGateReady(okExec)).ok, true);
  assert.equal(okExec.seen.filter((s) => /FROM listings/.test(s.sql)).length, listingsBefore, "成功結果在 TTL 內必須吃快取");
  // 失敗：換一個壞掉的 exec，第二次呼叫不得再查（永久記憶）。
  resetFoldSqlGate();
  const dirtyExec = fakeExec({ column: true, stamp: { at: "x", rows: 10, mismatches: 4 } });
  assert.equal((await foldSqlGateReady(dirtyExec)).ok, false);
  const dirtySeen = dirtyExec.seen.length;
  assert.equal((await foldSqlGateReady(dirtyExec)).ok, false);
  assert.equal(dirtyExec.seen.length, dirtySeen, "失敗結果必須永久記憶（不重試）");
});

test("開閘前檢：戳記是壞 JSON ⇒ 拒開閘（fail-closed，不是放行）", async () => {
  resetFoldRootRefreshProbe(); resetFoldSqlGate();
  const exec = fakeExec({ column: true, stamp: "{not json" });
  const gate = await foldSqlGateReady(exec);
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, FOLD_SQL_GATE_REASON.NO_DRIFT_STAMP);
});

test("關閘時舊路徑隔離：env 檢查必須在開閘前檢之前 return", () => {
  const src = readRepo("v3/src/publicListingSearchAsync.js");
  const fn = src.slice(src.indexOf("async function tryPublicListingsSqlFirst"));
  const guard = fn.indexOf('PUBLIC_LISTINGS_SQL_FIRST !== "1") return null');
  const gate = fn.indexOf("foldSqlGateReady(exec)");
  assert.ok(guard >= 0, "關閘的 env 檢查必須存在");
  assert.ok(gate > guard, "開閘前檢必須在關閘 return 之後（新路徑不得影響舊路徑）");
  // 開閘且依賴缺失時：丟 SEARCH_UNAVAILABLE（HTTP 503）並告警，不准降級成 Node 路徑。
  assert.match(fn, /throw new ListingSearchUnavailableError\(`fold sql-first gate closed/);
  assert.match(fn, /console\.error\(`\[fold-gate\]/);
});

test("PUBLIC_LISTINGS_SQL_FIRST 預設必須是 off（不准在 repo 內開閘）", () => {
  const src = readRepo("v3/src/publicListingSearchAsync.js");
  assert.match(src, /process\.env\.PUBLIC_LISTINGS_SQL_FIRST !== "1"/);
  assert.doesNotMatch(src, /PUBLIC_LISTINGS_SQL_FIRST\s*=\s*"1"/);
});
