// 回饋傳輸佇列（PG 島嶼）與 Ops 遞送 worker 的離線驗證（2026-09-28，第五十七批）。
//
// ⚠️ **這一支刻意不用 SQLite 夾具跑 SQL**：PG 版的語句是 PG 方言
// （`FOR UPDATE SKIP LOCKED`、`id = ANY($2::bigint[])`），SQLite 根本跑不動，
// 硬要翻譯就等於在測翻譯器而不是測程式。
// 分工是：
//   - 離線（這支）：**語句形狀**（送出的 SQL 與參數）＋**回傳映射**（bigint 字串 → 數字…）
//     ＋ worker 的**政策**（認領→送出→標記、退避、dead-letter）跑在一個小型的 PG 模擬器上。
//   - live（`ops-worker-live-pg.test.js`）：真 PG 的行為，**包含兩個連線同時認領不重疊**。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLAIM_OUTBOX_SQL,
  claimOutboxBatchAsync,
  compactSentOutboxPayloadsAsync,
  markOutboxFailureAsync,
  markOutboxSentAsync,
  outboxCapacityAlertAsync,
  outboxStatsAsync,
} from "../src/feedbackOutboxAsync.js";
import {
  STOP_UPSERT_SQL,
  deliveryControlAsync,
  feedbackOutboxStoreAsync,
  isLocalDeliveryStoppedAsync,
  setLocalDeliveryStoppedAsync,
} from "../src/opsDeliveryAsync.js";
import { backoffMs, OUTBOX_DEFAULT_MAX_ATTEMPTS } from "../src/feedbackOutbox.js";
import { deliverWithStore } from "../src/opsDelivery.js";

const PG = { driver: "postgres", strict: true };
const NOW = new Date("2026-09-28T04:00:00.000Z");
const call = (sql, params = [], rows = []) => ({ sql: String(sql).replace(/\s+/g, " ").trim(), params, rows });

// ---------------------------------------------------------------------------
// 1. 認領：語句形狀（SKIP LOCKED 是這一支的核心）

