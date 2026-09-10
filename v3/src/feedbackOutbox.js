import { randomUUID, createHash } from "node:crypto";

// Transactional Outbox（Product 端）。
// 不變式：一筆 feedback 必定對應一筆初始 outbox 事件（在同一個 DB 交易內建立）。
// 本模組只負責 outbox 的資料與狀態機；實際遞送在 opsDelivery.js。
//
// 狀態機（明確、決定性）：
//   pending  → sending → sent
//   pending  → sending → failed → (backoff) → sending → ...
//   failed(attempts>=max) → dead
//   sending(過期未 ack，視為 crash) → 由 claim 重新認領（at-least-once）
//
// 交付語義：at-least-once。Ops 端以 delivery_id 做冪等去重，達成「最終剛好一筆」。

export const OUTBOX_DEFAULT_MAX_ATTEMPTS = 8;
export const OUTBOX_CLAIM_STALE_MS = 2 * 60 * 1000; // 'sending' 超過 2 分鐘視為 stale，可重新認領
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 60 * 60 * 1000; // 1h

export function ensureFeedbackOutboxSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      feedback_id INTEGER NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT ${OUTBOX_DEFAULT_MAX_ATTEMPTS},
      next_attempt_at TEXT NOT NULL,
      claimed_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      sent_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_outbox_status ON feedback_outbox(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_feedback_outbox_feedback ON feedback_outbox(feedback_id);
  `);
}

function iso(now) {
  return (now instanceof Date ? now : new Date(now || Date.now())).toISOString();
}

// 建立初始 outbox 事件（不自帶交易；必須由 createFeedbackWithOutbox 的交易包住）。
export function enqueueFeedbackOutbox(db, { feedbackId, data = {}, idempotencyKey = null, maxAttempts = OUTBOX_DEFAULT_MAX_ATTEMPTS, now = new Date() }) {
  if (!feedbackId) throw new Error("enqueueFeedbackOutbox requires feedbackId");
  const deliveryId = randomUUID();
  const idem = idempotencyKey || `feedback:${feedbackId}`;
  const payloadObj = { delivery_id: deliveryId, idempotency_key: idem, ...data };
  const payload = JSON.stringify(payloadObj);
  const ts = iso(now);
  db.prepare(
    `INSERT INTO feedback_outbox(delivery_id, idempotency_key, feedback_id, payload, status, attempts, max_attempts, next_attempt_at, created_at)
     VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
  ).run(deliveryId, idem, feedbackId, payload, maxAttempts, ts, ts);
  return { deliveryId, idempotencyKey: idem, payload };
}

export function backoffMs(attempts, { base = BACKOFF_BASE_MS, cap = BACKOFF_CAP_MS, random = Math.random } = {}) {
  const raw = Math.min(base * 2 ** Math.max(0, attempts - 1), cap);
  // full jitter：0.5x ~ 1.0x，避免同時重試造成尖峰
  const jittered = raw * (0.5 + 0.5 * random());
  return Math.round(jittered);
}

// 認領一批可遞送項目，並以 UPDATE ... WHERE status=? 原子標記為 'sending'（避免重複認領）。
// 涵蓋 crash 復原：'sending' 但 claimed_at 過期者也可重新認領。
export function claimOutboxBatch(db, { limit = 20, now = new Date(), staleMs = OUTBOX_CLAIM_STALE_MS } = {}) {
  const nowIso = iso(now);
  const staleBefore = iso(new Date((now instanceof Date ? now.getTime() : now) - staleMs));
  const candidates = db.prepare(
    `SELECT * FROM feedback_outbox
     WHERE (status IN ('pending','failed') AND next_attempt_at <= ?)
        OR (status = 'sending' AND (claimed_at IS NULL OR claimed_at <= ?))
     ORDER BY id ASC
     LIMIT ?`,
  ).all(nowIso, staleBefore, Math.max(1, Math.min(Number(limit) || 20, 200)));

  const claimed = [];
  for (const row of candidates) {
    let res;
    if (row.status === "sending") {
      // 只重新認領 stale 的 sending（crash 復原）
      res = db.prepare(
        "UPDATE feedback_outbox SET claimed_at=? WHERE id=? AND status='sending' AND (claimed_at IS NULL OR claimed_at <= ?)",
      ).run(nowIso, row.id, staleBefore);
    } else {
      // pending / failed → sending，以 status 條件確保原子認領（兩個 worker 只有一個成功）
      res = db.prepare(
        "UPDATE feedback_outbox SET status='sending', claimed_at=? WHERE id=? AND status=?",
      ).run(nowIso, row.id, row.status);
    }
    if (res.changes === 1) {
      claimed.push({ ...row, status: "sending", claimed_at: nowIso });
    }
  }
  return claimed;
}

