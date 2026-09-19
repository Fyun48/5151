import { randomUUID } from "node:crypto";

// 可選 CRM 同步 outbox。本機寫入成功不依賴這張表；沒建表也不擋 CRM。
export const CRM_OUTBOX_MAX_ATTEMPTS = 8;
export const CRM_OUTBOX_STALE_MS = 2 * 60 * 1000;

export function ensureCrmOutboxSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS crm_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      contact_id INTEGER NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT ${CRM_OUTBOX_MAX_ATTEMPTS},
      next_attempt_at TEXT NOT NULL,
      claimed_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      sent_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_crm_outbox_status ON crm_outbox(status, next_attempt_at);
  `);
}

function iso(now) {
  return (now instanceof Date ? now : new Date(now || Date.now())).toISOString();
}

export function enqueueCrmOutbox(db, { contactId, data = {}, now = new Date() } = {}) {
  if (!contactId) return null;
  try { ensureCrmOutboxSchema(db); } catch { return null; }
  const deliveryId = randomUUID();
  const stamp = iso(now);
  const idem = `crm:${contactId}:${stamp}:${deliveryId.slice(0, 8)}`;
  const payload = JSON.stringify({
    delivery_id: deliveryId,
    idempotency_key: idem,
    source: "v3",
    external_contact_id: Number(contactId),
    snapshot: data,
    synced_at: stamp,
  });
  db.prepare(`
    INSERT INTO crm_outbox(delivery_id, idempotency_key, contact_id, payload, status, attempts, max_attempts, next_attempt_at, created_at)
    VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)
  `).run(deliveryId, idem, Number(contactId), payload, CRM_OUTBOX_MAX_ATTEMPTS, stamp, stamp);
  return { deliveryId, idempotencyKey: idem };
}

export function claimCrmOutboxBatch(db, { limit = 20, now = new Date(), staleMs = CRM_OUTBOX_STALE_MS } = {}) {
  const nowIso = iso(now);
  const staleBefore = iso(new Date((now instanceof Date ? now.getTime() : now) - staleMs));
  const candidates = db.prepare(`
    SELECT * FROM crm_outbox
     WHERE (status IN ('pending','failed') AND next_attempt_at <= ?)
        OR (status = 'sending' AND (claimed_at IS NULL OR claimed_at <= ?))
     ORDER BY id ASC LIMIT ?
  `).all(nowIso, staleBefore, Math.max(1, Math.min(Number(limit) || 20, 200)));
  const claimed = [];
  for (const row of candidates) {
    const res = row.status === "sending"
      ? db.prepare("UPDATE crm_outbox SET claimed_at=? WHERE id=? AND status='sending' AND (claimed_at IS NULL OR claimed_at <= ?)")
        .run(nowIso, row.id, staleBefore)
      : db.prepare("UPDATE crm_outbox SET status='sending', claimed_at=? WHERE id=? AND status=?")
        .run(nowIso, row.id, row.status);
    if (res.changes === 1) claimed.push({ ...row, status: "sending", claimed_at: nowIso });
  }
  return claimed;
}

export function markCrmOutboxSent(db, id, { now = new Date() } = {}) {
  db.prepare("UPDATE crm_outbox SET status='sent', sent_at=?, last_error=NULL WHERE id=?").run(iso(now), id);
}

export function markCrmOutboxFailure(db, row, errText, { now = new Date() } = {}) {
  const attempts = Number(row.attempts) + 1;
  const max = Number(row.max_attempts) || CRM_OUTBOX_MAX_ATTEMPTS;
  const err = String(errText || "").slice(0, 500);
  if (attempts >= max) {
    db.prepare("UPDATE crm_outbox SET status='dead', attempts=?, last_error=? WHERE id=?").run(attempts, err, row.id);
    return { status: "dead", attempts };
  }
  const next = iso(new Date((now instanceof Date ? now.getTime() : now) + Math.min(1000 * 2 ** (attempts - 1), 3600000)));
  db.prepare("UPDATE crm_outbox SET status='failed', attempts=?, next_attempt_at=?, last_error=? WHERE id=?")
    .run(attempts, next, err, row.id);
  return { status: "failed", attempts };
}

export function crmOutboxStats(db) {
  try {
    const rows = db.prepare("SELECT status, COUNT(*) n FROM crm_outbox GROUP BY status").all();
    const out = { pending: 0, sending: 0, sent: 0, failed: 0, dead: 0, total: 0 };
    for (const row of rows) {
      out[row.status] = Number(row.n) || 0;
      out.total += Number(row.n) || 0;
    }
    return out;
  } catch {
    return { pending: 0, sending: 0, sent: 0, failed: 0, dead: 0, total: 0 };
  }
}