test("claimOutboxBatchAsync：一定是**單句**原子認領，且含 FOR UPDATE SKIP LOCKED", async () => {
  // 為什麼堅持單句：兩段式（先 SELECT 候選、再 UPDATE）在 PG 上有窗口——
  // `pgDriver.query()` 每句是自己的隱含交易，SELECT 的鎖結束就放掉，
  // 另一個 worker 會在 UPDATE 之前看到同一批還是 pending ⇒ **重複認領**
  // （實測：30 筆被認領 31 次，由 live 併發測試抓到）。
  const calls = [];
  const exec = async (sql, params = []) => {
    calls.push(call(sql, params));
    return [{ id: 7, status: "sending", attempts: "0", max_attempts: "5", claimed_at: params[0] }];
  };
  const claimed = await claimOutboxBatchAsync({ limit: 5, now: NOW }, { ...PG, exec });
  assert.equal(calls.length, 1, `認領只能送出一句（實際 ${calls.length} 句）`);
  assert.match(calls[0].sql, /^UPDATE feedback_outbox SET status = 'sending', claimed_at = \$1 WHERE id IN \(\s*SELECT id FROM feedback_outbox/,
    `必須是一句 UPDATE … WHERE id IN (SELECT …)：${calls[0].sql}`);
  assert.match(calls[0].sql, /FOR UPDATE SKIP LOCKED/, "子查詢要含 SKIP LOCKED（兩個 worker 拿到互斥子集）");
  assert.match(calls[0].sql, /RETURNING \*/, "要 RETURNING，才拿得到自己搶到的列");
  assert.match(calls[0].sql, /status IN \('pending','failed'\) AND next_attempt_at <= \$1/);
  assert.match(calls[0].sql, /status = 'sending' AND \(claimed_at IS NULL OR claimed_at <= \$2\)/,
    "stale 的 sending 要能被重新認領（crash 復原）");
  assert.match(calls[0].sql, /ORDER BY id ASC/);
  assert.deepEqual(calls[0].params, [NOW.toISOString(), new Date(NOW.getTime() - 5 * 60 * 1000).toISOString(), 5],
    "參數是 [now, staleBefore, limit]");
  assert.deepEqual(claimed.map((r) => Number(r.id)), [7]);
  assert.equal(claimed[0].attempts, 0, "attempts 必須是數字（PG 的整數可能是字串）");
});

test("claimOutboxBatchAsync：limit 會被夾在 1..200；沒有候選時回空陣列", async () => {
  const calls = [];
  const empty = async (sql, params = []) => { calls.push(call(sql, params)); return []; };
  assert.deepEqual(await claimOutboxBatchAsync({ limit: 9999, now: NOW }, { ...PG, exec: empty }), []);
  assert.equal(calls[0].params[2], 200, "limit 要夾在 200");
  calls.length = 0;
  await claimOutboxBatchAsync({ limit: 0, now: NOW }, { ...PG, exec: empty });
  assert.equal(calls[0].params[2], 20, "limit 0 ⇒ 預設 20");
  assert.match(CLAIM_OUTBOX_SQL, /LIMIT \$3/);
});

// 2. 標記：sent／failed（退避）／dead

test("markOutboxSentAsync：寫 status='sent'、sent_at、清掉 last_error", async () => {
  const calls = [];
  const exec = async (sql, params = []) => { calls.push(call(sql, params)); return []; };
  await markOutboxSentAsync(7, { now: NOW }, { ...PG, exec });
  assert.match(calls[0].sql, /SET status='sent', sent_at=\$1, last_error=NULL/);
  assert.deepEqual(calls[0].params, [NOW.toISOString(), 7]);
});

test("markOutboxFailureAsync：未達上限 ⇒ failed ＋ 退避；達上限 ⇒ dead", async () => {
  const calls = [];
  const exec = async (sql, params = []) => { calls.push(call(sql, params)); return []; };
  const random = () => 0.5;
  const row = { id: 7, attempts: 1, max_attempts: 5 };
  const failed = await markOutboxFailureAsync(row, "HTTP 500", { now: NOW, random }, { ...PG, exec });
  assert.equal(failed.status, "failed");
  assert.equal(failed.attempts, 2, "attempts 要 +1");
  const expectedNext = new Date(NOW.getTime() + backoffMs(2, { random })).toISOString();
  assert.equal(failed.next_attempt_at, expectedNext, "下次重試時間必須用共用的 backoffMs 算");
  assert.match(calls[0].sql, /SET status='failed', attempts=\$1, next_attempt_at=\$2, last_error=\$3/);
  assert.deepEqual(calls[0].params, [2, expectedNext, "HTTP 500", 7]);

  calls.length = 0;
  const dying = { id: 8, attempts: OUTBOX_DEFAULT_MAX_ATTEMPTS - 1, max_attempts: OUTBOX_DEFAULT_MAX_ATTEMPTS };
  const dead = await markOutboxFailureAsync(dying, "timeout", { now: NOW, random }, { ...PG, exec });
  assert.equal(dead.status, "dead", "最後一次失敗要進 dead-letter");
  assert.match(calls[0].sql, /SET status='dead', attempts=\$1, last_error=\$2/);
  assert.deepEqual(calls[0].params, [OUTBOX_DEFAULT_MAX_ATTEMPTS, "timeout", 8]);
  // 錯誤訊息要截短（500 字），避免把整包 payload 寫進 DB。
  // ⚠️ failed 路徑的參數是 [attempts, next_attempt_at, err, id] ⇒ 錯誤訊息在索引 2。
  calls.length = 0;
  await markOutboxFailureAsync({ id: 9, attempts: 0, max_attempts: 3 }, "x".repeat(900), { now: NOW, random }, { ...PG, exec });
  assert.equal(calls[0].params[2].length, 500);
});

// 3. 統計／警示／精簡

test("outboxStatsAsync：bigint 字串要轉數字，total 是各狀態加總", async () => {
  const exec = async () => [{ status: "pending", n: "3" }, { status: "sent", n: "7" }, { status: "dead", n: "1" }];
  const stats = await outboxStatsAsync({ ...PG, exec });
  assert.deepEqual(stats, { pending: 3, sending: 0, sent: 7, failed: 0, dead: 1, total: 11 });
});

test("outboxCapacityAlertAsync：門檻與訊息與同步版同義", async () => {
  const exec = async () => [{ status: "pending", n: "40" }, { status: "failed", n: "11" }];
  const alert = await outboxCapacityAlertAsync({}, { ...PG, exec });
  assert.equal(alert.backlog, 51);
  assert.equal(alert.warn, true, "backlog 51 ≥ 50 ⇒ 警示");
  assert.match(alert.message, /堆積 51 筆/);
  assert.equal(alert.backlog_warn, 50);
  assert.equal(alert.dead_warn, 10);
  const calm = await outboxCapacityAlertAsync({}, { ...PG, exec: async () => [{ status: "pending", n: "1" }] });
  assert.equal(calm.warn, false);
  assert.equal(calm.message, "");
});

test("compactSentOutboxPayloadsAsync：只精簡舊的 sent／dead，保留 sha256", async () => {
  const updates = [];
  const exec = async (sql, params = []) => {
    if (/SELECT id, payload, feedback_id/.test(String(sql))) {
      return [{ id: 3, payload: '{"a":1}', feedback_id: 11 }, { id: 4, payload: '{"b":2}', feedback_id: 12 }];
    }
    updates.push(params);
    return [];
  };
  const out = await compactSentOutboxPayloadsAsync({ olderThanMs: 1000, now: NOW, limit: 10 }, { ...PG, exec });
  assert.deepEqual(out, { compacted: 2, scanned: 2 });
  assert.equal(updates.length, 2);
  const slim = JSON.parse(updates[0][0]);
  assert.equal(slim.compacted, true);
  assert.equal(slim.feedback_id, 11);
  assert.match(slim.payload_sha256, /^[0-9a-f]{64}$/, "要保留 sha256 以便追查");
  assert.ok(!("a" in slim), "原始 payload 不得留在精簡後的內容裡");
});

// 4. worker 政策跑在 PG store 上（用一個小型 PG 模擬器）

// 只實作本模組用到的那幾句語言的「PG 模擬器」：足以驗 worker 的政策（不是驗 SQL 引擎）。
function pgOutboxSim(rows, { stopped = false } = {}) {
  const state = rows.map((row) => ({ ...row }));
  const calls = [];
  const exec = async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, " ").trim();
    calls.push(call(text, params));
    if (/SELECT value FROM settings WHERE key/.test(text)) return stopped ? [{ value: "1" }] : [];
    // 單句原子認領：UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING *
    if (/SET status = 'sending'/.test(text)) {
      const [nowIso, staleIso, limit] = params;
      const taken = state.filter((row) => (
        (["pending", "failed"].includes(row.status) && row.next_attempt_at <= nowIso)
        || (row.status === "sending" && (!row.claimed_at || row.claimed_at <= staleIso))
      )).sort((a, b) => a.id - b.id).slice(0, limit);
      for (const row of taken) { row.status = "sending"; row.claimed_at = nowIso; }
      return taken.map((row) => ({ ...row }));
    }
    if (/SET status='sent'/.test(text)) {
      const [ts, id] = params;
      const row = state.find((r) => r.id === Number(id));
      if (row) { row.status = "sent"; row.sent_at = ts; row.last_error = null; }
      return [];
    }
    if (/SET status='dead'/.test(text)) {
      const [attempts, err, id] = params;
      const row = state.find((r) => r.id === Number(id));
      if (row) { row.status = "dead"; row.attempts = attempts; row.last_error = err; }
      return [];
    }
    if (/SET status='failed'/.test(text)) {
      const [attempts, next, err, id] = params;
      const row = state.find((r) => r.id === Number(id));
      if (row) { row.status = "failed"; row.attempts = attempts; row.next_attempt_at = next; row.last_error = err; }
      return [];
    }
    if (/SELECT status, COUNT/.test(text)) {
      const groups = new Map();
      for (const row of state) groups.set(row.status, (groups.get(row.status) || 0) + 1);
      return [...groups].map(([status, n]) => ({ status, n: String(n) }));
    }
    return [];
  };
  return { exec, state, calls };
}

