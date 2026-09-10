// 第 4 包：站內 CRM 主本。客戶不一定有會員帳號。關閉模組只停介面與新處理，不 DROP。
import { enqueueCrmOutbox } from "./crmOutbox.js";
import { crmDeliveryControl } from "./crmDelivery.js";

export const CRM_ENABLED_KEY = "crm_enabled";
export const CRM_NAME_MAX = 80;
export const CRM_COMPANY_MAX = 80;
export const CRM_CONTACT_MAX = 200;
export const CRM_NOTE_MAX = 2000;
export const CRM_TODO_MAX = 200;
export const CRM_TAG_MAX = 32;
export const CRM_TAG_LIMIT = 12;

export const CRM_HANDLING = [
  { id: "new", label: "待看" },
  { id: "planned", label: "已排入" },
  { id: "doing", label: "處理中" },
  { id: "done", label: "已完成" },
  { id: "declined", label: "暫不處理" },
];

export const CRM_CONSENT_SCOPES = Object.freeze([
  { id: "feedback_copy", label: "回饋複製到 OPS" },
  { id: "crm_sync", label: "CRM 欄位同步到 OPS" },
  { id: "stats", label: "統計指標" },
  { id: "cross_site_insight", label: "跨站分析" },
  { id: "followup_service", label: "後續服務使用" },
  { id: "retain_after_exit", label: "退出後保留複本" },
]);

export const CRM_LEGAL =
  "站內 CRM 只給本站經營者看。回饋授權不包含會員名單、行銷用途或自動同步到 OPS。同步必須另外開啟。";

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function iso(now = new Date()) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

function clip(value, max) {
  return String(value || "").trim().slice(0, max);
}

export function normalizeHandling(value) {
  const id = String(value || "").trim().toLowerCase();
  return CRM_HANDLING.some((row) => row.id === id) ? id : "new";
}

