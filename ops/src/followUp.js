import { withImmediateTx } from "./tx.js";
import { appendAuditRow } from "./audit.js";
import { httpError } from "./errors.js";
import { createEntityRow, findEntity } from "./stateMachine.js";

const FOLLOWUP_STATES = new Set(["RELEASED", "ROLLED_BACK"]);
const TITLE_MAX = 120;
const REASON_MAX = 1000;
const KIND_FOLLOWUP = "followup";

function iso(now) { return (now instanceof Date ? now : new Date(now || Date.now())).toISOString(); }
function issueEntityId(issueId) { return `issue:${Number(issueId)}`; }

export function inferIssueProductId(db, issueId) {
  const own = db.prepare("SELECT product_id FROM issue_candidate WHERE id=?").get(Number(issueId));
  if (own?.product_id) return own.product_id;
  const row = db.prepare(`
    SELECT f.product_id FROM issue_feedback_link l
    JOIN ingested_feedback f ON f.id = l.feedback_id
    WHERE l.issue_id=? AND l.active=1
    ORDER BY l.id DESC LIMIT 1
  `).get(Number(issueId));
  return row?.product_id || null;
}

export function listFollowUpIssues(db, parentIssueId) {
  return db.prepare(
    "SELECT id, title, issue_kind, product_id, created_at FROM issue_candidate WHERE parent_issue_id=? ORDER BY id DESC",
  ).all(Number(parentIssueId)).map((r) => ({
    id: Number(r.id),
    title: r.title || "",
    issue_kind: r.issue_kind || KIND_FOLLOWUP,
    product_id: r.product_id || null,
    created_at: r.created_at,
  }));
}

export function createFollowUpIssue(db, { parentIssueId, title = null, reason = null, actor = "owner", now = new Date() } = {}) {
  return withImmediateTx(db, () => {
    const parent = db.prepare("SELECT * FROM issue_candidate WHERE id=?").get(Number(parentIssueId));
    if (!parent) throw httpError("issue not found", 404);
    const entity = findEntity(db, issueEntityId(parent.id));
    if (!entity || !FOLLOWUP_STATES.has(entity.state)) {
      throw httpError(`follow-up only from RELEASED or ROLLED_BACK (state=${entity ? entity.state : "none"})`, 409);
    }
    const parentAuth = db.prepare(
      "SELECT id FROM development_authorization WHERE issue_id=? AND status='active' ORDER BY id DESC LIMIT 1",
    ).get(Number(parent.id));
    const productId = inferIssueProductId(db, parent.id);
    const ts = iso(now);
    const nextTitle = String(title || "").trim().slice(0, TITLE_MAX) || `後續：${String(parent.title || `#${parent.id}`).slice(0, TITLE_MAX - 3)}`;
    const summary = [
      `後續開發自已發布議題 #${parent.id}。`,
      reason ? `說明：${String(reason).trim().slice(0, REASON_MAX)}` : "",
      parent.summary || "",
    ].filter(Boolean).join("\n");
    const res = db.prepare(
      `INSERT INTO issue_candidate(title, summary, category, clustering_version, status, parent_issue_id, issue_kind, product_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
    ).run(
      nextTitle,
      summary,
      parent.category || "OTHER",
      parent.clustering_version || "followup-v1",
      Number(parent.id),
      KIND_FOLLOWUP,
      productId,
      ts,
      ts,
    );
    const id = Number(res.lastInsertRowid);
    createEntityRow(db, { entityType: "issue", id: issueEntityId(id), actor, now });
    appendAuditRow(db, {
      actor,
      action: "issue.followup.created",
      entityType: "issue_candidate",
      entityId: String(id),
      data: {
        issue_id: id,
        parent_issue_id: Number(parent.id),
        parent_state: entity.state,
        product_id: productId,
        copied_parent_grant: false,
        parent_grant_id: parentAuth ? Number(parentAuth.id) : null,
      },
      now,
    });
    return {
      issue_id: id,
      parent_issue_id: Number(parent.id),
      product_id: productId,
      issue_kind: KIND_FOLLOWUP,
      title: nextTitle,
    };
  });
}
