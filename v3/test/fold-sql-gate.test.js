// 開閘前檢（Owner 2026-10-12 R3，fail-closed）的離線測試。
//
// 這裡釘住三件事：
//   1. `foldSqlGateReady()` 的四種結果（缺欄／缺戳記／戳記有差／就緒）。
//   2. 關閘時舊路徑的隔離：`PUBLIC_LISTINGS_SQL_FIRST !== "1"` 的 return 必須在**開閘前檢之前**
//      （新路徑的任何失敗都不得影響舊路徑）。
//   3. 缺欄探測用的查詢是「不會失敗的查詢」（information_schema）——它在交易內失敗會讓整個交易
//      aborted（25P02）。真正的交易存活驗證在 fold-gate-transaction-live-pg.test.js（真 PG）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  foldSqlGateReady, resetFoldSqlGate, resetFoldRootRefreshProbe,
  FOLD_SQL_GATE_REASON, FOLD_DRIFT_STAMP_KEY,
} from "../src/foldComponentRoot.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readRepo = (rel) => readFileSync(path.join(REPO, rel), "utf8");

// 假的 PG exec：只認得探測與戳記兩條查詢（其他一律拋錯 ⇒ 任何多餘查詢都會讓測試紅）。
function fakeExec({ column = true, stamp = undefined } = {}) {
  const seen = [];
  const exec = async (sql, params = []) => {
    seen.push({ sql, params });
    if (/FROM pg_attribute/.test(sql)) return column ? [{ ok: 1 }] : [];
    if (/FROM settings WHERE key/.test(sql)) return stamp === undefined ? [] : [{ value: typeof stamp === "string" ? stamp : JSON.stringify(stamp) }];
    throw new Error(`unexpected sql: ${sql}`);
  };
  exec.seen = seen;
  return exec;
}

test("開閘前檢：欄位不存在 ⇒ 拒開閘（reason=fold_component_root_missing）", async () => {
  resetFoldRootRefreshProbe(); resetFoldSqlGate();
  const exec = fakeExec({ column: false });
  const gate = await foldSqlGateReady(exec);
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, FOLD_SQL_GATE_REASON.NO_COLUMN);
  // 只查了資訊綱要，沒有碰 listings（缺欄時不會送任何會失敗的查詢）
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

test("開閘前檢：戳記零差 ⇒ 就緒", async () => {
  resetFoldRootRefreshProbe(); resetFoldSqlGate();
  const exec = fakeExec({ column: true, stamp: { at: "2026-10-12T00:00:00Z", rows: 184754, mismatches: 0 } });
  const gate = await foldSqlGateReady(exec);
  assert.equal(gate.ok, true);
  assert.equal(gate.reason, null);
  assert.equal(gate.detail.rows, 184754);
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
