// Ops 反向指令（`POST /api/ops/commands/apply`）的 driver-aware 入口（PG 島嶼，2026-09-28，第五十九批）。
//
// 這一支是 Ops Console 把處理結果**套回產品端**的入口：Ops 簽章 → 驗章 → 依 `command_kind` 套用
// （`feedback.patch_handling`／`crm.add_note`）→ 把結果寫進 `site_command_inbox`（冪等）。
//
// 為什麼一定要移植：PG 模式下同步版把結果套在**節點本機**的 feedback／CRM，
// 而使用者看到的是 PG 的資料 ⇒ **Ops 改了狀態、產品端完全沒變**（而且回 Ops「已套用」）。
//
// 🚨 三個既有陷阱在這裡同時出現：
//   1. `ops_remote_cs_stop` 是**原生字串**鍵（比對 `"1"`）⇒ 不可走 `settingsKvAsync`（會 JSON 化）。
//   2. `site_command_inbox` 的 `idempotency_key` 是欄位 UNIQUE（**隱式索引**，鏡射不到）
//      ⇒ 少了它「同一個指令套用兩次」的守衛就失效。
//   3. 注入式 `exec` 的形狀：本模組的 runner 吃**裸陣列**。
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { ensurePgSchema } from "./pgSchema.js";
import {
  APPLY_PATH,
  COMMAND_KINDS,
  REMOTE_CS_STOP_KEY,
  applySiteCommand as applySiteCommandSync,
  ensureSiteCommandInbox as ensureSiteCommandInboxSync,
  isRemoteCsStopped as isRemoteCsStoppedSync,
  setRemoteCsStopped as setRemoteCsStoppedSync,
} from "./siteCommandApply.js";
import { verifyIngestRequest } from "./opsSignature.js";
import { updateFeedbackAsync } from "./feedbackAsync.js";
import { addNoteAsync } from "./crmAsync.js";

export const SITE_COMMAND_TABLES = ["site_command_inbox"];
export const SITE_COMMAND_UNIQUE_INDEXES = [
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_site_command_inbox_idem ON site_command_inbox(idempotency_key)",
];
export const STOP_SELECT_SQL = "SELECT value FROM settings WHERE key = ?";
export const STOP_UPSERT_SQL =
  "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";
