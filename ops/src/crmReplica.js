import { withImmediateTx } from "./tx.js";
import { appendAuditRow } from "./audit.js";
import { httpError } from "./errors.js";
import { DEFAULT_PRODUCT_ID, getProduct, publicProduct } from "./products.js";

// 第 4 包：OPS 只存站方 CRM 複本與 Owner 商務備註。欄位不用 status，避免與議題 lifecycle 混成一格。

const SYNC_STALE_MS = 30 * 60 * 1000;

export const CRM_CONSENT_KEYS = Object.freeze([
  "feedback_copy",
  "crm_sync",
  "stats",
  "cross_site_insight",
  "followup_service",
  "retain_after_exit",
]);

export function ensureCrmReplicaSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_crm_module (
      product_id TEXT PRIMARY KEY,
      module_state TEXT NOT NULL DEFAULT 'enabled',
      site_admin_url TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES ops_product(id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS ingested_crm_contact (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      external_contact_id TEXT NOT NULL,
      display_name TEXT,
      company_name TEXT,
      email TEXT,
      phone TEXT,
      line_id TEXT,
      assigned_to TEXT,
      tags_json TEXT,
      last_synced_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      UNIQUE(product_id, delivery_id),
      UNIQUE(product_id, idempotency_key),
      UNIQUE(product_id, external_contact_id)
    );
    CREATE INDEX IF NOT EXISTS idx_crm_contact_product ON ingested_crm_contact(product_id, id);
    CREATE TABLE IF NOT EXISTS ingested_crm_case (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      external_case_id TEXT NOT NULL,
      external_contact_id TEXT NOT NULL,
      external_feedback_id TEXT,
      title TEXT,
      handling_state TEXT,
      assigned_to TEXT,
      last_synced_at TEXT NOT NULL,
      UNIQUE(product_id, external_case_id)
    );
    CREATE TABLE IF NOT EXISTS ingested_crm_note (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      external_note_id TEXT NOT NULL,
      external_contact_id TEXT NOT NULL,
      external_case_id TEXT,
      body TEXT,
      created_at TEXT,
      last_synced_at TEXT NOT NULL,
      UNIQUE(product_id, external_note_id)
    );
    CREATE TABLE IF NOT EXISTS ingested_crm_todo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      external_todo_id TEXT NOT NULL,
      external_contact_id TEXT NOT NULL,
      external_case_id TEXT,
      title TEXT,
      due_at TEXT,
      done_at TEXT,
      last_synced_at TEXT NOT NULL,
      UNIQUE(product_id, external_todo_id)
    );
    CREATE TABLE IF NOT EXISTS ingested_crm_feedback_handling (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      external_feedback_id TEXT NOT NULL,
      handling_state TEXT,
      admin_note TEXT,
      last_synced_at TEXT NOT NULL,
      UNIQUE(product_id, external_feedback_id)
    );
    CREATE TABLE IF NOT EXISTS owner_crm_note (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      subject_kind TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(product_id, subject_kind, subject_key)
    );
  `);
}

function iso(now = new Date()) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

function clip(v, n) {
  if (v == null) return null;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) : s;
}

function parseCaps(raw) {
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

export function publicSiteAdminUrl(value) {
  const url = String(value || "").trim();
  return /^https?:\/\//i.test(url) ? clip(url, 400) : null;
}

export function normalizeSiteAdminUrl(value) {
  const url = String(value || "").trim();
  if (!url) return null;
  const ok = publicSiteAdminUrl(url);
  if (!ok) throw httpError("本站後台網址必須是 http 或 https 開頭的完整網址", 400);
  return ok;
}

export function crmModuleFor(db, productId) {
  const id = String(productId || DEFAULT_PRODUCT_ID);
  const row = db.prepare("SELECT * FROM product_crm_module WHERE product_id=?").get(id);
  return {
    product_id: id,
    module_state: row?.module_state || "enabled",
    enabled: (row?.module_state || "enabled") === "enabled",
    site_admin_url: row?.site_admin_url || null,
    updated_at: row?.updated_at || null,
  };
}

export function setCrmModule(db, productId, { enabled, siteAdminUrl, actor = "owner", now = new Date() } = {}) {
  const product = getProduct(db, productId);
  if (!product) throw httpError("not found", 404);
  const ts = iso(now);
  const current = crmModuleFor(db, product.id);
  const nextState = enabled === false ? "disabled" : (enabled === true ? "enabled" : current.module_state);
  const url = siteAdminUrl == null ? current.site_admin_url : normalizeSiteAdminUrl(siteAdminUrl);
  db.prepare(`
    INSERT INTO product_crm_module(product_id, module_state, site_admin_url, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(product_id) DO UPDATE SET
      module_state=excluded.module_state,
      site_admin_url=excluded.site_admin_url,
      updated_at=excluded.updated_at
  `).run(product.id, nextState, url, ts);
  appendAuditRow(db, {
    actor,
    action: enabled === false ? "crm.module.disabled" : "crm.module.updated",
    entityType: "product_crm_module",
    entityId: product.id,
    data: { module_state: nextState },
    now,
  });
  return crmModuleFor(db, product.id);
}

export function productAllowsCrmSync(db, productId) {
  const product = getProduct(db, productId);
  if (!product) return false;
  const caps = product.capabilities ? parseCaps(product.capabilities) : (product.subscription?.capabilities || {});
  return caps.crm_sync === true;
}

export function ingestCrmSnapshot(db, { deliveryId, payload, productId = DEFAULT_PRODUCT_ID, now = new Date() } = {}) {
  const pid = String(productId || DEFAULT_PRODUCT_ID);
  if (!deliveryId) throw httpError("missing delivery_id", 400);
  const idem = String(payload?.idempotency_key || "").trim();
  if (!idem) throw httpError("missing idempotency_key", 400);
  if (!productAllowsCrmSync(db, pid)) throw httpError("crm_sync not granted", 403);
  const module = crmModuleFor(db, pid);
  if (!module.enabled) throw httpError("CRM 模組已關閉，複本保留、不再收新處理", 409);

  const snap = payload?.snapshot || {};
  const contact = snap.contact || {};
  const externalId = String(payload.external_contact_id || contact.id || "").trim();
  if (!externalId) throw httpError("missing external_contact_id", 400);
  const ts = iso(now);
  const synced = clip(payload.synced_at, 64) || ts;

  return withImmediateTx(db, () => {
    const byDelivery = db.prepare("SELECT id FROM ingested_crm_contact WHERE product_id=? AND delivery_id=?").get(pid, deliveryId);
    if (byDelivery) return { id: Number(byDelivery.id), duplicate: true };

    const existing = db.prepare("SELECT id FROM ingested_crm_contact WHERE product_id=? AND external_contact_id=?").get(pid, externalId);
    if (existing) {
      db.prepare(`
        UPDATE ingested_crm_contact
           SET delivery_id=?, idempotency_key=?, display_name=?, company_name=?, email=?, phone=?, line_id=?,
               assigned_to=?, tags_json=?, last_synced_at=?, received_at=?
         WHERE id=?
      `).run(
        deliveryId,
        idem,
        clip(contact.display_name, 80),
        clip(contact.company_name, 80),
        clip(contact.email, 200),
        clip(contact.phone, 40),
        clip(contact.line_id, 80),
        clip(contact.assigned_to, 32),
        JSON.stringify(contact.tags || []),
        synced,
        ts,
        existing.id,
      );
    } else {
      db.prepare(`
        INSERT INTO ingested_crm_contact(
          product_id, delivery_id, idempotency_key, external_contact_id, display_name, company_name,
          email, phone, line_id, assigned_to, tags_json, last_synced_at, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        pid, deliveryId, idem, externalId,
        clip(contact.display_name, 80), clip(contact.company_name, 80),
        clip(contact.email, 200), clip(contact.phone, 40), clip(contact.line_id, 80),
        clip(contact.assigned_to, 32), JSON.stringify(contact.tags || []), synced, ts,
      );
    }

    for (const c of snap.cases || []) {
      db.prepare(`
        INSERT INTO ingested_crm_case(product_id, external_case_id, external_contact_id, external_feedback_id, title, handling_state, assigned_to, last_synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(product_id, external_case_id) DO UPDATE SET
          title=excluded.title, handling_state=excluded.handling_state, external_feedback_id=excluded.external_feedback_id,
          assigned_to=excluded.assigned_to, last_synced_at=excluded.last_synced_at
      `).run(pid, String(c.id), externalId, c.feedback_id == null ? null : String(c.feedback_id), clip(c.title, 80), clip(c.handling_state, 32), clip(c.assigned_to, 32), synced);
    }
    for (const n of snap.notes || []) {
      db.prepare(`
        INSERT INTO ingested_crm_note(product_id, external_note_id, external_contact_id, external_case_id, body, created_at, last_synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(product_id, external_note_id) DO UPDATE SET
          body=excluded.body, last_synced_at=excluded.last_synced_at
      `).run(pid, String(n.id), externalId, n.case_id == null ? null : String(n.case_id), clip(n.body, 2000), n.created_at || synced, synced);
    }
    for (const t of snap.todos || []) {
      db.prepare(`
        INSERT INTO ingested_crm_todo(product_id, external_todo_id, external_contact_id, external_case_id, title, due_at, done_at, last_synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(product_id, external_todo_id) DO UPDATE SET
          title=excluded.title, due_at=excluded.due_at, done_at=excluded.done_at, last_synced_at=excluded.last_synced_at
      `).run(pid, String(t.id), externalId, t.case_id == null ? null : String(t.case_id), clip(t.title, 200), t.due_at || null, t.done_at || null, synced);
    }
    for (const f of snap.feedback_handling || []) {
      db.prepare(`
        INSERT INTO ingested_crm_feedback_handling(product_id, external_feedback_id, handling_state, admin_note, last_synced_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(product_id, external_feedback_id) DO UPDATE SET
          handling_state=excluded.handling_state, admin_note=excluded.admin_note, last_synced_at=excluded.last_synced_at
      `).run(pid, String(f.feedback_id), clip(f.handling_state, 32), clip(f.admin_note, 500), synced);
    }

    const row = db.prepare("SELECT id FROM ingested_crm_contact WHERE product_id=? AND external_contact_id=?").get(pid, externalId);
    appendAuditRow(db, {
      actor: "ingest",
      action: "crm.ingested",
      entityType: "ingested_crm_contact",
      entityId: String(row.id),
      data: { product_id: pid, delivery_id: deliveryId, external_contact_id: externalId },
      now,
    });
    return { id: Number(row.id), duplicate: false };
  });
}