export function ensureCrmSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS crm_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      display_name TEXT NOT NULL,
      company_name TEXT NOT NULL DEFAULT '',
      user_id INTEGER,
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      line_id TEXT NOT NULL DEFAULT '',
      assigned_to INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_crm_contacts_name ON crm_contacts(display_name, id);
    CREATE TABLE IF NOT EXISTS crm_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      feedback_id INTEGER,
      title TEXT NOT NULL,
      handling_state TEXT NOT NULL DEFAULT 'new',
      assigned_to INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (contact_id) REFERENCES crm_contacts(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_crm_cases_contact ON crm_cases(contact_id, id);
    CREATE TABLE IF NOT EXISTS crm_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      case_id INTEGER,
      body TEXT NOT NULL,
      author_user_id INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (contact_id) REFERENCES crm_contacts(id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS crm_todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      case_id INTEGER,
      title TEXT NOT NULL,
      due_at TEXT,
      done_at TEXT,
      assigned_to INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (contact_id) REFERENCES crm_contacts(id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS crm_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS crm_contact_tags (
      contact_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (contact_id, tag_id),
      FOREIGN KEY (contact_id) REFERENCES crm_contacts(id) ON DELETE RESTRICT,
      FOREIGN KEY (tag_id) REFERENCES crm_tags(id) ON DELETE RESTRICT
    );
  `);
}

function setting(db, key) {
  try {
    return String(db.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value || "");
  } catch {
    return "";
  }
}

function setSetting(db, key, value) {
  db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, value);
}

export function isCrmEnabled(db) {
  return setting(db, CRM_ENABLED_KEY) !== "0";
}

export function setCrmEnabled(db, enabled) {
  setSetting(db, CRM_ENABLED_KEY, enabled ? "1" : "0");
  return crmModule(db);
}

export function crmModule(db) {
  const enabled = isCrmEnabled(db);
  return {
    enabled,
    closed: !enabled,
    legal: CRM_LEGAL,
    handling: CRM_HANDLING,
    consents: CRM_CONSENT_SCOPES,
    note: enabled ? "可新增與編輯。關閉只停介面，資料保留。" : "CRM 已關閉：不可新增處理，既有資料仍在。",
  };
}

function assertCrmOpen(db) {
  if (!isCrmEnabled(db)) {
    throw httpError("CRM 已關閉。資料仍保留；重新開啟後才能新增或修改。", 409);
  }
}

function assertContact(db, contactId) {
  const row = db.prepare("SELECT * FROM crm_contacts WHERE id=?").get(Number(contactId) || 0);
  if (!row) throw httpError("找不到這位聯絡人", 404);
  return row;
}

function tagNames(db, contactId) {
  return db.prepare(`
    SELECT t.name FROM crm_tags t
      JOIN crm_contact_tags ct ON ct.tag_id = t.id
     WHERE ct.contact_id=?
     ORDER BY t.name
  `).all(contactId).map((row) => row.name);
}

function replaceTags(db, contactId, tags) {
  const names = [...new Set((Array.isArray(tags) ? tags : String(tags || "").split(/[,，]/))
    .map((item) => clip(item, CRM_TAG_MAX).toLowerCase())
    .filter(Boolean))].slice(0, CRM_TAG_LIMIT);
  db.prepare("DELETE FROM crm_contact_tags WHERE contact_id=?").run(contactId);
  for (const name of names) {
    db.prepare("INSERT INTO crm_tags(name) VALUES (?) ON CONFLICT(name) DO NOTHING").run(name);
    const tag = db.prepare("SELECT id FROM crm_tags WHERE name=?").get(name);
    if (tag) db.prepare("INSERT OR IGNORE INTO crm_contact_tags(contact_id, tag_id) VALUES (?, ?)").run(contactId, tag.id);
  }
  return names;
}

function decorateContact(db, row) {
  return {
    id: Number(row.id),
    display_name: row.display_name,
    company_name: row.company_name || "",
    user_id: row.user_id == null ? null : Number(row.user_id),
    email: row.email || "",
    phone: row.phone || "",
    line_id: row.line_id || "",
    assigned_to: row.assigned_to == null ? null : Number(row.assigned_to),
    tags: tagNames(db, row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function snapshotContact(db, contactId) {
  const contact = decorateContact(db, assertContact(db, contactId));
  const cases = db.prepare("SELECT * FROM crm_cases WHERE contact_id=? ORDER BY id DESC").all(contact.id)
    .map((row) => ({
      id: Number(row.id),
      title: row.title,
      handling_state: row.handling_state,
      feedback_id: row.feedback_id == null ? null : Number(row.feedback_id),
      assigned_to: row.assigned_to == null ? null : Number(row.assigned_to),
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  const notes = db.prepare("SELECT * FROM crm_notes WHERE contact_id=? ORDER BY id DESC").all(contact.id)
    .map((row) => ({
      id: Number(row.id),
      case_id: row.case_id == null ? null : Number(row.case_id),
      body: row.body,
      author_user_id: row.author_user_id == null ? null : Number(row.author_user_id),
      created_at: row.created_at,
    }));
  const todos = db.prepare("SELECT * FROM crm_todos WHERE contact_id=? ORDER BY id DESC").all(contact.id)
    .map((row) => ({
      id: Number(row.id),
      case_id: row.case_id == null ? null : Number(row.case_id),
      title: row.title,
      due_at: row.due_at || null,
      done_at: row.done_at || null,
      assigned_to: row.assigned_to == null ? null : Number(row.assigned_to),
      created_at: row.created_at,
    }));
  const feedbackIds = [...new Set(cases.map((row) => row.feedback_id).filter(Boolean))];
  const feedback_handling = feedbackIds.map((id) => {
    const fb = db.prepare("SELECT id, status, admin_note, updated_at FROM feedback WHERE id=?").get(id);
    return fb ? {
      feedback_id: Number(fb.id),
      handling_state: fb.status,
      admin_note: fb.admin_note || "",
      updated_at: fb.updated_at,
    } : null;
  }).filter(Boolean);
  return { contact, cases, notes, todos, feedback_handling };
}

function enqueueSnapshot(db, contactId, now) {
  try {
    if (!crmDeliveryControl(db).effective) return;
    enqueueCrmOutbox(db, { contactId, data: snapshotContact(db, contactId), now });
  } catch {
    // outbox 未建或不應擋住本機寫入
  }
}

export function listContacts(db, { q = "" } = {}) {
  const query = clip(q, 80);
  const rows = query
    ? db.prepare(`
        SELECT * FROM crm_contacts
         WHERE display_name LIKE ? OR company_name LIKE ? OR email LIKE ? OR phone LIKE ?
         ORDER BY id DESC
      `).all(`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`)
    : db.prepare("SELECT * FROM crm_contacts ORDER BY id DESC").all();
  return rows.map((row) => decorateContact(db, row));
}

export function getContact(db, contactId) {
  return snapshotContact(db, contactId);
}

export function createContact(db, input = {}, { actorUserId = 0, now = new Date() } = {}) {
  assertCrmOpen(db);
  const name = clip(input.display_name || input.name, CRM_NAME_MAX);
  if (!name) throw httpError("請填聯絡人名稱");
  const ts = iso(now);
  db.exec("BEGIN IMMEDIATE");
  try {
    const res = db.prepare(`
      INSERT INTO crm_contacts(display_name, company_name, user_id, email, phone, line_id, assigned_to, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      clip(input.company_name, CRM_COMPANY_MAX),
      input.user_id ? Number(input.user_id) : null,
      clip(input.email, CRM_CONTACT_MAX),
      clip(input.phone, 40),
      clip(input.line_id, 80),
      input.assigned_to ? Number(input.assigned_to) : null,
      ts,
      ts,
    );
    const id = Number(res.lastInsertRowid);
    replaceTags(db, id, input.tags);
    enqueueSnapshot(db, id, now);
    db.exec("COMMIT");
    return getContact(db, id);
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* keep */ }
    throw err;
  }
}

