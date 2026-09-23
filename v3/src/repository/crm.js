// CRM 的 PostgreSQL 側（2.2a：admin 讀取路徑）。語句文字與 crm.js 逐字相同。
//
// 問題：crm.js 的語句全跑在 SQLite handle 上。`DB_DRIVER=postgres` 時後台看到的 CRM
// 與站上其他資料（客訴 feedback 等）分屬兩個 store。這個模組把「同一份語句文字」變成
// builder，交給注入的 exec 執行；哪個 driver 由 crmAsync.js 決定。
//
// 2.2a 只含讀取（crmModule／crmOverview／listContacts／getContact／snapshotContact）。
// 寫入（createContact／updateCase／addNote／addTodo／setTodoDone／crm_outbox）是 2.2b。
export const CRM_READ_TABLES = [
  "crm_contacts",
  "crm_tags",
  "crm_contact_tags",
  "crm_cases",
  "crm_notes",
  "crm_todos",
];

// crm.js 的 CRM_ENABLED_KEY（複製字串，避免 repository → domain 的循環 import）。
export const CRM_ENABLED_KEY = "crm_enabled";

export function crmEnabledQuery() {
  return { sql: "SELECT value FROM settings WHERE key = ?", params: [CRM_ENABLED_KEY] };
}

export function contactRowQuery(contactId) {
  return { sql: "SELECT * FROM crm_contacts WHERE id = ?", params: [Number(contactId) || 0] };
}

// crm.js tagNames()：標籤名稱依字母排序。
export function contactTagNamesQuery(contactId) {
  return {
    sql: `SELECT t.name FROM crm_tags t
      JOIN crm_contact_tags ct ON ct.tag_id = t.id
     WHERE ct.contact_id = ?
     ORDER BY t.name`,
    params: [Number(contactId) || 0],
  };
}

// crm.js listContacts()：q 先 clip(80)，四欄 LIKE 或全表，一律 id DESC。
export function listContactsQuery({ q = "" } = {}) {
  const query = String(q || "").trim().slice(0, 80);
  if (!query) return { sql: "SELECT * FROM crm_contacts ORDER BY id DESC", params: [] };
  const like = `%${query}%`;
  return {
    sql: `SELECT * FROM crm_contacts
     WHERE display_name LIKE ? OR company_name LIKE ? OR email LIKE ? OR phone LIKE ?
     ORDER BY id DESC`,
    params: [like, like, like, like],
  };
}

export function contactCasesQuery(contactId) {
  return { sql: "SELECT * FROM crm_cases WHERE contact_id = ? ORDER BY id DESC", params: [Number(contactId) || 0] };
}

export function contactNotesQuery(contactId) {
  return { sql: "SELECT * FROM crm_notes WHERE contact_id = ? ORDER BY id DESC", params: [Number(contactId) || 0] };
}

export function contactTodosQuery(contactId) {
  return { sql: "SELECT * FROM crm_todos WHERE contact_id = ? ORDER BY id DESC", params: [Number(contactId) || 0] };
}

// crm.js snapshotContact() 的 feedback_handling 來源（只取四個欄位）。
export function feedbackBriefQuery(feedbackId) {
  return {
    sql: "SELECT id, status, admin_note, updated_at FROM feedback WHERE id = ?",
    params: [Number(feedbackId) || 0],
  };
}

export async function crmEnabled(exec) {
  const query = crmEnabledQuery();
  const rows = (await exec(query.sql, query.params)) || [];
  // crm.js setting()：讀不到就當預設（enabled），只有明確 "0" 才是關閉。
  return String((rows[0] || {}).value || "") !== "0";
}

export async function readContactRow(exec, contactId) {
  const query = contactRowQuery(contactId);
  return ((await exec(query.sql, query.params)) || [])[0] || null;
}

export async function readTagNames(exec, contactId) {
  const query = contactTagNamesQuery(contactId);
  return ((await exec(query.sql, query.params)) || []).map((row) => row.name);
}

export async function readContactRows(exec, args = {}) {
  const query = listContactsQuery(args);
  return (await exec(query.sql, query.params)) || [];
}

export async function readCases(exec, contactId) {
  const query = contactCasesQuery(contactId);
  return (await exec(query.sql, query.params)) || [];
}

