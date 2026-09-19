import { httpError } from "./errors.js";
import { AUTHORIZED_GITHUB_ACTOR, isAuthorizedGithubActor } from "./release/productionReleasePolicy.js";

// 指令來源只能是已驗證身分（session / workflow actor），不能靠 payload 旗標冒充 Owner 直達。
const SPOOF_KEYS = ["owner_direct", "ownerDirect", "manual_owner", "manualOwner"];

export const INSTRUCTION_SOURCES = Object.freeze({
  VERIFIED_SESSION: "verified_session",
  VERIFIED_WORKFLOW_ACTOR: "verified_workflow_actor",
});

export function hasSpoofedOwnerDirect(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  for (const key of SPOOF_KEYS) {
    const v = body[key];
    if (v === true || v === 1 || v === "1" || String(v).toLowerCase() === "true") return true;
  }
  const source = String(body.instruction_source || body.instructionSource || "").toLowerCase();
  return source === "owner_direct" || source === "manual_owner";
}

export function rejectSpoofedOwnerDirect(body) {
  if (hasSpoofedOwnerDirect(body)) {
    throw httpError("instruction source must be a verified session, not a payload flag", 403);
  }
}

export function resolveVerifiedInstruction({
  session = null, workflowActor = null, body = null, env = process.env,
} = {}) {
  rejectSpoofedOwnerDirect(body);
  if (session?.role === "owner" && session?.email) {
    return {
      source: INSTRUCTION_SOURCES.VERIFIED_SESSION,
      actor: `owner:${session.email}`,
      session_nonce: session.nonce || null,
    };
  }
  const actorLogin = String(workflowActor || "").trim();
  const configured = String(env.PRODUCTION_RELEASE_GITHUB_ACTOR || AUTHORIZED_GITHUB_ACTOR).trim();
  if (
    actorLogin
    && isAuthorizedGithubActor(actorLogin)
    && isAuthorizedGithubActor(configured)
    && actorLogin === configured
  ) {
    return {
      source: INSTRUCTION_SOURCES.VERIFIED_WORKFLOW_ACTOR,
      actor: `workflow:${actorLogin}`,
      session_nonce: null,
    };
  }
  throw httpError("instruction source must be a verified session or authorized workflow actor", 403);
}

export function ensureInstructionRecordSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS instruction_record (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      product_id TEXT,
      environment_key TEXT,
      session_nonce TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_instruction_entity ON instruction_record(entity_type, entity_id, id);
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS instruction_record_no_update BEFORE UPDATE ON instruction_record
      BEGIN SELECT RAISE(ABORT, 'instruction_record is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS instruction_record_no_delete BEFORE DELETE ON instruction_record
      BEGIN SELECT RAISE(ABORT, 'instruction_record is append-only'); END;
  `);
}

export function recordInstruction(db, {
  source, actor, action, entityType, entityId,
  productId = null, environmentKey = null, sessionNonce = null, now = new Date(),
} = {}) {
  ensureInstructionRecordSchema(db);
  if (!source || !actor || !action || !entityType || entityId == null) {
    throw httpError("instruction record is incomplete", 400);
  }
  const ts = (now instanceof Date ? now : new Date(now)).toISOString();
  const res = db.prepare(`
    INSERT INTO instruction_record(
      source, actor, action, entity_type, entity_id, product_id, environment_key, session_nonce, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    source, actor, action, entityType, String(entityId),
    productId || null, environmentKey || null, sessionNonce || null, ts,
  );
  return { id: Number(res.lastInsertRowid), source, actor, action, entity_type: entityType, entity_id: String(entityId) };
}
