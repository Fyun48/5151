import { addNote, ensureCrmSchema } from "./crm.js";
import { ensureFeedbackSchema, updateFeedback } from "./feedback.js";
import { verifyIngestRequest } from "./opsSignature.js";

export const APPLY_PATH = "/api/ops/commands/apply";
export const REMOTE_CS_STOP_KEY = "ops_remote_cs_stop";
export const COMMAND_KINDS = Object.freeze(["feedback.patch_handling", "crm.add_note"]);

function httpError(message, status = 400, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

function iso(now = new Date()) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

export function ensureSiteCommandInbox(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS site_command_inbox (
      command_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      command_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      apply_state TEXT NOT NULL,
      result_json TEXT,
      received_at TEXT NOT NULL,
      applied_at TEXT
    );
  `);
}

export function isRemoteCsStopped(db) {
  if (!db) return false;
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key=?").get(REMOTE_CS_STOP_KEY);
    return String(row?.value || "") === "1";
  } catch {
    return false;
  }
}

export function setRemoteCsStopped(db, stopped) {
  ensureSiteCommandInbox(db);
  db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(REMOTE_CS_STOP_KEY, stopped ? "1" : "0");
  return isRemoteCsStopped(db);
}

export function remoteCsAcceptControl(db, env = process.env) {
  const envAllowed = env.V3_OPS_COMMAND_ACCEPT === "1";
  const configured = Boolean(env.V3_OPS_COMMAND_SECRET || "");
  const localStopped = isRemoteCsStopped(db);
  return {
    env_allowed: envAllowed,
    configured,
    local_stopped: localStopped,
    effective: Boolean(envAllowed && configured && !localStopped),
  };
}

function reject(applyState, reason, status = 409) {
  const err = httpError(reason, status);
  err.apply_state = applyState;
  err.reason = reason;
  return err;
}

function applyKind(db, command) {
  const payload = command.payload || {};
  if (command.command_kind === "feedback.patch_handling") {
    ensureFeedbackSchema(db);
    const id = Number(payload.feedback_id || payload.external_feedback_id || 0);
    if (!id) throw reject("rejected", "missing_feedback_id", 400);
    if (payload.handling_state == null && payload.status == null && payload.admin_note == null) {
      throw reject("rejected", "empty_patch", 400);
    }
    const row = updateFeedback(db, id, {
      status: payload.handling_state || payload.status,
      admin_note: payload.admin_note,
    });
    return {
      feedback_id: row.id,
      handling_state: row.status,
      admin_note: row.admin_note,
    };
  }
  if (command.command_kind === "crm.add_note") {
    ensureCrmSchema(db);
    const contactId = Number(payload.contact_id || payload.external_contact_id || 0);
    if (!contactId) throw reject("rejected", "missing_contact_id", 400);
    const contact = addNote(db, contactId, {
      body: payload.body,
      case_id: payload.case_id || payload.external_case_id,
    });
    return {
      contact_id: contact.contact?.id || contact.id,
      notes: (contact.notes || []).length,
    };
  }
  throw reject("rejected", "unknown_command_kind", 400);
}

export function applySiteCommand(db, command = {}, { now = new Date() } = {}) {
  ensureSiteCommandInbox(db);
  const commandId = String(command.command_id || "").trim();
  const idem = String(command.idempotency_key || "").trim();
  const kind = String(command.command_kind || "").trim();
  if (!commandId || !idem) throw reject("rejected", "missing_command_identity", 400);
  if (!COMMAND_KINDS.includes(kind)) throw reject("rejected", "unknown_command_kind", 400);

  const existing = db.prepare("SELECT * FROM site_command_inbox WHERE command_id=? OR idempotency_key=?").get(commandId, idem);
  if (existing) {
    const result = existing.result_json ? JSON.parse(existing.result_json) : {};
    return {
      apply_state: existing.apply_state,
      command_id: existing.command_id,
      idempotency_key: existing.idempotency_key,
      result,
      duplicate: true,
    };
  }

  const ts = iso(now);
  try {
    const result = applyKind(db, { ...command, command_kind: kind, payload: command.payload || {} });
    db.prepare(`
      INSERT INTO site_command_inbox(command_id, idempotency_key, command_kind, payload_json, apply_state, result_json, received_at, applied_at)
      VALUES (?, ?, ?, ?, 'applied', ?, ?, ?)
    `).run(commandId, idem, kind, JSON.stringify(command.payload || {}), JSON.stringify(result), ts, ts);
    return { apply_state: "applied", command_id: commandId, idempotency_key: idem, result, duplicate: false };
  } catch (err) {
    const applyState = err.apply_state || "rejected";
    const reason = err.reason || err.message || "apply_failed";
    try {
      db.prepare(`
        INSERT INTO site_command_inbox(command_id, idempotency_key, command_kind, payload_json, apply_state, result_json, received_at, applied_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(commandId, idem, kind, JSON.stringify(command.payload || {}), applyState, JSON.stringify({ reason }), ts);
    } catch { /* unique race */ }
    throw err;
  }
}

export function handleApplyRequest(db, { headers, rawBody, env = process.env, now = Date.now() }) {
  const control = remoteCsAcceptControl(db, env);
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
  if (!verified.ok) {
    return { httpStatus: 401, body: { apply_state: "rejected", reason: "bad_signature" } };
  }
  let parsed;
  try { parsed = JSON.parse(rawBody || "{}"); } catch {
    return { httpStatus: 400, body: { apply_state: "rejected", reason: "invalid_json" } };
  }
  if (String(parsed.command_id || "") !== String(verified.deliveryId || "")) {
    return { httpStatus: 400, body: { apply_state: "rejected", reason: "command_id_mismatch" } };
  }
  try {
    const applied = applySiteCommand(db, parsed, { now: new Date(now) });
    return { httpStatus: 200, body: applied };
  } catch (err) {
    return {
      httpStatus: err.status || 409,
      body: { apply_state: err.apply_state || "rejected", reason: err.reason || err.message },
    };
  }
}
