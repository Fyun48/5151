// Driver-aware CRM admin reads (2.2a)：admin 讀取在 PostgreSQL 上跑 crm.js 的同一份語句文字.
//
// sqlite   - 原 crm.js 函式，行為完全不變（正式站預設）。
// postgres - repository/crm.js 的語句，經 sharedPgDriver()；表先用 pgSchema 從 SQLite 鏡射。
// Fail-open：PostgreSQL 出錯退回 SQLite（`options.strict` 關掉它，測試／探針用）。
import { randomUUID } from "node:crypto";
import { sqliteHandle } from "./db.js";
import {
  CRM_CONSENT_SCOPES,
  CRM_HANDLING,
  CRM_LEGAL,
  addNote as addNoteSync,
  addTodo as addTodoSync,
  createCase as createCaseSync,
  createContact as createContactSync,
  crmModule as crmModuleSync,
  crmOverview as crmOverviewSync,
  getContact as getContactSync,
  listContacts as listContactsSync,
  setTodoDone as setTodoDoneSync,
  updateCase as updateCaseSync,
  updateContact as updateContactSync,
} from "./crm.js";
import { resolveDbDriver } from "./dbDriver.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { ensurePgSchema } from "./pgSchema.js";
import * as repo from "./repository/crm.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";

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

// driver 分派：postgres → 注入的 exec（測試）或 sharedPgDriver 的 pool；讀取出錯 fail-open 回 SQLite，
// 寫入（options.write）則 fail-closed 往丟（見 sqliteFallback.js）。
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
    if (!sqliteFallbackAllowed(options, { write: options.write === true })) throw error;
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


// ---- 2.2b：寫入動作（驗證、欄位裁剪與 crm.js 逐字相同）----
function iso(now) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

function clip(value, max) {
  return String(value || "").trim().slice(0, max);
}

const CRM_NAME_MAX = 80;
const CRM_COMPANY_MAX = 80;
const CRM_CONTACT_MAX = 200;
const CRM_NOTE_MAX = 2000;
const CRM_TODO_MAX = 200;
const CRM_TAG_MAX = 32;
const CRM_TAG_LIMIT = 12;
const CRM_OUTBOX_MAX_ATTEMPTS = 8;

function normalizeHandling(value) {
  const id = String(value || "").trim().toLowerCase();
  return CRM_HANDLING.some((row) => row.id === id) ? id : "new";
}

async function assertCrmOpenExec(exec) {
  if (!(await repo.crmEnabled(exec))) {
    throw httpError("CRM 已關閉。資料仍保留；重新開啟後才能新增或修改。", 409);
  }
}

async function assertContactExec(exec, contactId) {
  const row = await repo.readContactRow(exec, contactId);
  if (!row) throw httpError("找不到這位聯絡人", 404);
  return row;
}

// crm.js replaceTags() 的 async 版（PG 用 ON CONFLICT DO NOTHING 代替 INSERT OR IGNORE）。
async function replaceTagsExec(exec, contactId, tags) {
  const names = [...new Set((Array.isArray(tags) ? tags : String(tags || "").split(/[,，]/))
    .map((item) => clip(item, CRM_TAG_MAX).toLowerCase())
    .filter(Boolean))].slice(0, CRM_TAG_LIMIT);
  await repo.runWrite(exec, repo.tagDeleteQuery(contactId).sql, repo.tagDeleteQuery(contactId).params);
  for (const name of names) {
    const upsert = repo.tagUpsertQuery(name);
    await repo.runWrite(exec, upsert.sql, upsert.params);
    const idq = repo.tagIdQuery(name);
    const rows = (await exec(idq.sql, idq.params)) || [];
    const tagId = Number((rows[0] || {}).id) || 0;
    if (tagId) {
      const link = repo.contactTagInsertQuery(contactId, tagId);
      await repo.runWrite(exec, link.sql, link.params);
    }
  }
  return names;
}

// crm.js enqueueSnapshot()：同步開啟時，把整份快照寫進 crm_outbox（PG 模式就寫 PG）。
async function enqueueSnapshotExec(exec, contactId, now) {
  try {
    if (!(await syncEffectiveExec(exec))) return;
    const data = await snapshotContact(exec, contactId);
    const deliveryId = randomUUID();
    const stamp = iso(now);
    const idem = `crm:${contactId}:${stamp}:${deliveryId.slice(0, 8)}`;
    const payload = JSON.stringify({
      delivery_id: deliveryId,
      idempotency_key: idem,
      source: "v3",
      external_contact_id: Number(contactId),
      snapshot: data,
      synced_at: stamp,
    });
    const q = repo.outboxInsertQuery([deliveryId, idem, Number(contactId), payload, CRM_OUTBOX_MAX_ATTEMPTS, stamp, stamp]);
    await repo.runWrite(exec, q.sql, q.params);
  } catch {
    // outbox 未建或不應擋住本機寫入（與 crm.js 的 try/catch 同語意）
  }
}

