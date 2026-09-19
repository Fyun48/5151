import { DEFAULT_CAPABILITIES } from "./products.js";

function parseCaps(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

export function loadProductConsent(db, productId) {
  if (!productId || !db) return null;
  return db.prepare(`
    SELECT p.id, p.status, s.status AS subscription_status, s.capabilities,
           s.generation AS subscription_generation
      FROM ops_product p
      LEFT JOIN product_subscription s ON s.product_id = p.id
     WHERE p.id=?
  `).get(productId) || null;
}

export function currentSubscriptionGeneration(db, productId) {
  const row = loadProductConsent(db, productId);
  return Number(row?.subscription_generation || 1);
}

export function inferIssueProductId(db, issueId) {
  if (!db || issueId == null) return null;
  const own = db.prepare("SELECT product_id FROM issue_candidate WHERE id=?").get(Number(issueId));
  if (own?.product_id) return own.product_id;
  if (!tableExists(db, "issue_feedback_link") || !tableExists(db, "ingested_feedback")) return null;
  const row = db.prepare(`
    SELECT f.product_id FROM issue_feedback_link l
    JOIN ingested_feedback f ON f.id = l.feedback_id
    WHERE l.issue_id=? AND l.active=1
    ORDER BY l.id DESC LIMIT 1
  `).get(Number(issueId));
  return row?.product_id || null;
}

export function productAllowsIssuePipeline(product) {
  if (!product) return false;
  const pStatus = product.status;
  const sStatus = product.subscription_status || product.subscription?.status;
  return pStatus === "active" && (sStatus === "connected" || sStatus === "connecting");
}

export function issueWriteDecision(db, issueId, { expectedGeneration = null } = {}) {
  const productId = inferIssueProductId(db, issueId);
  if (!productId) return { ok: true, unbound: true };
  const product = loadProductConsent(db, productId);
  if (!product) return { ok: false, reason: "subscription_revoked" };
  const currentGen = Number(product.subscription_generation || 1);
  if (expectedGeneration != null && Number(expectedGeneration) !== currentGen) {
    return { ok: false, reason: "stale_generation", current_generation: currentGen, product_id: productId };
  }
  if (!productAllowsIssuePipeline(product)) {
    return { ok: false, reason: "subscription_revoked", current_generation: currentGen, product_id: productId };
  }
  return { ok: true, generation: currentGen, product_id: productId };
}

export function productNotifyDecision(db, productId, { expectedGeneration = null } = {}) {
  const product = loadProductConsent(db, productId);
  if (!product) return { ok: false, reason: "subscription_revoked" };
  const currentGen = Number(product.subscription_generation || 1);
  if (expectedGeneration != null && Number(expectedGeneration) !== currentGen) {
    return { ok: false, reason: "stale_generation", current_generation: currentGen };
  }
  if (!productAllowsIssuePipeline(product)) {
    return { ok: false, reason: "subscription_revoked", current_generation: currentGen };
  }
  return { ok: true, generation: currentGen };
}

export function workerWriteDecision(db, feedbackId, { expectedGeneration = null } = {}) {
  const row = db.prepare("SELECT product_id FROM ingested_feedback WHERE id=?").get(Number(feedbackId) || 0);
  if (!row?.product_id) return { ok: false, reason: "subscription_revoked" };
  const product = loadProductConsent(db, row.product_id);
  if (!product) return { ok: false, reason: "subscription_revoked" };
  const currentGen = Number(product.subscription_generation || 1);
  if (expectedGeneration != null && Number(expectedGeneration) !== currentGen) {
    return { ok: false, reason: "stale_generation", current_generation: currentGen };
  }
  if (!productAllowsNewInsight(product)) return { ok: false, reason: "subscription_revoked", current_generation: currentGen };
  return { ok: true, generation: currentGen };
}

export function productAllowsNewInsight(product) {
  if (!product) return false;
  const raw = product.subscription?.capabilities ?? product.capabilities;
  const caps = typeof raw === "string" ? parseCaps(raw) : { ...DEFAULT_CAPABILITIES, ...(raw || {}) };
  if (!caps.cross_site_insight) return false;
  const pStatus = product.status;
  const sStatus = product.subscription_status || product.subscription?.status;
  const connected = pStatus === "active" && (sStatus === "connected" || sStatus === "connecting");
  if (connected) return true;
  return Boolean(caps.retain_after_exit);
}

export function feedbackAllowsNewInsight(db, feedbackId) {
  return workerWriteDecision(db, feedbackId).ok;
}

export function insightPurgeCounts(db, productId) {
  const id = String(productId || "");
  const feedbackIds = tableExists(db, "ingested_feedback")
    ? db.prepare("SELECT id FROM ingested_feedback WHERE product_id=?").all(id).map((r) => Number(r.id))
    : [];
  const inList = feedbackIds.length ? feedbackIds.map(() => "?").join(",") : "";
  const countIn = (sql) => {
    if (!feedbackIds.length) return 0;
    return Number(db.prepare(sql).get(...feedbackIds)?.n || 0);
  };
  return {
    feedback: feedbackIds.length,
    analysis: tableExists(db, "feedback_analysis") && inList
      ? countIn(`SELECT COUNT(*) n FROM feedback_analysis WHERE feedback_id IN (${inList})`)
      : 0,
    embeddings: tableExists(db, "embedding") && inList
      ? countIn(`SELECT COUNT(*) n FROM embedding WHERE feedback_id IN (${inList})`)
      : 0,
    attachments: tableExists(db, "feedback_attachment") && inList
      ? countIn(`SELECT COUNT(*) n FROM feedback_attachment WHERE feedback_id IN (${inList})`)
      : 0,
    exports: tableExists(db, "product_handoff_export")
      ? Number(db.prepare("SELECT COUNT(*) n FROM product_handoff_export WHERE product_id=?").get(id)?.n || 0)
      : 0,
  };
}

export function redactInsightDerivatives(db, productId) {
  const id = String(productId || "");
  const before = insightPurgeCounts(db, id);
  const feedbackIds = tableExists(db, "ingested_feedback")
    ? db.prepare("SELECT id FROM ingested_feedback WHERE product_id=?").all(id).map((r) => Number(r.id))
    : [];
  if (feedbackIds.length) {
    const marks = feedbackIds.map(() => "?").join(",");
    if (tableExists(db, "feedback_analysis")) {
      db.prepare(`
        UPDATE feedback_analysis
           SET summary='[purged]', category=NULL, raw_output_hash=NULL, error_code='purged'
         WHERE feedback_id IN (${marks})
      `).run(...feedbackIds);
    }
    if (tableExists(db, "embedding")) {
      db.prepare(`
        UPDATE embedding
           SET vector='[]', text_hash='purged', status='stale'
         WHERE feedback_id IN (${marks})
      `).run(...feedbackIds);
    }
    if (tableExists(db, "feedback_attachment")) {
      db.prepare(`
        UPDATE feedback_attachment
           SET original_filename='[purged]', sha256='purged'
         WHERE feedback_id IN (${marks})
      `).run(...feedbackIds);
    }
  }
  if (tableExists(db, "product_handoff_export")) {
    db.prepare(`
      UPDATE product_handoff_export
         SET payload_json='{"purged":true}', manifest_json='{"purged":true}'
       WHERE product_id=?
    `).run(id);
  }
  return before;
}
