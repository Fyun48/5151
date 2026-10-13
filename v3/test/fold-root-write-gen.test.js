// `settings.foldRootWriteGen` 寫入世代鍵（升級層 2026-10-13 開閘硬條件）的離線測試。
//
// 覆蓋交辦單要求的三件事：
//   1. bump 會遞增（缺鍵先建 0），而且那一句 SQL **SQLite 真的跑得動**（用 node:sqlite 的
//      :memory: 實跑；PG 形狀在 fold-root-write-gen-live-pg.test.js 用真 PG 跑）。
//   2. 開閘前檢：gen 相符 ⇒ 放行；gen 不符 ⇒ `fold_root_drift_stamp_gen_stale`；
//      戳記缺 writeGen（舊式戳記）⇒ `fold_root_drift_stamp_gen_missing`。
//   3. **成功的 60 秒快取以 gen 為鍵**：原地 UPDATE（rows／maxPostId 不變）之後的**下一句**
//      就要被拒，不靠 TTL 到期才生效（交辦單第 6 條的驗收重點）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  foldSqlGateReady, resetFoldSqlGate, resetFoldRootRefreshProbe,
  readFoldRootWriteGen, bumpFoldRootWriteGen,
  FOLD_SQL_GATE_REASON, FOLD_DRIFT_STAMP_KEY, FOLD_WRITE_GEN_KEY,
  FOLD_WRITE_GEN_BUMP_SQL, FOLD_WRITE_GEN_ENSURE_SQL,
} from "../src/foldComponentRoot.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readRepo = (rel) => readFileSync(path.join(REPO, rel), "utf8");

// 真的 SQLite（node:sqlite）上的 settings(key,value)：證明 bump 的 SQL 不是只為 PG 寫的。
function sqliteExec() {
  const mem = new DatabaseSync(":memory:");
  mem.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const exec = async (sql, params = []) => mem.prepare(sql).all(...params);
  exec.raw = mem;
  return exec;
}

// 假的 PG exec：狀態可變（模擬「原地 UPDATE ⇒ 只有世代鍵動」），多餘的查詢一律拋錯。
function gateExec(state) {
  const seen = [];
  const exec = async (sql, params = []) => {
    seen.push({ sql, params });
    if (/FROM pg_attribute/.test(sql)) return state.column === false ? [] : [{ ok: 1 }];
    if (/FROM settings WHERE key/.test(sql)) {
      if (params[0] === FOLD_WRITE_GEN_KEY) return state.gen === undefined ? [] : [{ value: String(state.gen) }];
      return state.stamp === undefined ? [] : [{ value: typeof state.stamp === "string" ? state.stamp : JSON.stringify(state.stamp) }];
    }
    if (/FROM listings/.test(sql)) return [{ n: Number(state.live?.rows ?? 0), max_post_id: Number(state.live?.maxPostId ?? 0) }];
    throw new Error(`unexpected sql: ${sql}`);
  };
  exec.seen = seen;
  exec.genQueries = () => seen.filter((s) => /FROM settings WHERE key/.test(s.sql) && s.params[0] === FOLD_WRITE_GEN_KEY).length;
  exec.listingsQueries = () => seen.filter((s) => /FROM listings/.test(s.sql)).length;
  return exec;
}

const stampOf = ({ writeGen, rows = 10, maxPostId = 5 } = {}) => {
  const stamp = { at: "2026-10-13T00:00:00Z", rows, components: 3, mismatches: 0 };
  if (writeGen !== undefined) stamp.writeGen = writeGen;
  stamp.dataVersion = { rows, maxPostId, rootsMd5: "abc" };
  return stamp;
};

test("bumpFoldRootWriteGen：缺鍵先建 0、逐次 +1，值以 text 落地（SQLite 實跑）", async () => {
  const exec = sqliteExec();
  assert.equal(await readFoldRootWriteGen(exec), 0, "缺鍵 ⇒ 0（不猜）");
  assert.equal(await bumpFoldRootWriteGen(exec), 1);
  assert.equal(await bumpFoldRootWriteGen(exec), 2);
  const raw = exec.raw.prepare("SELECT value FROM settings WHERE key = ?").get(FOLD_WRITE_GEN_KEY).value;
  assert.equal(raw, "2");
  assert.equal(typeof raw, "string", "settings.value 是 TEXT NOT NULL ⇒ 值必須是字串");
  // 壞值不得讓它爆掉（當 0）：先寫一個非數字，再 bump 必須回到 1。
  exec.raw.prepare("UPDATE settings SET value = ? WHERE key = ?").run("not-a-number", FOLD_WRITE_GEN_KEY);
  assert.equal(await readFoldRootWriteGen(exec), 0);
  assert.equal(await bumpFoldRootWriteGen(exec), 1);
});

test("bump 的 SQL 形狀：bigint/text 兩個引擎都吃、鍵走參數（不硬編在 SQL 裡）", () => {
  assert.match(FOLD_WRITE_GEN_BUMP_SQL, /CAST\(COALESCE\(CAST\(value AS bigint\), 0\) \+ 1 AS text\)/);
  assert.match(FOLD_WRITE_GEN_BUMP_SQL, /WHERE key = \?$/);
  assert.match(FOLD_WRITE_GEN_ENSURE_SQL, /ON CONFLICT\(key\) DO NOTHING$/);
  assert.doesNotMatch(FOLD_WRITE_GEN_BUMP_SQL, /foldRootWriteGen/);
  assert.doesNotMatch(FOLD_WRITE_GEN_ENSURE_SQL, /foldRootWriteGen/);
});

