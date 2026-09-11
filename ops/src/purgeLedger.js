import { redactCrmReplicas } from "./crmReplica.js";
import { redactInsightDerivatives } from "./insightConsent.js";

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

export function ensurePurgeLedgerSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_purge_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      counts_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_purge_event_product ON product_purge_event(product_id, id);
  `);
}

export function listPurgeEvents(db, productId = "") {
  ensurePurgeLedgerSchema(db);
  const id = String(productId || "");
  if (id) {
    return db.prepare("SELECT * FROM product_purge_event WHERE product_id=? ORDER BY id DESC").all(id);
  }
  return db.prepare("SELECT * FROM product_purge_event ORDER BY id DESC").all();
}

export function recordPurgeEvent(db, { productId, actor = "owner", counts = {}, now = new Date() } = {}) {
  ensurePurgeLedgerSchema(db);
  const ts = (now instanceof Date ? now : new Date(now)).toISOString();
  const res = db.prepare(`
    INSERT INTO product_purge_event(product_id, actor, counts_json, created_at)
    VALUES (?, ?, ?, ?)
  `).run(String(productId || ""), String(actor || "owner").slice(0, 80), JSON.stringify(counts || {}), ts);
  return { id: Number(res.lastInsertRowid), product_id: String(productId || ""), actor, counts, created_at: ts };
}

export function redactExclusiveIssues(db, productId) {
  if (!tableExists(db, "issue_candidate") || !tableExists(db, "issue_feedback_link") || !tableExists(db, "ingested_feedback")) {
    return 0;
  }
  const id = String(productId || "");
  const issues = db.prepare(`
    SELECT i.id FROM issue_candidate i
     WHERE EXISTS (
       SELECT 1 FROM issue_feedback_link l
       JOIN ingested_feedback f ON f.id = l.feedback_id
       WHERE l.issue_id = i.id AND f.product_id = ?
     )
       AND NOT EXISTS (
         SELECT 1 FROM issue_feedback_link l
         JOIN ingested_feedback f ON f.id = l.feedback_id
         WHERE l.issue_id = i.id AND f.product_id != ?
       )
  `).all(id, id);
  for (const row of issues) {
    db.prepare("UPDATE issue_candidate SET title='[purged]', summary='[purged]', updated_at=? WHERE id=?")
      .run(new Date().toISOString(), row.id);
  }
  const feedbackIds = db.prepare("SELECT id FROM ingested_feedback WHERE product_id=?").all(id).map((r) => Number(r.id));
  if (feedbackIds.length) {
    const marks = feedbackIds.map(() => "?").join(",");
    db.prepare(`UPDATE issue_feedback_link SET active=0 WHERE feedback_id IN (${marks})`).run(...feedbackIds);
  }
  return issues.length;
}

export function reapplyProductPurge(db, productId) {
  const id = String(productId || "");
  if (!id || !tableExists(db, "ingested_feedback")) return { product_id: id, skipped: true };
  if (tableExists(db, "ingested_feedback")) {
    db.prepare(`
      UPDATE ingested_feedback
         SET content='[purged]', contact=NULL, context=NULL, user_ref=NULL
       WHERE product_id=?
    `).run(id);
  }
  if (tableExists(db, "ingested_crm_contact")) redactCrmReplicas(db, id);
  const insight = redactInsightDerivatives(db, id);
  const issues = redactExclusiveIssues(db, id);
  return { product_id: id, insight, issues };
}

export function reapplyPurgeLedger(db) {
  if (!db) return { applied: 0 };
  ensurePurgeLedgerSchema(db);
  const ids = db.prepare("SELECT DISTINCT product_id FROM product_purge_event").all().map((r) => r.product_id);
  let applied = 0;
  for (const productId of ids) {
    reapplyProductPurge(db, productId);
    applied += 1;
  }
  return { applied, product_ids: ids };
}
