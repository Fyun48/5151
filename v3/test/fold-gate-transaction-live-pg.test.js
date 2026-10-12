// 缺欄探測「不會毒化交易」的真 PG 測試（Owner 2026-10-12 R3）。
//
// 背景（實測踩過的坑）：`SELECT fold_component_root FROM listings LIMIT 1` 在欄位不存在時拋 42703，
// 而**在同一條 PG 交易裡一句失敗的 SELECT 會讓整個交易進 aborted（25P02）**⇒ 之後同交易的
// 寫入全部回滾（CI 的 listing-state-writes 就是這樣紅的）。所以探測改用
// `information_schema.columns`（缺欄時回 0 列、不拋錯）。
//
// 這支測試把「探測之後同一條交易還能寫」變成可重跑的斷言：
//   BEGIN → 探測（foldRootRefreshReady／foldSqlGateReady）→ 同交易 CREATE TEMP TABLE＋INSERT
//   → ROLLBACK。任何一步讓交易 aborted，後面的 INSERT 會直接 25P02 紅。
//
// 只在真 PG 上跑（PG_TEST_URL gate；CI 的拋棄式 PG 就是這一顆）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { foldRootRefreshReady, resetFoldRootRefreshProbe, foldSqlGateReady, resetFoldSqlGate } from "../src/foldComponentRoot.js";

const pgUrl = process.env.PG_TEST_URL || process.env.PG_URL || "";
const skip = pgUrl ? false : "PG_TEST_URL 未設定（CI 的 test-postgres job 會設定）";

test("缺欄探測不會毒化寫入交易（information_schema 探測 ＋ 同交易續寫）", { skip }, async () => {
  const drv = await createPostgresDriver({ env: { ...process.env, PG_URL: pgUrl } });
  const client = await drv.pool.connect();
  try {
    const exec = (sql, params = []) => client.query(toPostgresSql(sql), params).then((r) => r.rows);
    const hasColumn = (await exec(
      "SELECT 1 AS ok FROM information_schema.columns WHERE table_name = 'listings' AND column_name = 'fold_component_root' LIMIT 1",
    )).length > 0;

    await client.query("BEGIN");
    resetFoldRootRefreshProbe();
    resetFoldSqlGate();
    const ready = await foldRootRefreshReady(exec);
    const gate = await foldSqlGateReady(exec);
    assert.equal(ready, hasColumn, "探測結果必須等於欄位是否存在");
    if (hasColumn) {
      // 欄位在：開閘前檢是否放行取決於 drift 戳記，兩種都合法，但**不得拋錯**。
      assert.equal(typeof gate.ok, "boolean");
    } else {
      assert.equal(gate.ok, false);
      assert.equal(gate.reason, "fold_component_root_missing");
    }
    // 關鍵斷言：交易沒有被探測搞成 aborted（有的話這句會 25P02）。
    await client.query("CREATE TEMP TABLE fold_gate_probe (x int) ON COMMIT DROP");
    await client.query("INSERT INTO fold_gate_probe (x) VALUES (1)");
    const back = await client.query("SELECT x FROM fold_gate_probe");
    assert.equal(Number(back.rows[0]?.x), 1, "探測後同一條交易仍必須能寫入");
    await client.query("ROLLBACK");
  } finally {
    client.release();
    await drv.close();
  }
});
