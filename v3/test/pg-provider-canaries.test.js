import { test } from "node:test";
import assert from "node:assert/strict";

// CI 用（astra6 §6）：只有在**真的能建出可用的 PG driver** 時才跑（環境無關：CI 用 service
// container 的 PG* 變數、容器內用 app 自己的連線設定）。不能只檢查 PGHOST —— 容器實測就沒有它。
//
// 這一組是**回歸金絲雀**：任何一項失敗都代表 astra6 §0.2 的保證（PG 路徑不得回退 SQLite、
// 必須帶著 provider、必須能真的跑完、單一快照只取一次連線）被破壞 ⇒ 應在 CI 直接紅燈。
async function pgAvailable() {
  if (process.env.PG_SKIP_CANARIES === "1") return false;
  try {
    const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
    const drv = await createPostgresDriver({ env: process.env });
    await drv.query("SELECT 1");
    await drv.pool.end();
    return true;
  } catch {
    return false;
  }
}

const skip = (await pgAvailable()) ? false : "沒有可用的 PG 連線（設 PGHOST/PG* 或 DB_DRIVER=postgres）";

test("PG 整合：缺 pgDriver 時 canRunNodePg 必須為 false（不得誤判可跑）", { skip }, async () => {
  const { canRunNodePg } = await import("../src/listingSearchNodePg.js");
  const { listingSearchBuildContext } = await import("../src/db.js");
  const deps = listingSearchBuildContext();
  assert.equal(canRunNodePg({ pgDriver: null, deps }), false);
  assert.equal(canRunNodePg({ pgDriver: {}, deps }), false);
});

test("PG 整合：真實 PG 上跑完整路徑（node_pg），且確實經過 PG（查詢數 > 0）", { skip }, async () => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { searchListingsNodePg } = await import("../src/listingSearchNodePg.js");
  const { listingSearchBuildContext } = await import("../src/db.js");

  const drv = await createPostgresDriver({ env: process.env });
  let queries = 0;
  let connects = 0;
  const counting = {
    query: (sql, params) => { queries += 1; return drv.query(sql, params); },
    // 單一快照的關鍵：整個請求只向 pool 取一次連線。這裡真的計數（不是同義反覆的斷言）。
    pool: { connect: (...args) => { connects += 1; return drv.pool.connect(...args); } },
  };
  try {
    const deps = listingSearchBuildContext();
    const res = await searchListingsNodePg(
      { filter: "all", sort: "newest", limit: 20, offset: 0, districts: [], userId: 0, matchVoteUserId: 0, settings: {} },
      { pgDriver: counting, deps },
    );
    assert.equal(res?.queryDetails?.engine, "node_pg", "必須走 node_pg 引擎");
    assert.ok(queries > 0, "必須真的對 PG 發出查詢");
    assert.ok(Array.isArray(res.listings));
    assert.equal(connects, 1, `單一快照：整個請求只該向 pool 取一次連線（實際 ${connects} 次）`);
  } finally {
    await drv.pool.end();
  }
});

test("PG 整合：districtClosureIds 走 PG（closure 可為空，但不得拋錯）", { skip }, async () => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { districtClosureIds } = await import("../src/listingSearchNodePg.js");
  const drv = await createPostgresDriver({ env: process.env });
  try {
    const exec = async (sql, params = []) => {
      const { toPostgresSql } = await import("../src/sqlDialect.js");
      return (await drv.query(toPostgresSql(sql), params)).rows;
    };
    const ids = await districtClosureIds(exec, { districtNames: ["西屯區"], userId: 0 });
    assert.ok(Array.isArray(ids), "closure 必須是陣列（空庫時為空陣列，不得拋錯）");
  } catch (err) {
    // 空庫（CI 的 service container 尚未套 schema）時跳過；有 schema 時這個測試就是真的 gate。
    if (String(err?.code) === "42P01") return;
    throw err;
  } finally {
    await drv.pool.end();
  }
});
