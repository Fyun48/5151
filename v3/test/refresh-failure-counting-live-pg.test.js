// 刷新失敗計數通道的 live-PG 測試（不能用 mock 取代）。
//
// 證明四件事：
//   (a) 主寫入失敗（42703）後，**同交易**的計數陳述確實拿到 25P02（current transaction is aborted）
//       —— 這就是「把失敗計數寫回 rental_analytics_daily」在刷新真的壞掉時會失效的原因。
//   (b) 行程內計數器在 same catch 前後 0→1（不碰 DB，交易 aborted 也不失效）。
//   (c) /api/health 的形狀（直接打 refreshFailureStats()）看得到非零。
//   (d) ROLLBACK 後資料庫不留痕（rental_analytics_daily 該日該 metric 的 value 未變）。
//
// 場域：repro／tracker_test（domainToolGuards 允許清單；本測試不寫資料，仍只對隔離庫連線）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { noteRefreshFailure, refreshFailureStats, resetRefreshFailureStats } from "../src/listingRefreshHealth.js";
import { bumpAnalyticsAsync } from "../src/rentalAnalyticsAsync.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { taipeiDay } from "../src/rentalNotify.js";

const PG_URL = (process.env.PG_TEST_URL || process.env.PG_LIVE_REPRO_URL || "").trim();
const skip = PG_URL ? false : "PG_TEST_URL / PG_LIVE_REPRO_URL not set (live PostgreSQL refresh-failure counting)";

test("refresh 失敗：同交易 DB 計數拿 25P02，行程內計數器 0→1，ROLLBACK 不留痕", { skip }, async () => {
  const drv = await createPostgresDriver({ connectionString: PG_URL, poolOptions: { max: 2 } });
  resetRefreshFailureStats();

  const day = taipeiDay(new Date());
  const metric = "projection_refresh_failed";
  const readValue = async () => {
    try {
      const r = await drv.pool.query(
        "SELECT value FROM rental_analytics_daily WHERE day = $1 AND metric = $2",
        [day, metric],
      );
      return Number(r.rows[0]?.value) || 0;
    } catch (error) {
      if (/does not exist|42P01|no such table/i.test(String(error?.message || error))) return 0;
      throw error;
    }
  };
  const before = await readValue();

  let txErrorCode = null;
  await drv.withTransaction(async (client) => {
    // 主寫入（模擬刷新失敗）拋 42703 → 交易進入 aborted。
    try {
      await client.query("UPDATE listings SET no_such_column_xyz = 1 WHERE post_id = 1");
    } catch (error) {
      // (b) 先記行程內計數器（一定活著）。
      const beforeCounter = refreshFailureStats().projection.failures;
      noteRefreshFailure("projection", error);
      assert.equal(refreshFailureStats().projection.failures, beforeCounter + 1, "行程內計數器 0→1");

      // (a) 同交易的 DB 計數陳述確實拿到 25P02。
      const txExec = (sql, params = []) => client.query(toPostgresSql(sql), params).then((r) => r.rows);
      try {
        await bumpAnalyticsAsync(metric, new Date(), 1, { exec: txExec, driver: "postgres" });
      } catch (e) {
        txErrorCode = String(e?.code || e?.message || e);
      }
      assert.match(txErrorCode, /25P02|aborted/, "同交易計數應拿到 25P02");
    }
  });

  // (c) /api/health 形狀（直接打函式）。
  const stats = refreshFailureStats();
  assert.equal(stats.projection.failures, 1, "health 看得到非零的 projection_refresh_failures");
  assert.equal(typeof stats.fold.failures, "number");

  // (d) ROLLBACK 後 DB 不留痕（rental_analytics_daily 未變）。
  assert.equal(await readValue(), before, "rental_analytics_daily 的 value 未變");

  await drv.pool.end();
});
