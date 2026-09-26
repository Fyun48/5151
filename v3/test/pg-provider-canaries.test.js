import { test } from "node:test";
import assert from "node:assert/strict";

// PG 整合 canary（astra 2026-09-25 §3 裁決後修正）。
//
// 規則：
//   • **不得有繞道**：移除 PG_SKIP_CANARIES。
//   • **不得對缺 schema 放行**：移除 42P01 的 catch-and-return；缺表就是紅燈。
//   • 只有「完全沒有設定 PG」才略過（本機）；**只要設定了 PG，連不上／缺 schema 都必須失敗**。
//   • 計數要包在**回傳 client 的 query**（單一快照實際走的路徑），並把交易控制語句與資料查詢分開。

const pgConfigured = Boolean(
  process.env.PG_URL
  || process.env.PGHOST
  || process.env.PG_TEST_URL
  || process.env.DB_DRIVER === "postgres",
);
const skip = pgConfigured ? false : "本機未設定 PG（PG_URL／PGHOST／PG_TEST_URL／DB_DRIVER=postgres）⇒ 略過整合測試";

const TXN = /^\s*(BEGIN|COMMIT|ROLLBACK|SET\s)/i;

test("PG 整合：設定 PG 後必須真的連得上（連不上＝失敗，不是略過）", { skip }, async () => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const drv = await createPostgresDriver({ env: process.env });
  try {
    const res = await drv.query("SELECT 1 AS ok");
    assert.equal(Number(res.rows[0].ok), 1);
  } finally {
    await drv.pool.end();
  }
});


test("PG 整合：缺 pgDriver 時 canRunNodePg 必須為 false（不得誤判可跑）", { skip }, async () => {
  const { canRunNodePg } = await import("../src/listingSearchNodePg.js");
  const { listingSearchBuildContext } = await import("../src/db.js");
  const deps = listingSearchBuildContext();
  assert.equal(canRunNodePg({ pgDriver: null, deps }), false);
  assert.equal(canRunNodePg({ pgDriver: {}, deps }), false);
});

test("PG 整合：完整路徑走 node_pg、單一快照只取一次連線、資料查詢都走該 client", { skip }, async () => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { searchListingsNodePg } = await import("../src/listingSearchNodePg.js");
  const { listingSearchBuildContext } = await import("../src/db.js");

  const drv = await createPostgresDriver({ env: process.env });
  let wrapperQueries = 0;   // 繞過快照、直接走 pool 的查詢（必須為 0）
  let connects = 0;         // pool.connect 次數（單一快照 ⇒ 1）
  const clientQueries = [];
  const counting = {
    query: (sql, params) => { wrapperQueries += 1; return drv.query(sql, params); },
    pool: {
      connect: async (...args) => {
        connects += 1;
        const client = await drv.pool.connect(...args);
        // 快照實際用的是 client.query ⇒ 計數要包在這裡
        // （原本只包 drv.query ⇒ 即使搜尋跑完 queries 仍是 0，等於沒有 gate）。
        return {
          query: (sql, params) => { clientQueries.push(String(sql)); return client.query(sql, params); },
          release: (...a) => client.release(...a),
        };
      },
    },
  };
  try {
    const deps = listingSearchBuildContext();
    // ⚠️ 用**單一行政區**讓候選有界（穩定的正確性 gate）；「無行政區」的全表候選逾時是已知缺口，
    // 由 astra §4 的效能 job 量測，不放在這裡當 gate（否則 canary 會變成 flaky／跑很久）。
    const res = await searchListingsNodePg(
      { filter: "all", sort: "newest", limit: 20, offset: 0, districts: ["西屯區"], userId: 0, matchVoteUserId: 0, settings: {}, searchKeys: [] },
      { pgDriver: counting, deps },
    );
    assert.equal(res?.queryDetails?.engine, "node_pg", "必須走 node_pg 引擎");
    assert.equal(connects, 1, `單一快照：整個請求只該向 pool 取一次連線（實際 ${connects} 次）`);
    assert.equal(wrapperQueries, 0, "所有查詢都必須經由快照 client（不得繞過 pool）");
    const dataQueries = clientQueries.filter((sql) => !TXN.test(sql));
    assert.ok(dataQueries.length > 0, "必須真的對 PG 發出資料查詢");
    assert.ok(
      clientQueries.some((sql) => /^\s*BEGIN/i.test(sql)),
      "必須開啟唯讀交易（單一快照）",
    );
    assert.ok(Array.isArray(res.listings));
  } finally {
    await drv.pool.end();
  }
});

test("PG 整合：districtClosureIds 走 PG（不得拋錯；不需行政區條件時可為 null）", { skip }, async () => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { districtClosureIds } = await import("../src/listingSearchNodePg.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const drv = await createPostgresDriver({ env: process.env });
  try {
    const exec = async (sql, params = []) => (await drv.query(toPostgresSql(sql), params)).rows;
    const ids = await districtClosureIds(exec, { districtNames: ["西屯區"], userId: 0 });
    // 不得再對 42P01（缺 schema）放行：CI 的 PG job 必須先套 schema，缺表就是紅燈。
    assert.ok(ids === null || Array.isArray(ids), "closure 必須是陣列，或 null（代表不需要行政區條件）");
  } finally {
    await drv.pool.end();
  }
});
