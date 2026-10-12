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

/**
 * 假的 executor：只認得本模組會送出的查詢。
 *
 * se-p7 起守門多了三種查詢：結構指紋（`pg_stat_user_tables`）、`data_revision` 的增量
 * （`WHERE id > $1 AND id <= $2`）、以及**限制在變更過的 post_id 上**的同一組兩項證明
 * （含 `post_id = ANY`）。`state` 讓測試在中途改指紋／版本／delta。
 */
function fakeExec({
  revision = 7, missing = 0, mismatched = 0, ids = [{ post_id: 1 }, { post_id: 2 }],
  hasProjection = true, hasListings = true, sentinel = "5", sentinelTables = 2, delta = [],
  scopedMissing = 0, scopedMismatched = 0,
} = {}) {
  const state = { revision, sentinel, delta, scopedMissing, scopedMismatched, missing, mismatched };
  const calls = [];
  const exec = async (sql, params = []) => {
    calls.push(sql);
    const text = String(sql);
    if (/to_regclass\('data_revision'\)/.test(text)) return [{ has_table: state.revision != null }];
    if (/MAX\(id\) AS n FROM data_revision/.test(text)) return [{ n: state.revision }];
    if (/pg_stat_user_tables/.test(text)) return sentinelTables == null ? [] : [{ churn: state.sentinel, tables: sentinelTables }];
    if (/FROM data_revision\s+WHERE id >/.test(text)) return state.delta;
    if (/to_regclass\('listings'\) IS NOT NULL/.test(text)) return [{ ok: hasProjection && hasListings }];
    if (/to_regclass\('listing_search_projection'\)/.test(text)) return [{ has_table: hasProjection }];
    if (/COUNT\(\*\) AS n FROM listings l WHERE NOT EXISTS/.test(text)) return [{ n: state.missing }];
    if (/post_id = ANY/.test(text)) return [{ missing: state.scopedMissing, mismatched: state.scopedMismatched }];
    if (/AS missing,/.test(text) || /AS mismatched/.test(text)) return [{ missing: state.missing, mismatched: state.mismatched }];
    if (/SELECT post_id FROM listing_search_projection WHERE district/.test(text)) return ids;
    throw new Error(`unexpected SQL: ${text}`);
  };
  return { exec, calls, state };
}

const VERIFY = { districtNames: NAMES, allowedKeys: districtKeyLists(NAMES).allowed };
const fullScans = (calls) => calls.filter((sql) => /AS missing,/.test(sql) && !/post_id = ANY/.test(sql)).length;
const scopedScans = (calls) => calls.filter((sql) => /AS missing,/.test(sql) && /post_id = ANY/.test(sql)).length;

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
  assert.equal(fullScans(calls), 1, "第一次要全掃");
  await districtProjectionVerified(exec, opts);
  await districtProjectionVerified(exec, opts);
  assert.equal(fullScans(calls), 1, "同一個 revision（且指紋沒動）不應重探");
});

// ── se-p7：增量驗證的四條邊界（每一條都必須「退回全掃」而不是「沿用舊快取」）──────────────
test("版本前進但只有別的 post_id 變更：只驗證那一段（增量），不再付全表證明", async () => {
  resetDistrictProjectionCompletenessCache();
  const { exec, calls, state } = fakeExec({ revision: 42, delta: [{ entity_type: "listing", entity_id: 777 }] });
  await districtProjectionVerified(exec, VERIFY);
  assert.equal(fullScans(calls), 1, "第一次全掃");
  state.revision = 43; // 版本前進，但 delta 指名的是 777
  assert.equal(await districtProjectionVerified(exec, VERIFY), true);
  assert.equal(fullScans(calls), 1, "增量驗證通過就不該再全掃");
  assert.equal(scopedScans(calls), 1, "要對變更過的 post_id 跑一次同一組判定式");
  // delta 空（例如 revision 只有 crawl_source 的變更）也一樣：不重付全表證明。
  state.revision = 44;
  state.delta = [];
  assert.equal(await districtProjectionVerified(exec, VERIFY), true);
  assert.equal(fullScans(calls), 1);
});

