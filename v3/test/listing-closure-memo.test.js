// 行政區聯通閉包（`districtClosureIds`）的**進程內 TTL 記憶**（策略 H-A）驗收測試。
//
// 這一支**刻意離線**：用假的 `exec`／計數用的 `compute` ＋ 注入時鐘，不需要 PG，
// 就能把「併發單飛、TTL 硬上限、key 正規化、LRU、開關、null 不進快取」逐條釘住。
// 真 PG 的 A/B（同一入口、同一請求、逐筆比對 id 序列）在 `v3/scripts/closure-memo-ab.mjs`。
//
// 為什麼要有這一層：closure 的輸入是 **match 圖**（不是 `data_revision` 同源的投影），
// 依 revision 版本化的快取在爬蟲活躍時命中率 0/9（見 `listingDistrictPrefilter.js:368-386` 的
// 實測論證與 L-0862）。Owner 2026-10-13 11:15 裁決改走 **H-A：時間上界的進程內記憶**
// （TTL ≤ 20s，過期就重算、不做 SWR），把「最多沿用幾秒」變成一個明確、可量測的上界。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createClosureMemo,
  closureMemoKey,
  closureMemoEnabled,
  closureMemoTtlMs,
  clampClosureMemoTtlMs,
  CLOSURE_MEMO_MAX_TTL_MS,
  CLOSURE_MEMO_DEFAULT_TTL_MS,
  CLOSURE_MEMO_DEFAULT_MAX_ENTRIES,
} from "../src/listingClosureMemo.js";

/** 注入時鐘：讓「TTL 內命中／過期重算」不靠真實時間。 */
function makeClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => { current += ms; },
    set: (ms) => { current = ms; },
  };
}

/** 計數用的 compute：回傳值由 `reply` 決定，並記錄每次進來的參數。 */
function countingCompute(reply) {
  const calls = [];
  const compute = async (_exec, options) => {
    calls.push(options);
    return typeof reply === "function" ? reply(options, calls.length) : reply;
  };
  compute.calls = calls;
  return compute;
}

const OPTS_A = Object.freeze({ districtNames: ["中山區", "大安區"], userId: 0, relatedOnly: false });

test("(a) 併發同 key：3 個同時呼叫只算 1 次，且三方拿到同一份結果", async () => {
  const clock = makeClock();
  const compute = countingCompute([1, 2, 3]);
  const memo = createClosureMemo(compute, { now: clock.now });
  const [a, b, c] = await Promise.all([
    memo(null, OPTS_A), memo(null, OPTS_A), memo(null, OPTS_A),
  ]);
  assert.equal(compute.calls.length, 1, "同 key 併發必須共享同一個 in-flight promise（單飛）");
  assert.deepEqual(a, [1, 2, 3]);
  assert.deepEqual(b, [1, 2, 3]);
  assert.deepEqual(c, [1, 2, 3]);
  assert.equal(memo.stats().computes, 1);
  assert.equal(memo.stats().shared, 2, "另外兩個呼叫要算成共享，而不是各算一次");
});

test("(b) TTL 內命中、過期重算（注入時鐘）", async () => {
  const clock = makeClock();
  const compute = countingCompute([7]);
  const memo = createClosureMemo(compute, { now: clock.now, ttlMs: 15_000 });

  await memo(null, OPTS_A);
  clock.advance(1);                       // age = 1ms
  await memo(null, OPTS_A);
  assert.equal(compute.calls.length, 1, "TTL 內必須命中，不得重算");

  clock.advance(14_999);                  // age = 15_000ms ⇒ 邊界：age <= TTL 仍算命中
  await memo(null, OPTS_A);
  assert.equal(compute.calls.length, 1, "age == TTL 是命中（`age <= TTL` 的邊界語意）");

  clock.advance(2);                       // age = 15_002ms ⇒ 過期
  await memo(null, OPTS_A);
  assert.equal(compute.calls.length, 2, "超過 TTL 必須重算（沒有 SWR、不給舊值）");
});