// crm.js crmDeliveryControl() 的 effective 判斷（env ＋ 本機停止旗標）。
async function syncEffectiveExec(exec) {
  const stop = repo.crmSyncStopQuery();
  const rows = (await exec(stop.sql, stop.params)) || [];
  const localStopped = String((rows[0] || {}).value || "") === "1";
  const envAllowed = process.env.OPS_CRM_DELIVERY === "1";
  const configured = Boolean(process.env.OPS_INGEST_URL && process.env.OPS_INGEST_SECRET);
  return Boolean(envAllowed && configured && !localStopped);
}

async function withTransaction(exec, run) {
  await exec("BEGIN");
  try {
    const out = await run();
    await exec("COMMIT");
    return out;
  } catch (error) {
    try { await exec("ROLLBACK"); } catch { /* keep original error */ }
    throw error;
  }
}

// crm.js createContact()
export function createContactAsync(input = {}, opts = {}, options = {}) {
  const { actorUserId = 0, now = new Date() } = opts;
  return withFallback(
    { ...options, write: true },
    async (exec) => {
      await assertCrmOpenExec(exec);
      const name = clip(input.display_name || input.name, CRM_NAME_MAX);
      if (!name) throw httpError("請填聯絡人名稱");
      const ts = iso(now);
      return withTransaction(exec, async () => {
        const id = await repo.insertReturningId(exec, repo.contactInsertQuery([
          name,
          clip(input.company_name, CRM_COMPANY_MAX),
          input.user_id ? Number(input.user_id) : null,
          clip(input.email, CRM_CONTACT_MAX),
          clip(input.phone, 40),
          clip(input.line_id, 80),
          input.assigned_to ? Number(input.assigned_to) : null,
          ts,
          ts,
        ]));
        await replaceTagsExec(exec, id, input.tags);
        await enqueueSnapshotExec(exec, id, now);
        return snapshotContact(exec, id);
      });
    },
    () => createContactSync(sqliteFor(options), input, { actorUserId, now }),
  );
}

// crm.js updateContact()
export function updateContactAsync(contactId, input = {}, opts = {}, options = {}) {
  const { now = new Date() } = opts;
  return withFallback(
    { ...options, write: true },
    async (exec) => {
      await assertCrmOpenExec(exec);
      const row = await assertContactExec(exec, contactId);
      const ts = iso(now);
      return withTransaction(exec, async () => {
        const q = repo.contactUpdateQuery([
          clip(input.display_name ?? row.display_name, CRM_NAME_MAX) || row.display_name,
          clip(input.company_name ?? row.company_name, CRM_COMPANY_MAX),
          input.user_id === "" || input.user_id == null ? row.user_id : Number(input.user_id) || null,
          clip(input.email ?? row.email, CRM_CONTACT_MAX),
          clip(input.phone ?? row.phone, 40),
          clip(input.line_id ?? row.line_id, 80),
          input.assigned_to === "" || input.assigned_to == null ? row.assigned_to : Number(input.assigned_to) || null,
          ts,
          row.id,
        ]);
        await repo.runWrite(exec, q.sql, q.params);
        if (input.tags != null) await replaceTagsExec(exec, row.id, input.tags);
        await enqueueSnapshotExec(exec, row.id, now);
        return snapshotContact(exec, row.id);
      });
    },
    () => updateContactSync(sqliteFor(options), contactId, input, { now }),
  );
}

// crm.js createCase()
export function createCaseAsync(contactId, input = {}, opts = {}, options = {}) {
  const { now = new Date() } = opts;
  return withFallback(
    { ...options, write: true },
    async (exec) => {
      await assertCrmOpenExec(exec);
      const contact = await assertContactExec(exec, contactId);
      const title = clip(input.title, CRM_NAME_MAX);
      if (!title) throw httpError("請填案件標題");
      const ts = iso(now);
      return withTransaction(exec, async () => {
        const id = await repo.insertReturningId(exec, repo.caseInsertQuery([
          contact.id,
          input.feedback_id ? Number(input.feedback_id) : null,
          title,
          normalizeHandling(input.handling_state),
          input.assigned_to ? Number(input.assigned_to) : null,
          ts,
          ts,
        ]));
        await enqueueSnapshotExec(exec, contact.id, now);
        return { id, ...(await snapshotContact(exec, contact.id)) };
      });
    },
    () => createCaseSync(sqliteFor(options), contactId, input, { now }),
  );
}