export function markOutboxSent(db, id, { now = new Date() } = {}) {
  const ts = iso(now);
  db.prepare("UPDATE feedback_outbox SET status='sent', sent_at=?, last_error=NULL WHERE id=?").run(ts, id);
}

// 遞送失敗：attempts+1；達上限 → dead，否則 failed 並排下次重試（backoff+jitter）。
export function markOutboxFailure(db, row, errText, { now = new Date(), random = Math.random } = {}) {
  const attempts = Number(row.attempts) + 1;
  const max = Number(row.max_attempts) || OUTBOX_DEFAULT_MAX_ATTEMPTS;
  const err = String(errText || "").slice(0, 500);
  if (attempts >= max) {
    db.prepare("UPDATE feedback_outbox SET status='dead', attempts=?, last_error=? WHERE id=?").run(attempts, err, row.id);
    return { status: "dead", attempts };
  }
  const nowMs = now instanceof Date ? now.getTime() : now;
  const next = iso(new Date(nowMs + backoffMs(attempts, { random })));
  db.prepare("UPDATE feedback_outbox SET status='failed', attempts=?, next_attempt_at=?, last_error=? WHERE id=?")
    .run(attempts, next, err, row.id);
  return { status: "failed", attempts, next_attempt_at: next };
}

export function getOutboxById(db, id) {
  return db.prepare("SELECT * FROM feedback_outbox WHERE id=?").get(id) || null;
}

export function listOutbox(db, { status = null, limit = 100 } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 100, 500));
  if (status) return db.prepare("SELECT * FROM feedback_outbox WHERE status=? ORDER BY id DESC LIMIT ?").all(status, cap);
  return db.prepare("SELECT * FROM feedback_outbox ORDER BY id DESC LIMIT ?").all(cap);
}

export function outboxStats(db) {
  const out = { pending: 0, sending: 0, sent: 0, failed: 0, dead: 0, total: 0 };
  for (const r of db.prepare("SELECT status, COUNT(*) n FROM feedback_outbox GROUP BY status").all()) {
    out[r.status] = Number(r.n) || 0;
    out.total += Number(r.n) || 0;
  }
  return out;
}

export const OUTBOX_BACKLOG_WARN = 50;
export const OUTBOX_DEAD_WARN = 10;
export const OUTBOX_COMPACT_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export function outboxCapacityAlert(db, { backlogWarn = OUTBOX_BACKLOG_WARN, deadWarn = OUTBOX_DEAD_WARN } = {}) {
  const stats = outboxStats(db);
  const backlog = (stats.pending || 0) + (stats.failed || 0) + (stats.sending || 0);
  const warn = backlog >= backlogWarn || (stats.dead || 0) >= deadWarn;
  return {
    ...stats,
    backlog,
    warn,
    backlog_warn: backlogWarn,
    dead_warn: deadWarn,
    message: warn
      ? `傳輸佇列堆積 ${backlog} 筆、dead ${stats.dead || 0} 筆。回饋主本仍在本機；可精簡已送出的傳輸複本。`
      : "",
  };
}

export function compactSentOutboxPayloads(db, { olderThanMs = OUTBOX_COMPACT_AFTER_MS, now = new Date(), limit = 500 } = {}) {
  const cutoff = iso(new Date((now instanceof Date ? now.getTime() : now) - olderThanMs));
  const rows = db.prepare(`
    SELECT id, payload, feedback_id FROM feedback_outbox
     WHERE status IN ('sent','dead')
       AND created_at <= ?
       AND payload NOT LIKE '{"compacted":true%'
     ORDER BY id ASC
     LIMIT ?
  `).all(cutoff, Math.max(1, Math.min(Number(limit) || 500, 2000)));
  let compacted = 0;
  for (const row of rows) {
    const slim = JSON.stringify({
      compacted: true,
      feedback_id: row.feedback_id,
      payload_sha256: payloadHashHex(row.payload),
    });
    db.prepare("UPDATE feedback_outbox SET payload=? WHERE id=?").run(slim, row.id);
    compacted += 1;
  }
  return { compacted, scanned: rows.length };
}

export function payloadHashHex(payload) {
  return createHash("sha256").update(Buffer.from(String(payload), "utf8")).digest("hex");
}