export const INBOX_FIND_SQL = "SELECT * FROM site_command_inbox WHERE command_id = $1 OR idempotency_key = $2";
export const INBOX_INSERT_SQL = `INSERT INTO site_command_inbox(command_id, idempotency_key, command_kind, payload_json, apply_state, result_json, received_at, applied_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";
const one = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);
const rowsOf = (raw) => (Array.isArray(raw) ? raw : (raw?.rows || []));

export const iso = (now = new Date()) => (now instanceof Date ? now : new Date(now)).toISOString();

function httpError(message, status = 400, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

function reject(applyState, reason, status = 409) {
  const err = httpError(reason, status);
  err.apply_state = applyState;
  err.reason = reason;
  return err;
}

const schemaReady = new WeakMap();
export async function ensureSiteCommandStoreOnce(pgDriver) {
  if (!pgDriver) return;
  if (schemaReady.has(pgDriver)) return schemaReady.get(pgDriver);
  const sqlite = sqliteHandle();
  // 🚨 `site_command_inbox` 是**延遲建立**的（同步版在第一次用到時才 `ensureSiteCommandInbox()`）
  // ⇒ 全新節點的本機 SQLite 還沒有它，直接鏡射會被 `ensurePgSchema()` 擋下
  // （第五十批加的那道守衛，會建出零欄表的那個坑）。這裡照同步版先把來源表準備好。
  ensureSiteCommandInboxSync(sqlite);
  const ready = (async () => {
    await ensurePgSchema(pgDriver, sqlite, { tables: SITE_COMMAND_TABLES, indexes: false });
    for (const sql of SITE_COMMAND_UNIQUE_INDEXES) await pgDriver.exec(sql);
  })();
  schemaReady.set(pgDriver, ready);
  try {
    await ready;
  } catch (error) {
    schemaReady.delete(pgDriver);
    throw error;
  }
}

async function execFor(options) {
  if (options.exec) {
    const injected = options.exec;
    return async (sql, params = []) => rowsOf(await injected(sql, params));
  }
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  await ensureSiteCommandStoreOnce(pgDriver);
  return async (sql, params = []) => (await pgDriver.query(toPostgresSql(sql), params)).rows;
}

async function withFallback(options, runPostgres, runSqlite, { write = true } = {}) {
  if (!isPg(options)) return runSqlite();
  try {
    return await runPostgres(await execFor(options));
  } catch (error) {
    if (!sqliteFallbackAllowed(options, { write })) throw error;
    return runSqlite();
  }
}

// `siteCommandApply.isRemoteCsStopped()` 的 PG 版：**原始文字**比對 `"1"`。
export async function isRemoteCsStoppedAsync(options = {}) {
  return withFallback(options, async (exec) => {
    const row = one(await exec(STOP_SELECT_SQL, [REMOTE_CS_STOP_KEY]));
    return String(row?.value || "") === "1";
  }, () => isRemoteCsStoppedSync(sqliteHandle()), { write: false });
}

// `setRemoteCsStopped()` 的 PG 版：存原始字串（不是 JSON），並在本機鏡射一份。
export async function setRemoteCsStoppedAsync(stopped, options = {}) {
  const value = stopped ? "1" : "0";
  const result = await withFallback(options, async (exec) => {
    await exec(STOP_UPSERT_SQL, [REMOTE_CS_STOP_KEY, value]);
    return value === "1";
  }, () => setRemoteCsStoppedSync(sqliteHandle(), Boolean(stopped)));
  if (isPg(options)) {
    try { setRemoteCsStoppedSync(sqliteHandle(), Boolean(stopped)); } catch { /* 本機鏡射失敗不擋 */ }
  }
  return result;
}

// `remoteCsAcceptControl()` 的 PG 版（欄位逐欄相同）。
export async function remoteCsAcceptControlAsync(options = {}, env = process.env) {
  if (!isPg(options)) {
    const { remoteCsAcceptControl } = await import("./siteCommandApply.js");
    return remoteCsAcceptControl(sqliteHandle(), env);
  }
  const envAllowed = env.V3_OPS_COMMAND_ACCEPT === "1";
  const configured = Boolean(env.V3_OPS_COMMAND_SECRET || "");
  const localStopped = await isRemoteCsStoppedAsync(options);
  return { env_allowed: envAllowed, configured, local_stopped: localStopped, effective: Boolean(envAllowed && configured && !localStopped) };
}

// `applyKind()` 的 PG 版：兩個指令各自的規則與同步版逐條對應。
async function applyKindAsync(command, options = {}) {
  const payload = command.payload || {};
  if (command.command_kind === "feedback.patch_handling") {
    const id = Number(payload.feedback_id || payload.external_feedback_id || 0);
    if (!id) throw reject("rejected", "missing_feedback_id", 400);
    if (payload.handling_state == null && payload.status == null && payload.admin_note == null) {
      throw reject("rejected", "empty_patch", 400);
    }
    const row = await updateFeedbackAsync(id, {
      status: payload.handling_state || payload.status,
      admin_note: payload.admin_note,
    }, options);
    return { feedback_id: row.id, handling_state: row.status, admin_note: row.admin_note };
  }
  if (command.command_kind === "crm.add_note") {
    const contactId = Number(payload.contact_id || payload.external_contact_id || 0);
    if (!contactId) throw reject("rejected", "missing_contact_id", 400);
    const contact = await addNoteAsync(contactId, {
      body: payload.body,
      case_id: payload.case_id || payload.external_case_id,
    }, {}, options);
    return { contact_id: contact.contact?.id || contact.id, notes: (contact.notes || []).length };
  }
  throw reject("rejected", "unknown_command_kind", 400);
}

// `applySiteCommand()` 的 PG 版：**冪等**（先查 inbox，同一組 command_id／idempotency_key 回舊結果），
// 失敗也要把 rejected 寫進 inbox（Ops 才看得到「被拒絕」而不是無聲無息）。
export async function applySiteCommandAsync(command = {}, { now = new Date() } = {}, options = {}) {
  if (!isPg(options)) return applySiteCommandSync(sqliteHandle(), command, { now });
  const commandId = String(command.command_id || "").trim();
  const idem = String(command.idempotency_key || "").trim();
  const kind = String(command.command_kind || "").trim();
  if (!commandId || !idem) throw reject("rejected", "missing_command_identity", 400);
  if (!COMMAND_KINDS.includes(kind)) throw reject("rejected", "unknown_command_kind", 400);

  const exec = await execFor(options);
  const existing = one(await exec(INBOX_FIND_SQL, [commandId, idem]));
  if (existing) {
    return {
      apply_state: existing.apply_state,
      command_id: existing.command_id,
      idempotency_key: existing.idempotency_key,
      result: existing.result_json ? JSON.parse(existing.result_json) : {},
      duplicate: true,
    };
  }
  const ts = iso(now);
  try {
    const result = await applyKindAsync({ ...command, command_kind: kind, payload: command.payload || {} }, options);
    await exec(INBOX_INSERT_SQL, [commandId, idem, kind, JSON.stringify(command.payload || {}), "applied", JSON.stringify(result), ts, ts]);
    return { apply_state: "applied", command_id: commandId, idempotency_key: idem, result, duplicate: false };
  } catch (err) {
    const applyState = err.apply_state || "rejected";
    const reason = err.reason || err.message || "apply_failed";
    try {
      await exec(INBOX_INSERT_SQL, [commandId, idem, kind, JSON.stringify(command.payload || {}), applyState, JSON.stringify({ reason }), ts, null]);
    } catch { /* unique race：另一個 worker 先寫進去了 */ }
    throw err;
  }
}

// `handleApplyRequest()` 的 PG 版（驗章、解析、套用、錯誤狀態碼都逐條對應）。
export async function handleApplyRequestAsync({ headers, rawBody, env = process.env, now = Date.now() } = {}, options = {}) {
  if (!isPg(options)) {
    const { handleApplyRequest } = await import("./siteCommandApply.js");
    return handleApplyRequest(sqliteHandle(), { headers, rawBody, env, now });
  }
  const control = await remoteCsAcceptControlAsync(options, env);
  if (!control.effective) {
    const reason = !control.env_allowed ? "accept_off" : !control.configured ? "no_secret" : "local_stopped";
    return { httpStatus: 403, body: { apply_state: "rejected", reason } };
  }
  const verified = verifyIngestRequest({
    method: "POST",
    path: APPLY_PATH,
    headers,
    rawBody,
    secret: env.V3_OPS_COMMAND_SECRET,
    now,
  });
  if (!verified.ok) return { httpStatus: 401, body: { apply_state: "rejected", reason: "bad_signature" } };
  let parsed;
  try { parsed = JSON.parse(rawBody || "{}"); } catch {
    return { httpStatus: 400, body: { apply_state: "rejected", reason: "invalid_json" } };
  }
  if (String(parsed.command_id || "") !== String(verified.deliveryId || "")) {
    return { httpStatus: 400, body: { apply_state: "rejected", reason: "command_id_mismatch" } };
  }
  try {
    const applied = await applySiteCommandAsync(parsed, { now: new Date(now) }, options);
    return { httpStatus: 200, body: applied };
  } catch (err) {
    return {
      httpStatus: err.status || 409,
      body: { apply_state: err.apply_state || "rejected", reason: err.reason || err.message },
    };
  }
}