export function updateContact(db, contactId, input = {}, { now = new Date() } = {}) {
  assertCrmOpen(db);
  const row = assertContact(db, contactId);
  const ts = iso(now);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      UPDATE crm_contacts
         SET display_name=?, company_name=?, user_id=?, email=?, phone=?, line_id=?, assigned_to=?, updated_at=?
       WHERE id=?
    `).run(
      clip(input.display_name ?? row.display_name, CRM_NAME_MAX) || row.display_name,
      clip(input.company_name ?? row.company_name, CRM_COMPANY_MAX),
      input.user_id === "" || input.user_id == null ? row.user_id : Number(input.user_id) || null,
      clip(input.email ?? row.email, CRM_CONTACT_MAX),
      clip(input.phone ?? row.phone, 40),
      clip(input.line_id ?? row.line_id, 80),
      input.assigned_to === "" || input.assigned_to == null ? row.assigned_to : Number(input.assigned_to) || null,
      ts,
      row.id,
    );
    if (input.tags != null) replaceTags(db, row.id, input.tags);
    enqueueSnapshot(db, row.id, now);
    db.exec("COMMIT");
    return getContact(db, row.id);
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* keep */ }
    throw err;
  }
}

export function createCase(db, contactId, input = {}, { now = new Date() } = {}) {
  assertCrmOpen(db);
  const contact = assertContact(db, contactId);
  const title = clip(input.title, CRM_NAME_MAX);
  if (!title) throw httpError("請填案件標題");
  const ts = iso(now);
  db.exec("BEGIN IMMEDIATE");
  try {
    const res = db.prepare(`
      INSERT INTO crm_cases(contact_id, feedback_id, title, handling_state, assigned_to, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      contact.id,
      input.feedback_id ? Number(input.feedback_id) : null,
      title,
      normalizeHandling(input.handling_state),
      input.assigned_to ? Number(input.assigned_to) : null,
      ts,
      ts,
    );
    enqueueSnapshot(db, contact.id, now);
    db.exec("COMMIT");
    return { id: Number(res.lastInsertRowid), ...getContact(db, contact.id) };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* keep */ }
    throw err;
  }
}