function handlingLabel(id) {
  return ({ new: "待看", planned: "已排入", doing: "處理中", done: "已完成", declined: "暫不處理" })[id] || id || "尚未同步";
}

function opsProgressForFeedback(db, productId, feedbackId) {
  if (!feedbackId) return null;
  const ingested = db.prepare(
    "SELECT id FROM ingested_feedback WHERE product_id=? AND CAST(external_feedback_id AS TEXT)=?",
  ).get(productId, String(feedbackId));
  if (!ingested) return null;
  const link = db.prepare("SELECT issue_id FROM issue_feedback_link WHERE feedback_id=? ORDER BY id DESC LIMIT 1").get(ingested.id);
  if (!link) return { label: "OPS 開發進度", state: null, issue_id: null, text: "尚未連到議題" };
  const entity = db.prepare("SELECT id, state FROM state_entity WHERE id=?").get(link.issue_id);
  return {
    label: "OPS 開發進度",
    state: entity?.state || null,
    issue_id: link.issue_id,
    text: entity?.state ? `議題 ${entity.state}` : "議題狀態不明",
  };
}

export function upsertOwnerNote(db, { productId, subjectKind, subjectKey, body, actor = "owner", now = new Date() } = {}) {
  const product = getProduct(db, productId);
  if (!product) throw httpError("not found", 404);
  if (!crmModuleFor(db, product.id).enabled) throw httpError("CRM 模組已關閉，資料保留", 409);
  const text = String(body || "").trim().slice(0, 2000);
  if (text.length < 2) throw httpError("請填商務備註");
  const kind = String(subjectKind || "contact").slice(0, 32);
  const key = String(subjectKey || "").trim().slice(0, 80);
  if (!key) throw httpError("missing subject");
  const ts = iso(now);
  db.prepare(`
    INSERT INTO owner_crm_note(product_id, subject_kind, subject_key, body, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_id, subject_kind, subject_key) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at
  `).run(product.id, kind, key, text, ts, ts);
  appendAuditRow(db, {
    actor,
    action: "crm.owner_note.saved",
    entityType: "owner_crm_note",
    entityId: `${product.id}:${kind}:${key}`,
    data: { product_id: product.id },
    now,
  });
  return { product_id: product.id, subject_kind: kind, subject_key: key, body: text, source: "ops_owner", updated_at: ts };
}