test("(c) 回傳的最大 age 一律 <= TTL；過了就一定是重算（不做「過期後繼續給舊值」）", async () => {
  const ttl = 15_000;
  const clock = makeClock();
  const compute = countingCompute([11, 12]);
  const memo = createClosureMemo(compute, { now: clock.now, ttlMs: ttl });

  // 每一步是「相對上一步前進多少毫秒」，逐點記錄「這次是重算還是命中」與「命中時的年齡」，
  // 用注入時鐘證明：**任何一次命中的 age 都 <= TTL**，而且只要超過就一定重算。
  const served = [];
  let storedAt = null;
  const deltas = [0, 1_000, 8_999, 5_001, 1, 4_999, 10_001, 1];   // 累積：0／1_000／9_999／15_000／15_001／20_000／30_001／30_002
  for (const delta of deltas) {
    clock.advance(delta);
    const before = compute.calls.length;
    await memo(null, OPTS_A);
    const computed = compute.calls.length > before;
    if (computed) storedAt = clock.now();
    served.push({ at: clock.now(), computed, age: storedAt == null ? null : clock.now() - storedAt });
  }
  const hits = served.filter(s => !s.computed);
  assert.ok(hits.length > 0, "這條測試必須真的量到命中，否則證明不了 age 上界");
  const maxAge = Math.max(...hits.map(s => s.age));
  assert.ok(maxAge <= ttl, `命中的最大 age（${maxAge}ms）不得超過 TTL（${ttl}ms）`);
  assert.deepEqual(served.map(s => s.computed), [true, false, false, false, true, false, false, true],
    "逐點的重算／命中和 TTL 邊界一致（15_000ms 命中、15_001ms 起重算、下一輪再滿 15_000ms 才重算）");
});

test("(d) key 正規化：行政區亂序／重複同 key；userId／relatedOnly 不同 key", async () => {
  const clock = makeClock();
  const compute = countingCompute([1]);
  const memo = createClosureMemo(compute, { now: clock.now, ttlMs: 15_000 });

  assert.equal(
    closureMemoKey({ districtNames: ["大安區", "中山區"], userId: 0, relatedOnly: false }),
    closureMemoKey({ districtNames: ["中山區", "大安區"], userId: 0, relatedOnly: false }),
    "同一組行政區不同順序必須同 key",
  );
  assert.equal(
    closureMemoKey({ districtNames: ["中山區", "中山區", "大安區"] }),
    closureMemoKey({ districtNames: ["大安區", "中山區"] }),
    "重複的行政區名必須去重後才進 key",
  );

  await memo(null, { districtNames: ["大安區", "中山區"], userId: 0, relatedOnly: false });
  await memo(null, { districtNames: ["中山區", "大安區"], userId: 0, relatedOnly: false });
  await memo(null, { districtNames: ["中山區", "大安區"], userId: 0, relatedOnly: false });
  assert.equal(compute.calls.length, 1, "亂序／去重後必須命中同一筆");

  await memo(null, { districtNames: ["中山區", "大安區"], userId: 0, relatedOnly: true });
  assert.equal(compute.calls.length, 2, "relatedOnly 不同 ⇒ 不同 key（必須重算）");
  await memo(null, { districtNames: ["中山區", "大安區"], userId: 5, relatedOnly: false });
  assert.equal(compute.calls.length, 3, "userId 不同 ⇒ 不同 key（必須重算）");
  assert.notEqual(
    closureMemoKey({ districtNames: ["中山區"], userId: 5, relatedOnly: true }),
    closureMemoKey({ districtNames: ["中山區"], userId: 0, relatedOnly: false }),
  );
});

