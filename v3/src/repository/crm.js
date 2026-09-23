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

