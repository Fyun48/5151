import { randomUUID } from "node:crypto";
import { appendAuditRow } from "./audit.js";
import { withImmediateTx } from "./tx.js";
import { httpError } from "./errors.js";

// ─────────────────────────────────────────────────────────────────────────────
// 中央狀態機 —— 唯一能改 lifecycle 狀態的地方。
//
// Canonical source of truth：state_entity.state（見 opsDb.js / STATE_MODEL）。
// 未來的 domain 表（proposal / dev_task / release_candidate / release）只能「衍生/去正規化」
// 顯示狀態，且不得獨立寫入第二個 lifecycle 狀態欄位。
//
// 語義（Phase 1.1）：
//  - 每個 entity type 有自己的 allowed transitions（allowedTransitionsByEntityType），
//    不使用單一全域 terminal 定義。
//  - 一般轉移：不需授權。
//  - guarded 轉移：需要「明確授權碼」才能執行（re-evaluation / owner-unblock / regression）。
//      * DEFERRED / REJECTED → EVALUATING 需 authorization="reevaluation"
//        （未來由 Re-evaluation Engine 判定門檻達標後才發動；不會因單筆 feedback 自動重評）。
//      * BLOCKED → EVALUATING 需 authorization="owner_unblock"
//        （BLOCKED 永遠不會自動重評；只有 Owner 明確解除）。
//      * RELEASED 不得回到開發生命週期（沒有通往 DEVELOPING/TESTING/EVALUATING 的路徑）；
//        再次發生（regression）由後續 Phase 建立「新的 Regression/Follow-up 實體」，而非重開舊 dev task。
//  - terminal：某狀態沒有任何一般或 guarded 出口才算 terminal（可因 entity type 而異）。
// ─────────────────────────────────────────────────────────────────────────────

// issue（feedback → proposal → development → release）主生命週期。
const ISSUE_LIFECYCLE = {
  name: "issue",
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
    RELEASED: ["ROLLED_BACK"], // 不重開開發生命週期
    FAILED: ["DEVELOPING", "CANCELLED"],
    ROLLED_BACK: ["CANCELLED"],
    APPROVAL_INVALIDATED: ["WAITING_OWNER_APPROVAL", "EVALUATING", "CANCELLED", "SUPERSEDED"],
    DEFERRED: ["CANCELLED"], // 一般路徑只能取消；回 EVALUATING 需授權
    REJECTED: ["CANCELLED"],
    BLOCKED: ["CANCELLED"], // 只有 Owner 取消或（授權）解除
    REGRESSED: ["EVALUATING", "CANCELLED"],
    CANCELLED: [],
    SUPERSEDED: [],
  },
  guarded: {
    DEFERRED: { EVALUATING: "reevaluation" },
    REJECTED: { EVALUATING: "reevaluation" },
    ROLLED_BACK: { EVALUATING: "reevaluation" },
    BLOCKED: { EVALUATING: "owner_unblock" },
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
  registry.set(def.name, { guarded: {}, ...def });
  return registry.get(def.name);
}

registerLifecycle(ISSUE_LIFECYCLE);
// 向後相容別名：Phase 1 的預設型別叫 "lifecycle"。
registerLifecycle({ ...ISSUE_LIFECYCLE, name: "lifecycle" });

export function getLifecycle(name) {
  const def = registry.get(name);
  if (!def) throw httpError(`unknown lifecycle: ${name}`, 400);
  return def;
}

export function allowedTransitions(name, state) {
  const def = getLifecycle(name);
  if (!(state in def.transitions)) throw httpError(`unknown state ${state} for ${name}`, 400);
  return def.transitions[state] || [];
}

export function guardedTransitions(name, state) {
  const def = getLifecycle(name);
  return (def.guarded && def.guarded[state]) || {};
}

