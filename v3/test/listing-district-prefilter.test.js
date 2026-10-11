// 行政區「投影預篩」的等價／退回契約測試（裁決 §4.1 P1、本包第 2 步）。
//
// 一定要固定的四件事：
//   1. 投影**缺列**（滯後）時必須退回完整掃描，不得靜默少算。
//   2. `MEMBER_DISTRICT_PREFILTER=0` 可以整條關掉（這是等價測試的 A/B 開關）。
//   3. 沒有預篩 id 時，子句逐字回到原本的 `split_part(source_key…)` 表達式。
//   4. 有預篩 id 時，子句是 `post_id = ANY(...)`（可用主鍵索引），且**保留**關係閉包那一項。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  districtPrefilterEnabled, districtProjectionComplete, districtProjectionVerified,
  loadDistrictPrefilterIds, resetDistrictProjectionCompletenessCache,
} from "../src/listingDistrictPrefilter.js";
import { appendDistrictProjectedCandidates } from "../src/listDistrictSql.js";
import { districtKeyPrefixExpression, districtKeyLists } from "../src/listDistrictSql.js";
import { buildListListingsClauses } from "../src/db.js";

const NAMES = ["中山區"];

function withEnv(value, run) {
  const previous = process.env.MEMBER_DISTRICT_PREFILTER;
  if (value == null) delete process.env.MEMBER_DISTRICT_PREFILTER;
  else process.env.MEMBER_DISTRICT_PREFILTER = value;
  try { return run(); } finally {
    if (previous == null) delete process.env.MEMBER_DISTRICT_PREFILTER;
    else process.env.MEMBER_DISTRICT_PREFILTER = previous;
  }
}

