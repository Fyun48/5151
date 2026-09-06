import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureFeedbackSchema, createFeedbackWithOutbox } from "../src/feedback.js";
import {
  ensureFeedbackOutboxSchema,
  listOutbox,
  outboxStats,
  claimOutboxBatch,
  backoffMs,
  OUTBOX_DEFAULT_MAX_ATTEMPTS,
} from "../src/feedbackOutbox.js";
import { deliverOutboxOnce } from "../src/opsDelivery.js";

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA busy_timeout = 5000");
  ensureFeedbackSchema(db);
  ensureFeedbackOutboxSchema(db);
  return db;
}

const okFetch = async () => ({ status: 200 });
const downFetch = async () => { throw new Error("ECONNREFUSED"); };
const timeoutFetch = async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; };
const cfg = { url: "http://ops.local/ops/api/ingest/feedback", secret: "s", fetchImpl: null, random: () => 0.5 };

test("createFeedbackWithOutbox writes feedback AND one outbox row atomically (IFF)", () => {
  const db = open();
  const res = createFeedbackWithOutbox(db, 7, { kind: "bug", body: "手機篩選鈕蓋到標題" });
  assert.ok(res.id > 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM feedback").get().n, 1);
  const outbox = listOutbox(db);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].feedback_id, res.id);
  assert.equal(outbox[0].status, "pending");
  const payload = JSON.parse(outbox[0].payload);
  assert.equal(payload.delivery_id, outbox[0].delivery_id);
  assert.equal(payload.idempotency_key, `feedback:${res.id}`);
  assert.equal(payload.content, "手機篩選鈕蓋到標題");
  assert.equal(payload.trust_level, "untrusted");
  db.close();
});

test("transaction rolls back together when outbox insert fails (no orphan feedback)", () => {
  const db = open();
  const failing = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql) => {
          if (/INSERT\s+INTO\s+feedback_outbox/i.test(sql)) {
            return { run: () => { throw new Error("boom outbox"); } };
          }
          return target.prepare(sql);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  assert.throws(() => createFeedbackWithOutbox(failing, 1, { kind: "idea", body: "some idea here" }), /boom outbox/);
  // 兩者皆未寫入
  assert.equal(db.prepare("SELECT COUNT(*) n FROM feedback").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM feedback_outbox").get().n, 0);
  db.close();
});

test("honeypot creates neither feedback nor outbox", () => {
  const db = open();
  const res = createFeedbackWithOutbox(db, 1, { kind: "bug", body: "spam", website: "http://spam" });
  assert.equal(res.id, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM feedback").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM feedback_outbox").get().n, 0);
  db.close();
});

test("worker delivers pending item and marks it sent", async () => {
  const db = open();
  createFeedbackWithOutbox(db, 1, { kind: "bug", body: "please deliver me" });
  const summary = await deliverOutboxOnce(db, { ...cfg, fetchImpl: okFetch });
  assert.equal(summary.claimed, 1);
  assert.equal(summary.sent, 1);
  assert.equal(outboxStats(db).sent, 1);
  assert.equal(outboxStats(db).pending, 0);
  db.close();
});

test("Ops unavailable: product write already succeeded; worker marks retryable", async () => {
  const db = open();
  const res = createFeedbackWithOutbox(db, 1, { kind: "bug", body: "ops is down now" });
  assert.ok(res.id > 0); // 使用者送出已成功（不依賴 Ops）
  const summary = await deliverOutboxOnce(db, { ...cfg, fetchImpl: downFetch });
  assert.equal(summary.failed, 1);
  const row = listOutbox(db)[0];
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 1);
  assert.ok(row.next_attempt_at); // 排定稍後重試
  db.close();
});

test("Ops timeout is treated as retryable", async () => {
  const db = open();
  createFeedbackWithOutbox(db, 1, { kind: "bug", body: "ops times out" });
  const summary = await deliverOutboxOnce(db, { ...cfg, fetchImpl: timeoutFetch });
  assert.equal(summary.failed, 1);
  assert.equal(listOutbox(db)[0].status, "failed");
  db.close();
});

test("retry later then Ops recovers → delivered", async () => {
  const db = open();
  createFeedbackWithOutbox(db, 1, { kind: "bug", body: "will recover" });
  await deliverOutboxOnce(db, { ...cfg, fetchImpl: downFetch }); // fail once
  // 把 next_attempt_at 拉到過去，模擬時間到了可重試
  db.prepare("UPDATE feedback_outbox SET next_attempt_at = '2000-01-01T00:00:00.000Z'").run();
  const summary = await deliverOutboxOnce(db, { ...cfg, fetchImpl: okFetch });
  assert.equal(summary.sent, 1);
  assert.equal(outboxStats(db).sent, 1);
  db.close();
});

test("max_attempts reached → dead-letter", async () => {
  const db = open();
  createFeedbackWithOutbox(db, 1, { kind: "bug", body: "permanently failing" });
  // 直接把 attempts 設到上限前一次，next_attempt_at 過去
  db.prepare("UPDATE feedback_outbox SET attempts=?, next_attempt_at='2000-01-01T00:00:00.000Z', status='failed'")
    .run(OUTBOX_DEFAULT_MAX_ATTEMPTS - 1);
  const summary = await deliverOutboxOnce(db, { ...cfg, fetchImpl: downFetch });
  assert.equal(summary.dead, 1);
  assert.equal(outboxStats(db).dead, 1);
  db.close();
});

test("claim marks item 'sending' and won't be re-claimed while fresh", () => {
  const db = open();
  createFeedbackWithOutbox(db, 1, { kind: "bug", body: "claim me once" });
  const first = claimOutboxBatch(db, {});
  assert.equal(first.length, 1);
  assert.equal(db.prepare("SELECT status FROM feedback_outbox WHERE id=?").get(first[0].id).status, "sending");
  const second = claimOutboxBatch(db, {}); // 仍在處理中且未 stale → 不應被重複認領
  assert.equal(second.length, 0);
  db.close();
});

test("worker restart resumes: stale 'sending' items are reclaimed", () => {
  const db = open();
  createFeedbackWithOutbox(db, 1, { kind: "bug", body: "stuck in sending" });
  const id = listOutbox(db)[0].id;
  // 模擬 crash：卡在 sending 且 claimed_at 很久以前
  db.prepare("UPDATE feedback_outbox SET status='sending', claimed_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(id);
  const reclaimed = claimOutboxBatch(db, {});
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0].id, id);
  db.close();
});

test("backoff grows and is bounded", () => {
  const fixed = { random: () => 1 };
  const a1 = backoffMs(1, fixed);
  const a3 = backoffMs(3, fixed);
  assert.ok(a3 > a1);
  assert.ok(backoffMs(50, fixed) <= 60 * 60 * 1000);
});

test("delivery skips cleanly when not configured", async () => {
  const db = open();
  createFeedbackWithOutbox(db, 1, { kind: "bug", body: "no transport configured" });
  const summary = await deliverOutboxOnce(db, { url: "", secret: "", fetchImpl: okFetch });
  assert.equal(summary.skipped, "not_configured");
  assert.equal(outboxStats(db).pending, 1); // 仍保留，未遺失
  db.close();
});