// 完整的 per-entity-type 轉移表（含 guarded 標記），供文件/檢視使用。
export function allowedTransitionsByEntityType(name) {
  const def = getLifecycle(name);
  const out = {};
  for (const [state, targets] of Object.entries(def.transitions)) {
    out[state] = {
      normal: targets.slice(),
      guarded: { ...((def.guarded && def.guarded[state]) || {}) },
    };
  }
  return out;
}

export function isTerminal(name, state) {
  const normal = allowedTransitions(name, state);
  const guarded = Object.keys(guardedTransitions(name, state));
  return normal.length === 0 && guarded.length === 0;
}

export function findEntity(db, id) {
  return db.prepare("SELECT * FROM state_entity WHERE id = ?").get(String(id)) || null;
}

export function getEntity(db, id) {
  const row = findEntity(db, id);
  if (!row) throw httpError("entity not found", 404);
  return row;
}

// 建立 entity 的核心（無自帶交易）：供「已在交易內」的呼叫者（如 Phase 8 原子審批流程）組合使用。
export function createEntityRow(db, { entityType = "lifecycle", id = null, actor = "system", meta = null, now = new Date() } = {}) {
  const def = getLifecycle(entityType);
  const eid = id ? String(id) : randomUUID();
  const existing = findEntity(db, eid);
  if (existing) return existing;
  const ts = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  db.prepare(
    `INSERT INTO state_entity(id, entity_type, state, version, meta, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, ?)`,
  ).run(eid, entityType, def.initial, meta ? JSON.stringify(meta) : null, ts, ts);
  appendAuditRow(db, { actor, action: "state.create", entityType, entityId: eid, data: { state: def.initial }, now });
  return getEntity(db, eid);
}

// 建立 entity（冪等：同 id 已存在則直接回傳現有）。整段包在單一交易內。
export function createEntity(db, opts = {}) {
  return withImmediateTx(db, () => createEntityRow(db, opts));
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

// 一次原子轉移：optimistic-lock 檢查 + state_entity 更新 + state_transition append + audit append，
// 全部在同一個 BEGIN IMMEDIATE 交易內；任一步失敗則整體 ROLLBACK。
// 轉移核心（無自帶交易）：供「已在交易內」的呼叫者（如 Phase 8 審批）與 transition() 共用同一套規則。
export function transitionRow(db, { id, to, actor = "system", idempotencyKey = null, expectedVersion = null, authorization = null, data = null, now = new Date() }) {
  if (!to) throw httpError("transition requires target state 'to'", 400);
  const key = idempotencyKey || randomUUID();
  {
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

    const normal = allowedTransitions(name, entity.state);
    const guarded = guardedTransitions(name, entity.state);
    let usedAuthorization = null;
    if (normal.includes(to)) {
      // 一般轉移
    } else if (to in guarded) {
      const required = guarded[to];
      if (authorization !== required) {
        throw httpError(`transition ${entity.state} -> ${to} requires authorization '${required}'`, 403);
      }
      usedAuthorization = required;
    } else {
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

    db.prepare(
      `INSERT INTO state_transition(entity_type, entity_id, from_state, to_state, actor, idempotency_key, entity_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(name, entity.id, entity.state, to, actor, key, newVersion, ts);

    appendAuditRow(db, {
      actor,
      action: "state.transition",
      entityType: name,
      entityId: entity.id,
      data: { from: entity.state, to, version: newVersion, ...(usedAuthorization ? { authorization: usedAuthorization } : {}), ...(data ? { data } : {}) },
      now,
    });

    return { entity_id: entity.id, from: entity.state, to, version: newVersion, idempotent: false };
  }
}

// 一次原子轉移：optimistic-lock 檢查 + state_entity 更新 + state_transition append + audit append，
// 全部在同一個 BEGIN IMMEDIATE 交易內；任一步失敗則整體 ROLLBACK。
export function transition(db, opts) {
  return withImmediateTx(db, () => transitionRow(db, opts));
}
