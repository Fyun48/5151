// Ops 遞送 worker 的 **live PG** 驗證（2026-09-28，第五十七批）。
//
// 這一支要證明三件離線證明不了的事：
//   1. **`FOR UPDATE SKIP LOCKED` 真的讓兩個 worker 不重複認領**（同一批 30 筆，
//      兩個獨立連線同時 claim ⇒ 兩邊拿到的 id 不重疊、合起來剛好 30 筆）。
//   2. 認領 → 送出 → 標記 sent 在真 PG 上跑得完（worker 的 store 介面）。
//   3. 停止鍵存的是**原始字串** `"1"`（不是 JSON）：存進去、讀出來都一樣。
//
// ⚠️ 安全設計照抄 `demand-live-pg.test.js`：只認 `PG_LIVE_REPRO_URL` 且資料庫名要在允許清單內。
// 測試資料用可辨識的 feedback_id 範圍，前後都清。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const RAW = String(process.env.PG_LIVE_REPRO_URL || "").trim();
const ALLOWED_DB = new Set(["repro", "tracker_test", "repro2"]);
const DB = (() => { try { return new URL(RAW).pathname.replace(/^\//, ""); } catch { return ""; } })();
const REFUSED = RAW && !ALLOWED_DB.has(DB);
const skip = !RAW ? "PG_LIVE_REPRO_URL 未設定（live PG 驗證需要隔離環境）"
  : REFUSED ? `拒絕執行：資料庫 "${DB}" 不在允許清單 ${[...ALLOWED_DB].join("/")}（正式庫 5151_shadow 一律拒絕）`
    : false;

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-opsworker-live-"));
process.env.DATA_DIR = process.env.DATA_DIR || dataDir;

const MARK = 970000000; // 這一輪測試用的 feedback_id 起點

test("live PG：兩個 worker 同時認領不重疊，而且送出的會被標成 sent", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const {
    ensureFeedbackOutboxStoreOnce,
    claimOutboxBatchAsync,
    outboxStatsAsync,
    markOutboxFailureAsync,
  } = await import("../src/feedbackOutboxAsync.js");
  const { feedbackOutboxStoreAsync, isLocalDeliveryStoppedAsync } = await import("../src/opsDeliveryAsync.js");
  const { deliverWithStore } = await import("../src/opsDelivery.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const second = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  const query2 = async (sql, params = []) => (await second.query(sql, params)).rows;
  assert.equal((await query("SELECT current_database() AS db"))[0].db, DB, "連到的資料庫必須與 URL 一致");
  await ensureFeedbackOutboxStoreOnce(pgDriver);
  await ensureFeedbackOutboxStoreOnce(second);

  const cleanup = async () => {
    await query(`DELETE FROM feedback_outbox WHERE feedback_id >= $1`, [MARK]);
  };
  t.after(async () => {
    try { await cleanup(); } catch { /* 盡力而為 */ }
    try { await pgDriver.query("DELETE FROM settings WHERE key = 'ops_feedback_stop'"); } catch { /* 盡力而為 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
    try { await second.close(); } catch { /* 已關就算了 */ }
  });
  await cleanup();

  const NOW = new Date();
  const nowIso = NOW.toISOString();
  const past = new Date(NOW.getTime() - 60_000).toISOString();
  const TOTAL = 30;
  for (let i = 0; i < TOTAL; i += 1) {
    await query(
      `INSERT INTO feedback_outbox(delivery_id, idempotency_key, feedback_id, payload, status, attempts, next_attempt_at, created_at)
       VALUES ($1, $2, $3, $4, 'pending', 0, $5, $5)`,
      [`live-d-${MARK}-${i}`, `live-k-${MARK}-${i}`, MARK + i, JSON.stringify({ delivery_id: `live-d-${MARK}-${i}` }), past],
    );
  }

  const execOf = (driver) => async (sql, params = []) => {
    const res = await driver.query(toPostgresSql(sql), params);
    return { rows: res.rows, rowCount: Number(res.rowCount) || 0 };
  };
  const opts = { driver: "postgres", pgDriver, exec: execOf(pgDriver), strict: true };
  const opts2 = { driver: "postgres", pgDriver: second, exec: execOf(second), strict: true };

  // 1. 真的送一輪：認領 → 送出 → 標記 sent（全部在 PG 上）
  const store = feedbackOutboxStoreAsync(opts);
  const summary = await deliverWithStore(store, {
    url: "https://ops.example.test/ops/api/ingest/feedback",
    secret: "live-secret",
    now: () => new Date(),
    batchSize: TOTAL,
    concurrency: 4,
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(summary.claimed, TOTAL, `這一輪要把 ${TOTAL} 筆都認領起來（實際 ${summary.claimed}）`);
  assert.equal(summary.sent, TOTAL, "全部都要成功送出");
  const sentCount = await query(`SELECT COUNT(*)::int AS n FROM feedback_outbox WHERE feedback_id >= $1 AND status = 'sent'`, [MARK]);
  assert.equal(sentCount[0].n, TOTAL, "PG 上 30 筆都要是 sent");

  // 2. 併發認領：重新種一批 pending，兩個獨立連線同時搶 ⇒ 不重疊、也不漏
  await query(`UPDATE feedback_outbox SET status='pending', claimed_at=NULL, next_attempt_at=$1 WHERE feedback_id >= $2`, [past, MARK]);
  const [a, b] = await Promise.all([
    claimOutboxBatchAsync({ limit: 20, now: NOW }, opts),
    claimOutboxBatchAsync({ limit: 20, now: NOW }, opts2),
  ]);
  const idsA = a.map((row) => Number(row.id));
  const idsB = b.map((row) => Number(row.id));
  assert.ok(idsA.length > 0 && idsB.length > 0, `兩邊都要搶到東西（A=${idsA.length} B=${idsB.length}）`);
  assert.equal(idsA.length + idsB.length, TOTAL,
    `兩邊合起來要剛好 ${TOTAL} 筆（A=${idsA.length} B=${idsB.length}）`);
  const overlap = idsA.filter((id) => idsB.includes(id));
  assert.deepEqual(overlap, [], `兩個 worker 不得認領到同一列（重疊：${JSON.stringify(overlap)}）`);
  const sending = await query(`SELECT COUNT(*)::int AS n FROM feedback_outbox WHERE feedback_id >= $1 AND status = 'sending'`, [MARK]);
  assert.equal(sending[0].n, TOTAL, "PG 上 30 筆都要是 sending");
  // fresh 的 sending 不該被再認領（避免同一輪重複送）
  assert.equal((await claimOutboxBatchAsync({ limit: 20, now: NOW }, opts)).length, 0);

  // 3. crash 復原：把 claimed_at 推回過去 ⇒ 要能全部回收（stale 的 sending）
  await query(`UPDATE feedback_outbox SET claimed_at = $1 WHERE feedback_id >= $2 AND status = 'sending'`,
    [new Date(NOW.getTime() - 10 * 60_000).toISOString(), MARK]);
  const reclaimed = await claimOutboxBatchAsync({ limit: 50, now: NOW }, opts);
  assert.equal(reclaimed.length, TOTAL, `stale 的 sending 要能全部回收（實際 ${reclaimed.length}）`);
  assert.ok(reclaimed.every((row) => row.status === "sending"));

  // 4. 失敗路徑：拿一筆 sending 標記失敗（attempts+1、可重試、寫下 last_error）
  const one = await query(`SELECT * FROM feedback_outbox WHERE feedback_id >= $1 AND status = 'sending' LIMIT 1`, [MARK]);
  assert.equal(one.length, 1, "前提：要有一筆 sending 可以標記失敗");
  const info = await markOutboxFailureAsync(one[0], "HTTP 503", { now: new Date(), random: () => 0.5 }, opts2);
  assert.equal(info.status, "failed");
  assert.equal(info.attempts, Number(one[0].attempts) + 1);
  const after = await query(`SELECT status, last_error, next_attempt_at FROM feedback_outbox WHERE id = $1`, [one[0].id]);
  assert.equal(after[0].status, "failed");
  assert.equal(after[0].last_error, "HTTP 503");
  assert.ok(after[0].next_attempt_at > new Date().toISOString(), "要有下次重試時間（退避）");
  // ⚠️ `stats` 算的是**整張表**（隔離庫裡可能還有別的執行留下的列），所以拿同一句 GROUP BY 當期望值。
  const expectedStats = Object.fromEntries((await query(
    "SELECT status, COUNT(*)::int AS n FROM feedback_outbox GROUP BY status",
  )).map((row) => [row.status, row.n]));
  const stats = await outboxStatsAsync(opts);
  assert.equal(stats.total, Object.values(expectedStats).reduce((sum, n) => sum + n, 0), "total 要等於各狀態加總");
  assert.equal(stats.failed, expectedStats.failed || 0);
  assert.equal(stats.sending, expectedStats.sending || 0);
  assert.ok(stats.failed >= 1, "剛剛標記失敗的那一筆要被算進 failed");
  assert.ok(stats.sending >= TOTAL - 1, "其餘的仍在 sending");

  // 5. 停止鍵：存的是原始字串 "1"（不是 JSON），讀回來也一樣
  await query(`INSERT INTO settings(key, value) VALUES ('ops_feedback_stop', '1')
               ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  assert.equal(await isLocalDeliveryStoppedAsync(opts), true, "原始字串 '1' ⇒ 停止");
  const raw = await query("SELECT value FROM settings WHERE key = 'ops_feedback_stop'");
  assert.equal(raw[0].value, "1", "存的必須是原始字串（不是 '\"1\"'）");
  await query(`UPDATE settings SET value = '0' WHERE key = 'ops_feedback_stop'`);
  assert.equal(await isLocalDeliveryStoppedAsync(opts), false, "'0' ⇒ 不停");
});
