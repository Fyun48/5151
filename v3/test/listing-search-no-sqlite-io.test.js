import { test } from "node:test";
import assert from "node:assert/strict";
import { buildListListingsClauses } from "../src/db.js";

// astra6 §2.1：**「搜尋熱路徑零 SQLite」必須可被證明**，而且不能只靠「stub 拋錯」——
// `stage1FixtureIsolation.tableColumns()` 會吞掉例外並可能退成 `1=1`（＝fixture 列外洩）。
// 因此這裡改為**計數**：任何一次 SQLite 存取嘗試都會被記錄，斷言必須為 0。
function sqliteSpy(calls) {
  const record = (kind) => (...args) => {
    calls.push({ kind, args: args.map((a) => String(a).slice(0, 60)) });
    // 故意**不拋錯**：即使有人吞例外，呼叫本身仍會被記錄下來。
    return { all: () => [], get: () => undefined, run: () => undefined };
  };
  return {
    prepare: record("prepare"),
    exec: record("exec"),
    pragma: record("pragma"),
    transaction: record("transaction"),
  };
}

const PG_CONTEXT = {
  searchKeys: [],
  crawlSources: { items: [{ id: "591", enabled: true }] },
  isolation: { sql: "(listings.fixture_namespace IS NULL OR listings.fixture_namespace = '')", params: [] },
};

for (const filter of ["all", "watched", "hidden", "unseen", "viewed"]) {
  test(`PG context + sqliteDb=null：filter=${filter} 不得有任何 SQLite 存取嘗試`, () => {
    const calls = [];
    const built = buildListListingsClauses(
      { filter, districts: [], settings: {}, uid: 7, voteUid: 9, context: PG_CONTEXT },
      { sqliteDb: null },
    );
    assert.equal(calls.length, 0, `不應觸碰 SQLite：${JSON.stringify(calls)}`);
    assert.ok(String(built.where).includes("fixture_namespace"), "仍必須帶 fixture 隔離子句");
  });
}

test("PG context + 間諜 sqliteDb：即使傳入 sqliteDb 也不得被觸碰（context 優先）", () => {
  const calls = [];
  for (const filter of ["all", "watched"]) {
    buildListListingsClauses(
      { filter, districts: [], settings: {}, uid: 7, voteUid: 9, context: PG_CONTEXT },
      { sqliteDb: sqliteSpy(calls) },
    );
  }
  assert.equal(calls.length, 0, `context 已提供 isolation 時不該碰 SQLite：${JSON.stringify(calls)}`);
});

test("PG 路徑缺 context.isolation 時必須明確失敗（不得靜默降級成 1=1 或讀 SQLite）", () => {
  for (const filter of ["all", "watched"]) {
    assert.throws(
      () => buildListListingsClauses(
        { filter, districts: [], settings: {}, uid: 7, voteUid: 9, context: { crawlSources: PG_CONTEXT.crawlSources, searchKeys: [] } },
        { sqliteDb: null },
      ),
      /context\.isolation/,
      `filter=${filter} 缺 isolation 時必須拋錯`,
    );
  }
});

test("SQLite 路徑不受影響：未給 context 時仍走原本的 sqliteDb（預設模組 db）", () => {
  const calls = [];
  const built = buildListListingsClauses(
    { filter: "all", districts: [], settings: {}, uid: 0, voteUid: 0 },
    { sqliteDb: sqliteSpy(calls) },
  );
  assert.ok(calls.length > 0, "SQLite 路徑本來就會探測 schema");
  assert.ok(Array.isArray(built.params));
});