const okFetch = (status = 200) => async () => ({ status, ok: status >= 200 && status < 300 });

test("worker（PG store）：認領 → 送出 → 標記 sent；Ops 500 ⇒ failed 並排下次重試", async () => {
  const sim = pgOutboxSim([
    { id: 1, delivery_id: "d1", status: "pending", attempts: 0, max_attempts: 5, next_attempt_at: "2026-09-28T00:00:00.000Z", payload: '{"delivery_id":"d1"}', claimed_at: null, feedback_id: 1 },
    { id: 2, delivery_id: "d2", status: "pending", attempts: 0, max_attempts: 5, next_attempt_at: "2026-09-28T00:00:00.000Z", payload: '{"delivery_id":"d2"}', claimed_at: null, feedback_id: 2 },
  ]);
  const store = feedbackOutboxStoreAsync({ driver: "postgres", exec: sim.exec, strict: true });
  const summary = await deliverWithStore(store, {
    url: "https://ops.example.test/ops/api/ingest/feedback",
    secret: "s3cret",
    now: () => NOW,
    fetchImpl: okFetch(200),
    batchSize: 10,
    concurrency: 2,
  });
  assert.deepEqual(summary, { claimed: 2, sent: 2, failed: 0, dead: 0 }, "兩筆都要送出");
  assert.deepEqual(sim.state.map((r) => r.status), ["sent", "sent"], "PG 那一份要被標成 sent");

  // Ops 500：failed（可重試）而不是 dead
  const sim2 = pgOutboxSim([
    { id: 5, delivery_id: "d5", status: "pending", attempts: 0, max_attempts: 5, next_attempt_at: "2026-09-28T00:00:00.000Z", payload: '{"delivery_id":"d5"}', claimed_at: null, feedback_id: 5 },
  ]);
  const store2 = feedbackOutboxStoreAsync({ driver: "postgres", exec: sim2.exec, strict: true });
  const failed = await deliverWithStore(store2, {
    url: "https://ops.example.test/x", secret: "s", now: () => NOW, fetchImpl: okFetch(500), batchSize: 5,
  });
  assert.deepEqual(failed, { claimed: 1, sent: 0, failed: 1, dead: 0 });
  assert.equal(sim2.state[0].status, "failed");
  assert.equal(sim2.state[0].attempts, 1);
  assert.ok(sim2.state[0].next_attempt_at > NOW.toISOString(), "要有下次重試時間");
});

