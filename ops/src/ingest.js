import { withImmediateTx } from "./tx.js";
import { appendAuditRow } from "./audit.js";
import { httpError } from "./errors.js";
import { enqueueAnalysisRow } from "./feedbackAnalysis.js";
import { DEFAULT_PRODUCT_ID } from "./products.js";

// Ops ingest：儲存從 Product 遞送進來的 feedback，並以 delivery_id / idempotency_key 冪等去重。
// 只儲存與傳輸；不執行任何 feedback 內容。trust_level 一律 untrusted。

const MAX_CONTENT = 20000;

function clip(v, n) {
  if (v == null) return null;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) : s;
}

// 判斷既有紀錄與本次遞送是否為「相同邏輯 payload」。
// 冪等成立條件：delivery_id 與 idempotency_key 對應到同一列，且 payload_hash 相同。
// 否則視為衝突（delivery_id 或 idempotency_key 被重用於不同內容）。
function classifyExisting({ byDelivery, byIdem, deliveryId, idempotencyKey, payloadHash }) {
  if (byDelivery) {
    const sameLogical =
      byDelivery.idempotency_key === idempotencyKey &&
      String(byDelivery.payload_hash || "") === String(payloadHash || "");
    if (sameLogical) return { kind: "duplicate", id: Number(byDelivery.id) };
    return { kind: "conflict", reason: "delivery_conflict", id: Number(byDelivery.id) };
  }
  if (byIdem) {
    // delivery_id 是新的，但 idempotency_key 已被用過。正常運作下一個 idempotency_key
    // 只會對應唯一的 delivery_id；出現不同 delivery_id 即視為衝突（不覆寫原紀錄）。
    return { kind: "conflict", reason: "idempotency_conflict", id: Number(byIdem.id) };
  }
  return null;
}

// payload：已解析的物件（含 delivery_id / idempotency_key 與 feedback 欄位）。
// 回傳：{duplicate:false,id} | {duplicate:true,id} | {conflict:true,reason,id}
export function ingestFeedback(db, { deliveryId, payload, payloadHash, productId = DEFAULT_PRODUCT_ID, now = new Date() }) {
  const idempotencyKey = String(payload?.idempotency_key || "").trim();
  if (!deliveryId) throw httpError("missing delivery_id", 400);
  if (!idempotencyKey) throw httpError("missing idempotency_key", 400);
  const pid = String(productId || DEFAULT_PRODUCT_ID);
  const ts = (now instanceof Date ? now : new Date(now)).toISOString();

  const conflictAudit = (verdict) => {
    // 只記中繼資料與 hash（非機密），絕不覆寫原始紀錄。
    appendAuditRow(db, {
      actor: "ingest",
      action: "feedback.ingest.conflict",
      entityType: "ingested_feedback",
      entityId: String(verdict.id),
      data: { product_id: pid, delivery_id: deliveryId, reason: verdict.reason, incoming_payload_hash: payloadHash || null },
      now,
    });
  };

  return withImmediateTx(db, () => {
    const lookup = () => ({
      byDelivery: db.prepare("SELECT * FROM ingested_feedback WHERE product_id = ? AND delivery_id = ?").get(pid, deliveryId),
      byIdem: db.prepare("SELECT * FROM ingested_feedback WHERE product_id = ? AND idempotency_key = ?").get(pid, idempotencyKey),
    });

    let { byDelivery, byIdem } = lookup();
    let verdict = classifyExisting({ byDelivery, byIdem, deliveryId, idempotencyKey, payloadHash });
    if (verdict) {
      if (verdict.kind === "conflict") {
        conflictAudit(verdict);
        return { conflict: true, reason: verdict.reason, id: verdict.id };
      }
      return { duplicate: true, id: verdict.id };
    }

    try {
      const res = db.prepare(
        `INSERT INTO ingested_feedback
           (product_id, delivery_id, idempotency_key, source, external_feedback_id, user_ref, kind, content, contact, context, app_version, submitted_at, trust_level, payload_hash, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'untrusted', ?, ?)`,
      ).run(
        pid,
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
        data: { product_id: pid, delivery_id: deliveryId, source: payload.source || "unknown", kind: payload.kind || null, external_feedback_id: payload.external_feedback_id ?? null },
        now,
      });
      // Phase 4：新 feedback 入庫的同一交易內，排入一筆待 AI 分析 job（不依賴 AI 可用性）。
      enqueueAnalysisRow(db, { feedbackId: id, now });
      return { id, duplicate: false };
    } catch (err) {
      // 併發下另一寫入者先插入（UNIQUE 撞號）→ 重新分類：相同邏輯=冪等；否則=衝突。
      ({ byDelivery, byIdem } = lookup());
      verdict = classifyExisting({ byDelivery, byIdem, deliveryId, idempotencyKey, payloadHash });
      if (verdict) {
        if (verdict.kind === "conflict") {
          conflictAudit(verdict);
          return { conflict: true, reason: verdict.reason, id: verdict.id };
        }
        return { duplicate: true, id: verdict.id };
      }
      throw err;
    }
  });
}

export function listIngested(db, { limit = 100, productId = null } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 100, 500));
  if (productId) {
    return db.prepare("SELECT * FROM ingested_feedback WHERE product_id=? ORDER BY id DESC LIMIT ?").all(productId, cap);
  }
  return db.prepare("SELECT * FROM ingested_feedback ORDER BY id DESC LIMIT ?").all(cap);
}

export function countIngested(db, { productId = null } = {}) {
  if (productId) {
    return Number(db.prepare("SELECT COUNT(*) AS n FROM ingested_feedback WHERE product_id=?").get(productId).n) || 0;
  }
  return Number(db.prepare("SELECT COUNT(*) AS n FROM ingested_feedback").get().n) || 0;
}
