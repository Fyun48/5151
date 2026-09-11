import { createHash } from "node:crypto";
import { withImmediateTx } from "./tx.js";
import { appendAuditRow } from "./audit.js";
import { httpError } from "./errors.js";
import {
  getProduct,
  publicProduct,
  unsubscribeProduct,
  normalizeProductId,
} from "./products.js";
import { redactCrmReplicas, listCrmHandoff } from "./crmReplica.js";
import { redactInsightDerivatives } from "./insightConsent.js";
import { recordPurgeEvent, redactExclusiveIssues } from "./purgeLedger.js";

export const EXIT_ACTIONS = Object.freeze(["pause", "unsubscribe", "handoff", "purge_replica"]);
export const HANDOFF_SCHEMA = 1;

function iso(now = new Date()) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

function sha256Json(value) {
  return createHash("sha256").update(Buffer.from(JSON.stringify(value), "utf8")).digest("hex");
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function safeAll(db, sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

export function ensureExitDrillSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_exit_record (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1,
      action TEXT NOT NULL,
      exit_status TEXT NOT NULL,
      pending_json TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (product_id) REFERENCES ops_product(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_exit_record_product ON product_exit_record(product_id, id);
    CREATE TABLE IF NOT EXISTS product_handoff_export (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      exit_record_id INTEGER,
      manifest_json TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES ops_product(id) ON DELETE RESTRICT
    );
  `);
}

export function listPendingWork(db, productId) {
  const id = normalizeProductId(productId);
  const items = [];
  const creds = safeAll(db, "SELECT id, label, status FROM product_ingest_credential WHERE product_id=? AND status='active'", [id]);
  for (const row of creds) {
    items.push({
      kind: "credential",
      id: row.id,
      label: row.label || "ingest",
      state: row.status,
      blocking: false,
      note: "解除訂閱後會撤銷",
    });
  }
  const analysis = safeAll(db, `
    SELECT a.id, a.status FROM feedback_analysis a
     JOIN ingested_feedback f ON f.id = a.feedback_id
    WHERE f.product_id=? AND a.status IN ('pending','processing')
  `, [id]);
  for (const row of analysis) {
    items.push({
      kind: "analysis",
      id: row.id,
      state: row.status,
      blocking: row.status === "processing",
      note: "未送出的分析可取消；已在跑的不宣稱撤回。訂閱世代已換或已退出的晚到結果不會開新議題。",
    });
  }
  if (tableExists(db, "issue_evaluation_run")) {
    const evals = safeAll(db, `
      SELECT r.id, r.status FROM issue_evaluation_run r
       JOIN issue_candidate i ON i.id = r.issue_id
      WHERE r.status IN ('pending','processing')
        AND (
          i.product_id=?
          OR EXISTS (
            SELECT 1 FROM issue_feedback_link l
             JOIN ingested_feedback f ON f.id = l.feedback_id
            WHERE l.issue_id = i.id AND l.active = 1 AND f.product_id = ?
          )
        )
    `, [id, id]);
    for (const row of evals) {
      items.push({
        kind: "evaluation",
        id: row.id,
        state: row.status,
        blocking: row.status === "processing",
        note: "未送出的評估可取消；已在跑的不宣稱撤回。訂閱世代已換或已退出的晚到評估不會寫入新結果。",
      });
    }
  }
  if (tableExists(db, "issue_proposal")) {
    const props = safeAll(db, `
      SELECT p.id, p.status FROM issue_proposal p
       JOIN issue_candidate i ON i.id = p.issue_id
      WHERE p.status IN ('pending','processing')
        AND (
          i.product_id=?
          OR EXISTS (
            SELECT 1 FROM issue_feedback_link l
             JOIN ingested_feedback f ON f.id = l.feedback_id
            WHERE l.issue_id = i.id AND l.active = 1 AND f.product_id = ?
          )
        )
    `, [id, id]);
    for (const row of props) {
      items.push({
        kind: "proposal",
        id: row.id,
        state: row.status,
        blocking: row.status === "processing",
        note: "未送出的提案可取消；已在跑的不宣稱撤回。訂閱世代已換或已退出的晚到提案不會寫入或送 webhook。",
      });
    }
  }
  if (tableExists(db, "development_coding_task")) {
    const tasks = safeAll(db, `
      SELECT id, status FROM development_coding_task
       WHERE status IN ('pending','claimed','running','changes_ready','failed_retry')
    `);
    for (const row of tasks) {
      items.push({
        kind: "coding",
        id: row.id,
        state: row.status,
        blocking: row.status === "running" || row.status === "claimed",
        unscoped: true,
        note: "製作任務尚未綁 product_id；退出時列出但不能宣稱已取消外部呼叫",
      });
    }
  }
  if (tableExists(db, "embedding")) {
    const embN = Number(db.prepare(`
      SELECT COUNT(*) n FROM embedding e
       JOIN ingested_feedback f ON f.id = e.feedback_id
      WHERE f.product_id=? AND e.status='active'
    `).get(id)?.n || 0);
    if (embN) {
      items.push({
        kind: "insight_embedding",
        id,
        state: "replica",
        blocking: false,
        note: `OPS 有 ${embN} 筆向量；刪複本才清除。去掉 email 不是匿名化。撤回跨站分析只停新洞察。`,
      });
    }
  }
  if (tableExists(db, "ingested_crm_contact")) {
    const crmN = Number(db.prepare("SELECT COUNT(*) n FROM ingested_crm_contact WHERE product_id=?").get(id)?.n || 0);
    if (crmN) {
      items.push({
        kind: "crm_replica",
        id: id,
        state: "replica",
        blocking: false,
        note: `OPS 有 ${crmN} 筆站方 CRM 複本；刪複本才清除，關模組不會 DROP`,
      });
    }
  }
  if (tableExists(db, "release_notification")) {
    const notes = safeAll(db, "SELECT id, status FROM release_notification WHERE status='pending'");
    for (const row of notes) {
      items.push({
        kind: "release_notification",
        id: row.id,
        state: row.status,
        blocking: false,
        unscoped: true,
        note: "發布通知佇列尚未分站",
      });
    }
  }
  const blocking = items.filter((it) => it.blocking);
  return { items, blocking, site_delivery_unconfirmed: true };
}

function insertExitRecord(db, { productId, generation, action, exitStatus, pending, notes, actor, now }) {
  const ts = iso(now);
  const res = db.prepare(`
    INSERT INTO product_exit_record(product_id, generation, action, exit_status, pending_json, notes, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    productId,
    Number(generation || 1),
    action,
    exitStatus,
    JSON.stringify(pending || { items: [], blocking: [] }),
    notes || "",
    ts,
    ts,
    exitStatus === "completed" ? ts : null,
  );
  appendAuditRow(db, {
    actor,
    action: `product.exit.${action}`,
    entityType: "ops_product",
    entityId: productId,
    data: { exit_record_id: Number(res.lastInsertRowid), exit_status: exitStatus },
    now,
  });
  return getExitRecord(db, Number(res.lastInsertRowid));
}

export function getExitRecord(db, id) {
  const row = db.prepare("SELECT * FROM product_exit_record WHERE id=?").get(id);
  return row ? publicExit(row) : null;
}

export function listExits(db, productId) {
  const id = normalizeProductId(productId);
  if (!id) return [];
  return db.prepare("SELECT * FROM product_exit_record WHERE product_id=? ORDER BY id DESC LIMIT 20").all(id).map(publicExit);
}

export function latestExit(db, productId) {
  const id = normalizeProductId(productId);
  if (!id) return null;
  const row = db.prepare("SELECT * FROM product_exit_record WHERE product_id=? ORDER BY id DESC LIMIT 1").get(id);
  return row ? publicExit(row) : null;
}

export function publicExit(row) {
  if (!row) return null;
  let pending = { items: [], blocking: [] };
  try { pending = row.pending_json ? JSON.parse(row.pending_json) : pending; } catch { /* keep empty */ }
  return {
    id: Number(row.id),
    product_id: row.product_id,
    generation: Number(row.generation || 1),
    action: row.action,
    exit_status: row.exit_status,
    pending,
    notes: row.notes || "",
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at || null,
  };
}

export function beginUnsubscribeExit(db, productId, { actor = "owner", now = new Date() } = {}) {
  const before = getProduct(db, productId);
  if (!before) throw httpError("not found", 404);
  const pending = listPendingWork(db, before.id);
  const product = unsubscribeProduct(db, before.id, { actor, now });
  const blocked = pending.blocking.length > 0;
  const record = withImmediateTx(db, () => insertExitRecord(db, {
    productId: before.id,
    generation: before.subscription_generation,
    action: "unsubscribe",
    exitStatus: blocked ? "blocked" : "completed",
    pending,
    notes: blocked
      ? "憑證已撤銷。未決外部工作不能宣稱已取消。"
      : "已解除訂閱並撤銷密鑰。本機主本不在 OPS。",
    actor,
    now,
  }));
  return {
    product,
    exit: record,
    pending,
    site_delivery_unconfirmed: true,
  };
}

export function pendingForHandoff(pendingAll) {
  const items = (pendingAll?.items || []).filter((it) => !it.unscoped);
  const blocking = (pendingAll?.blocking || []).filter((it) => !it.unscoped);
  return {
    items,
    blocking,
    site_delivery_unconfirmed: true,
    omitted_unscoped: (pendingAll?.items || []).filter((it) => it.unscoped).length,
  };
}

export function exportHandoff(db, productId, { actor = "owner", now = new Date() } = {}) {
  const product = getProduct(db, productId);
  if (!product) throw httpError("not found", 404);
  const pending = pendingForHandoff(listPendingWork(db, product.id));
  const crmContacts = tableExists(db, "ingested_crm_contact") ? listCrmHandoff(db, product.id) : [];
  const feedback = db.prepare(`
    SELECT id, product_id, kind, content, app_version, received_at, submitted_at, source
      FROM ingested_feedback WHERE product_id=? ORDER BY id ASC
  `).all(product.id).map((row) => ({
    id: Number(row.id),
    product_id: row.product_id,
    kind: row.kind || "other",
    content: row.content || "",
    app_version: row.app_version || null,
    received_at: row.received_at,
    submitted_at: row.submitted_at,
    source: row.source || "unknown",
    content_sha256: createHash("sha256").update(String(row.content || ""), "utf8").digest("hex"),
  }));
  const payload = {
    schema_version: HANDOFF_SCHEMA,
    product: publicProduct(product),
    exported_at: iso(now),
    feedback,
    crm_contacts: crmContacts,
    pending,
    checklist: {
      code: { included: false, note: "同一 repo；分家時另交該站程式與 lockfile，不在本包" },
      operations_data: { included: true, count: feedback.length, note: "OPS 複本回饋（不含聯絡方式）" },
      crm: { included: true, count: crmContacts.length, note: "站方 CRM 複本摘要；Owner 商務備註不當作站方資料匯出" },
      accounts: { included: false, note: "本機管理員帳號在站方庫，不在 OPS" },
      infrastructure: { included: false, note: "網域／Tunnel／CI 另列經營者" },
      external_services: { included: false, note: "金鑰不匯出；對方自備憑證" },
      permission_revoke: { included: true, note: "訂閱憑證由解除訂閱撤銷；其它部署鑰匙第 8 包" },
    },
  };
  const digest = sha256Json(payload);
  const manifest = {
    schema_version: HANDOFF_SCHEMA,
    product_id: product.id,
    sha256: digest,
    feedback_count: feedback.length,
    exported_at: payload.exported_at,
    files: [
      { name: "handoff.json", sha256: digest },
    ],
  };
  return withImmediateTx(db, () => {
    const exit = insertExitRecord(db, {
      productId: product.id,
      generation: product.subscription_generation,
      action: "handoff",
      exitStatus: "completed",
      pending,
      notes: `交接包 ${digest.slice(0, 12)}`,
      actor,
      now,
    });
    db.prepare(`
      INSERT INTO product_handoff_export(product_id, exit_record_id, manifest_json, payload_json, sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(product.id, exit.id, JSON.stringify(manifest), JSON.stringify(payload), digest, iso(now));
    return { manifest, payload, sha256: digest, exit };
  });
}

export function latestHandoff(db, productId) {
  const id = normalizeProductId(productId);
  if (!id) return null;
  const row = db.prepare("SELECT * FROM product_handoff_export WHERE product_id=? ORDER BY id DESC LIMIT 1").get(id);
  if (!row) return null;
  return {
    id: Number(row.id),
    product_id: row.product_id,
    sha256: row.sha256,
    manifest: JSON.parse(row.manifest_json),
    payload: JSON.parse(row.payload_json),
    created_at: row.created_at,
  };
}

export function purgeReplica(db, productId, { actor = "owner", now = new Date(), confirm = "" } = {}) {
  const product = getProduct(db, productId);
  if (!product) throw httpError("not found", 404);
  const expected = `PURGE-${product.id}`;
  if (String(confirm || "") !== expected) throw httpError(`confirmation must be ${expected}`, 400);
  const pending = listPendingWork(db, product.id);
  return withImmediateTx(db, () => {
    const before = Number(db.prepare("SELECT COUNT(*) n FROM ingested_feedback WHERE product_id=?").get(product.id).n) || 0;
    db.prepare(`
      UPDATE ingested_feedback
         SET content='[purged]', contact=NULL, context=NULL, user_ref=NULL
       WHERE product_id=?
    `).run(product.id);
    const crmPurged = tableExists(db, "ingested_crm_contact") ? redactCrmReplicas(db, product.id) : 0;
    const insight = redactInsightDerivatives(db, product.id);
    const issues = redactExclusiveIssues(db, product.id);
    recordPurgeEvent(db, {
      productId: product.id,
      actor,
      counts: { feedback: before, crm: crmPurged, ...insight, issues },
      now,
    });
    const record = insertExitRecord(db, {
      productId: product.id,
      generation: product.subscription_generation,
      action: "purge_replica",
      exitStatus: "completed",
      pending,
      notes: `已清除 ${before} 筆回饋複本、${crmPurged} 筆 CRM 複本、分析 ${insight.analysis}、向量 ${insight.embeddings}、附件 ${insight.attachments}、匯出 ${insight.exports}、專屬議題 ${issues}。去掉聯絡方式不是匿名化。產品卡、稽核與清除帳本保留，還原後會再套用。本機主本不在此庫。`,
      actor,
      now,
    });
    return { product: publicProduct(getProduct(db, product.id)), purged: before, insight, issues, exit: record };
  });
}
