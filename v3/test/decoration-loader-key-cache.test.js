// 第三刀（2026-10-11）P1 的護欄：裝飾資料載入器**以 key／id 為單位**快取，
// 而且同一個請求的 list／stats 兩條管線共用同一個 loader 時，重疊的集合不得重查。
//
// 為什麼要這支離線測試：`rowCache` 的省查詢效果要在「同一個請求內兩次呼叫」才看得到，
// live 量測（`v3/scripts/member-list-sql-count.mjs`）需要 PG 才跑得起來；這裡用假的 exec
// 固定契約：送出的 SQL、送出的 key 集合、回傳值的形狀都必須逐字符合。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDecorationDataLoader } from "../src/repository/decorationData.js";

function fakeExec(rowsByKey, keyColumn) {
  const seen = [];
  const exec = async (sql, params) => {
    const keys = Array.isArray(params?.[0]) ? params[0] : params;
    seen.push({ sql: String(sql), keys: [...keys] });
    return keys.filter((k) => rowsByKey.has(k)).map((k) => ({ [keyColumn]: k, marker: rowsByKey.get(k) }));
  };
  return { exec, seen };
}

test("routeCacheMap：同一組 key 只查一次（子集呼叫不再查詢）", async () => {
  const rows = new Map([["k1", "r1"], ["k2", "r2"]]);
  const { exec, seen } = fakeExec(rows, "route_key");
  const loader = createDecorationDataLoader({ exec, driver: "postgres" });

  const first = await loader.routeCacheMap(["k1", "k2"]);
  assert.equal(seen.length, 1, "第一次呼叫應只查一次");
  assert.deepEqual(seen[0].keys.sort(), ["k1", "k2"]);
  assert.equal(first.get("k1").marker, "r1");

  const second = await loader.routeCacheMap(["k1"]);
  assert.equal(seen.length, 1, "子集呼叫必須完全命中快取，不得再查（第三刀的核心）");
  assert.equal(second.get("k1").marker, "r1");
  assert.deepEqual([...second.keys()], ["k1"], "回傳的 Map 必須涵蓋被請求的 key");
});

test("routeCacheMap：只補查沒見過的 key，缺列一律回 null 且不重查", async () => {
  const rows = new Map([["k1", "r1"]]);
  const { exec, seen } = fakeExec(rows, "route_key");
  const loader = createDecorationDataLoader({ exec, driver: "postgres" });

  await loader.routeCacheMap(["k1", "missing"]);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].keys.sort(), ["k1", "missing"]);

  const again = await loader.routeCacheMap(["missing", "k1"]);
  assert.equal(seen.length, 1, "缺列也必須記住（否則是每次重查的地雷）");
  assert.equal(again.get("missing"), null);
  assert.equal(again.get("k1").marker, "r1");

  const third = await loader.routeCacheMap(["k1", "missing", "k3"]);
  assert.equal(seen.length, 2, "只有真正沒見過的 key 才補查");
  assert.deepEqual(seen[1].keys, ["k3"]);
});

test("routeJobsMap／mrtCacheMap：同樣的 per-key 快取契約", async () => {
  const jobs = fakeExec(new Map([["j1", "a"]]), "job_key");
  const jobsLoader = createDecorationDataLoader({ exec: jobs.exec, driver: "postgres" });
  await jobsLoader.routeJobsMap(["j1"]);
  await jobsLoader.routeJobsMap(["j1"]);
  assert.equal(jobs.seen.length, 1);

  const mrt = fakeExec(new Map([["g1", "m"]]), "geo_key");
  const mrtLoader = createDecorationDataLoader({ exec: mrt.exec, driver: "postgres" });
  const out = await mrtLoader.mrtCacheMap(["g1"]);
  await mrtLoader.mrtCacheMap(["g1"]);
  assert.equal(mrt.seen.length, 1);
  assert.equal(out.get("g1").marker, "m");
});

test("兩個 loader 各自獨立：共用 loader 才有跨管線去重（list／stats 各一份時各查一次）", async () => {
  const rows = new Map([["k1", "r1"]]);
  const a = fakeExec(rows, "route_key");
  const b = fakeExec(rows, "route_key");
  const listLoader = createDecorationDataLoader({ exec: a.exec, driver: "postgres" });
  const statsLoader = createDecorationDataLoader({ exec: b.exec, driver: "postgres" });

  await listLoader.routeCacheMap(["k1"]);
  await statsLoader.routeCacheMap(["k1"]);
  assert.equal(a.seen.length, 1);
  assert.equal(b.seen.length, 1, "沒有共用 loader 時就是兩次查詢（這正是第三刀要消掉的那一次）");
});

test("併發呼叫共用同一個 in-flight promise（不得各發一次）", async () => {
  const rows = new Map([["k1", "r1"], ["k2", "r2"]]);
  let calls = 0;
  const exec = async (sql, params) => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 5));
    const keys = Array.isArray(params?.[0]) ? params[0] : params;
    return keys.map((k) => ({ route_key: k, marker: rows.get(k) }));
  };
  const loader = createDecorationDataLoader({ exec, driver: "postgres" });
  const [x, y] = await Promise.all([loader.routeCacheMap(["k1"]), loader.routeCacheMap(["k1"])]);
  assert.equal(calls, 1);
  assert.equal(x.get("k1").marker, "r1");
  assert.equal(y.get("k1").marker, "r1");
});

test("空 key 集合不查詢", async () => {
  let calls = 0;
  const loader = createDecorationDataLoader({ exec: async () => { calls += 1; return []; }, driver: "postgres" });
  assert.deepEqual([...await loader.routeCacheMap([])], []);
  assert.deepEqual([...await loader.routeJobsMap([])], []);
  assert.deepEqual([...await loader.mrtCacheMap([])], []);
  assert.equal(calls, 0);
});