export function listCrmViews(db, { productId = null, now = new Date() } = {}) {
  const pid = productId ? String(productId) : null;
  const contacts = pid
    ? db.prepare("SELECT * FROM ingested_crm_contact WHERE product_id=? ORDER BY id DESC").all(pid)
    : db.prepare("SELECT * FROM ingested_crm_contact ORDER BY id DESC").all();
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  return contacts.map((contact) => {
    const cases = db.prepare("SELECT * FROM ingested_crm_case WHERE product_id=? AND external_contact_id=? ORDER BY id DESC")
      .all(contact.product_id, contact.external_contact_id);
    const notes = db.prepare("SELECT * FROM ingested_crm_note WHERE product_id=? AND external_contact_id=? ORDER BY id DESC")
      .all(contact.product_id, contact.external_contact_id);
    const todos = db.prepare("SELECT * FROM ingested_crm_todo WHERE product_id=? AND external_contact_id=? ORDER BY id DESC")
      .all(contact.product_id, contact.external_contact_id);
    const module = crmModuleFor(db, contact.product_id);
    const syncedMs = Date.parse(contact.last_synced_at || "") || 0;
    const lag = Math.max(0, nowMs - syncedMs);
    const owner = db.prepare(
      "SELECT * FROM owner_crm_note WHERE product_id=? AND subject_kind='contact' AND subject_key=?",
    ).get(contact.product_id, contact.external_contact_id);
    const primary = cases[0] || null;
    const fbId = primary?.external_feedback_id || null;
    const fb = fbId
      ? db.prepare("SELECT * FROM ingested_crm_feedback_handling WHERE product_id=? AND external_feedback_id=?")
        .get(contact.product_id, String(fbId))
      : null;
    const siteHandling = primary || fb
      ? {
        label: "站方處理進度",
        handling_state: primary?.handling_state || fb?.handling_state || null,
        text: handlingLabel(primary?.handling_state || fb?.handling_state),
        feedback_id: fbId,
        source: "site_event",
      }
      : { label: "站方處理進度", handling_state: null, text: "尚未有案件或回饋進度", feedback_id: null, source: "site_event" };
    return {
      product_id: contact.product_id,
      last_synced_at: contact.last_synced_at,
      sync_lag_ms: lag,
      sync_stale: lag > SYNC_STALE_MS,
      site_admin_url: publicSiteAdminUrl(module.site_admin_url),
      columns: {
        site_crm: {
          label: "站方客戶／客服往來",
          source: "site_replica",
          contact: {
            external_contact_id: contact.external_contact_id,
            display_name: contact.display_name,
            company_name: contact.company_name,
            email: contact.email,
            phone: contact.phone,
            line_id: contact.line_id,
            tags: (() => { try { return JSON.parse(contact.tags_json || "[]"); } catch { return []; } })(),
          },
          cases,
          notes,
          todos,
        },
        site_handling: siteHandling,
        ops_progress: opsProgressForFeedback(db, contact.product_id, fbId) || {
          label: "OPS 開發進度",
          state: null,
          issue_id: null,
          text: "與站方客服進度分開；尚未連到議題",
        },
        owner_notes: {
          label: "Owner 商務備註",
          source: "ops_owner",
          body: owner?.body || "",
          updated_at: owner?.updated_at || null,
          not_site_replica: true,
        },
      },
    };
  });
}