test("worker（PG store）：本地停止鍵為 '1' 時完全不出手（也不發 HTTP）", async () => {
  const sim = pgOutboxSim([
    { id: 1, delivery_id: "d1", status: "pending", attempts: 0, max_attempts: 5, next_attempt_at: "2026-09-28T00:00:00.000Z", payload: "{}", claimed_at: null, feedback_id: 1 },
  ], { stopped: true });
  const store = feedbackOutboxStoreAsync({ driver: "postgres", exec: sim.exec, strict: true });
  let delivered = 0;
  const summary = await deliverWithStore(store, {
    url: "https://ops.example.test/x", secret: "s", now: () => NOW, batchSize: 5,
    fetchImpl: async () => { delivered += 1; return { status: 200 }; },
  });
  assert.deepEqual(summary, { claimed: 0, sent: 0, failed: 0, dead: 0, skipped: "local_stopped" },
    "停止鍵為 '1' ⇒ 明確回 skipped，不認領");
  assert.equal(delivered, 0, "不得發出任何請求");
  assert.equal(sim.state[0].status, "pending", "PG 的列不得被動到");
  // 對照：停止鍵是 JSON 化的 '"1"' 時**不會**被當成停止（那個坑會讓開關失效），
  // 這時才會認領（`isLocalDeliveryStoppedAsync` 的測試已單獨釘住 raw-vs-JSON）。
  const jsonSim = pgOutboxSim([
    { id: 1, delivery_id: "d1", status: "pending", attempts: 0, max_attempts: 5, next_attempt_at: "2026-09-28T00:00:00.000Z", payload: "{}", claimed_at: null, feedback_id: 1 },
  ]);
  const jsonStore = feedbackOutboxStoreAsync({ driver: "postgres", exec: jsonSim.exec, strict: true });
  const ok = await deliverWithStore(jsonStore, {
    url: "https://ops.example.test/x", secret: "s", now: () => NOW, batchSize: 5, fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(ok.claimed, 1, "沒有停止鍵時正常認領");
});

// 5. 設定鍵：原生字串（JSON 語意會讓開关永遠失效）

test("isLocalDeliveryStoppedAsync：只有原始字串 '1' 算停止（JSON 的 \"1\" 不算）", async () => {
  const raw = async () => [{ value: "1" }];
  assert.equal(await isLocalDeliveryStoppedAsync({ ...PG, exec: raw }), true);
  const json = async () => [{ value: '"1"' }]; // settingsKvAsync 會寫成的樣子
  assert.equal(await isLocalDeliveryStoppedAsync({ ...PG, exec: json }), false,
    "JSON 化的值不算停止——這正是「開關永遠失效且沒有錯誤」的那個坑");
  const zero = async () => [{ value: "0" }];
  assert.equal(await isLocalDeliveryStoppedAsync({ ...PG, exec: zero }), false);
  const missing = async () => [];
  assert.equal(await isLocalDeliveryStoppedAsync({ ...PG, exec: missing }), false);
});

test("setLocalDeliveryStoppedAsync：UPSERT 原始字串（不是 JSON）＋本機鏡射", async () => {
  const calls = [];
  const exec = async (sql, params = []) => { calls.push(call(sql, params)); return []; };
  assert.equal(await setLocalDeliveryStoppedAsync(true, { ...PG, exec }), true);
  assert.match(calls[0].sql, /INSERT INTO settings\(key, value\) VALUES \(\?, \?\) ON CONFLICT\(key\) DO UPDATE/);
  assert.deepEqual(calls[0].params, ["ops_feedback_stop", "1"], "必須是原始字串 '1'");
  calls.length = 0;
  await setLocalDeliveryStoppedAsync(false, { ...PG, exec });
  assert.deepEqual(calls[0].params, ["ops_feedback_stop", "0"]);
  assert.equal(STOP_UPSERT_SQL.includes("excluded.value"), true);
});

test("deliveryControlAsync：欄位與同步版逐欄對應（env_allowed／configured／local_stopped／effective）", async () => {
  const exec = async (sql) => (/SELECT value FROM settings/.test(String(sql)) ? [{ value: "1" }] : [{ status: "pending", n: "2" }]);
  const env = { OPS_INGEST_URL: "https://ops.example.test/x", OPS_INGEST_SECRET: "s", OPS_FEEDBACK_DELIVERY: "1", OPS_PRODUCT_ID: "v3" };
  const control = await deliveryControlAsync({ ...PG, exec }, env);
  assert.equal(control.env_allowed, true);
  assert.equal(control.configured, true);
  assert.equal(control.local_stopped, true);
  assert.equal(control.effective, false, "本地停止 ⇒ 不生效");
  assert.equal(control.product_id, "v3");
  assert.equal(control.outbox.pending, 2);
  assert.equal(control.outbox.total, 2);
  const noEnv = await deliveryControlAsync({ ...PG, exec: async () => [] }, {});
  assert.equal(noEnv.effective, false);
  assert.equal(noEnv.configured, false);
});

test("非 postgres：所有入口都走同步版（不碰傳入的 exec）", async () => {
  let calls = 0;
  const boom = async () => { calls += 1; throw new Error("exec 不該被呼叫（sqlite 模式）"); };
  const sqlite = { driver: "sqlite", exec: boom };
  assert.equal(await isLocalDeliveryStoppedAsync(sqlite), false);
  assert.equal(await setLocalDeliveryStoppedAsync(true, sqlite), true);
  const control = await deliveryControlAsync(sqlite, {});
  assert.equal(control.product_id, "v3");
  assert.equal(calls, 0, "sqlite 模式不得呼叫 PG runner");
  await setLocalDeliveryStoppedAsync(false, sqlite); // 還原
});
