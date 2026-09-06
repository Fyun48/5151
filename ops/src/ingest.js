import { withImmediateTx } from "./tx.js";
import { appendAuditRow } from "./audit.js";
import { httpError } from "./errors.js";

// Ops ingest：儲存從 Product 遞送進來的 feedback，並以 delivery_id / idempotency_key 冪等去重。
// 只儲存與傳輸；不執行任何 feedback 內容。trust_level 一律 untrusted。

const MAX_CONTENT = 20000;

function clip(v, n) {
  if (v == null) return null;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) : s;
}

// payload：已解析的物件（含 delivery_id / idempotency_key 與 feedback 欄位）。
export function ingestFeedback(db, { deliveryId, payload, payloadHash, now = new Date() }) {
  const idempotencyKey = String(payload?.idempotency_key || "").trim();
  if (!deliveryId) throw httpError("missing delivery_id", 400);
  if (!idempotencyKey) throw httpError("missing idempotency_key", 400);
  const ts = (now instanceof Date ? now : new Date(now)).toISOString();

  return withImmediateTx(db, () => {
    const existing = db.prepare(
      "SELECT id FROM ingested_feedback WHERE delivery_id = ? OR idempotency_key = ?",
    ).get(deliveryId, idempotencyKey);
    if (existing) return { id: Number(existing.id), duplicate: true };

    try {
      const res = db.prepare(
        `INSERT INTO ingested_feedback
           (delivery_id, idempotency_key, source, external_feedback_id, user_ref, kind, content, contact, context, app_version, submitted_at, trust_level, payload_hash, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'untrusted', ?, ?)`,
      ).run(
        deliveryId,
        idempotencyKey,
        clip(payload.source, 64) || "unknown",
        clip(payload.external_feedback_id, 128),
        clip(payload.user_ref, 128),
        clip(payload.kind, 64),
        clip(payload.content, MAX_CONTENT),
        clip(payload.contact, 200),
        clip(payload.context, 8000),
        clip(payload.app_version, 64),
        clip(payload.submitted_at, 64),
        payloadHash || null,
        ts,
      );
      const id = Number(res.lastInsertRowid);
      appendAuditRow(db, {
        actor: "ingest",
        action: "feedback.ingested",
        entityType: "ingested_feedback",
        entityId: String(id),
        // 稽核只記中繼資料，不記完整內容（避免落地大量未信任文字）。
        data: { delivery_id: deliveryId, source: payload.source || "unknown", kind: payload.kind || null, external_feedback_id: payload.external_feedback_id ?? null },
        now,
      });
      return { id, duplicate: false };
    } catch (err) {
      // 併發下另一寫入者先插入（UNIQUE 撞號）→ 視為冪等重複。
      const row = db.prepare(
        "SELECT id FROM ingested_feedback WHERE delivery_id = ? OR idempotency_key = ?",
      ).get(deliveryId, idempotencyKey);
      if (row) return { id: Number(row.id), duplicate: true };
      throw err;
    }
  });
}

export function listIngested(db, { limit = 100 } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 100, 500));
  return db.prepare("SELECT * FROM ingested_feedback ORDER BY id DESC LIMIT ?").all(cap);
}

export function countIngested(db) {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM ingested_feedback").get().n) || 0;
}