export async function readNotes(exec, contactId) {
  const query = contactNotesQuery(contactId);
  return (await exec(query.sql, query.params)) || [];
}

export async function readTodos(exec, contactId) {
  const query = contactTodosQuery(contactId);
  return (await exec(query.sql, query.params)) || [];
}

export async function readFeedbackBrief(exec, feedbackId) {
  const query = feedbackBriefQuery(feedbackId);
  return ((await exec(query.sql, query.params)) || [])[0] || null;
}


// ---- 2.2b：寫入動作與佇列寫入 ----
// createCase 用 INSERT ... RETURNING id 取 id（SQLite 端原本用 lastInsertRowid，PG 沒有這個東西）。
export const CRM_WRITE_TABLES = [...CRM_READ_TABLES, "crm_outbox"];

export function contactInsertQuery(values) {
  return {
    sql: `INSERT INTO crm_contacts(display_name, company_name, user_id, email, phone, line_id, assigned_to, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    params: values,
  };
}

export function contactUpdateQuery(values) {
  return {
    sql: `UPDATE crm_contacts
       SET display_name=?, company_name=?, user_id=?, email=?, phone=?, line_id=?, assigned_to=?, updated_at=?
     WHERE id=?`,
    params: values,
  };
}

export function caseInsertQuery(values) {
  return {
    sql: `INSERT INTO crm_cases(contact_id, feedback_id, title, handling_state, assigned_to, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    params: values,
  };
}

export function caseUpdateQuery(values) {
  return {
    sql: `UPDATE crm_cases
       SET title=?, handling_state=?, feedback_id=?, assigned_to=?, updated_at=?
     WHERE id=?`,
    params: values,
  };
}

export function caseRowQuery(caseId) {
  return { sql: "SELECT * FROM crm_cases WHERE id = ?", params: [Number(caseId) || 0] };
}

export function contactTouchQuery(stamp, contactId) {
  return { sql: "UPDATE crm_contacts SET updated_at=? WHERE id=?", params: [stamp, Number(contactId) || 0] };
}

export function noteInsertQuery(values) {
  return {
    sql: `INSERT INTO crm_notes(contact_id, case_id, body, author_user_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    params: values,
  };
}

export function todoInsertQuery(values) {
  return {
    sql: `INSERT INTO crm_todos(contact_id, case_id, title, due_at, done_at, assigned_to, created_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    params: values,
  };
}

export function todoRowQuery(todoId) {
  return { sql: "SELECT * FROM crm_todos WHERE id = ?", params: [Number(todoId) || 0] };
}

export function todoDoneQuery(stamp, todoId) {
  return { sql: "UPDATE crm_todos SET done_at=? WHERE id=?", params: [stamp, Number(todoId) || 0] };
}

// 標籤：PG 不支援 INSERT OR IGNORE，改寫成 ON CONFLICT DO NOTHING。
export function tagDeleteQuery(contactId) {
  return { sql: "DELETE FROM crm_contact_tags WHERE contact_id=?", params: [Number(contactId) || 0] };
}

export function tagUpsertQuery(name) {
  return { sql: "INSERT INTO crm_tags(name) VALUES (?) ON CONFLICT(name) DO NOTHING", params: [name] };
}

export function tagIdQuery(name) {
  return { sql: "SELECT id FROM crm_tags WHERE name=?", params: [name] };
}

export function contactTagInsertQuery(contactId, tagId) {
  return {
    sql: "INSERT INTO crm_contact_tags(contact_id, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
    params: [Number(contactId) || 0, Number(tagId) || 0],
  };
}

export function crmSyncStopQuery() {
  return { sql: "SELECT value FROM settings WHERE key = ?", params: ["ops_crm_stop"] };
}

export function outboxInsertQuery(values) {
  return {
    sql: `INSERT INTO crm_outbox(delivery_id, idempotency_key, contact_id, payload, status, attempts, max_attempts, next_attempt_at, created_at)
      VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    params: values,
  };
}

export async function runWrite(exec, sql, params) {
  await exec(sql, params);
}

export async function insertReturningId(exec, query) {
  const rows = (await exec(query.sql, query.params)) || [];
  return Number((rows[0] || {}).id) || 0;
}