export function updateCase(db, caseId, input = {}, { now = new Date() } = {}) {
  assertCrmOpen(db);
  const row = db.prepare("SELECT * FROM crm_cases WHERE id=?").get(Number(caseId) || 0);
  if (!row) throw httpError("找不到這件案件", 404);
  const ts = iso(now);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      UPDATE crm_cases
         SET title=?, handling_state=?, feedback_id=?, assigned_to=?, updated_at=?
       WHERE id=?
    `).run(
      clip(input.title ?? row.title, CRM_NAME_MAX) || row.title,
      normalizeHandling(input.handling_state ?? row.handling_state),
      input.feedback_id === "" ? null : (input.feedback_id == null ? row.feedback_id : Number(input.feedback_id) || null),
      input.assigned_to === "" ? null : (input.assigned_to == null ? row.assigned_to : Number(input.assigned_to) || null),
      ts,
      row.id,
    );
    enqueueSnapshot(db, row.contact_id, now);
    db.exec("COMMIT");
    return getContact(db, row.contact_id);
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* keep */ }
    throw err;
  }
}

export function addNote(db, contactId, input = {}, { actorUserId = 0, now = new Date() } = {}) {
  assertCrmOpen(db);
  const contact = assertContact(db, contactId);
  const body = clip(input.body, CRM_NOTE_MAX);
  if (body.length < 2) throw httpError("請填備註");
  const ts = iso(now);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO crm_notes(contact_id, case_id, body, author_user_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(contact.id, input.case_id ? Number(input.case_id) : null, body, actorUserId || null, ts);
    db.prepare("UPDATE crm_contacts SET updated_at=? WHERE id=?").run(ts, contact.id);
    enqueueSnapshot(db, contact.id, now);
    db.exec("COMMIT");
    return getContact(db, contact.id);
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* keep */ }
    throw err;
  }
}

export function addTodo(db, contactId, input = {}, { now = new Date() } = {}) {
  assertCrmOpen(db);
  const contact = assertContact(db, contactId);
  const title = clip(input.title, CRM_TODO_MAX);
  if (!title) throw httpError("請填待辦");
  const ts = iso(now);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO crm_todos(contact_id, case_id, title, due_at, done_at, assigned_to, created_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?)
    `).run(
      contact.id,
      input.case_id ? Number(input.case_id) : null,
      title,
      input.due_at ? clip(input.due_at, 64) : null,
      input.assigned_to ? Number(input.assigned_to) : null,
      ts,
    );
    db.prepare("UPDATE crm_contacts SET updated_at=? WHERE id=?").run(ts, contact.id);
    enqueueSnapshot(db, contact.id, now);
    db.exec("COMMIT");
    return getContact(db, contact.id);
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* keep */ }
    throw err;
  }
}

export function setTodoDone(db, todoId, done, { now = new Date() } = {}) {
  assertCrmOpen(db);
  const row = db.prepare("SELECT * FROM crm_todos WHERE id=?").get(Number(todoId) || 0);
  if (!row) throw httpError("找不到這則待辦", 404);
  const ts = iso(now);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE crm_todos SET done_at=? WHERE id=?").run(done ? ts : null, row.id);
    db.prepare("UPDATE crm_contacts SET updated_at=? WHERE id=?").run(ts, row.contact_id);
    enqueueSnapshot(db, row.contact_id, now);
    db.exec("COMMIT");
    return getContact(db, row.contact_id);
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* keep */ }
    throw err;
  }
}

export function enqueueCrmFromFeedback(db, feedbackId, { now = new Date() } = {}) {
  const id = Number(feedbackId) || 0;
  if (!id) return 0;
  const cases = db.prepare("SELECT DISTINCT contact_id FROM crm_cases WHERE feedback_id=?").all(id);
  for (const row of cases) enqueueSnapshot(db, row.contact_id, now);
  return cases.length;
}

function guessContactFromFeedback(fb) {
  const raw = String(fb.contact || "").trim();
  let display_name = raw;
  let email = "";
  let phone = "";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
    email = raw.slice(0, CRM_CONTACT_MAX);
    display_name = raw.split("@")[0];
  } else if (/^[\d+\-\s]{8,20}$/.test(raw)) {
    phone = raw.replace(/\s+/g, "").slice(0, 40);
    display_name = phone;
  }
  if (!display_name) display_name = `回饋 #${fb.id}`;
  return {
    display_name: clip(display_name, CRM_NAME_MAX),
    email,
    phone,
    user_id: fb.user_id ? Number(fb.user_id) : null,
  };
}

