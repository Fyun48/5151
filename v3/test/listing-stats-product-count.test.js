// product-count（stats 的 dbTotal）走 data_revision 版本化快取的行為契約。
//
// 為什麼要單獨釘：這一支原本是每個請求一次 `COUNT(*) FROM listings WHERE <isolation>`（正式庫實測
// 418ms）；改成版本化快取後，「什麼時候可以沿用」與「什麼時候必須現讀」是新的正確性邊界，
// 尤其是 fail-soft（沒有 data_revision／空表／查詢失敗時**不得**緩存）。
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "prb-stats-product-count-"));
process.env.DATA_DIR = dataDir;
const { createListingStatsRepository, resetPgProductCountCache } = await import("../src/repository/listingStats.js");
after(() => rmSync(dataDir, { recursive: true, force: true }));

const DEPS = {
  resolveUserId: (value) => Number(value) || 0,
  getSettings: () => ({}),
  searchWhere: () => {},
  listingVisibilityClauses: () => {},
  appendDistrictCandidates: () => {},
  appendPriceCeilingCandidates: () => {},
  memberRegionDistrictNames: () => [],
  candidateColumns: "post_id",
  buildListingStatsRows: (options) => options.rows || [],
  summarizeListingStats: () => ({}),
};

const REQUEST_CONTEXT = {
  isolation: { sql: "(fixture_namespace IS NULL OR fixture_namespace = '')", params: [] },
  searchKeys: [],
  crawlSources: { items: [] },
  now: Date.now(),
  asOf: new Date().toISOString(),
  settingsForUser: () => ({}),
};

/** 假 exec：記錄每一次 SQL，依內容回答；`state` 可在測試中調整。 */
function makeExec(state) {
  const calls = [];
  const exec = async (sql, params = []) => {
    calls.push({ sql, params });
    if (/to_regclass\('data_revision'\)/.test(sql)) return [{ has_table: state.hasRevisionTable }];
    if (/MAX\(id\) AS n FROM data_revision/.test(sql)) {
      if (state.revision === null) throw new Error("data_revision unavailable");
      return [{ n: state.revision }];
    }
    if (/COUNT\(\*\) AS n FROM listings/.test(sql)) { state.countQueries += 1; return [{ n: state.total }]; }
    return [];
  };
  return { exec, calls, countQueries: () => state.countQueries };
}

function repo(exec) {
  return createListingStatsRepository({ driver: "postgres", exec, deps: DEPS });
}

beforeEach(() => resetPgProductCountCache());

test("同一個 data_revision 只 COUNT 一次，換代後重算", async () => {
  const state = { hasRevisionTable: true, revision: 10, total: 1234, countQueries: 0 };
  const { exec, countQueries } = makeExec(state);
  const repository = repo(exec);

  const first = await repository.loadInputs({ userId: 0, requestContext: REQUEST_CONTEXT });
  assert.equal(first.dbTotal, 1234);
  assert.equal(countQueries(), 1);

  const second = await repository.loadInputs({ userId: 0, requestContext: REQUEST_CONTEXT });
  assert.equal(second.dbTotal, 1234);
  assert.equal(countQueries(), 1, "同一個 revision 不應再打一次全表 COUNT");

  state.revision = 11;
  state.total = 1235;
  const third = await repository.loadInputs({ userId: 0, requestContext: REQUEST_CONTEXT });
  assert.equal(third.dbTotal, 1235);
  assert.equal(countQueries(), 2, "revision 換代就必須重算");
});

test("沒有 data_revision 表時每次都現讀（不得緩存）", async () => {
  const state = { hasRevisionTable: false, revision: null, total: 77, countQueries: 0 };
  const { exec, countQueries } = makeExec(state);
  const repository = repo(exec);
  await repository.loadInputs({ userId: 0, requestContext: REQUEST_CONTEXT });
  await repository.loadInputs({ userId: 0, requestContext: REQUEST_CONTEXT });
  assert.equal(countQueries(), 2);
});

test("data_revision 是空表（MAX(id) IS NULL）時每次都現讀", async () => {
  const state = { hasRevisionTable: true, revision: null, total: 55, countQueries: 0 };
  const { exec, countQueries } = makeExec(state);
  const repository = repo(exec);
  await repository.loadInputs({ userId: 0, requestContext: REQUEST_CONTEXT });
  await repository.loadInputs({ userId: 0, requestContext: REQUEST_CONTEXT });
  assert.equal(countQueries(), 2);
});

test("revision 查詢失敗時 fail-soft：回得到數字，且不緩存", async () => {
  const state = { hasRevisionTable: true, revision: null, total: 12, countQueries: 0 };
  const { exec, countQueries } = makeExec(state);
  const repository = repo(exec);
  const inputs = await repository.loadInputs({ userId: 0, requestContext: REQUEST_CONTEXT });
  assert.equal(inputs.dbTotal, 12);
  assert.equal(countQueries(), 1);
  await repository.loadInputs({ userId: 0, requestContext: REQUEST_CONTEXT });
  assert.equal(countQueries(), 2);
});

test("不同隔離條件不會共用同一筆快取", async () => {
  const state = { hasRevisionTable: true, revision: 3, total: 900, countQueries: 0 };
  const { exec, countQueries } = makeExec(state);
  const repository = repo(exec);
  await repository.loadInputs({ userId: 0, requestContext: REQUEST_CONTEXT });
  const namespaced = { ...REQUEST_CONTEXT, isolation: { sql: "fixture_namespace = $1", params: ["stage1"] } };
  await repository.loadInputs({ userId: 0, requestContext: namespaced });
  assert.equal(countQueries(), 2);
});
