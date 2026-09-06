import { randomUUID } from "node:crypto";
import { appendAudit } from "./audit.js";
import { httpError } from "./errors.js";

// 中央狀態機：唯一能改 state 的地方。
// - 明確 allowed transitions
// - entity_version 樂觀鎖（compare-and-set）
// - idempotency key（重複轉移 = no-op，回相同結果）
// - 並發保護（version CAS + state_transition.idempotency_key UNIQUE）
// - terminal state 強制（無 outgoing 的狀態不可再轉出）
// - 每次轉移寫入 state_transition 與 audit_log

// Proposal / Development lifecycle（修正版架構的完整狀態集）。
export const LIFECYCLE = {
  name: "lifecycle",
  initial: "COLLECTING",
  transitions: {
    COLLECTING: ["EVALUATING", "DEFERRED", "CANCELLED"],
    EVALUATING: ["WAITING_OWNER_APPROVAL", "DEFERRED", "REJECTED", "BLOCKED", "CANCELLED"],
    WAITING_OWNER_APPROVAL: ["APPROVED_FOR_DEVELOPMENT", "PROPOSAL_CHANGES_REQUESTED", "DEFERRED", "REJECTED", "BLOCKED", "CANCELLED"],
    PROPOSAL_CHANGES_REQUESTED: ["EVALUATING", "WAITING_OWNER_APPROVAL", "CANCELLED", "SUPERSEDED"],
    APPROVED_FOR_DEVELOPMENT: ["DEVELOPING", "APPROVAL_INVALIDATED", "CANCELLED"],
    DEVELOPING: ["TESTING", "FAILED", "CANCELLED"],
    TESTING: ["STAGING", "DEVELOPING", "FAILED", "CANCELLED"],
    STAGING: ["WAITING_RELEASE_APPROVAL", "TESTING", "FAILED", "CANCELLED"],
    WAITING_RELEASE_APPROVAL: ["RELEASING", "CHANGES_REQUESTED", "CANCELLED"],
    CHANGES_REQUESTED: ["DEVELOPING", "CANCELLED", "SUPERSEDED"],
    RELEASING: ["RELEASED", "FAILED", "ROLLED_BACK"],
    RELEASED: ["REGRESSED", "ROLLED_BACK"],
    DEFERRED: ["EVALUATING", "REJECTED", "BLOCKED", "CANCELLED"],
    REJECTED: ["EVALUATING", "CANCELLED"],
    BLOCKED: ["EVALUATING", "CANCELLED"],
    FAILED: ["DEVELOPING", "CANCELLED"],
    ROLLED_BACK: ["EVALUATING", "CANCELLED"],
    APPROVAL_INVALIDATED: ["WAITING_OWNER_APPROVAL", "EVALUATING", "CANCELLED", "SUPERSEDED"],
    REGRESSED: ["EVALUATING", "CANCELLED"],
    // 終態（無 outgoing）
    CANCELLED: [],
    SUPERSEDED: [],
  },
};

const registry = new Map();

export function registerLifecycle(def) {
  if (!def?.name || !def?.initial || !def?.transitions) {
    throw new Error("lifecycle def requires name, initial, transitions");
  }
  if (!(def.initial in def.transitions)) {
    throw new Error(`initial state ${def.initial} missing in transitions`);
  }
  registry.set(def.name, def);
  return def;
}

registerLifecycle(LIFECYCLE);

export function getLifecycle(name) {
  const def = registry.get(name);
  if (!def) throw httpError(`unknown lifecycle: ${name}`, 400);
  return def;
}

export function allowedTransitions(name, state) {
  const def = getLifecycle(name);
  return def.transitions[state] || [];
}

export function isTerminal(name, state) {
  const def = getLifecycle(name);
  if (!(state in def.transitions)) throw httpError(`unknown state ${state} for ${name}`, 400);
  return def.transitions[state].length === 0;
}