export function crmDashboard(db, { productId = null } = {}) {
  const items = listCrmViews(db, { productId });
  const module = crmModuleFor(db, productId || DEFAULT_PRODUCT_ID);
  const product = getProduct(db, productId || DEFAULT_PRODUCT_ID);
  return {
    module,
    product: publicProduct(product),
    items,
    hint: "四欄分開：站方客戶、站方處理進度、OPS 開發進度、Owner 商務備註。關 CRM 不是 DROP。",
  };
}

export function redactCrmReplicas(db, productId) {
  const id = String(productId);
  const before = Number(db.prepare("SELECT COUNT(*) n FROM ingested_crm_contact WHERE product_id=?").get(id)?.n || 0);
  db.prepare(`
    UPDATE ingested_crm_contact
       SET display_name='[purged]', company_name=NULL, email=NULL, phone=NULL, line_id=NULL, tags_json='[]'
     WHERE product_id=?
  `).run(id);
  db.prepare("UPDATE ingested_crm_note SET body='[purged]' WHERE product_id=?").run(id);
  db.prepare("UPDATE ingested_crm_feedback_handling SET admin_note=NULL WHERE product_id=?").run(id);
  return before;
}

export function listCrmHandoff(db, productId) {
  return db.prepare(`
    SELECT external_contact_id, display_name, company_name, last_synced_at
      FROM ingested_crm_contact WHERE product_id=? ORDER BY id ASC
  `).all(productId).map((row) => ({
    external_contact_id: row.external_contact_id,
    display_name: row.display_name,
    company_name: row.company_name,
    last_synced_at: row.last_synced_at,
  }));
}