test("開閘前檢：戳記 writeGen ＝ 當前世代鍵 ⇒ 放行（detail 帶 writeGen）", async () => {
  resetFoldRootRefreshProbe(); resetFoldSqlGate();
  const exec = gateExec({ stamp: stampOf({ writeGen: 7 }), gen: 7, live: { rows: 10, maxPostId: 5 } });
  const gate = await foldSqlGateReady(exec);
  assert.equal(gate.ok, true);
  assert.equal(gate.reason, null);
  assert.equal(gate.detail.writeGen, 7);
});

test("開閘前檢：戳記 writeGen ≠ 當前世代鍵（原地更新後）⇒ 拒開閘 gen_stale", async () => {
  resetFoldRootRefreshProbe(); resetFoldSqlGate();
  const exec = gateExec({ stamp: stampOf({ writeGen: 7 }), gen: 8, live: { rows: 10, maxPostId: 5 } });
  const gate = await foldSqlGateReady(exec);
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, FOLD_SQL_GATE_REASON.DRIFT_STAMP_GEN_STALE);
  assert.equal(gate.reason, "fold_root_drift_stamp_gen_stale");
  assert.equal(gate.detail.stampedWriteGen, 7);
  assert.equal(gate.detail.liveWriteGen, 8);
  assert.match(gate.detail.fix, /--stamp/);
});

test("開閘前檢：舊式戳記（沒有 writeGen）⇒ 拒開閘 gen_missing", async () => {
  resetFoldRootRefreshProbe(); resetFoldSqlGate();
  const exec = gateExec({ stamp: stampOf({}), gen: 3, live: { rows: 10, maxPostId: 5 } });
  const gate = await foldSqlGateReady(exec);
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, FOLD_SQL_GATE_REASON.DRIFT_STAMP_GEN_MISSING);
  assert.equal(gate.reason, "fold_root_drift_stamp_gen_missing");
  assert.equal(gate.detail.missing, "writeGen");
  assert.equal(gate.detail.liveWriteGen, 3);
  assert.match(gate.detail.fix, /--stamp/);
});

test("開閘前檢：戳記缺資料版本（更舊式）仍走既有的 stale 分支", async () => {
  resetFoldRootRefreshProbe(); resetFoldSqlGate();
  const stamp = { at: "x", rows: 10, mismatches: 0, writeGen: 3 };
  const exec = gateExec({ stamp, gen: 3, live: { rows: 10, maxPostId: 5 } });
  const gate = await foldSqlGateReady(exec);
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, FOLD_SQL_GATE_REASON.DRIFT_STAMP_STALE);
  assert.equal(gate.detail.missing, "dataVersion");
});

test("成功快取以 gen 為鍵：原地寫入後『下一句』就被拒（不靠 TTL 救回）", async () => {
  resetFoldRootRefreshProbe(); resetFoldSqlGate();
  const state = { stamp: stampOf({ writeGen: 7 }), gen: 7, live: { rows: 10, maxPostId: 5 } };
  const exec = gateExec(state);
  assert.equal((await foldSqlGateReady(exec)).ok, true);
  const listingsAfterFirst = exec.listingsQueries();
  // 同一個 gen、TTL（預設 60s）內 ⇒ 吃快取：只多讀一次世代鍵，不再查 listings 資料版本。
  assert.equal((await foldSqlGateReady(exec)).ok, true);
  assert.equal(exec.listingsQueries(), listingsAfterFirst, "同 gen 且 TTL 內必須吃快取（不重跑資料版本）");
  assert.ok(exec.genQueries() >= 1, "快取命中要讀世代鍵（快取鍵的一部分）");
  // 原地 UPDATE root：rows／maxPostId 與戳記內容都不變，**只有世代鍵 +1**。
  state.gen = 8;
  const third = await foldSqlGateReady(exec);
  assert.equal(third.ok, false, "世代鍵一動，下一句就必須被拒（不能等 TTL 到期）");
  assert.equal(third.reason, FOLD_SQL_GATE_REASON.DRIFT_STAMP_GEN_STALE);
  assert.equal(exec.listingsQueries(), listingsAfterFirst + 1, "gen 一變就重驗（證明拒的原因是世代鍵，不是 TTL）");
  // 失敗永久記憶：換回同一個 gen 也不得放行（要重啟行程；既有 fail-closed 語意不變）。
  state.gen = 7;
  assert.equal((await foldSqlGateReady(exec)).ok, false, "失敗永久記憶（修好依賴要重啟）");
});

test("--stamp 的 payload 帶 writeGen，且與 rows／maxPostId 出自同一句 SQL", () => {
  const src = readRepo("v3/scripts/fold-root-drift-check.mjs");
  assert.match(src, /AS write_gen/);
  assert.match(src, /writeGen: dataVersion\.writeGen/);
  assert.match(src, /\[FOLD_WRITE_GEN_KEY\]/);
});

test("所有 fold_component_root 的寫入路徑都 bump（原始碼清單釘住）", () => {
  // 寫入路徑唯一清單（grep `UPDATE listings SET fold_component_root` 的結果，逐檔釘住）。
  const writers = [
    "v3/src/foldComponentRoot.js",
    "v3/scripts/fold-root-backfill.mjs",
    "v3/scripts/fold-ci-parity.mjs",
    "v3/scripts/fold-shape-fixtures.mjs",
  ];
  for (const file of writers) {
    const src = readRepo(file);
    assert.ok(src.includes("bumpFoldRootWriteGen"), `${file} 的寫入路徑必須 bump 世代鍵`);
  }
});