/** 假的 executor：只認得本模組會送出的三種查詢。 */
function fakeExec({ revision = 7, missing = 0, mismatched = 0, ids = [{ post_id: 1 }, { post_id: 2 }], hasProjection = true, hasListings = true } = {}) {
  const calls = [];
  const exec = async (sql) => {
    calls.push(sql);
    if (/to_regclass\('data_revision'\)/.test(sql)) return [{ has_table: revision != null }];
    if (/MAX\(id\) AS n FROM data_revision/.test(sql)) return [{ n: revision }];
    if (/to_regclass\('listings'\) IS NOT NULL/.test(sql)) return [{ ok: hasProjection && hasListings }];
    if (/to_regclass\('listing_search_projection'\)/.test(sql)) return [{ has_table: hasProjection }];
    if (/COUNT\(\*\) AS n FROM listings l WHERE NOT EXISTS/.test(sql)) return [{ n: missing }];
    if (/AS missing,/.test(sql) || /AS mismatched/.test(sql)) return [{ missing, mismatched }];
    if (/SELECT post_id FROM listing_search_projection WHERE district/.test(sql)) return ids;
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return { exec, calls };
}

after(() => resetDistrictProjectionCompletenessCache());

test("開關：預設開啟，0／false／off 關閉", () => {
  withEnv(null, () => assert.equal(districtPrefilterEnabled(), true));
  for (const off of ["0", "false", "off", "NO", " false "]) {
    withEnv(off, () => assert.equal(districtPrefilterEnabled(), false, `${off} 應為關閉`));
  }
  withEnv("1", () => assert.equal(districtPrefilterEnabled(), true));
});

test("沒有行政區名稱時不做預篩（回 null，呼叫端沿用原表達式）", async () => {
  resetDistrictProjectionCompletenessCache();
  const { exec } = fakeExec();
  assert.equal(await loadDistrictPrefilterIds(exec, { districtNames: [] }), null);
});

test("投影缺列（滯後）時必須退回完整掃描，不得靜默少算", async () => {
  resetDistrictProjectionCompletenessCache();
  const { exec, calls } = fakeExec({ missing: 3 });
  assert.equal(await districtProjectionComplete(exec), false);
  assert.equal(await districtProjectionVerified(exec, { districtNames: NAMES, allowedKeys: districtKeyLists(NAMES).allowed }), false);
  assert.equal(await loadDistrictPrefilterIds(exec, { districtNames: NAMES }), null,
    "缺列 ⇒ 不得回預篩 id");
  assert.equal(calls.some((sql) => /SELECT post_id FROM listing_search_projection WHERE district/.test(sql)), false,
    "缺列時不該再去取預篩 id");
});

test("投影表不存在時也要退回（不得靠猜）", async () => {
  resetDistrictProjectionCompletenessCache();
  const { exec } = fakeExec({ hasProjection: false });
  assert.equal(await districtProjectionComplete(exec), false);
  assert.equal(await loadDistrictPrefilterIds(exec, { districtNames: NAMES }), null);
});

test("驗證探針依 data_revision 版本快取：同版本只付一次", async () => {
  resetDistrictProjectionCompletenessCache();
  const { exec, calls } = fakeExec({ revision: 42 });
  const opts = { districtNames: NAMES, allowedKeys: districtKeyLists(NAMES).allowed };
  await districtProjectionVerified(exec, opts);
  const after1 = calls.filter((sql) => /AS mismatched/.test(sql)).length;
  assert.equal(after1, 1);
  await districtProjectionVerified(exec, opts);
  await districtProjectionVerified(exec, opts);
  assert.equal(calls.filter((sql) => /AS mismatched/.test(sql)).length, 1, "同一個 revision 不應重探");
});

test("前綴與投影不一致（投影過期）時必須退回完整掃描", async () => {
  resetDistrictProjectionCompletenessCache();
  const { exec } = fakeExec({ mismatched: 12 });
  assert.equal(await districtProjectionVerified(exec, { districtNames: NAMES, allowedKeys: districtKeyLists(NAMES).allowed }), false);
  resetDistrictProjectionCompletenessCache();
  assert.equal(await loadDistrictPrefilterIds(exec, { districtNames: NAMES }), null, "不一致 ⇒ 不得用預篩");
});

test("投影完整時回傳 id 集合；關掉開關時完全不查", async () => {
  resetDistrictProjectionCompletenessCache();
  const on = fakeExec({ ids: [{ post_id: 5 }, { post_id: 6 }] });
  assert.deepEqual(await loadDistrictPrefilterIds(on.exec, { districtNames: NAMES }), { postIds: [5, 6], districtNames: NAMES });
  resetDistrictProjectionCompletenessCache();
  const off = fakeExec();
  await withEnv("0", async () => {
    assert.equal(await loadDistrictPrefilterIds(off.exec, { districtNames: NAMES }), null);
  });
  assert.equal(off.calls.length, 0, "關閉時不得發出任何查詢");
});

test("子句形狀：有預篩走 `post_id = ANY`，沒有預篩逐字回到 split_part 表達式", () => {
  const { allKeys } = districtKeyLists(NAMES);
  const prefix = districtKeyPrefixExpression("pg");
  void allKeys;

  const projected = [];
  const projectedParams = [];
  assert.equal(appendDistrictProjectedCandidates(NAMES, projected, projectedParams,
    { projectedIds: [11, 12], relatedIds: [13] }), true);
  assert.equal(projected.length, 1);
  assert.match(projected[0], /^\(post_id = ANY\(\?::bigint\[\]\) OR post_id = ANY\(\?::bigint\[\]\)\)$/);
  assert.deepEqual(projectedParams, [[11, 12], [13]]);
  assert.doesNotMatch(projected[0], /split_part/, "有預篩時不得再出現無法索引的 split_part 子句");

  // 沒有 projectedIds（＝null）⇒ 交回呼叫端走原路徑。
  assert.equal(appendDistrictProjectedCandidates(NAMES, [], [], { projectedIds: null, relatedIds: [] }), false);

  // 整合層：buildListListingsClauses 在有／沒有預篩時的 where 片段。
  const base = {
    filter: "all", kind: "", sources: "", districts: NAMES, uid: 1, voteUid: 1,
    settings: {}, context: fakeContext(),
  };
  const withProjection = buildListListingsClauses({ ...base, districtProjectedIds: [11, 12], districtRelatedIds: [13] }, { sqliteDb: null });
  assert.match(withProjection.where, /post_id = ANY/, "有預篩時要用 id 集合");
  assert.doesNotMatch(withProjection.where, new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "不得再掃 split_part");

  const without = buildListListingsClauses({ ...base, districtProjectedIds: null, districtRelatedIds: [13] }, { sqliteDb: null });
  assert.match(without.where, /split_part/, "沒有預篩時必須回到原本的 split_part 表達式");
});

// 假 context：滿足 buildListListingsClauses 的 PG 前提（不觸及任何 SQLite）。
function fakeContext() {
  return {
    isolation: { sql: "1 = 1", params: [] },
    searchKeys: [],
    crawlSources: { items: [] },
    systemCrawl: { isSystemCrawlSource: () => false },
    now: Date.now(),
    asOf: null,
    degraded: [],
  };
}
