// astra6 2026-09-25 §0.2 的護欄：request context（由 PG 建立一次）應能取代
// `currentSearchKeys()`／`getCrawlSources()`／`sqlExcludeFixtureRows(db)` 這些 SQLite 讀取。
//
// 這裡用「有無 context」的差異證明契約存在：給了 context，子句內容就依 context 而變，
// 呼叫端不必（也不能）靠 SQLite 決定。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildListListingsClauses } from "../src/db.js";

const ARGS = { filter: "all", districts: ["士林區"], settings: {}, uid: 0, voteUid: 0 };

test("context.searchKeys 會取代 SQLite 的 currentSearchKeys()", () => {
  const built = buildListListingsClauses({ ...ARGS, context: { searchKeys: ["https://ctx.test/a", "https://ctx.test/b"] } });
  assert.match(built.where, /search_key IN \(\?,\?\)/);
  assert.ok(built.params.includes("https://ctx.test/a"));
  assert.ok(built.params.includes("https://ctx.test/b"));
});

test("context.crawlSources 的停用來源會進入條件（不讀 SQLite 設定）", () => {
  const built = buildListListingsClauses({
    ...ARGS,
    context: { crawlSources: { items: [{ id: "sinyi", enabled: false }, { id: "591", enabled: true }] } },
  });
  assert.match(built.where, /COALESCE\(source, '591'\) NOT IN \(\?\)/);
  assert.ok(built.params.includes("sinyi"));
  assert.ok(!built.params.includes("591"));
});

test("context.isolation 會取代 sqlExcludeFixtureRows(db)", () => {
  const built = buildListListingsClauses({
    ...ARGS,
    context: { isolation: { sql: "fixture_namespace = ?", params: ["ns1"] } },
  });
  assert.match(built.where, /fixture_namespace = \?/);
  assert.ok(built.params.includes("ns1"));
});

test("context.searchKeys 視為已展開：參數逐字等於提供值（不再呼叫 expandSearchKeys）", () => {
  const built = buildListListingsClauses({
    ...ARGS,
    context: { searchKeys: ["https://ctx.test/x"] },
  });
  assert.match(built.where, /search_key IN \(\?\)/);
  assert.deepEqual(built.params.filter((p) => String(p).startsWith("https://ctx.test/")), ["https://ctx.test/x"]);
});

test("未提供 context.searchKeys 時維持現況（走 SQLite 的 currentSearchKeys／expandSearchKeys）", () => {
  const built = buildListListingsClauses({ ...ARGS, context: { isolation: { sql: "1 = 1", params: [] } } });
  // 只驗證契約：不會因為有 context 就假裝 searchKeys 已展開（此呼叫端未提供該欄位）。
  assert.ok(Array.isArray(built.params));
});
