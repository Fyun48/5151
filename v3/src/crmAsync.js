// Driver-aware CRM admin reads (2.2a)：admin 讀取在 PostgreSQL 上跑 crm.js 的同一份語句文字.
//
// sqlite   - 原 crm.js 函式，行為完全不變（正式站預設）。
// postgres - repository/crm.js 的語句，經 sharedPgDriver()；表先用 pgSchema 從 SQLite 鏡射。
// Fail-open：PostgreSQL 出錯退回 SQLite（`options.strict` 關掉它，測試／探針用）。
import { sqliteHandle } from "./db.js";
import {
  CRM_CONSENT_SCOPES,
  CRM_HANDLING,
  CRM_LEGAL,
  crmModule as crmModuleSync,
  crmOverview as crmOverviewSync,
  getContact as getContactSync,
  listContacts as listContactsSync,
} from "./crm.js";
import { resolveDbDriver } from "./dbDriver.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { ensurePgSchema } from "./pgSchema.js";
import * as repo from "./repository/crm.js";

// crm.js 的私有 httpError()（async 層要拋一樣的形狀：message + status）。
function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// sqlite 側一律用 db.js 的 handle（可用 options.sqliteHandle 覆寫，測試方便）。
function sqliteFor(options = {}) {
  return options.sqliteHandle || sqliteHandle();
}

async function ensurePgCrmSchema(pgDriver) {
  await ensurePgSchema(pgDriver, sqliteHandle(), { tables: repo.CRM_READ_TABLES });
}

// driver 分派：postgres → 注入的 exec（測試）或 sharedPgDriver 的 pool；出錯 fail-open 回 SQLite。
async function withFallback(options, runPostgres, runSqlite) {
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") return runSqlite();
  try {
    if (options.exec) return await runPostgres(options.exec);
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    await ensurePgCrmSchema(pgDriver);
    const exec = (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
    return await runPostgres(exec);
  } catch (error) {
    if (options.strict) throw error;
    return runSqlite();
  }
}

// crm.js decorateContact()：欄位轉型與 labels 逐字沿用。
async function decorateContact(exec, row) {
  return {
    id: Number(row.id),
    display_name: row.display_name,
    company_name: row.company_name || "",
    user_id: row.user_id == null ? null : Number(row.user_id),
    email: row.email || "",
    phone: row.phone || "",
    line_id: row.line_id || "",
    assigned_to: row.assigned_to == null ? null : Number(row.assigned_to),
    tags: await repo.readTagNames(exec, row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// crm.js snapshotContact()（含 cases／notes／todos／feedback_handling）。
async function snapshotContact(exec, contactId) {
  const row = await repo.readContactRow(exec, contactId);
  if (!row) throw httpError("找不到這位聯絡人", 404);
  const contact = await decorateContact(exec, row);
  const cases = (await repo.readCases(exec, contact.id)).map((item) => ({
    id: Number(item.id),
    title: item.title,
    handling_state: item.handling_state,
    feedback_id: item.feedback_id == null ? null : Number(item.feedback_id),
    assigned_to: item.assigned_to == null ? null : Number(item.assigned_to),
    created_at: item.created_at,
    updated_at: item.updated_at,
  }));
  const notes = (await repo.readNotes(exec, contact.id)).map((item) => ({
    id: Number(item.id),
    case_id: item.case_id == null ? null : Number(item.case_id),
    body: item.body,
    author_user_id: item.author_user_id == null ? null : Number(item.author_user_id),
    created_at: item.created_at,
  }));
  const todos = (await repo.readTodos(exec, contact.id)).map((item) => ({
    id: Number(item.id),
    case_id: item.case_id == null ? null : Number(item.case_id),
    title: item.title,
    due_at: item.due_at || null,
    done_at: item.done_at || null,
    assigned_to: item.assigned_to == null ? null : Number(item.assigned_to),
    created_at: item.created_at,
  }));
  const feedbackIds = [...new Set(cases.map((item) => item.feedback_id).filter(Boolean))];
  const feedback_handling = [];
  for (const id of feedbackIds) {
    const fb = await repo.readFeedbackBrief(exec, id);
    if (fb) {
      feedback_handling.push({
        feedback_id: Number(fb.id),
        handling_state: fb.status,
        admin_note: fb.admin_note || "",
        updated_at: fb.updated_at,
      });
    }
  }
  return { contact, cases, notes, todos, feedback_handling };
}

// crm.js crmModule()
export function crmModuleAsync(options = {}) {
  return withFallback(
    options,
    async (exec) => {
      const enabled = await repo.crmEnabled(exec);
      return {
        enabled,
        closed: !enabled,
        legal: CRM_LEGAL,
        handling: CRM_HANDLING,
        consents: CRM_CONSENT_SCOPES,
        note: enabled ? "可新增與編輯。關閉只停介面，資料保留。" : "CRM 已關閉：不可新增處理，既有資料仍在。",
      };
    },
    () => crmModuleSync(sqliteFor(options)),
  );
}

// crm.js listContacts()
export function listCrmContactsAsync(args = {}, options = {}) {
  return withFallback(
    options,
    async (exec) => {
      const rows = await repo.readContactRows(exec, args);
      const out = [];
      for (const row of rows) out.push(await decorateContact(exec, row));
      return out;
    },
    () => listContactsSync(sqliteFor(options), args),
  );
}

// crm.js getContact()
export function getCrmContactAsync(contactId, options = {}) {
  return withFallback(
    options,
    (exec) => snapshotContact(exec, contactId),
    () => getContactSync(sqliteFor(options), contactId),
  );
}

// crm.js crmOverview()
export function crmOverviewAsync(args = {}, options = {}) {
  return withFallback(
    options,
    async (exec) => ({
      module: await crmModuleAsync({ ...options, exec }),
      contacts: await listCrmContactsAsync(args, { ...options, exec }),
    }),
    () => crmOverviewSync(sqliteFor(options), args),
  );
}

// Exposed for tests/diagnostics: the builders the PostgreSQL path runs.
export function crmAsyncContext() {
  return repo;
}