// crm.js updateCase()
export function updateCaseAsync(caseId, input = {}, opts = {}, options = {}) {
  const { now = new Date() } = opts;
  return withFallback(
    { ...options, write: true },
    async (exec) => {
      await assertCrmOpenExec(exec);
      const q0 = repo.caseRowQuery(caseId);
      const row = ((await exec(q0.sql, q0.params)) || [])[0];
      if (!row) throw httpError("找不到這件案件", 404);
      const ts = iso(now);
      return withTransaction(exec, async () => {
        const q = repo.caseUpdateQuery([
          clip(input.title ?? row.title, CRM_NAME_MAX) || row.title,
          normalizeHandling(input.handling_state ?? row.handling_state),
          input.feedback_id === "" ? null : (input.feedback_id == null ? row.feedback_id : Number(input.feedback_id) || null),
          input.assigned_to === "" ? null : (input.assigned_to == null ? row.assigned_to : Number(input.assigned_to) || null),
          ts,
          row.id,
        ]);
        await repo.runWrite(exec, q.sql, q.params);
        await enqueueSnapshotExec(exec, row.contact_id, now);
        return snapshotContact(exec, row.contact_id);
      });
    },
    () => updateCaseSync(sqliteFor(options), caseId, input, { now }),
  );
}

// crm.js addNote()
export function addNoteAsync(contactId, input = {}, opts = {}, options = {}) {
  const { actorUserId = 0, now = new Date() } = opts;
  return withFallback(
    { ...options, write: true },
    async (exec) => {
      await assertCrmOpenExec(exec);
      const contact = await assertContactExec(exec, contactId);
      const body = clip(input.body, CRM_NOTE_MAX);
      if (body.length < 2) throw httpError("請填備註");
      const ts = iso(now);
      return withTransaction(exec, async () => {
        const q = repo.noteInsertQuery([contact.id, input.case_id ? Number(input.case_id) : null, body, actorUserId || null, ts]);
        await repo.runWrite(exec, q.sql, q.params);
        const touch = repo.contactTouchQuery(ts, contact.id);
        await repo.runWrite(exec, touch.sql, touch.params);
        await enqueueSnapshotExec(exec, contact.id, now);
        return snapshotContact(exec, contact.id);
      });
    },
    () => addNoteSync(sqliteFor(options), contactId, input, { actorUserId, now }),
  );
}

// crm.js addTodo()
export function addTodoAsync(contactId, input = {}, opts = {}, options = {}) {
  const { now = new Date() } = opts;
  return withFallback(
    { ...options, write: true },
    async (exec) => {
      await assertCrmOpenExec(exec);
      const contact = await assertContactExec(exec, contactId);
      const title = clip(input.title, CRM_TODO_MAX);
      if (!title) throw httpError("請填待辦");
      const ts = iso(now);
      return withTransaction(exec, async () => {
        const q = repo.todoInsertQuery([
          contact.id,
          input.case_id ? Number(input.case_id) : null,
          title,
          input.due_at ? clip(input.due_at, 64) : null,
          input.assigned_to ? Number(input.assigned_to) : null,
          ts,
        ]);
        await repo.runWrite(exec, q.sql, q.params);
        const touch = repo.contactTouchQuery(ts, contact.id);
        await repo.runWrite(exec, touch.sql, touch.params);
        await enqueueSnapshotExec(exec, contact.id, now);
        return snapshotContact(exec, contact.id);
      });
    },
    () => addTodoSync(sqliteFor(options), contactId, input, { now }),
  );
}

// crm.js setTodoDone()
export function setTodoDoneAsync(todoId, done, opts = {}, options = {}) {
  const { now = new Date() } = opts;
  return withFallback(
    { ...options, write: true },
    async (exec) => {
      await assertCrmOpenExec(exec);
      const q0 = repo.todoRowQuery(todoId);
      const row = ((await exec(q0.sql, q0.params)) || [])[0];
      if (!row) throw httpError("找不到這則待辦", 404);
      const ts = iso(now);
      return withTransaction(exec, async () => {
        const q = repo.todoDoneQuery(done ? ts : null, row.id);
        await repo.runWrite(exec, q.sql, q.params);
        const touch = repo.contactTouchQuery(ts, row.contact_id);
        await repo.runWrite(exec, touch.sql, touch.params);
        await enqueueSnapshotExec(exec, row.contact_id, now);
        return snapshotContact(exec, row.contact_id);
      });
    },
    () => setTodoDoneSync(sqliteFor(options), todoId, done, { now }),
  );
}