test("(e) LRU：上限 32 筆，超過就汰舊；被汰掉的再問要重算", async () => {
  const clock = makeClock();
  const compute = countingCompute((options) => [options.districtNames.length]);
  const memo = createClosureMemo(compute, { now: clock.now, ttlMs: 15_000 });

  const names = (i) => [`區${String(i).padStart(3, "0")}`];
  const keys = Array.from({ length: CLOSURE_MEMO_DEFAULT_MAX_ENTRIES }, (_, i) => i);
  for (const i of keys) await memo(null, { districtNames: names(i) });
  assert.equal(memo.size(), CLOSURE_MEMO_DEFAULT_MAX_ENTRIES, "剛好到上限時不得提前汰舊");

  await memo(null, { districtNames: names(999) });          // 第 33 筆 ⇒ 汰掉最舊的 0
  assert.equal(memo.size(), CLOSURE_MEMO_DEFAULT_MAX_ENTRIES, "上限必須硬性維持在 32");

  const before = compute.calls.length;
  await memo(null, { districtNames: names(0) });
  assert.equal(compute.calls.length, before + 1, "被汰掉的那筆必須重算（不能幽靈命中）");
  await memo(null, { districtNames: names(999) });
  assert.equal(compute.calls.length, before + 1, "沒被汰掉的必須還在（LRU 命中）");
});

test("(f) 開關 MEMBER_DISTRICT_CLOSURE_MEMO=0 與 TTL=0 都退回「每次重算」", async () => {
  const clock = makeClock();
  const originalMemo = process.env.MEMBER_DISTRICT_CLOSURE_MEMO;
  const originalTtl = process.env.MEMBER_DISTRICT_CLOSURE_MEMO_TTL_MS;
  try {
    // (f1) 開關 =0 ⇒ 純即時算
    process.env.MEMBER_DISTRICT_CLOSURE_MEMO = "0";
    delete process.env.MEMBER_DISTRICT_CLOSURE_MEMO_TTL_MS;
    assert.equal(closureMemoEnabled(), false, "`=0` 必須被判成關閉");
    assert.equal(closureMemoTtlMs(), CLOSURE_MEMO_DEFAULT_TTL_MS, "沒設 TTL 時預設 15s");
    let compute = countingCompute([1]);
    let memo = createClosureMemo(compute, { now: clock.now });
    await memo(null, OPTS_A); await memo(null, OPTS_A); await memo(null, OPTS_A);
    assert.equal(compute.calls.length, 3, "關閉時必須每次都即時算");
    assert.equal(memo.size(), 0, "關閉時不得留下任何快取項");

    // (f2) 開關 ON，但 TTL=0 ⇒ 也視同關閉
    process.env.MEMBER_DISTRICT_CLOSURE_MEMO = "1";
    process.env.MEMBER_DISTRICT_CLOSURE_MEMO_TTL_MS = "0";
    assert.equal(closureMemoEnabled(), true);
    assert.equal(closureMemoTtlMs(), 0, "TTL=0 必須原樣讀出（0 視同關閉）");
    compute = countingCompute([1]);
    memo = createClosureMemo(compute, { now: clock.now });
    await memo(null, OPTS_A); await memo(null, OPTS_A);
    assert.equal(compute.calls.length, 2, "TTL=0 時必須每次都即時算");
    assert.equal(memo.size(), 0, "TTL=0 時不得留下任何快取項");

    // (f3) 預設（沒設開關）＝ ON
    delete process.env.MEMBER_DISTRICT_CLOSURE_MEMO;
    assert.equal(closureMemoEnabled(), true, "預設必須是 ON");
  } finally {
    if (originalMemo == null) delete process.env.MEMBER_DISTRICT_CLOSURE_MEMO;
    else process.env.MEMBER_DISTRICT_CLOSURE_MEMO = originalMemo;
    if (originalTtl == null) delete process.env.MEMBER_DISTRICT_CLOSURE_MEMO_TTL_MS;
    else process.env.MEMBER_DISTRICT_CLOSURE_MEMO_TTL_MS = originalTtl;
  }
});

