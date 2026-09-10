import { countIngested } from "./ingest.js";
import { notifyConfig } from "./notify/webhook.js";

export const OPS_PHASE = "15";

export function publicFeedback(row, { includeContact = false } = {}) {
  if (!row) return null;
  return {
    id: Number(row.id),
    product_id: row.product_id || "v3",
    source: row.source || "unknown",
    kind: row.kind || "other",
    content: row.content || "",
    app_version: row.app_version || null,
    submitted_at: row.submitted_at || null,
    received_at: row.received_at || null,
    trust_level: row.trust_level || "untrusted",
    has_contact: Boolean(row.contact),
    contact: includeContact ? (row.contact || null) : undefined,
    user_ref_present: Boolean(row.user_ref),
  };
}

export function listFeedbackInbox(db, { limit = 50, offset = 0, includeContact = false, productId = null } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 50, 200));
  const skip = Math.max(0, Number(offset) || 0);
  const total = countIngested(db, { productId });
  const rows = productId
    ? db.prepare(
      `SELECT f.*, l.issue_id AS issue_id
         FROM ingested_feedback f
         LEFT JOIN issue_feedback_link l ON l.feedback_id = f.id AND l.active = 1
        WHERE f.product_id = ?
        ORDER BY f.id DESC LIMIT ? OFFSET ?`,
    ).all(productId, cap, skip)
    : db.prepare(
      `SELECT f.*, l.issue_id AS issue_id
         FROM ingested_feedback f
         LEFT JOIN issue_feedback_link l ON l.feedback_id = f.id AND l.active = 1
        ORDER BY f.id DESC LIMIT ? OFFSET ?`,
    ).all(cap, skip);
  return {
    total,
    limit: cap,
    offset: skip,
    items: rows.map((r) => ({ ...publicFeedback(r, { includeContact }), issue_id: r.issue_id ? Number(r.issue_id) : null })),
  };
}

export function getDashboard(db, env = process.env) {
  const lifecycle = {};
  for (const row of db.prepare("SELECT state, COUNT(*) AS n FROM state_entity WHERE entity_type IN ('issue','lifecycle') GROUP BY state").all()) {
    lifecycle[row.state] = Number(row.n) || 0;
  }
  const issues = Number(db.prepare("SELECT COUNT(*) AS n FROM issue_candidate").get()?.n) || 0;
  const openIssues = Number(db.prepare("SELECT COUNT(*) AS n FROM issue_candidate WHERE status='open'").get()?.n) || 0;
  const pendingNotifs = Number(db.prepare("SELECT COUNT(*) AS n FROM release_notification WHERE status='pending'").get()?.n) || 0;
  const cfg = notifyConfig(env);
  return {
    phase: OPS_PHASE,
    feedback_total: countIngested(db),
    issues_total: issues,
    issues_open: openIssues,
    lifecycle,
    waiting_owner_approval: lifecycle.WAITING_OWNER_APPROVAL || 0,
    waiting_release_approval: lifecycle.WAITING_RELEASE_APPROVAL || 0,
    pending_release_notifications: pendingNotifs,
    webhook: { configured: cfg.configured, channel: cfg.configured ? cfg.channel : null, on_ingest: cfg.onIngest },
  };
}

export function listIssuesWithLifecycle(db, { limit = 80 } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 80, 200));
  const rows = db.prepare("SELECT * FROM issue_candidate ORDER BY id DESC LIMIT ?").all(cap);
  return rows.map((r) => {
    const entity = db.prepare("SELECT state, version FROM state_entity WHERE id=?").get(`issue:${r.id}`);
    const impact = db.prepare(
      `SELECT a.impact_score, a.impact_level FROM issue_impact_current c
       JOIN issue_impact_assessment a ON a.id = c.assessment_id
       WHERE c.issue_id=?`,
    ).get(Number(r.id));
    const evalRow = db.prepare(
      "SELECT final_recommendation FROM issue_evaluation_current WHERE issue_id=?",
    ).get(Number(r.id));
    const members = Number(db.prepare("SELECT COUNT(*) n FROM issue_feedback_link WHERE issue_id=? AND active=1").get(r.id).n) || 0;
    return {
      id: Number(r.id),
      title: r.title,
      summary: r.summary,
      category: r.category,
      status: r.status,
      member_count: members,
      lifecycle_state: entity?.state || "COLLECTING",
      impact_score: impact?.impact_score ?? null,
      impact_level: impact?.impact_level ?? null,
      evaluation: evalRow?.final_recommendation || null,
      updated_at: r.updated_at,
    };
  });
}