export function getEntity(db, id) {
  const row = db.prepare("SELECT * FROM state_entity WHERE id = ?").get(String(id));
  if (!row) throw httpError("entity not found", 404);
  return row;
}

export function findEntity(db, id) {
  return db.prepare("SELECT * FROM state_entity WHERE id = ?").get(String(id)) || null;
}

// 建立 entity（冪等：同 id 已存在則直接回傳現有）。
export function createEntity(db, { entityType = "lifecycle", id = null, actor = "system", meta = null, now = new Date() } = {}) {
  const def = getLifecycle(entityType);
  const eid = id ? String(id) : randomUUID();
  const existing = findEntity(db, eid);
  if (existing) return existing;
  const ts = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  db.prepare(
    `INSERT INTO state_entity(id, entity_type, state, version, meta, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, ?)`,
  ).run(eid, entityType, def.initial, meta ? JSON.stringify(meta) : null, ts, ts);
  appendAudit(db, { actor, action: "state.create", entityType, entityId: eid, data: { state: def.initial }, now });
  return getEntity(db, eid);
}

export function listTransitions(db, { entityId = null, limit = 200 } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 200, 1000));
  if (entityId) {
    return db.prepare(
      "SELECT * FROM state_transition WHERE entity_id = ? ORDER BY id DESC LIMIT ?",
    ).all(String(entityId), cap);
  }
  return db.prepare("SELECT * FROM state_transition ORDER BY id DESC LIMIT ?").all(cap);
}

export function transition(db, { id, to, actor = "system", idempotencyKey = null, expectedVersion = null, data = null, now = new Date() }) {
  if (!to) throw httpError("transition requires target state 'to'", 400);
  const key = idempotencyKey || randomUUID();

  // 冪等：同 key 已處理過 → no-op，回原結果。
  const prior = db.prepare("SELECT * FROM state_transition WHERE idempotency_key = ?").get(key);
  if (prior) {
    return {
      entity_id: prior.entity_id,
      from: prior.from_state,
      to: prior.to_state,
      version: Number(prior.entity_version),
      idempotent: true,
    };
  }

  const entity = getEntity(db, id);
  const name = entity.entity_type;

  if (isTerminal(name, entity.state)) {
    throw httpError(`state ${entity.state} is terminal; no transitions allowed`, 409);
  }
  if (expectedVersion != null && Number(expectedVersion) !== Number(entity.version)) {
    throw httpError(`version conflict (expected ${expectedVersion}, actual ${entity.version})`, 409);
  }
  if (!allowedTransitions(name, entity.state).includes(to)) {
    throw httpError(`illegal transition: ${entity.state} -> ${to}`, 422);
  }

  const ts = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  // 樂觀鎖：只有版本相符才更新，避免並發雙轉移。
  const upd = db.prepare(
    "UPDATE state_entity SET state = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
  ).run(to, ts, entity.id, entity.version);
  if (upd.changes === 0) {
    throw httpError("concurrent modification detected", 409);
  }
  const newVersion = Number(entity.version) + 1;

  try {
    db.prepare(
      `INSERT INTO state_transition(entity_type, entity_id, from_state, to_state, actor, idempotency_key, entity_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(name, entity.id, entity.state, to, actor, key, newVersion, ts);
  } catch (err) {
    // idempotency_key UNIQUE 撞號：另一寫入者已記錄 → 回其結果。
    const other = db.prepare("SELECT * FROM state_transition WHERE idempotency_key = ?").get(key);
    if (other) {
      return {
        entity_id: other.entity_id,
        from: other.from_state,
        to: other.to_state,
        version: Number(other.entity_version),
        idempotent: true,
      };
    }
    throw err;
  }

  appendAudit(db, {
    actor,
    action: "state.transition",
    entityType: name,
    entityId: entity.id,
    data: { from: entity.state, to, version: newVersion, ...(data ? { data } : {}) },
    now,
  });

  return { entity_id: entity.id, from: entity.state, to, version: newVersion, idempotent: false };
}