test("增量驗證抓到漂移：不推進 watermark、不快取（下一次請求仍判 false）", async () => {
  resetDistrictProjectionCompletenessCache();
  const { exec, calls, state } = fakeExec({ revision: 50, delta: [{ entity_type: "listing", entity_id: 888 }] });
  await districtProjectionVerified(exec, VERIFY);
  state.revision = 51;
  state.scopedMissing = 1; // 那個 post_id 少了投影列 ⇒ 漂移
  assert.equal(await districtProjectionVerified(exec, VERIFY), false, "增量命中漂移要回 false");
  const fulls = fullScans(calls);
  // 版本沒有再前進：下一次請求必須再驗一次同一段，而且仍然 false（不得被任何快取掩蓋）。
  state.scopedMissing = 1;
  assert.equal(await districtProjectionVerified(exec, VERIFY), false, "同一段仍要判 false");
  assert.equal(fullScans(calls), fulls, "不得因為抓到漂移就改判全掃結果");
  assert.equal(scopedScans(calls) >= 2, true, "漂移未被修好前，每次請求都要重新驗證");
});

test("delta 無法逐一列舉（entity_id IS NULL／非 listing）就退回全掃", async () => {
  resetDistrictProjectionCompletenessCache();
  const nullId = fakeExec({ revision: 60, delta: [{ entity_type: "listing", entity_id: null }] });
  await districtProjectionVerified(nullId.exec, VERIFY);
  nullId.state.revision = 61;
  assert.equal(await districtProjectionVerified(nullId.exec, VERIFY), true);
  assert.equal(fullScans(nullId.calls), 2, "entity_id IS NULL ⇒ 第二次也要全掃");

  resetDistrictProjectionCompletenessCache();
  const other = fakeExec({ revision: 70, delta: [{ entity_type: "crawl_source", entity_id: 3 }] });
  await districtProjectionVerified(other.exec, VERIFY);
  other.state.revision = 71;
  assert.equal(await districtProjectionVerified(other.exec, VERIFY), true);
  assert.equal(fullScans(other.calls), 2, "非 listing 的變更無法逐一列舉 ⇒ 全掃");

  resetDistrictProjectionCompletenessCache();
  const tooMany = fakeExec({ revision: 80 });
  tooMany.state.delta = Array.from({ length: 4001 }, () => ({ entity_type: "listing", entity_id: 1 }));
  await districtProjectionVerified(tooMany.exec, VERIFY);
  tooMany.state.revision = 81;
  assert.equal(await districtProjectionVerified(tooMany.exec, VERIFY), true);
  assert.equal(fullScans(tooMany.calls), 2, "變更列超過上限 ⇒ 全掃");
});

test("結構指紋改變（版本沒動）⇒ 立刻全掃：快取不得掩蓋沒有 data_revision 紀錄的列增減", async () => {
  resetDistrictProjectionCompletenessCache();
  const { exec, calls, state } = fakeExec({ revision: 90, missing: 0 });
  assert.equal(await districtProjectionVerified(exec, VERIFY), true);
  assert.equal(fullScans(calls), 1);
  // 有人直接 INSERT 一列 listings（沒有 bump revision）⇒ 指紋改變、全掃看到缺列
  state.sentinel = "6";
  state.missing = 1;
  assert.equal(await districtProjectionVerified(exec, VERIFY), false, "指紋變了就要重新全掃，且這次全掃抓到缺列");
  assert.equal(fullScans(calls), 2);
  // 修好投影（指紋再次改變）⇒ 下一個請求要全掃並回 true
  state.sentinel = "7";
  state.missing = 0;
  assert.equal(await districtProjectionVerified(exec, VERIFY), true);
  assert.equal(fullScans(calls), 3);
});