test("(f2) TTL clamp：硬上界 20_000ms、下限 0，空字串／壞值回預設", async () => {
  assert.equal(CLOSURE_MEMO_MAX_TTL_MS, 20_000, "20 秒是 Owner 批的過期上限，必須硬寫死");
  assert.equal(clampClosureMemoTtlMs(60_000), 20_000, "超過上界一律夾到 20_000");
  assert.equal(clampClosureMemoTtlMs(20_000), 20_000);
  assert.equal(clampClosureMemoTtlMs(-1), 0, "負值夾到 0（0 視同關閉）");
  assert.equal(clampClosureMemoTtlMs("abc"), CLOSURE_MEMO_DEFAULT_TTL_MS, "壞值回預設，不得變成 0");
  const originalTtl = process.env.MEMBER_DISTRICT_CLOSURE_MEMO_TTL_MS;
  try {
    process.env.MEMBER_DISTRICT_CLOSURE_MEMO_TTL_MS = "999999";
    assert.equal(closureMemoTtlMs(), CLOSURE_MEMO_MAX_TTL_MS, "環境變數也必須被同一個 clamp 收斂");
    process.env.MEMBER_DISTRICT_CLOSURE_MEMO_TTL_MS = "";
    assert.equal(closureMemoTtlMs(), CLOSURE_MEMO_DEFAULT_TTL_MS, "空字串＝沒設，回預設");
  } finally {
    if (originalTtl == null) delete process.env.MEMBER_DISTRICT_CLOSURE_MEMO_TTL_MS;
    else process.env.MEMBER_DISTRICT_CLOSURE_MEMO_TTL_MS = originalTtl;
  }
  // 注入的 ttlMs 也走同一個 clamp：設 60s 的實例，第 20_000ms 之後一律重算。
  const clock = makeClock();
  const compute = countingCompute([1]);
  const memo = createClosureMemo(compute, { now: clock.now, ttlMs: 60_000 });
  await memo(null, OPTS_A);
  clock.advance(20_000);
  await memo(null, OPTS_A);
  assert.equal(compute.calls.length, 1, "20_000ms 仍在（被夾過的）TTL 內");
  clock.advance(1);
  await memo(null, OPTS_A);
  assert.equal(compute.calls.length, 2, "超過 20_000ms 必須重算");
});

test("(g) null（便宜路徑）不進快取：連打兩次 compute 就必須跑 2 次", async () => {
  const clock = makeClock();
  const compute = countingCompute(null);
  const memo = createClosureMemo(compute, { now: clock.now, ttlMs: 15_000 });
  assert.equal(await memo(null, OPTS_A), null);
  assert.equal(await memo(null, OPTS_A), null);
  assert.equal(compute.calls.length, 2, "null 是「不需過濾」的便宜路徑 ⇒ 快取它只會浪費記憶體");
  assert.equal(memo.size(), 0, "null 不得佔用任何快取格");

  // 對照組：非 null 的結果在同一段時間內只算 1 次（證明上面的 2 次確實來自「不快取 null」）。
  const compute2 = countingCompute([5]);
  const memo2 = createClosureMemo(compute2, { now: clock.now, ttlMs: 15_000 });
  await memo2(null, OPTS_A); await memo2(null, OPTS_A);
  assert.equal(compute2.calls.length, 1);
});

test("(h) 命中回傳淺拷貝：呼叫端改動不得污染內部陣列", async () => {
  const clock = makeClock();
  const compute = countingCompute([1, 2, 3]);
  const memo = createClosureMemo(compute, { now: clock.now, ttlMs: 15_000 });
  const first = await memo(null, OPTS_A);
  first.push(999);
  const second = await memo(null, OPTS_A);
  assert.deepEqual(second, [1, 2, 3], "命中必須回傳拷貝；呼叫端亂改不能影響下一手");
  assert.equal(compute.calls.length, 1);
});

test("(i) compute 失敗不得留下毒快取：下一次必須重算（成功的才進快取）", async () => {
  const clock = makeClock();
  let fail = true;
  const compute = async () => { if (fail) throw new Error("boom"); return [1]; };
  const memo = createClosureMemo(compute, { now: clock.now, ttlMs: 15_000 });
  await assert.rejects(() => memo(null, OPTS_A), /boom/);
  fail = false;
  assert.deepEqual(await memo(null, OPTS_A), [1], "失敗後下一次要能正常重算");
  assert.equal(memo.inflightSize(), 0, "失敗後不得留下 in-flight 殘留");
});
