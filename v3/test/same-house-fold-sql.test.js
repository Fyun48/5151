import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listingRefreshAt,
  listingRefreshParts,
  listingTieBreakKey,
  comparableRent,
  preferPrimaryListing,
  computeFoldColumns,
} from "../src/match.js";
import { buildPublicListingsFoldSql, foldRoleCte } from "../src/listingSearchSql.js";

// 相對時間字串解析：listingRefreshParts 必須與 listingRefreshAt 逐位元一致。
test("listingRefreshParts round-trips listingRefreshAt for every relative/absolute format", () => {
  const now = 1_800_000_000_000;
  const cases = [
    ["剛剛", now],
    ["30 秒前", now - 30_000],
    ["5 分鐘前", now - 5 * 60_000],
    ["16 小時前", now - 16 * 3_600_000],
    ["16 小時內更新", now - 16 * 3_600_000],
    ["今日", now],
    ["今天", now],
    ["昨日", now - 86_400_000],
    ["3 天前", now - 3 * 86_400_000],
    ["2026-10-09T00:00:00.000Z", Date.parse("2026-10-09T00:00:00.000Z")],
  ];
  for (const [refreshTime, expected] of cases) {
    const listing = { refresh_time: refreshTime, last_seen_at: "2026-01-01T00:00:00.000Z" };
    assert.equal(listingRefreshAt(listing, now), expected, `refresh_time=${refreshTime}`);
    const parts = listingRefreshParts(listing);
    const rebuilt = parts.kind === "relative" ? now - parts.relMs : parts.absMs;
    assert.equal(rebuilt, expected, `parts rebuild refresh_time=${refreshTime}`);
  }
});

// fallback 到 last_seen_at，再 fallback 到 0。
test("listingRefreshParts falls back to last_seen_at then 0", () => {
  const listing = { refresh_time: "", last_seen_at: "2026-08-08T08:08:08.000Z" };
  assert.equal(listingRefreshParts(listing).kind, "absolute");
  assert.equal(listingRefreshParts(listing).absMs, Date.parse("2026-08-08T08:08:08.000Z"));
  const none = { refresh_time: "", last_seen_at: "" };
  assert.equal(listingRefreshParts(none).kind, "missing");
  assert.equal(listingRefreshParts(none).absMs, 0);
  assert.equal(listingRefreshAt(none, 123), 0);
});

// $now 單點綁定的邊界：相對（小時前）與絕對（last_seen_at）混比時，兩邊必須用同一個 $now 還原，
// 結果才會一致；16h±1s 的臨界必須證明「同 asOf 兩邊同結果」。
test("fold refresh columns reconstruct listingRefreshAt at the same $now (16h ± 1s boundary)", () => {
  const rel = { post_id: 1, source: "591", source_id: "a", refresh_time: "16 小時前", last_seen_at: "2026-01-01T00:00:00.000Z" };
  // 絕對時間刻意落在「16 小時前」的 ±1s 臨界。
  for (const deltaMs of [-1000, 0, 1000]) {
    const absMs = 1_800_000_000_000 - 16 * 3_600_000 + deltaMs;
    const abs = { post_id: 2, source: "591", source_id: "b", refresh_time: "", last_seen_at: new Date(absMs).toISOString() };
    // 兩個不同 $now 值：reconstruction 必須都等於 listingRefreshAt(listing, now)。
    for (const now of [1_800_000_000_000, 1_800_000_000_000 + 7_200_000]) {
      const fr = computeFoldColumns(rel);
      const fa = computeFoldColumns(abs);
      const rebuild = (f) => (f.fold_refresh_kind === 1 ? now - f.fold_refresh_rel_ms : f.fold_refresh_abs_ms);
      assert.equal(rebuild(fr), listingRefreshAt(rel, now));
      assert.equal(rebuild(fa), listingRefreshAt(abs, now));
    }
    // preferPrimaryListing 的方向在臨界 ±1s 要一致（兩個路徑用同一 now 比較）。
    const p = preferPrimaryListing(rel, abs, 1_800_000_000_000);
    assert.ok(p && [1, 2].includes(Number(p.post_id)));
  }
});

// computeFoldColumns 的租金 = comparableRent（不可比較 → null）。
test("computeFoldColumns fold_rent_num equals comparableRent", () => {
  const listing = { price: "25000元", price_num: 25000, extra_fee: 2000, extra_fees: "[]", extra_fee_text: "", tags: "[]", refresh_time: "3 小時前", last_seen_at: "2026-01-01T00:00:00.000Z" };
  const f = computeFoldColumns(listing);
  assert.equal(f.fold_rent_num, comparableRent(listing));
  assert.equal(f.fold_refresh_kind, 1);
  assert.equal(f.fold_refresh_rel_ms, 3 * 3_600_000);
  const noRent = { price: "", price_num: 0, extra_fee: 0, extra_fees: "[]", extra_fee_text: "", tags: "[]", refresh_time: "", last_seen_at: "" };
  assert.equal(computeFoldColumns(noRent).fold_rent_num, null);
  assert.equal(computeFoldColumns(noRent).fold_refresh_kind, 0);
});

// buildPublicListingsFoldSql：訪客 searchKeys=[]、hidden 子句、affiliate 排除、true COUNT 結構。
test("buildPublicListingsFoldSql uses searchWhere([]) and hidden/affiliate clauses", () => {
  const calls = { searchKeys: null, hidden: false };
  const deps = {
    resolveUserId: () => 0,
    getSettings: () => ({}),
    searchWhere: (keys) => { calls.searchKeys = keys; },
    listingVisibilityClauses: () => {},
    appendDistrictCandidates: () => {},
    appendPriceCeilingCandidates: () => {},
    memberRegionDistrictNames: () => [],
  };
  const built = buildPublicListingsFoldSql(
    { kind: "", q: "", sort: "newest", settings: {}, districts: [], districtIds: null, enabledSources: ["591"], now: 1_800_000_000_000 },
    deps,
  );
  assert.equal(built.ok, true);
  assert.deepEqual(calls.searchKeys, [], "guest path must pass searchKeys=[]");
  assert.match(built.where, /COALESCE\(hidden, 0\) != 1/);
  assert.match(built.countQuery.sql, /fold_role/);
  assert.match(built.countQuery.sql, /IS DISTINCT FROM 'affiliate'/);
  assert.match(built.countQuery.sql, /SELECT COUNT\(\*\) AS n/);
  assert.match(built.pageQuery({ limit: 5 }).sql, /LIMIT \? OFFSET \?/);
});

// foldRoleCte 是「可終止、不遞歸」的 window-function 折疊（沒有 RECURSIVE／depth 截斷）。
test("foldRoleCte is a terminating non-recursive window-function fold", () => {
  const cte = foldRoleCte("");
  assert.ok(!/RECURSIVE/i.test(cte), "must not use recursive CTE");
  assert.ok(/row_number\(\) OVER \(PARTITION BY x ORDER BY ord ASC/i.test(cte), "first-incident-edge via row_number");
  assert.ok(/fold_role AS/.test(cte));
});