// ── se-p8：指紋降級成「帶外寫入偵測器」後的兩條新紅線 ─────────────────────────────────
test("【se-p8 反向紅線】revision 沒有前進、但指紋變了 ⇒ 仍必須全掃並判 ok=false", async () => {
  resetDistrictProjectionCompletenessCache();
  const { exec, calls, state } = fakeExec({ revision: 120, sentinel: "11", missing: 0 });
  assert.equal(await districtProjectionVerified(exec, VERIFY), true, "前置：乾淨狀態先驗證通過");
  assert.equal(fullScans(calls), 1);

  // 有人**不 bump data_revision**直接 INSERT 一列 listings（列增減 ⇒ 指紋變了），
  // 全掃會看到「listings 有列、投影沒有」＝漂移。這正是指紋降級後最容易破的點：
  // 若把指紋比較改成永真（`sentinelNow === entry.sentinel` 恆成立），這一條就會紅。
  state.sentinel = "12";
  state.missing = 1;
  assert.equal(
    await districtProjectionVerified(exec, VERIFY),
    false,
    "紅線破了：revision 沒前進但指紋變了（＝沒有 revision 紀錄的列增減）時，守門竟沒有全掃／判成 ok=true（會靜默少算）",
  );
  assert.equal(fullScans(calls), 2, "指紋變了必須再全掃一次");

  // 漂移還沒修好（版本仍然沒動、指紋也不再變）⇒ 下一次請求仍須全掃且仍判 false
  //   （不得因為「指紋與快取一致」就沿用上一輪的結果）。
  assert.equal(await districtProjectionVerified(exec, VERIFY), false, "漂移未修好前不得判回 true");
  assert.equal(fullScans(calls), 3, "版本沒前進 ⇒ 每次請求都要重驗（不得被快取掩蓋）");
});

test("【se-p8 回歸】revision 前進且指紋同時改變（爬蟲的正常寫入）⇒ 走增量，不得每次全掃", async () => {
  resetDistrictProjectionCompletenessCache();
  const { exec, calls, state } = fakeExec({
    revision: 200, sentinel: "20", delta: [{ entity_type: "listing", entity_id: 555 }],
  });
  assert.equal(await districtProjectionVerified(exec, VERIFY), true);
  assert.equal(fullScans(calls), 1, "第一次全掃");

  // 爬蟲每秒都在寫：`data_revision` 會前進，`listings` 的列增減指紋也幾乎每次都變。
  //   修正前：指紋一比對就落到全掃 ⇒ 每請求 1–2 次全表 anti-join（正式庫 110–244ms）。
  //   修正後：版本有前進就走「delta 增量證明」，指紋不參與。
  state.revision = 201;
  state.sentinel = "21";
  assert.equal(await districtProjectionVerified(exec, VERIFY), true);
  state.revision = 202;
  state.sentinel = "22";
  assert.equal(await districtProjectionVerified(exec, VERIFY), true);

  assert.equal(fullScans(calls), 1, "版本有前進就不是帶外寫入：不得再全掃（這一條是 se-p8 的效能修正本體）");
  assert.equal(scopedScans(calls), 2, "每次版本前進都要對指名的 post_id 跑一次同一組判定式");
});

test("讀不到結構指紋（統計檢視不可用）⇒ 不可跨請求快取，每次全掃", async () => {
  resetDistrictProjectionCompletenessCache();
  const { exec, calls } = fakeExec({ revision: 100, sentinelTables: null });
  assert.equal(await districtProjectionVerified(exec, VERIFY), true);
  assert.equal(await districtProjectionVerified(exec, VERIFY), true);
  assert.equal(fullScans(calls), 2, "沒有指紋 ⇒ fail-safe：每個請求都全掃（＝舊版強度）");
});

test("週期全掃到期：即使版本與指紋都沒動，也會重新全掃一次", async () => {
  process.env.MEMBER_DISTRICT_GUARD_FULL_SCAN_MS = "1";
  try {
    // 常數在模組載入時讀環境變數 ⇒ 用帶 query 的動態 import 取一份新實例。
    const fresh = await import(`../src/listingDistrictPrefilter.js?fullscan=${Date.now()}`);
    const { exec, calls } = fakeExec({ revision: 110 });
    fresh.resetDistrictProjectionCompletenessCache();
    assert.equal(await fresh.districtProjectionVerified(exec, VERIFY), true);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await fresh.districtProjectionVerified(exec, VERIFY), true);
    assert.equal(fullScans(calls) >= 2, true, "窗口到期要重掃");
  } finally {
    delete process.env.MEMBER_DISTRICT_GUARD_FULL_SCAN_MS;
  }
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
