// rental_match_seen 的 SELECT-then-INSERT 併發競態（多節點 HA，2026-10）。
//
// 背景：正式站是雙節點 HA，兩個 web 節點每 5 分鐘各跑一次 runRentalNotifyTickAsync，
// 共享同一個 PostgreSQL（5151_shadow）。openMatchEpisodeIfNeededAsync 對 rental_match_seen
// 是 SELECT-then-INSERT；兩節點同時命中同一 (owner_user_id, listing_id, wish_ref) 時，
// 若 INSERT 不是冪等的，第二筆會以 23505 unique_violation 讓**整筆 tick 交易回滾**。
//
// 離線 parity 夾具是單執行緒 SQLite，測不出「兩條真 PG 連線的併發」；所以這個測試在真 PG 上
// 用兩條獨立連線＋一個 SELECT 屏障，確定性地逼出競態視窗，證明冪等 INSERT
// （ON CONFLICT DO NOTHING）之後：無未捕異常、無重複 row、且「只有一個」caller 回報 notify
// （與單次呼叫在全新 row 上回報 notify:true 等價）。
//
// ⚠️ 安全：吃 PG_TEST_URL（CI 的拋棄式 tracker_test），但目標庫必須在允許清單內
// （正式庫 5151_shadow 一律拒絕），與 live PG 測試同一組守衛。
import { test } from "node:test";
import assert from "node:assert/strict";

const RAW = String(process.env.PG_TEST_URL || "").trim();

// 守衛必須在「連線／寫入」之前：PG_TEST_URL 在開發機上可能指向正式庫，若不在允許清單就整支 skip。
const skip = await (async () => {
  if (!RAW) return "PG_TEST_URL 未設定（需要真 PG 才能測兩條連線的併發）";
  const { assertPgTargetAllowed } = await import("../src/domainToolGuards.js");
  try {
    assertPgTargetAllowed("rental-match-seen-ha-race", RAW);
    return false;
  } catch (error) {
    return error.message;
  }
})();

const OWNER = 900000000972;
const LISTING = 900000000973;
const REF_SINGLE = `ha-race-single-${Date.now()}`;
const REF_RACE = `ha-race-${Date.now()}`;

test("openMatchEpisodeIfNeededAsync：兩條併發呼叫與單次呼叫等價，無重複 row、無未捕異常", { skip }, async () => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const { openMatchEpisodeIfNeededAsync, ensureRentalNotifyWorkerOnce } = await import("../src/rentalNotifyWorkerAsync.js");

  // 兩條獨立 driver（各 max:1）＝兩個獨立連線，模擬兩個節點各自的交易。
  const a = await createPostgresDriver({ connectionString: RAW, poolOptions: { max: 1 } });
  const b = await createPostgresDriver({ connectionString: RAW, poolOptions: { max: 1 } });
  try {
    await ensureRentalNotifyWorkerOnce(a);
    const q = async (driver, sql, params = []) => (await driver.query(sql, params)).rows;
    const countFor = async (ref) => Number((await q(a,
      "SELECT COUNT(*) AS n FROM rental_match_seen WHERE owner_user_id = $1 AND listing_id = $2 AND wish_ref = $3",
      [OWNER, LISTING, ref],
    ))[0].n) || 0;

    await a.query("DELETE FROM rental_match_seen WHERE owner_user_id = $1 AND listing_id = $2", [OWNER, LISTING]);

    // 基準：單次呼叫在全新 row 上回報 notify:true、episode 1，且只有一筆 row。
    const single = await a.withTransaction(async (client) => {
      const run = async (sql, params = []) => {
        const res = await client.query(toPostgresSql(sql), params);
        return { rows: res.rows, rowCount: Number(res.rowCount) || 0 };
      };
      return openMatchEpisodeIfNeededAsync(run, OWNER, LISTING, REF_SINGLE, new Date());
    });
    assert.equal(single.notify, true);
    assert.equal(single.episode, 1);
    assert.equal(await countFor(REF_SINGLE), 1);

    // 競態：SELECT 屏障讓兩個 call 都先跑完 SELECT（都看到「無 row」），再一起往下走 INSERT。
    let selected = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const makeRun = (driver) => driver.withTransaction(async (client) => {
      const run = async (sql, params = []) => {
        const res = await client.query(toPostgresSql(sql), params);
        if (/^\s*SELECT\b/i.test(sql)) {
          selected += 1;
          if (selected === 2) release();
          await gate;
        }
        return { rows: res.rows, rowCount: Number(res.rowCount) || 0 };
      };
      return openMatchEpisodeIfNeededAsync(run, OWNER, LISTING, REF_RACE, new Date());
    });

    const [r1, r2] = await Promise.all([makeRun(a), makeRun(b)]);

    // 無未捕異常（有 23505 的話 Promise.all 已經 reject，到不了這裡）。
    // 無重複 row：複合主鍵保證只有一筆。
    assert.equal(await countFor(REF_RACE), 1, "同一 (owner, listing, wish_ref) 只能有一筆 row");

    // 與單次呼叫等價：只有一個 caller 回報 notify，且 episode 一致。
    assert.equal([r1, r2].filter((r) => r.notify).length, 1, "只有一個 caller 回報 notify");
    assert.deepEqual([r1, r2].map((r) => r.episode).sort(), [1, 1], "episode 必須一致為 1");

    const row = (await q(a,
      "SELECT eligible, episode FROM rental_match_seen WHERE owner_user_id = $1 AND listing_id = $2 AND wish_ref = $3",
      [OWNER, LISTING, REF_RACE],
    ))[0];
    assert.equal(row.eligible, 1);
    assert.equal(row.episode, 1);

    await a.query("DELETE FROM rental_match_seen WHERE owner_user_id = $1 AND listing_id = $2", [OWNER, LISTING]);
  } finally {
    await a.close();
    await b.close();
  }
});