export function createCaseFromFeedback(db, feedbackId, { now = new Date() } = {}) {
  assertCrmOpen(db);
  const fb = db.prepare("SELECT * FROM feedback WHERE id=?").get(Number(feedbackId) || 0);
  if (!fb) throw httpError("找不到這則回饋", 404);
  const existing = db.prepare("SELECT * FROM crm_cases WHERE feedback_id=?").get(fb.id);
  if (existing) {
    return { reused: true, ...getContact(db, existing.contact_id) };
  }
  const guessed = guessContactFromFeedback(fb);
  let contact = guessed.email
    ? db.prepare("SELECT * FROM crm_contacts WHERE email=?").get(guessed.email)
    : null;
  if (!contact && guessed.phone) {
    contact = db.prepare("SELECT * FROM crm_contacts WHERE phone=?").get(guessed.phone);
  }
  if (!contact) {
    const created = createContact(db, guessed, { now });
    contact = created.contact;
  }
  const title = clip(fb.body, 40) || `回饋 #${fb.id}`;
  return {
    reused: false,
    ...createCase(db, contact.id, {
      title,
      feedback_id: fb.id,
      handling_state: normalizeHandling(fb.status),
    }, { now }),
  };
}

export function restoreContactsFromHandoff(db, payload, { now = new Date() } = {}) {
  const rows = Array.isArray(payload?.crm_contacts) ? payload.crm_contacts : [];
  const ts = iso(now);
  let imported = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const name = clip(row.display_name, CRM_NAME_MAX);
      if (!name || name === "[purged]") continue;
      const company = clip(row.company_name, CRM_COMPANY_MAX);
      let existing = db.prepare("SELECT id FROM crm_contacts WHERE display_name=? AND company_name=?").get(name, company);
      let contactId = existing ? Number(existing.id) : 0;
      if (!contactId) {
        const res = db.prepare(`
          INSERT INTO crm_contacts(display_name, company_name, user_id, email, phone, line_id, assigned_to, created_at, updated_at)
          VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, ?)
        `).run(name, company, clip(row.email, CRM_CONTACT_MAX), clip(row.phone, 40), clip(row.line_id, 80), ts, ts);
        contactId = Number(res.lastInsertRowid);
        replaceTags(db, contactId, row.tags);
        imported += 1;
      }
      for (const item of row.cases || []) {
        const title = clip(item.title, CRM_NAME_MAX);
        if (!title || title === "[purged]") continue;
        const has = db.prepare("SELECT id FROM crm_cases WHERE contact_id=? AND title=?").get(contactId, title);
        if (has) continue;
        db.prepare(`
          INSERT INTO crm_cases(contact_id, feedback_id, title, handling_state, assigned_to, created_at, updated_at)
          VALUES (?, ?, ?, ?, NULL, ?, ?)
        `).run(contactId, item.feedback_id ? Number(item.feedback_id) : null, title, normalizeHandling(item.handling_state), ts, ts);
      }
      for (const item of row.notes || []) {
        const body = clip(item.body, CRM_NOTE_MAX);
        if (body.length < 2 || body === "[purged]") continue;
        db.prepare(`
          INSERT INTO crm_notes(contact_id, case_id, body, author_user_id, created_at)
          VALUES (?, NULL, ?, NULL, ?)
        `).run(contactId, body, item.created_at || ts);
      }
      for (const item of row.todos || []) {
        const title = clip(item.title, CRM_TODO_MAX);
        if (!title || title === "[purged]") continue;
        db.prepare(`
          INSERT INTO crm_todos(contact_id, case_id, title, due_at, done_at, assigned_to, created_at)
          VALUES (?, NULL, ?, ?, ?, NULL, ?)
        `).run(contactId, title, item.due_at || null, item.done_at || null, item.created_at || ts);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* keep */ }
    throw err;
  }
  return { imported, product_id: payload?.product?.id || null };
}

export function crmOverview(db, { q = "" } = {}) {
  return {
    module: crmModule(db),
    contacts: listContacts(db, { q }),
  };
}
